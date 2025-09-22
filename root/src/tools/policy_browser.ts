import crypto from 'node:crypto';
import { observeExternal } from '../util/metrics.js';
import { incFallback } from '../util/metrics.js';
import { withBreaker, getBreaker, getBreakerStats } from '../util/circuit.js';
import { scheduleWithLimit } from '../util/limiter.js';
import { callLLM } from '../core/llm.js';
import { getPrompt } from '../core/prompts.js';
import { scoreDomainAuthenticity } from '../core/domain_authenticity.js';
import { PolicyReceiptSchema, type ClauseTypeT, type PolicyReceipt, type DomainScore } from '../schemas/policy.js';
import type { CheerioCrawlingContext } from 'crawlee';

const SOURCE_CACHE = new Map<string, 'airline' | 'hotel' | 'visa' | 'generic'>();

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface ScoredResult extends SearchResult {
  domainScore: DomainScore;
}

/**
 * Filter and rank search results by domain authenticity
 */
export async function filterResultsByDomainAuthenticity(
  results: SearchResult[],
  airlineName: string,
  signal?: AbortSignal
): Promise<ScoredResult[]> {
  const scoredResults: ScoredResult[] = [];
  const maxLinksToCheck = parseInt(process.env.POLICY_DOMAIN_CHECK_LIMIT || '5', 10);
  
  for (const result of results.slice(0, maxLinksToCheck)) {
    try {
      const domain = new URL(result.url).hostname;
      const domainScore = await scoreDomainAuthenticity(domain, airlineName, signal);
      
      scoredResults.push({
        ...result,
        domainScore
      });
    } catch (error) {
      console.warn(`Failed to score domain for ${result.url}:`, error);
      // Add with default low score
      scoredResults.push({
        ...result,
        domainScore: {
          domain: result.url,
          confidence: 0.1,
          reasoning: 'llm_classified',
          isOfficial: false
        }
      });
    }
  }
  
  // Sort by domain authenticity score (highest first)
  return scoredResults.sort((a, b) => b.domainScore.confidence - a.domainScore.confidence);
}

