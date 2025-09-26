import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import MarkdownIt from 'markdown-it';
import { handleChat } from './core/blend.js';
import { createLogger } from './util/logging.js';
import { silenceNoisyLibLogs } from './util/noise_filter.js';
import { RateLimiter } from './core/rate-limiter.js';
import { RATE_LIMITER_CONFIG } from './config/resilience.js';
import { loadSessionConfig } from './config/session.js';
import { createStore, initSessionStore } from './core/session_store.js';
import { clearThreadSlots } from './core/slot_memory.js';
import type { Decision } from './core/receipts.js';
import { incMessages, observeE2E } from './util/metrics.js';
import type { PipelineStageKey, PipelineStatusUpdate } from './core/pipeline_status.js';

// Start standalone metrics server for dashboard access
if (process.env.METRICS !== 'off') {
  import('./util/metrics-server.js').catch(() => {
    // Ignore if metrics server fails to start
  });
}

// Default push URL so CLI metrics appear on the metrics server dashboard
if (!process.env.METRICS_PUSH_URL) {
  process.env.METRICS_PUSH_URL = 'http://localhost:3001/metrics/ingest';
}

const rl = readline.createInterface({ input, output });
const log = createLogger();
let threadId = 'local';

// Initialize session store
const sessionConfig = loadSessionConfig();
const sessionStore = createStore(sessionConfig);
initSessionStore(sessionStore);

log.info({ sessionStore: sessionConfig.kind, ttlSec: sessionConfig.ttlSec }, 'Session store initialized');

// Rate limiter for CLI commands
const cliRateLimiter = new RateLimiter(RATE_LIMITER_CONFIG);

const md = new MarkdownIt({
  breaks: true,
  linkify: true,
});

function renderMarkdownToTerminal(markdown: string): string {
  // Parse markdown into HTML-like structure
  const html = md.render(markdown);

  // Convert HTML to ANSI escape sequences for terminal
  return html
    // Headers
    .replace(/<h1>(.*?)<\/h1>/gi, chalk.bold.blue('\n$1\n') + '='.repeat(50))
    .replace(/<h2>(.*?)<\/h2>/gi, chalk.bold.cyan('\n$1\n') + '-'.repeat(30))
    .replace(/<h3>(.*?)<\/h3>/gi, chalk.bold.yellow('\n$1'))
    .replace(/<h[4-6]>(.*?)<\/h[4-6]>/gi, chalk.bold.magenta('\n$1'))

    // Bold and italic
    .replace(/<strong>(.*?)<\/strong>/gi, chalk.bold('$1'))
    .replace(/<b>(.*?)<\/b>/gi, chalk.bold('$1'))
    .replace(/<em>(.*?)<\/em>/gi, chalk.italic('$1'))
    .replace(/<i>(.*?)<\/i>/gi, chalk.italic('$1'))

    // Code
    .replace(/<code>(.*?)<\/code>/gi, chalk.bgGray.white(' $1 '))
    .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, (_m: string, code: string) => {
      return '\n' + chalk.bgGray.white(' ' + code.trim() + ' ') + '\n';
    })

    // Links: show both text and URL
    .replace(/<a href="([^"]+)">(.*?)<\/a>/gi, (_m: string, href: string, text: string) => {
      return chalk.blue.underline(text) + ' ' + chalk.gray('(' + href + ')');
    })

    // Lists
    .replace(/<ul>/gi, '')
    .replace(/<\/ul>/gi, '')
    .replace(/<ol>/gi, '')
    .replace(/<\/ol>/gi, '')
    .replace(/<li>(.*?)<\/li>/gi, '  • $1\n')

    // Paragraphs
    .replace(/<p>(.*?)<\/p>/gi, '$1\n')

    // Line breaks
    .replace(/<br\s*\/?>(?!\n)/gi, '\n')

    // Clean up remaining HTML tags
    .replace(/<\/?[^>]+(>|$)/g, '')

    // Normalize whitespace and line breaks
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

// Get streaming delay from environment or use default
const STREAMING_DELAY_MS = parseInt(process.env.CLI_STREAMING_DELAY_MS || '2');

