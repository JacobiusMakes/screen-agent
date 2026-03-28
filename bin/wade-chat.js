#!/usr/bin/env node

/**
 * WADE Chat — Natural language terminal REPL for screen control
 *
 * Talk to your screen in plain English. Wade sees what's on screen
 * and executes actions (click, type, scroll) on your behalf.
 *
 * Uses Claude Code's existing auth by default (no API key needed).
 * Falls back to direct Anthropic API if ANTHROPIC_API_KEY is set.
 *
 * Usage:
 *   npm run chat                              # uses claude CLI auth
 *   wade chat                         # same
 *   ANTHROPIC_API_KEY=... npm run chat        # direct API mode
 *
 * Special commands:
 *   /state      — Print current screen state
 *   /budget     — Show token budget/costs
 *   /screenshot — Save screenshot to file
 *   /quit       — Exit
 */

import readline from 'node:readline';
import { spawn, execSync } from 'node:child_process';
import { captureAmbient, captureState, captureScreenshot } from '../src/capture/bridge.js';
import { TokenBudget } from '../src/budget/token-budget.js';

// ============================================================
//  Config
// ============================================================

const BUDGET_PRESET = process.env.SCREEN_AGENT_BUDGET || 'normal';
const budget = new TokenBudget({ budget: BUDGET_PRESET, model: 'claude-sonnet' });

// Plan-based usage tracking
const PLANS = {
  pro:     { name: 'Pro',      monthly: 20 },
  max5x:   { name: 'Max 5x',   monthly: 100 },
  max20x:  { name: 'Max 20x',  monthly: 200 },
  team:    { name: 'Team',     monthly: 30 },
  api:     { name: 'API',      monthly: Infinity },
};

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'screen-agent');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  } catch {}
}

async function detectOrAskPlan(rl) {
  // 1. Env var override
  if (process.env.SCREEN_AGENT_PLAN) {
    return PLANS[process.env.SCREEN_AGENT_PLAN.toLowerCase()] || PLANS.max5x;
  }

  // 2. Cached from previous session
  const cfg = loadConfig();
  if (cfg.plan && PLANS[cfg.plan]) {
    return PLANS[cfg.plan];
  }

  // 3. Ask user on first run
  console.log(`${c.bold}First run — which Claude plan are you on?${c.reset}`);
  console.log(`  1) Pro       ($20/mo)`);
  console.log(`  2) Max 5x    ($100/mo)`);
  console.log(`  3) Max 20x   ($200/mo)`);
  console.log(`  4) Team      ($30/mo)`);
  console.log(`  5) API       (pay-per-use)`);

  const answer = await new Promise((resolve) => {
    rl.question(`${c.dim}Enter 1-5 [default: 2]: ${c.reset}`, (ans) => {
      resolve(ans.trim() || '2');
    });
  });

  const planMap = { '1': 'pro', '2': 'max5x', '3': 'max20x', '4': 'team', '5': 'api' };
  const picked = planMap[answer] || 'max5x';

  // Cache for next time
  saveConfig({ ...cfg, plan: picked });
  console.log(`${c.green}Saved: ${PLANS[picked].name}. Change anytime with SCREEN_AGENT_PLAN env or delete ${CONFIG_PATH}${c.reset}\n`);

  return PLANS[picked];
}

let plan = PLANS.max5x; // placeholder until detected
let sessionCost = 0;

function formatUsage(cost) {
  sessionCost += cost;
  if (plan.monthly === Infinity) {
    return `$${cost.toFixed(4)} | session: $${sessionCost.toFixed(4)}`;
  }
  const daily = plan.monthly / 30;
  const pctDaily = (sessionCost / daily) * 100;
  const pctMonthly = (sessionCost / plan.monthly) * 100;
  if (pctDaily < 0.01) {
    return `$${cost.toFixed(4)} | session: $${sessionCost.toFixed(4)} (<0.01% daily ${plan.name})`;
  }
  return `$${cost.toFixed(4)} | session: $${sessionCost.toFixed(4)} (${pctDaily.toFixed(2)}% daily / ${pctMonthly.toFixed(3)}% monthly ${plan.name})`;
}