function escapeForPrompt(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function scorePolicyConfidence(
  clause: ClauseTypeT,
  extractedText: string,
  sourceUrl: string
): Promise<number> {
  try {
    const tpl = await getPrompt('policy_confidence');
    const prompt = tpl
      .replace('{{clauseType}}', clause)
      .replace('{{extractedText}}', escapeForPrompt(extractedText.slice(0, 800)))
      .replace('{{sourceUrl}}', sourceUrl);
    const raw = await callLLM(prompt, { responseFormat: 'text' });
    const match = raw.match(/(\d+(?:\.\d+)?)/);
    if (!match || !match[1]) return 0;
    let score = parseFloat(match[1]);
    if (!Number.isFinite(score)) return 0;
    if (score > 1) score /= 100;
    return Math.max(0, Math.min(1, score));
  } catch (error) {
    console.warn('policy_confidence_failed', error instanceof Error ? error.message : String(error));
    return 0;
  }
}

async function classifySourceCategory(url: string, excerpt: string): Promise<'airline' | 'hotel' | 'visa' | 'generic'> {
  try {
    const host = new URL(url).hostname;
    if (SOURCE_CACHE.has(host)) return SOURCE_CACHE.get(host)!;

    const tpl = await getPrompt('policy_classifier');
    const question = `Source host: ${host}. Policy excerpt: ${excerpt.slice(0, 280)}.`;
    const prompt = tpl.replace('{question}', escapeForPrompt(question));
    const raw = await callLLM(prompt, { responseFormat: 'text' });
    const normalized = raw.trim().toLowerCase();

    let category: 'airline' | 'hotel' | 'visa' | 'generic' = 'generic';
    if (normalized.includes('airline')) category = 'airline';
    else if (normalized.includes('hotel')) category = 'hotel';
    else if (normalized.includes('visa')) category = 'visa';

    SOURCE_CACHE.set(host, category);
    return category;
  } catch (error) {
    console.warn('policy_source_classifier_failed', error instanceof Error ? error.message : String(error));
    return 'generic';
  }
}

const PNG_MAX = 2_000_000;

export async function extractPolicyClause(params: {
  url: string;
  clause: ClauseTypeT;
  airlineName?: string;
  engine?: 'playwright' | 'cheerio';
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<PolicyReceipt> {
  const t0 = Date.now();
  const url = params.url;
  const host = new URL(url).hostname;

  try {
    const timeoutSecs = Math.ceil((params.timeoutMs ?? 30000) / 1000); // 30 second default
    
    console.log(`🎯 Policy extraction: ${host} - Using Playwright ONLY (Crawlee disabled)`);
    
    // Score domain authenticity if airline name provided
    let domainScore: DomainScore | undefined;
    if (params.airlineName) {
      try {
        const signal = AbortSignal.timeout(150);
        domainScore = await scoreDomainAuthenticity(host, params.airlineName, signal);
        console.log(`🏆 Domain authenticity: ${domainScore.confidence.toFixed(2)} (${domainScore.reasoning})`);
      } catch (error) {
        console.warn('Domain scoring failed:', error);
      }
    }
    
    // Use only Playwright with advanced stealth - no Crawlee fallback
    return await scheduleWithLimit(host, async () => {
      try {
        return await withBreaker(host, async () => {
          try { incFallback('browser'); } catch {}
          const result = await withPlaywright(url, params.clause, timeoutSecs, domainScore);
          return PolicyReceiptSchema.parse(result);
        });
      } catch (error) {
        const openCircuit =
          error instanceof Error && (
            error.name === 'CircuitBreakerOpenError' ||
            error.message.includes('Circuit breaker is open')
          );
        if (!openCircuit) throw error;

        const breaker = getBreaker(host);
        const stats = getBreakerStats(host);
        console.warn('policy_browser_breaker_bypass', { host, stats });
        try { (breaker as any).close?.(); } catch {}
        try { incFallback('browser'); } catch {}
        const result = await withPlaywright(url, params.clause, timeoutSecs, domainScore);
        return PolicyReceiptSchema.parse(result);
      }
    });
    
  } finally {
    observeExternal({ target: 'policy_browser', status: 'ok' }, Date.now() - t0);
  }
}

async function withPlaywright(url: string, clause: ClauseTypeT, timeoutSecs: number, domainScore?: DomainScore) {
  const { chromium } = await import('playwright');
  
  const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
  const blockResources = process.env.PLAYWRIGHT_BLOCK_RESOURCES?.split(',').map(s => s.trim()) || ['image', 'font', 'media'];
  
  console.log(`🎭 ${headless ? 'Headless' : 'Headful'} mode with advanced stealth`);
  
  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      ...(headless ? ['--disable-extensions-except=/dev/null', '--disable-extensions'] : []),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-popup-blocking',
      '--disable-translate',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-ipc-flooding-protection'
    ]
  });
  
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { 
        width: 1366 + Math.floor(Math.random() * 200), 
        height: 768 + Math.floor(Math.random() * 200) 
      },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"'
      }
    });
    
    const page = await context.newPage();
    
    // Advanced stealth - comprehensive anti-detection
    await page.addInitScript(() => {
      // Remove webdriver traces
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
      delete (window as any).__webdriver_evaluate;
      delete (window as any).__selenium_evaluate;
      delete (window as any).__webdriver_script_function;
      delete (window as any).__webdriver_script_func;
      delete (window as any).__webdriver_script_fn;
      delete (window as any).__fxdriver_evaluate;
      delete (window as any).__driver_unwrapped;
      delete (window as any).__webdriver_unwrapped;
      delete (window as any).__driver_evaluate;
      delete (window as any).__selenium_unwrapped;
      delete (window as any).__fxdriver_unwrapped;
      
      // Spoof plugins (from research)
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', length: 1 },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', length: 1 },
          { name: 'Native Client', filename: 'internal-nacl-plugin', length: 1 }
        ]
      });
      
      // Spoof mimeTypes
      Object.defineProperty(navigator, 'mimeTypes', {
        get: () => [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: navigator.plugins[0] },
          { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: navigator.plugins[1] },
          { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable', enabledPlugin: navigator.plugins[2] }
        ]
      });
      
      // Fix missing properties in headless
      if (!window.outerHeight) {
        Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight });
        Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
      }
      
      // Spoof WebGL context (from research)
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
        if (parameter === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
        return getParameter.call(this, parameter);
      };
      
      // Spoof hardware concurrency and device memory (from research)
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
      
      // Add chrome object with runtime
      if (!(window as any).chrome) {
        (window as any).chrome = { 
          runtime: { 
            onConnect: undefined,
            onMessage: undefined,
            connect: () => ({}),
            sendMessage: () => ({})
          },
          app: {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
          }
        };
      }
      
      // Disable WebRTC IP leakage (from research)
      const origRTC = (window as any).RTCPeerConnection || (window as any).webkitRTCPeerConnection;
      if (origRTC) {
        (window as any).RTCPeerConnection = class extends origRTC {
          constructor(config: any) {
            if (config && config.iceServers) {
              config.iceServers = [];
            }
            super(config);
          }
        };
      }
      
      // Spoof battery API (from research)
      if ((navigator as any).getBattery) {
        (navigator as any).getBattery = () => Promise.resolve({
          charging: false,
          chargingTime: Infinity,
          dischargingTime: 14400, // 4 hours
          level: 0.73 + Math.random() * 0.2 // 73-93%
        });
      }
      
      // Spoof permissions
      if (navigator.permissions) {
        const originalQuery = navigator.permissions.query;
        navigator.permissions.query = (parameters: any) => {
          if (parameters.name === 'notifications') {
            return Promise.resolve({ 
              state: 'default',
              name: 'notifications',
              onchange: null,
              addEventListener: () => {},
              removeEventListener: () => {},
              dispatchEvent: () => false
            } as any);
          }
          return originalQuery.call(navigator.permissions, parameters);
        };
      }
      
      // Override toString methods to appear native
      const nativeToStringFunctionString = Error.toString().replace(/Error/g, "toString");
      const oldCall = Function.prototype.call;
      function call(this: any) {
        return oldCall.apply(this, arguments as any);
      }
      Function.prototype.call = call;
      
      const oldToString = Function.prototype.toString;
      function functionToString(this: any) {
        if (this === (navigator as any).webdriver) {
          return 'function webdriver() { [native code] }';
        }
        if (this === functionToString) {
          return nativeToStringFunctionString;
        }
        return oldCall.call(oldToString, this);
      }
      Function.prototype.toString = functionToString;
    });
    
    // Block resources based on config
    await page.route('**/*', async (route: any) => {
      const resourceType = route.request().resourceType();
      if (blockResources.includes(resourceType)) {
        await route.abort();
      } else {
        await route.continue();
      }
    });
    
    console.log(`🌐 Navigating to ${url} with full stealth`);
    
    // Navigate with timeout
    await page.goto(url, { 
      timeout: timeoutSecs * 1000, 
      waitUntil: 'domcontentloaded'
    });
    
    // Wait longer for El Al's dynamic content
    if (url.includes('elal.com')) {
      console.log('🔒 El Al detected - using enhanced stealth');
      await page.waitForTimeout(5000); // Longer wait for El Al
      
      // Try to bypass potential overlays/modals
      try {
        await page.evaluate(() => {
          // Remove common overlay elements
          const overlays = document.querySelectorAll('[class*="overlay"], [class*="modal"], [class*="popup"], [id*="overlay"], [id*="modal"]');
          overlays.forEach(el => el.remove());
          
          // Remove cookie banners
          const cookies = document.querySelectorAll('[class*="cookie"], [class*="gdpr"], [class*="consent"]');
          cookies.forEach(el => el.remove());
        });
      } catch {}
      
      // Multiple scroll attempts to trigger lazy loading
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 500);
        await page.waitForTimeout(200);
      }
      
      // Scroll back to top
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
    } else {
      await page.waitForTimeout(1000);
      
      // Fast human behavior simulation
      console.log('🤖 Fast human behavior simulation...');
      await page.mouse.move(Math.random() * 1366, Math.random() * 768);
      await page.waitForTimeout(50);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(100);
    }
    
    // Extract content with multiple methods
    const extractContent = async () => {
      const fullText = await page.evaluate(() => {
        const selectors = [
          'main', 'article', '.content', '[class*="baggage"]', '[class*="policy"]', 
          '[class*="carry"]', '[class*="cabin"]', '[class*="allowance"]',
          'p', 'div', 'span', 'li', 'td', 'section'
        ];
        let text = '';
        selectors.forEach(selector => {
          try {
            document.querySelectorAll(selector).forEach(el => {
              if (el.textContent && el.textContent.trim().length > 10) {
                text += ' ' + el.textContent.trim();
              }
            });
          } catch (e) {}
        });
        
        // Fallback to body text if selectors don't work
        if (text.length < 100) {
          text = document.body.innerText || document.body.textContent || '';
        }
        
        return text.trim();
      });
      
      const title = await page.title();
      
      console.log(`📄 Extracted ${fullText.length} chars: "${title}"`);
      
      return { fullText, title };
    };

    const { fullText, title } = await extractContent();
    
    const extractedClause = await extractClauseWithLLM(fullText, clause, url);
    
    // Screenshot for receipt
    let png: Buffer | undefined;
    try {
      png = await page.screenshot({ 
        fullPage: true, 
        timeout: 5000,
        type: 'png'
      });
    } catch (error) {
      console.log('📸 Screenshot failed, continuing without it');
    }
    
    const hash = crypto.createHash('sha256').update(`${url}\n${extractedClause.quote}`).digest('hex');
    const imgPath = png && png.byteLength <= PNG_MAX ? await persistPng(url, png) : undefined;
    const sourceCategory = await classifySourceCategory(url, extractedClause.quote);

    return {
      url,
      title,
      hash,
      capturedAt: new Date().toISOString(),
      quote: extractedClause.quote,
      imgPath,
      confidence: extractedClause.confidence,
      source: sourceCategory,
      domainAuthenticity: domainScore
    };
    
  } catch (error) {
    console.error(`Policy extraction failed for ${url}:`, error);
    throw error;
    
  } finally {
    await browser.close();
  }
}

