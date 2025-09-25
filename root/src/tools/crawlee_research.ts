import crypto from 'node:crypto';
import { callLLM } from '../core/llm.js';
import { getPrompt } from '../core/prompts.js';
import { scoreDomainAuthenticity } from '../core/domain_authenticity.js';
import { PolicyReceiptSchema, type ClauseTypeT, type PolicyReceipt, type DomainScore } from '../schemas/policy.js';
import { observeCrawler } from '../util/metrics.js';
import { blockHost, isHostBlocked, getBlockedHosts } from '../util/blocked_hosts.js';

const DEBUG = process.env.LOG_LEVEL === 'debug';

type CrawlResult = {
  url: string;
  title: string;
  content: string;
  summary?: string;
};

export async function deepResearchPages(
  urls: string[],
  query: string,
  opts: { engine?: 'cheerio'|'playwright'; maxPages?: number } = {}
): Promise<{
  ok: boolean;
  results: CrawlResult[];
  summary?: string;
}> {
  if (urls.length === 0) return { ok: false, results: [] };
  // Filter out blocked hosts up front
  if (DEBUG) console.debug(`🔍 Blocked hosts (TTL): ${getBlockedHosts().join(', ')}`);
  urls = urls.filter(u => {
    try { return !isHostBlocked(new URL(u).hostname); } catch { return true; }
  });
  if (urls.length === 0) return { ok: false, results: [] };
  
  const engine = opts.engine || process.env.CRAWLEE_ENGINE || 'cheerio';
  if (DEBUG) console.debug(`🔍 Crawlee engine: ${engine}`);
  
  try {
    const results: CrawlResult[] = [];
    const maxPages = Math.min(urls.length, opts.maxPages || parseInt(process.env.CRAWLEE_MAX_PAGES || '4'));
    
    if (DEBUG) console.debug(`🔍 Crawlee config: CRAWLEE_ENGINE=${engine}, CRAWLEE_MAX_PAGES=${process.env.CRAWLEE_MAX_PAGES}, maxPages=${maxPages}, urls.length=${urls.length}`);
    
    if (engine === 'playwright') {
      await runPlaywrightCrawler(urls, maxPages, results);
    } else {
      await runCheerioCrawler(urls, maxPages, results);
    }
    
    if (results.length === 0) {
      if (DEBUG) console.debug(`❌ No content extracted from any pages`);
      return { ok: false, results: [] };
    }
    if (DEBUG) console.debug(`📋 Successfully crawled ${results.length} pages, starting summarization...`);
    
    // Summarize each page
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result) continue;
      
      if (DEBUG) console.debug(`🤖 Summarizing page ${i + 1}/${results.length}: ${result.title.slice(0, 50)}...`);
      result.summary = await summarizePage(result.content, query);
      if (DEBUG) console.debug(`✅ Summary: ${result.summary.slice(0, 100)}...`);
    }
    
    // Create overall summary
    if (DEBUG) console.debug(`🔄 Creating overall summary from ${results.length} page summaries...`);
    const overallSummary = await createOverallSummary(results, query);
    if (DEBUG) console.debug(`📊 Final summary: ${overallSummary.slice(0, 150)}...`);
    
    return {
      ok: true,
      results,
      summary: overallSummary
    };
  } catch (error) {
    if (DEBUG) console.error('Crawlee error:', error);
    
    // Fallback: return basic search results without deep crawling
    const fallbackResults = urls.slice(0, 3).map((url, i) => ({
      url,
      title: `Search Result ${i + 1}`,
      content: `This page contains information relevant to: ${query}`,
      summary: `Relevant information about ${query} can be found at this source.`
    }));
    
    return { 
      ok: true, 
      results: fallbackResults,
      summary: `Based on search results, here are some options for: ${query}. Due to technical limitations, detailed page analysis was not available, but these sources contain relevant information.`
    };
  }
}