// Detect mode: prefer Claude CLI (native auth), fall back to direct API
const API_KEY = process.env.ANTHROPIC_API_KEY;
let useClaudeCLI = false;
let claudePath = null;

// Always try CLI first — it uses existing Claude Code subscription
try {
  claudePath = execSync('which claude', { encoding: 'utf-8', timeout: 3000 }).trim();
  useClaudeCLI = true;
} catch {
  // CLI not found — need API key
  if (!API_KEY) {
    console.error('\x1b[31mError: `claude` CLI not found and no ANTHROPIC_API_KEY set.\x1b[0m');
    console.error('Either install Claude Code or set ANTHROPIC_API_KEY.');
    process.exit(1);
  }
}

// Direct API client (lazy-loaded only if needed)
let anthropicClient = null;
let TOOLS = null;
let handlers = null;

async function initDirectAPI() {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const { TOOLS: T, createToolHandlers } = await import('../src/tools/handlers.js');
  const { SessionMemory } = await import('../src/state/session-memory.js');
  const { DiffEngine } = await import('../src/state/diff-engine.js');

  anthropicClient = new Anthropic({ apiKey: API_KEY });
  TOOLS = T;
  handlers = createToolHandlers({
    memory: new SessionMemory({ maxEntries: 500 }),
    diffEngine: new DiffEngine(),
    budget,
  });
}

// ============================================================
//  ANSI Colors
// ============================================================

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
  magenta: '\x1b[35m',
};

// ============================================================
//  Screen Agent System Prompt (prepended to each CLI invocation)
// ============================================================

const AGENT_CONTEXT = `You are Wade — Watchful Autonomous Decision Entity. You operate using the WADE Protocol:

1. WATCH — Observe screen state. Use get_ambient for quick checks, get_screen_state for detail, take_screenshot only when you need visual context. Capture the minimum necessary.
2. ASSESS — Determine what's relevant. Filter signal from noise. Don't process everything — decide when to dive in.
3. DECIDE — Select the optimal action. Minimize compute and tokens. Plan your interaction (click, type, scroll, etc.)
4. EXECUTE — Perform the action decisively. Feed the result back into the loop.

You have full control of the user's macOS screen via MCP tools. Be concise — the user can see what's happening. Wade doesn't see everything. It sees what matters.`;

// ============================================================
//  Chat via Claude CLI (native auth)
// ============================================================