async function withCheerio(url: string, clause: ClauseTypeT, timeoutMs: number, domainScore?: DomainScore) {
  const { CheerioCrawler, createCheerioRouter } = await import('crawlee');
  let receipt: any | undefined;
  
  const router = createCheerioRouter();
  router.addDefaultHandler(async (ctx: CheerioCrawlingContext) => {
    const { $, request } = ctx;
    
    // Extract all text content
    const fullText = $('body').text().replace(/\s+/g, ' ').trim();
    const title = $('title').text().trim() || new URL(request.url).hostname;
    
    // Use LLM to extract relevant policy clause
    const extractedClause = await extractClauseWithLLM(fullText, clause, request.url);
    const hash = crypto.createHash('sha256').update(`${request.url}\n${extractedClause.quote}`).digest('hex');
    const sourceCategory = await classifySourceCategory(request.url, extractedClause.quote);

    receipt = {
      url: request.url,
      title,
      hash,
      capturedAt: new Date().toISOString(),
      quote: extractedClause.quote,
      confidence: extractedClause.confidence,
      source: sourceCategory,
      domainAuthenticity: domainScore
    };
  });
  
  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 1,
    requestHandlerTimeoutSecs: Math.ceil(timeoutMs / 1000),
    requestHandler: router,
    maxRequestRetries: 2,
    failedRequestHandler: async ({ request, error }) => {
      console.warn(`Cheerio failed for ${request.url}:`, String(error));
    }
  });
  
  try {
    await crawler.run([url]);
  } catch (error) {
    console.warn('Cheerio crawler error:', error);
  }
  
  if (receipt) return receipt;

  const fallbackSource = await classifySourceCategory(url, '');
  return {
    url,
    title: new URL(url).hostname,
    hash: crypto.createHash('sha256').update(url).digest('hex'),
    capturedAt: new Date().toISOString(),
    quote: '',
    confidence: 0,
    source: fallbackSource,
    domainAuthenticity: domainScore
  };
}