async function runCheerioCrawler(urls: string[], maxPages: number, results: CrawlResult[]): Promise<void> {
  const { CheerioCrawler, Configuration } = await import('crawlee');
  const fs = await import('fs/promises');
  const path = await import('path');
  const os = await import('os');

  const failedUrls: string[] = [];

  const runStorageDir = path.join(
    os.tmpdir(),
    'navan-crawlee',
    `cheerio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(runStorageDir, { recursive: true });

  const configuration = new Configuration({
    storageDir: runStorageDir,
    persistStorage: false,
  } as any);

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: maxPages,
    requestHandlerTimeoutSecs: 15,
    maxRequestRetries: 1,
    useSessionPool: true,
    // treat 401/403/429 as blocked to retire session quickly
    isBlockedResponseFunction: ({ response }) => {
      try {
        const sc = (response as any)?.statusCode || (response as any)?.status();
        return sc === 401 || sc === 403 || sc === 429;
      } catch { return false; }
    },
    async requestHandler({ $, request }) {
      try {
        const title = $('title').text().trim();
        const content = extractMainContent($);
        
        console.log(`📄 Crawling (Cheerio): ${request.url}`);
        console.log(`📝 Title: ${title.slice(0, 100)}${title.length > 100 ? '...' : ''}`);
        console.log(`📊 Content length: ${content.length} chars`);
        
        if (content.length > 100) {
          results.push({
            url: request.url,
            title,
            content: content.slice(0, 2000)
          });
          observeCrawler('cheerio', 0, true); // latency not precisely measured per page here
          console.log(`✅ Added to results (${results.length}/${maxPages})`);
        } else {
          console.log(`❌ Content too short, skipping`);
          observeCrawler('cheerio', 0, false);
        }
      } catch (e) {
        console.warn(`❌ Failed to process ${request.url}:`, e);
        failedUrls.push(request.url);
        observeCrawler('cheerio', 0, false);
      }
    },
    failedRequestHandler({ request }) {
      console.warn(`Failed to crawl: ${request.url}`);
      try { const h = new URL(request.url).hostname; blockHost(h); } catch {}
      failedUrls.push(request.url);
      observeCrawler('cheerio', 0, false);
    },
  });

  try {
    await crawler.run(urls.slice(0, maxPages));
  } finally {
    await fs.rm(runStorageDir, { recursive: true, force: true }).catch(() => undefined);
  }
  
  // Retry failed URLs with Playwright if available
  if (failedUrls.length > 0) {
    if (DEBUG) console.debug(`🔄 Retrying ${failedUrls.length} failed URLs with Playwright...`);
    try {
      await runPlaywrightCrawler(failedUrls, failedUrls.length, results);
    } catch (e) {
      if (DEBUG) console.warn(`❌ Playwright fallback also failed:`, e);
    }
  }
}

async function runPlaywrightCrawler(urls: string[], maxPages: number, results: CrawlResult[]): Promise<void> {
  const { PlaywrightCrawler, Configuration } = await import('crawlee');
  const fs = await import('fs/promises');
  const path = await import('path');
  const os = await import('os');

  const runStorageDir = path.join(
    os.tmpdir(),
    'navan-crawlee',
    `playwright-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(runStorageDir, { recursive: true });

  const configuration = new Configuration({
    storageDir: runStorageDir,
    persistStorage: false,
  } as any);

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: maxPages,
    requestHandlerTimeoutSecs: 15,
    navigationTimeoutSecs: 10,
    maxRequestRetries: 1,
    useSessionPool: true,
    launchContext: {
      launchOptions: {
        headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
        timeout: 10000,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-ipc-flooding-protection',
        ],
      }
    },
    async requestHandler({ page, request }) {
      try {
        // Block heavy resources
        await page.route('**/*', route => {
          const type = route.request().resourceType();
          const block = (process.env.PLAYWRIGHT_BLOCK_RESOURCES || 'image,font,media')
            .split(',').map(s => s.trim());
        
          if (block.includes(type)) return route.abort();
          return route.continue();
        });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9', DNT: '1' as any });
        // Wait for main content selectors with timeout
        const contentSelectors = ['main', 'article', '.content', 'body'];
        let content = '';
        let title = '';
        
        try {
          // Get title
          title = await page.title();
          
          // Try to wait for and extract from main content areas
          for (const selector of contentSelectors) {
            try {
              await page.waitForSelector(selector, { timeout: 3000 });
              const element = await page.$(selector);
              if (element) {
                const text = await element.innerText();
                if (text && text.trim().length > 200) {
                  content = text.trim();
                  break;
                }
              }
            } catch {
              // Continue to next selector
            }
          }
          
          // Fallback to page content if no main content found
          if (!content || content.length < 100) {
            content = await page.content();
            // Strip HTML tags for plain text
            content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                           .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                           .replace(/<[^>]*>/g, ' ')
                           .replace(/\s+/g, ' ')
                           .trim();
          }
        } catch (e) {
          console.warn(`❌ Failed to extract content from ${request.url}:`, e);
          return;
        }
        
        console.log(`📄 Crawling (Playwright): ${request.url}`);
        console.log(`📝 Title: ${title.slice(0, 100)}${title.length > 100 ? '...' : ''}`);
        console.log(`📊 Content length: ${content.length} chars`);
        
        if (content.length > 100) {
          results.push({
            url: request.url,
            title,
            content: content.slice(0, 2000)
          });
          observeCrawler('playwright', 0, true);
          console.log(`✅ Added to results (${results.length}/${maxPages})`);
        } else {
          console.log(`❌ Content too short, skipping`);
          observeCrawler('playwright', 0, false);
        }
      } catch (e) {
        console.warn(`❌ Failed to process ${request.url}:`, e);
        observeCrawler('playwright', 0, false);
      }
    },
    failedRequestHandler({ request }) {
      console.warn(`Failed to crawl: ${request.url}`);
      try { const h = new URL(request.url).hostname; blockHost(h); } catch {}
      observeCrawler('playwright', 0, false);
    },
  });

  try {
    await crawler.run(urls.slice(0, maxPages));
  } finally {
    await fs.rm(runStorageDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function extractMainContent($: any): string {
  // Remove unwanted elements
  $('script, style, nav, header, footer, aside, .ad, .advertisement, .sidebar').remove();
  
  // Try to find main content
  const mainSelectors = ['main', 'article', '.content', '.post', '.entry', '.main-content'];
  for (const selector of mainSelectors) {
    const main = $(selector).first();
    if (main.length && main.text().trim().length > 200) {
      return main.text().trim();
    }
  }
  
  // Fallback to body
  return $('body').text().trim();
}

async function summarizePage(content: string, query: string): Promise<string> {
  const tpl = await getPrompt('crawlee_page_summary');
  const prompt = tpl
    .replace('{query}', query)
    .replace('{content}', content.slice(0, 16000));

  try {
    const response = await callLLM(prompt);
    return response.trim();
  } catch {
    return 'Summary unavailable';
  }
}

async function createOverallSummary(results: CrawlResult[], query: string): Promise<string> {
  if (results.length === 0) return '';
  
  const summaries = results.map((r, i) => `[${i + 1}] ${r.title}: ${r.summary}`).join('\n');
  
  const tpl = await getPrompt('crawlee_overall_summary');
  const prompt = tpl
    .replace('{query}', query)
    .replace('{summaries}', summaries);

  try {
    const response = await callLLM(prompt);
    return response.trim();
  } catch {
    return 'Overall summary unavailable';
  }
}

// --- Crawlee-only policy extraction (single URL) ---
const PNG_MAX = 2_000_000;
async function persistPng(url: string, buf: Buffer): Promise<string> {
  const dir = process.env.POLICY_RECEIPTS_DIR || 'assets/receipts';
  const fs = await import('node:fs/promises');
  const name = `${Date.now()}-${Buffer.from(url).toString('base64').slice(0, 12)}.png`;
  const p = `${dir}/${name}`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(p, buf);
  return p;
}

export async function extractPolicyWithCrawlee(params: {
  url: string;
  clause: ClauseTypeT;
  airlineName?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<PolicyReceipt> {
  const t0 = Date.now();
  const { url, clause } = params;
  let title = '';
  let textContent = '';
  const engine: 'playwright' = 'playwright';
  const duration = () => Date.now() - t0;
  const { PlaywrightCrawler, Configuration } = await import('crawlee');
  const fs = await import('fs/promises');
  const path = await import('path');
  const os = await import('os');

  const runStorageDir = path.join(
    os.tmpdir(),
    'navan-crawlee',
    `policy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(runStorageDir, { recursive: true });

  const configuration = new Configuration({ storageDir: runStorageDir, persistStorage: false } as any);

  let ok = false;
  let screenshotBytes = 0;
  let screenshotPath: string | undefined;
  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: 1,
    requestHandlerTimeoutSecs: Math.ceil((params.timeoutMs ?? 20000) / 1000),
    navigationTimeoutSecs: 10,
    launchContext: {
      launchOptions: {
        headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
        timeout: 10000,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-ipc-flooding-protection',
        ],
      },
    },
    async requestHandler({ page, request }) {
      // Block heavy resources
      await page.route('**/*', route => {
        const type = route.request().resourceType();
        const block = (process.env.PLAYWRIGHT_BLOCK_RESOURCES || 'image,font,media')
          .split(',').map(s => s.trim());
        if (block.includes(type)) return route.abort();
        return route.continue();
      });
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9', DNT: '1' as any });

      // Navigate
      await page.goto(request.url, { timeout: params.timeoutMs ?? 20000, waitUntil: 'domcontentloaded' });

      // Extract main content first; fallback to body text
      title = await page.title();
      const contentSelectors = ['main', 'article', '.content', '[role="main"]'];
      for (const selector of contentSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 3000 });
          const el = await page.$(selector);
          if (el) {
            const txt = await el.innerText();
            if (txt && txt.trim().length > 200) { textContent = txt.trim(); break; }
          }
        } catch {}
      }
      if (!textContent || textContent.length < 100) {
        const html = await page.content();
        textContent = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }

      // Optional screenshot
      if (process.env.CRAWLEE_SCREENSHOT === 'true') {
        try {
          const buf = await page.screenshot({ type: 'png', timeout: 5000, fullPage: true });
          screenshotBytes = buf?.byteLength || 0;
          if (buf && buf.byteLength <= PNG_MAX) {
            try { screenshotPath = await persistPng(url, buf); } catch {}
          }
        } catch {}
      }
      ok = textContent.length > 0;
    },
    failedRequestHandler({ request }) {
      ok = false;
    },
  });

  try {
    await crawler.run([url]);
  } finally {
    observeCrawler(engine, duration(), ok, { screenshotBytes });
    await fs.rm(runStorageDir, { recursive: true, force: true }).catch(() => undefined);
  }

  // Extract clause with LLM
  const extractorPrompt = await getPrompt('policy_extractor');
  const extractPrompt = extractorPrompt
    .replace('{{clauseType}}', clause)
    .replace('{{sourceText}}', textContent.slice(0, 80000));
  const extractedText = await callLLM(extractPrompt, { responseFormat: 'text' });
  const cleaned = extractedText
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .trim();

  // Confidence scoring
  const confTpl = await getPrompt('policy_confidence');
  const confPrompt = confTpl.replace('{{clauseType}}', clause).replace('{{extractedText}}', cleaned.slice(0, 800)).replace('{{sourceUrl}}', url);
  let confidence = 0;
  try {
    const raw = await callLLM(confPrompt, { responseFormat: 'text' });
    const m = raw.match(/(\d+(?:\.\d+)?)/);
    confidence = Math.max(0, Math.min(1, (m && parseFloat(m[1])) > 1 ? parseFloat(m![1]) / 100 : (m ? parseFloat(m[1]) : 0)));
  } catch { confidence = 0; }

  // Domain authenticity score
  let domainAuthenticity: DomainScore | undefined;
  if (params.airlineName) {
    try { domainAuthenticity = await scoreDomainAuthenticity(new URL(url).hostname, params.airlineName, undefined, clause); } catch {}
  }

  const hash = crypto.createHash('sha256').update(`${url}\n${cleaned}`).digest('hex');
  const receipt: PolicyReceipt = PolicyReceiptSchema.parse({
    url,
    title: title || new URL(url).hostname,
    hash,
    capturedAt: new Date().toISOString(),
    quote: cleaned.slice(0, 1000),
    imgPath: screenshotPath,
    confidence,
    source: ((): 'airline'|'hotel'|'visa'|'generic' => {
      const h = new URL(url).hostname;
      if (/air|airline|jetblue|delta|united|lufthansa|qatar|emirates|britishairways/.test(h)) return 'airline';
      if (/hotel|marriott|hyatt|hilton|ihg/.test(h)) return 'hotel';
      if (/visa|embassy|consulate|gov/.test(h)) return 'visa';
      return 'generic';
    })(),
    domainAuthenticity,
  });
  return receipt;
}