async function streamText(text: string, delayMs = STREAMING_DELAY_MS) {
  for (const char of text) {
    process.stdout.write(char);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

class Spinner {
  private readonly frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private readonly stageOrder: PipelineStageKey[] = [
    'guard',
    'parse',
    'context',
    'plan',
    'tool',
    'web-search',
    'compose',
    'verify',
    'finalize',
  ];
  private readonly stageLabels: Record<PipelineStageKey, string> = {
    guard: 'Running safety checks...',
    parse: 'Parsing your request...',
    context: 'Retrieving recent context...',
    plan: 'Planning next steps...',
    tool: 'Gathering data from tools...',
    'web-search': 'Searching the web...',
    compose: 'Drafting your answer...',
    verify: 'Verifying answer quality...',
    finalize: 'Finalizing recommendations...',
  };
  private interval: NodeJS.Timeout | null = null;
  private currentFrame = 0;
  private currentStage: PipelineStageKey = 'guard';
  private customStatus: string | null = null;
  private customStatusTime = 0;
  private readonly CUSTOM_STATUS_TIMEOUT = 3000; // 3 seconds

  start() {
    this.currentFrame = 0;
    this.customStatus = null;
    this.customStatusTime = 0;
    this.currentStage = 'guard';
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => {
      const displayStatus = this.getCurrentDisplayStatus();
      const frame = chalk.yellow(this.frames[this.currentFrame]);
      const text = chalk.gray(displayStatus);
      process.stdout.write(`\r\x1b[2K${frame} ${text}`);
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
    }, 80);
  }

  handlePipelineUpdate(update: PipelineStatusUpdate | string) {
    if (typeof update === 'string') {
      this.setStatus(update);
      return;
    }
    if (update.stage) this.setStage(update.stage);
    if (update.message) this.setStatus(update.message);
  }

  private setStage(stage: PipelineStageKey) {
    if (this.stageOrder.includes(stage)) {
      this.currentStage = stage;
      if (this.interval && !this.customStatus) {
        const frame = chalk.yellow(this.frames[this.currentFrame]);
        const text = chalk.gray(this.getStageStatus());
        process.stdout.write(`\r\x1b[2K${frame} ${text}`);
      }
    }
  }

  private setStatus(status: string) {
    const newStatus = status || 'Processing...';
    this.customStatus = newStatus;
    this.customStatusTime = Date.now();
    if (this.interval) {
      const frame = chalk.yellow(this.frames[this.currentFrame]);
      const text = chalk.gray(newStatus);
      process.stdout.write(`\r\x1b[2K${frame} ${text}`);
    }
  }

  private getStageStatus(): string {
    return this.stageLabels[this.currentStage] || 'Processing...';
  }

  private getCurrentDisplayStatus(): string {
    if (this.customStatus && Date.now() - this.customStatusTime < this.CUSTOM_STATUS_TIMEOUT) {
      return this.customStatus;
    }
    if (this.customStatus) {
      this.customStatus = null;
    }
    return this.getStageStatus();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      this.customStatus = null;
      this.customStatusTime = 0;
      process.stdout.write('\r'.padEnd(50, ' ') + '\r');
    }
    this.currentStage = 'guard';
  }
}