/**
 * AI-first clause extraction using LLM
 */
async function extractClauseWithLLM(
  fullText: string, 
  clause: ClauseTypeT, 
  sourceUrl: string
): Promise<{ quote: string; confidence: number }> {
  try {
    // Increase context window significantly - use most of the 128k context
    const truncatedText = fullText.slice(0, 80000);
    
    console.log(`🔍 LLM Extraction Debug:`);
    console.log(`- URL: ${sourceUrl}`);
    console.log(`- Text length: ${fullText.length} -> ${truncatedText.length}`);
    console.log(`- First 300 chars: "${truncatedText.slice(0, 300)}"`);
    
    // Extract with LLM - emphasize the specific airline
    const extractorPrompt = await getPrompt('policy_extractor');
    const enhancedPrompt = `${extractorPrompt}

CRITICAL: You are extracting policy information from ${new URL(sourceUrl).hostname}. 
Pay close attention to the SPECIFIC AIRLINE mentioned in the content.
If this is El Al content, extract EL AL policies, NOT other airlines.

IMPORTANT: Look for specific baggage policy information including:
- Size limits (dimensions in cm or inches)
- Weight limits (kg or lbs) 
- Number of bags allowed
- Fees and restrictions
- Official policy language

Extract the most relevant and specific policy text about ${clause} from the CORRECT airline mentioned in the source.`;

    const prompt = enhancedPrompt
      .replace('{{clauseType}}', clause)
      .replace('{{sourceText}}', truncatedText);
    
    console.log(`- Sending ${truncatedText.length} chars to LLM for ${clause} extraction...`);
    
    const extractedText = await callLLM(prompt, { responseFormat: 'text' });
    
    // Decode HTML entities
    const decodedText = extractedText
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'");
    
    const cleaned = decodedText.trim();
    if (cleaned.length < 10) {
      console.log('❌ LLM response too short');
      return { quote: '', confidence: 0 };
    }

    const confidence = await scorePolicyConfidence(clause, cleaned, sourceUrl);
    console.log(`- Parsed confidence: ${confidence}`);
    console.log(`✅ Final result: ${cleaned.length} chars, ${(confidence * 100).toFixed(0)}% confidence`);

    if (confidence < 0.3) {
      console.log('❌ Confidence too low for extracted clause');
      return { quote: '', confidence };
    }

    return {
      quote: cleaned.slice(0, 1000),
      confidence
    };
  } catch (error) {
    console.warn('❌ LLM extraction failed:', error);
    return { quote: '', confidence: 0 };
  }
}

async function persistPng(url: string, buf: Buffer): Promise<string> {
  const dir = process.env.POLICY_RECEIPTS_DIR || 'assets/receipts';
  const name = `${Date.now()}-${Buffer.from(url).toString('base64').slice(0, 12)}.png`;
  const fs = await import('node:fs/promises');
  const p = `${dir}/${name}`;
  
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(p, buf);
  return p;
}