function chatViaCLI(userMessage) {
  return new Promise((resolve) => {
    // Build the prompt with screen agent context
    const fullPrompt = `${AGENT_CONTEXT}\n\nUser request: ${userMessage}`;

    const args = [
      '-p', fullPrompt,
      '--output-format', 'json',
      '--model', process.env.SCREEN_AGENT_CHAT_MODEL || 'claude-sonnet-4-6',
    ];

    // Restrict to screen-agent tools only (no file editing, no bash)
    args.push('--allowedTools', 'mcp__screen-agent__*');

    const proc = spawn(claudePath || 'claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],  // /dev/null for stdin
      env: { ...process.env },
    });

    let stdout = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      // Show tool use progress from stderr (claude CLI logs tool calls there)
      if (text && !text.includes('Compiling') && !text.includes('warning:')) {
        process.stderr.write(`${c.dim}${text}${c.reset}\n`);
      }
    });

    proc.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        console.error(`${c.red}claude exited with code ${code}${c.reset}`);
        resolve();
        return;
      }

      // Parse JSON response
      try {
        const response = JSON.parse(stdout);
        // response.result is the text output from claude -p --output-format json
        const text = response.result || response.content || stdout;
        if (typeof text === 'string') {
          process.stdout.write(`${c.cyan}${text}${c.reset}\n`);
        } else if (Array.isArray(text)) {
          // Content blocks array
          for (const block of text) {
            if (block.type === 'text') {
              process.stdout.write(`${c.cyan}${block.text}${c.reset}`);
            } else if (block.type === 'tool_use') {
              const argsStr = Object.keys(block.input || {}).length > 0
                ? ` ${JSON.stringify(block.input)}`
                : '';
              process.stdout.write(`${c.yellow}  [${block.name}${argsStr}]${c.reset}\n`);
            }
          }
          process.stdout.write('\n');
        } else {
          process.stdout.write(`${c.cyan}${JSON.stringify(text)}${c.reset}\n`);
        }

        // Use actual cost from Claude CLI (more accurate than token math)
        const actualCost = response.total_cost_usd || 0;
        if (actualCost > 0) {
          const turns = response.num_turns || 1;
          console.log(`${c.dim}  [${turns} turn${turns > 1 ? 's' : ''} | ${formatUsage(actualCost)}]${c.reset}`);
        } else if (response.usage) {
          const inp = response.usage.input_tokens || 0;
          const out = response.usage.output_tokens || 0;
          const cost = (inp * 3 + out * 15) / 1_000_000;
          console.log(`${c.dim}  [${inp} in + ${out} out | ${formatUsage(cost)}]${c.reset}`);
        }
      } catch {
        // Not JSON — print raw text
        if (stdout.trim()) {
          process.stdout.write(`${c.cyan}${stdout.trim()}${c.reset}\n`);
        }
      }
      resolve();
    });

    proc.on('error', (err) => {
      console.error(`${c.red}Failed to spawn claude: ${err.message}${c.reset}`);
      resolve();
    });
  });
}

// ============================================================
//  Chat via Direct API (fallback with ANTHROPIC_API_KEY)
// ============================================================

const directMessages = [];

async function chatViaAPI(userMessage) {
  if (!anthropicClient) await initDirectAPI();

  const MODEL = process.env.SCREEN_AGENT_CHAT_MODEL || 'claude-sonnet-4-20250514';

  // Inject ambient context
  let contextPrefix = '';
  try {
    const ambient = await captureAmbient();
    if (ambient) {
      contextPrefix = `[Current screen: ${ambient.app} — "${ambient.title || '(untitled)'}" | Cursor at (${ambient.cursor?.join(',') || '?'})]\n\n`;
    }
  } catch {}

  directMessages.push({ role: 'user', content: contextPrefix + userMessage });

  const apiTools = TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  let totalIn = 0, totalOut = 0;

  // Agentic loop (capped at 20 iterations to prevent runaway)
  const MAX_ITERATIONS = 20;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    process.stdout.write(c.cyan);

    let response;
    try {
      response = await anthropicClient.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: AGENT_CONTEXT,
        tools: apiTools,
        messages: directMessages,
      });
    } catch (err) {
      process.stdout.write(c.reset);
      console.error(`\n${c.red}API Error: ${err.message}${c.reset}`);
      directMessages.pop();
      return;
    }

    totalIn += response.usage?.input_tokens || 0;
    totalOut += response.usage?.output_tokens || 0;

    const assistantContent = [];
    let hasToolUse = false;

    for (const block of response.content) {
      assistantContent.push(block);
      if (block.type === 'text') {
        process.stdout.write(block.text);
      } else if (block.type === 'tool_use') {
        hasToolUse = true;
        const argsStr = Object.keys(block.input).length > 0 ? ` ${JSON.stringify(block.input)}` : '';
        process.stdout.write(`${c.reset}${c.yellow}  [${block.name}${argsStr}]${c.cyan}`);
      }
    }

    process.stdout.write(c.reset + '\n');
    directMessages.push({ role: 'assistant', content: assistantContent });

    if (!hasToolUse || response.stop_reason !== 'tool_use') break;

    // Execute tools
    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type !== 'tool_use') continue;
      const handler = handlers[block.name];
      let result;
      try {
        result = handler ? await handler(block.input || {}) : `Unknown tool: ${block.name}`;
      } catch (err) {
        result = `Error: ${err.message}`;
      }

      if (result && typeof result === 'object' && result.type === 'image') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: result.mimeType, data: result.data },
          }],
        });
      } else {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
    }

    directMessages.push({ role: 'user', content: toolResults });
  }

  budget.totalInputTokens += totalIn;
  budget.totalOutputTokens += totalOut;
  const cost = (totalIn * 3 + totalOut * 15) / 1_000_000;
  console.log(`${c.dim}  [${totalIn} in + ${totalOut} out | ${formatUsage(cost)}]${c.reset}`);
}