async function main() {
  // Log startup information for debugging
  log.debug({ logLevel: process.env.LOG_LEVEL || 'error' }, 'CLI starting with log level');
  // Suppress noisy third‑party logs (e.g., Transformers dtype warnings) for non‑debug levels
  silenceNoisyLibLogs(process.env.LOG_LEVEL);
  
  // Clear any existing context from previous sessions
  try {
    await clearThreadSlots(threadId);
    log.debug({ threadId }, 'Cleared previous session context');
  } catch (error) {
    log.debug({ error }, 'Failed to clear previous context (continuing anyway)');
  }
  
  // Display banner and intro
  console.log(chalk.cyan(`
██╗   ██╗ ██████╗ ██╗   ██╗ █████╗ ███╗   ██╗████████╗
██║   ██║██╔═══██╗╚██╗ ██╔╝██╔══██╗████╗  ██║╚══██╔══╝
██║   ██║██║   ██║ ╚████╔╝ ███████║██╔██╗ ██║   ██║
╚██╗ ██╔╝██║   ██║  ╚██╔╝  ██╔══██║██║╚██╗██║   ██║
 ╚████╔╝ ╚██████╔╝   ██║   ██║  ██║██║ ╚████║   ██║
  ╚═══╝   ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝

`));
  console.log(chalk.yellow.bold('✈️  VOYANT Travel Agent CLI'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.white('Ask travel questions. I answer in concise English.'));
  console.log(chalk.gray('You can ask in any language; I will reply in English.'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.white.bold('What I can help with:'));
  console.log(chalk.green('  • Weather — "Weather in London this week?"'));
  console.log(chalk.green('  • Packing — "What to pack for Tokyo in March?"'));
  console.log(chalk.green('  • Attractions — "Kid‑friendly things to do in SF in late Aug"'));
  console.log(chalk.green('  • Destinations — "Where to go from Tel Aviv in August?"'));
  console.log(chalk.green('  • Flights — "Flights from NYC to London March 15" (live search via Amadeus)'));
  console.log(chalk.green('  • Policies (RAG) — "United baggage allowance", "Marriott cancellation"'));
  console.log(chalk.green('    and visas — "Do I need a visa for Japan with a US passport?"'));
  console.log(chalk.green('  • Web search on consent — events, flights, live info'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.white.bold('How to ask:'));
  console.log(chalk.white('  • Include city and month/dates when possible.'));
  console.log(chalk.white('  • I may ask to use web search or deep research — reply "yes" to proceed.'));
  console.log(chalk.white('  • I avoid prices/budgeting; I can still suggest options.'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.white.bold('Commands:'));
  console.log(chalk.blue('  /why   Show how I got my answer (sources, reasoning, fact-checking)'));
  console.log(chalk.red('  exit   Quit'));
  console.log(chalk.gray('─'.repeat(60)));
  // console.log(chalk.white.bold('Environment Variables:'));
  // console.log(chalk.yellow('  CLI_STREAMING_DELAY_MS  Set text streaming delay (default: 2ms)'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log();

  log.debug('CLI started. Type "exit" to quit.');
  const spinner = new Spinner();

  while (true) {
    const q = await rl.question(chalk.blue.bold('You> '));
    if (q.trim().toLowerCase() === 'exit') break;

    // Check rate limit
    if (!(await cliRateLimiter.acquire())) {
      console.log(chalk.red('⚠️  Rate limit exceeded. Please wait a moment before trying again.'));
      continue;
    }

    log.debug({ message: q, threadId }, 'Processing user message');
    
    spinner.start();
    spinner.handlePipelineUpdate({
      stage: 'guard',
      message: 'Running safety checks before planning...'
    });
    const t0 = Date.now();
    const wantReceipts = /^\s*\/why\b/i.test(q);
    
    try {
      // Count CLI messages to include in dashboard via push-ingest (if configured)
      incMessages();
      const res = await handleChat(
        { message: q, threadId, receipts: wantReceipts }, 
        { 
          log,
          onStatus: (update) => spinner.handlePipelineUpdate(update)
        }
      );
      // e2e latency (best-effort)
      try { observeE2E(Date.now() - t0); } catch {}
      spinner.stop();

      // Update threadId if returned
      if (res.threadId && res.threadId !== threadId) {
        threadId = res.threadId;
      }

      log.debug({ threadId, responseThreadId: res.threadId }, 'cli_thread_debug');

      process.stdout.write(chalk.green.bold('Assistant> '));
      let outputText = res.reply;
      
      // Only append receipts if this isn't a /why command (which already includes receipts in reply)
      if (res.receipts && !wantReceipts) {
        outputText += '\n\n--- RECEIPTS ---\n';
        outputText += `Sources: ${(res.sources || []).join(', ')}\n`;
        outputText += `Decisions: ${res.receipts.decisions.map(d => {
          if (typeof d === 'string') return d;
          return `${d.action} (rationale: ${d.rationale}${d.alternatives ? `, alternatives: ${d.alternatives.join(', ')}` : ''}${d.confidence ? `, confidence: ${d.confidence}` : ''})`;
        }).join(' ')}\n`;
        outputText += `Self-Check: ${res.receipts.selfCheck.verdict}`;
        if (res.receipts.selfCheck.notes.length > 0) {
          outputText += ` (${res.receipts.selfCheck.notes.join(', ')})`;
        }
        outputText += '\n';
        outputText += `Budget: ${res.receipts.budgets.ext_api_latency_ms || 0}ms API, ~${res.receipts.budgets.token_estimate || 0} tokens`;
      }
      const renderedReply = renderMarkdownToTerminal(outputText);
      await streamText(renderedReply);
      console.log(); // new line after completion
    } catch (error) {
      spinner.stop();
      console.log(chalk.red('❌ Error processing request:', error instanceof Error ? error.message : String(error)));
    } finally {
      // Release rate limiter
      cliRateLimiter.release();
    }
  }
  rl.close();
}

main().catch((e) => (console.error(e), process.exit(1)));
