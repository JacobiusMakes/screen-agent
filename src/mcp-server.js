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
];

// ============================================================
//  Tool Handlers
// ============================================================

async function handleGetScreenState() {
  const state = await captureState();
  if (!state) {
    return "Error: Could not capture screen state. Check Accessibility permissions.";
  }
  return JSON.stringify(state, null, 2);
}

async function handleGetAmbient() {
  const state = await captureAmbient();
  if (!state) {
    return "Error: Could not capture ambient state.";
  }
  return JSON.stringify(state);
}

async function handleTakeScreenshot() {
  const result = await captureScreenshotBase64();
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

const TOOL_HANDLERS = {
  get_screen_state: handleGetScreenState,
  get_ambient: handleGetAmbient,
  take_screenshot: handleTakeScreenshot,
  get_screenshot_path: handleGetScreenshotPath,
  estimate_tokens: handleEstimateTokens,
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