// ============================================================
//  Unified chat function
// ============================================================

async function chat(userMessage) {
  if (useClaudeCLI) {
    await chatViaCLI(userMessage);
  } else {
    await chatViaAPI(userMessage);
  }
}

// ============================================================
//  Special Commands
// ============================================================

async function handleSpecialCommand(input) {
  const cmd = input.trim().toLowerCase();

  if (cmd === '/state') {
    const state = await captureState();
    if (state) {
      console.log(JSON.stringify(state, null, 2));
    } else {
      console.error('Could not capture screen state.');
    }
    return true;
  }

  if (cmd === '/budget') {
    const stats = budget.getStats();
    console.log(`${c.green}Budget: ${stats.preset} ($${stats.budget.maxPerHour === Infinity ? '∞' : stats.budget.maxPerHour.toFixed(2)}/hr)${c.reset}`);
    console.log(`This hour: $${stats.budget.currentHourlyCost.toFixed(4)}`);
    console.log(`Session: $${stats.session.totalCost.toFixed(4)} | ${stats.session.totalInputTokens} in + ${stats.session.totalOutputTokens} out`);
    return true;
  }

  if (cmd === '/screenshot') {
    const path = await captureScreenshot();
    if (path) {
      console.log(`${c.green}Screenshot saved: ${path}${c.reset}`);
    } else {
      console.error('Screenshot failed.');
    }
    return true;
  }

  if (cmd === '/quit' || cmd === '/exit' || cmd === '/q') {
    console.log(`${c.dim}Goodbye.${c.reset}`);
    process.exit(0);
  }

  if (cmd === '/help') {
    console.log(`${c.bold}Commands:${c.reset}`);
    console.log('  /state       Print current screen state (JSON)');
    console.log('  /budget      Show token budget and costs');
    console.log('  /screenshot  Save screenshot to file');
    console.log('  /quit        Exit');
    console.log('');
    console.log('Anything else is sent as natural language to Claude.');
    return true;
  }

  return false;
}

// ============================================================
//  REPL
// ============================================================

async function main() {
  // Welcome banner
  let appName = 'your screen';
  try {
    const ambient = await captureAmbient();
    if (ambient) appName = `${ambient.app} — "${ambient.title || ''}"`;
  } catch {}

  const mode = useClaudeCLI ? 'Claude Code (native auth)' : 'Direct API';

  console.log(`${c.bold}${c.magenta}wade chat${c.reset}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.bold}> ${c.reset}`,
    historySize: 100,
  });

  // Detect plan (asks on first run, caches for future)
  plan = await detectOrAskPlan(rl);

  const planLabel = plan.monthly === Infinity ? plan.name : `${plan.name} ($${plan.monthly}/mo)`;
  console.log(`${c.dim}Mode: ${mode} | Plan: ${planLabel} | Budget: ${BUDGET_PRESET}${c.reset}`);
  console.log(`${c.dim}Currently viewing: ${appName}${c.reset}`);
  console.log(`${c.dim}Type /help for commands, Ctrl+D to exit${c.reset}`);
  console.log('');

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith('/')) {
      const handled = await handleSpecialCommand(input);
      if (handled) {
        rl.prompt();
        return;
      }
    }

    await chat(input);
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(`\n${c.dim}Goodbye.${c.reset}`);
    process.exit(0);
  });

  rl.on('SIGINT', () => {
    console.log(`\n${c.dim}(Ctrl+C — use /quit or Ctrl+D to exit)${c.reset}`);
    rl.prompt();
  });
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
