#!/usr/bin/env node

/**
 * screen-agent MCP Server
 *
 * Exposes screen understanding as MCP tools that Claude Code (or any
 * MCP-compatible AI) can call directly. This is the bridge between
 * "AI that reads text" and "AI that sees your screen."
 *
 * Tools provided:
 *   - get_screen_state: Get current screen state (app, window, UI elements)
 *   - get_ambient: Lightweight state (just app name + title, ~5 tokens)
 *   - take_screenshot: Capture screenshot, return as base64 for vision
 *   - get_screenshot_path: Capture screenshot, return file path
 *   - estimate_tokens: Show token cost for current screen state
 *
 * Start: node src/mcp-server.js (uses stdio transport)
 * Configure in Claude Code: add to .claude/settings.json mcpServers
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { captureState, captureAmbient, captureScreenshot, captureScreenshotBase64 } from './capture/bridge.js';
import { moveCursor, click, typeText, keyPress, scroll, getCapabilities, getActionLog } from './input/injector.js';
import { SessionMemory } from './state/session-memory.js';
import { DiffEngine } from './state/diff-engine.js';
import { TokenBudget, getBudgetPresets } from './budget/token-budget.js';

// Session-level instances
const memory = new SessionMemory({ maxEntries: 500 });
const diffEngine = new DiffEngine();
const budget = new TokenBudget({
  budget: process.env.SCREEN_AGENT_BUDGET || 'normal',
  model: process.env.SCREEN_AGENT_MODEL || 'claude-sonnet',
});

// ============================================================
//  Tool Definitions
// ============================================================

const TOOLS = [
  {
    name: "get_screen_state",
    description: "Get the current screen state including frontmost app, window title, and UI elements from the accessibility tree. Returns structured JSON optimized for token efficiency (~100-300 tokens). Use this to understand what the user is looking at.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_ambient",
    description: "Get lightweight ambient screen state: just the app name, window title, and cursor position. Costs ~5 tokens. Use this for quick context checks.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "take_screenshot",
    description: "Capture a full screenshot of the screen and return it as a base64-encoded JPEG image. More expensive (~1200 tokens) but gives full visual context. Use when you need to see something the accessibility tree can't capture (images, PDFs, canvas, visual layout).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_screenshot_path",
    description: "Capture a screenshot and save it to a file. Returns the file path. Use this when you want to reference the screenshot later or pass it to another tool.",
    inputSchema: {
      type: "object",
      properties: {
        output: {
          type: "string",
          description: "Output file path (optional, defaults to temp file)",
        },
      },
    },
  },
  {
    name: "estimate_tokens",
    description: "Estimate how many tokens the current screen state would cost to send to an LLM. Useful for cost awareness.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  // ── Input Tools ──
  {
    name: "move_cursor",
    description: "Move the mouse cursor to a screen position. The user will see the cursor move.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate (pixels from left)" },
        y: { type: "number", description: "Y coordinate (pixels from top)" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "click",
    description: "Click at a screen position. Moves cursor there first. Use 'left' for normal click, 'right' for context menu, 'double' for double-click.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate" },
        y: { type: "number", description: "Y coordinate" },
        button: { type: "string", enum: ["left", "right", "double"], description: "Click type (default: left)" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "type_text",
    description: "Type text at the current cursor position, as if typed on the keyboard.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type" },
      },
      required: ["text"],
    },
  },
  {
    name: "key_press",
    description: "Press a keyboard shortcut. Format: 'cmd+s', 'ctrl+shift+p', 'enter', 'tab', 'escape'.",
    inputSchema: {
      type: "object",
      properties: {
        keys: { type: "string", description: "Key combo (e.g. 'cmd+s', 'enter', 'ctrl+shift+p')" },
      },
      required: ["keys"],
    },
  },
  {
    name: "scroll",
    description: "Scroll at the current cursor position.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction" },
        amount: { type: "number", description: "Scroll amount in lines (default: 3)" },
      },
      required: ["direction"],
    },
  },
  // ── Memory Tools ──
  {
    name: "recall_screen",
    description: "Search session memory for past screen states matching a query. Returns what was on screen at relevant moments. Example: 'the error message from earlier' or 'when I was in Settings'.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for in screen history" },
        limit: { type: "number", description: "Max results (default: 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_recent_screens",
    description: "Get the last N screen states from session memory. Useful for understanding recent context.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of recent states (default: 5)" },
      },
    },
  },
  {
    name: "get_session_stats",
    description: "Get stats about the current screen-agent session: memory entries, unique apps visited, session duration.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  // ── Budget Tools ──
  {
    name: "get_budget",
    description: "Get token budget status: cost so far, hourly spend rate, remaining budget, recommended capture mode. Use before expensive operations to check if you can afford a screenshot.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "set_budget",
    description: "Change the token budget preset. Options: 'frugal' ($0.05/hr, ambient only), 'normal' ($0.20/hr, balanced), 'rich' ($1/hr, frequent screenshots), 'unlimited'.",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["frugal", "normal", "rich", "unlimited"], description: "Budget preset" },
      },
      required: ["preset"],
    },
  },
];

// ============================================================
//  Tool Handlers
// ============================================================

async function handleGetScreenState() {
  const state = await captureState();
  if (!state) {
    return "Error: Could not capture screen state. Check Accessibility permissions.";
  }
  // Auto-record to session memory + budget
  memory.record(state);
  budget.recordCapture('structural');
  // Use diff engine for efficient updates
  const update = diffEngine.computeUpdate(state);
  return JSON.stringify(update || state, null, 2);
}

async function handleGetAmbient() {
  const state = await captureAmbient();
  if (!state) {
    return "Error: Could not capture ambient state.";
  }
  return JSON.stringify(state);
}

async function handleTakeScreenshot() {
  // Use budget-recommended quality
  const mode = budget.getRecommendedMode();
  if (!mode.screenshotQuality) {
    return "Budget exceeded — screenshots disabled. Use get_screen_state for text-only state, or set_budget to increase limit.";
  }
  const result = await captureScreenshotBase64(mode.screenshotQuality);
  budget.recordScreenshot(mode.screenshotQuality);
  if (!result) {
    return "Error: Screenshot failed. Check Screen Recording permissions.";
  }

  // Return as image content for vision models
  return {
    type: "image",
    data: result.image,
    mimeType: "image/jpeg",
  };
}

async function handleGetScreenshotPath(args) {
  const path = await captureScreenshot(args?.output);
  if (!path) {
    return "Error: Screenshot failed.";
  }
  return `Screenshot saved to: ${path}`;
}

async function handleEstimateTokens() {
  const state = await captureState();
  if (!state) {
    return "Error: Could not capture state.";
  }

  const json = JSON.stringify(state);
  const estimatedTokens = Math.ceil(json.length / 4);

  return [
    `App: ${state.app}`,
    `Window: ${state.title || "(none)"}`,
    `Elements: ${state.elements?.length || 0}`,
    `State size: ${json.length} chars`,
    `Estimated tokens: ~${estimatedTokens}`,
    ``,
    `Cost per capture (Sonnet @ $3/M): $${(estimatedTokens * 3 / 1000000).toFixed(6)}`,
    `Cost per hour (30s interval): $${(estimatedTokens * 120 * 3 / 1000000).toFixed(4)}`,
  ].join('\n');
}

// ── Input Handlers ──

async function handleMoveCursor(args) {
  const result = await moveCursor(args.x, args.y);
  return result.success ? `Cursor moved to (${args.x}, ${args.y})` : `Failed: ${result.error}`;
}

async function handleClick(args) {
  const result = await click(args.x, args.y, args.button || 'left');
  return result.success ? `Clicked ${args.button || 'left'} at (${args.x}, ${args.y})` : `Failed: ${result.error}`;
}

async function handleTypeText(args) {
  const result = await typeText(args.text);
  return result.success ? `Typed ${result.length} characters` : `Failed: ${result.error}`;
}

async function handleKeyPress(args) {
  const result = await keyPress(args.keys);
  return result.success ? `Pressed ${args.keys}` : `Failed: ${result.error}`;
}

async function handleScroll(args) {
  const result = await scroll(args.direction, args.amount || 3);
  return result.success ? `Scrolled ${args.direction} ${args.amount || 3} lines` : `Failed: ${result.error}`;
}

// ── Memory Handlers ──

async function handleRecallScreen(args) {
  const results = memory.search(args.query, args.limit || 5);
  if (results.length === 0) return `No matching screen states found for "${args.query}"`;

  return results.map(r => {
    const ago = Math.round((Date.now() - r.ts) / 1000);
    return `[${ago}s ago] ${r.state.app} — ${r.state.title || '(no title)'}\n  Score: ${r.score.toFixed(3)}\n  ${r.text.substring(0, 200)}`;
  }).join('\n\n');
}

async function handleGetRecentScreens(args) {
  const recent = memory.getRecent(args?.count || 5);
  if (recent.length === 0) return 'No screen states recorded yet.';

  return recent.map(r => {
    const ago = Math.round((Date.now() - r.ts) / 1000);
    return `[${ago}s ago] ${r.state.app} — ${r.state.title || '(no title)'}`;
  }).join('\n');
}

async function handleGetSessionStats() {
  const stats = memory.getStats();
  const caps = getCapabilities();
  const log = getActionLog();

  return [
    `Session Memory: ${stats.entries} states recorded`,
    `Max capacity: ${stats.maxEntries}`,
    stats.oldestMs ? `Oldest: ${Math.round(stats.oldestMs / 1000)}s ago` : 'No data yet',
    `Apps visited: ${stats.uniqueApps.join(', ') || 'none'}`,
    ``,
    `Input backend: ${caps.backend}`,
    `Actions taken this session: ${log.length}`,
    `Last action: ${log.length > 0 ? log[log.length-1].action : 'none'}`,
  ].join('\n');
}

// ── Budget Handlers ──

async function handleGetBudget() {
  const stats = budget.getStats();
  const lines = [
    `Budget: ${stats.preset} ($${stats.budget.maxPerHour === Infinity ? '∞' : stats.budget.maxPerHour.toFixed(2)}/hr)`,
    `Model: ${stats.model} ($${stats.pricePerMillion}/M tokens)`,
    ``,
    `This hour: $${stats.budget.currentHourlyCost.toFixed(4)} / $${stats.budget.maxPerHour === Infinity ? '∞' : stats.budget.maxPerHour.toFixed(2)} (${stats.budget.percentUsed}%)`,
    `Session total: $${stats.session.totalCost.toFixed(4)} over ${stats.session.durationMinutes} min`,
    `Captures: ${stats.session.captures} | Screenshots: ${stats.session.screenshots}`,
    `Tokens: ${stats.session.totalInputTokens} input + ${stats.session.totalOutputTokens} output`,
    ``,
    `Recommended mode: ${stats.recommended.capture}`,
    `Screenshot quality: ${stats.recommended.screenshotQuality || 'DISABLED'}`,
    `Capture interval: ${stats.recommended.interval / 1000}s`,
    stats.recommended.warning ? `⚠ ${stats.recommended.warning}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

async function handleSetBudget(args) {
  const newBudget = new TokenBudget({
    budget: args.preset,
    model: budget.model,
  });
  // Preserve session history
  newBudget.totalInputTokens = budget.totalInputTokens;
  newBudget.totalOutputTokens = budget.totalOutputTokens;
  newBudget.captures = budget.captures;
  newBudget.screenshots = budget.screenshots;
  newBudget.hourlyWindow = budget.hourlyWindow;
  newBudget.sessionStart = budget.sessionStart;
  Object.assign(budget, newBudget);
  return `Budget changed to ${args.preset} ($${budget.preset.maxPerHour === Infinity ? '∞' : budget.preset.maxPerHour.toFixed(2)}/hr)`;
}

const TOOL_HANDLERS = {
  get_screen_state: handleGetScreenState,
  get_ambient: handleGetAmbient,
  take_screenshot: handleTakeScreenshot,
  get_screenshot_path: handleGetScreenshotPath,
  estimate_tokens: handleEstimateTokens,
  move_cursor: handleMoveCursor,
  click: handleClick,
  type_text: handleTypeText,
  key_press: handleKeyPress,
  scroll: handleScroll,
  recall_screen: handleRecallScreen,
  get_recent_screens: handleGetRecentScreens,
  get_session_stats: handleGetSessionStats,
  get_budget: handleGetBudget,
  set_budget: handleSetBudget,
};

// ============================================================
//  MCP Server Setup
// ============================================================

const server = new Server(
  { name: "screen-agent", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = TOOL_HANDLERS[name];

  if (!handler) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    const result = await handler(args || {});

    // Handle image results (screenshots)
    if (result && typeof result === 'object' && result.type === 'image') {
      return {
        content: [
          {
            type: "image",
            data: result.data,
            mimeType: result.mimeType,
          },
        ],
      };
    }

    // Text results
    return {
      content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// ============================================================
//  Start
// ============================================================

const transport = new StdioServerTransport();
await server.connect(transport);
