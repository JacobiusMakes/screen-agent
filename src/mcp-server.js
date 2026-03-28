#!/usr/bin/env node

/**
 * WADE MCP Server — Watchful Autonomous Decision Entity
 *
 * Exposes the WADE Protocol (Watch → Assess → Decide → Execute) as MCP
 * tools that Claude Code (or any MCP-compatible AI) can call directly.
 *
 * Wade doesn't see everything. It sees what matters.
 *
 * Start: node src/mcp-server.js (uses stdio transport)
 * Configure in Claude Code: add to .mcp.json mcpServers
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SessionMemory } from './state/session-memory.js';
import { DiffEngine } from './state/diff-engine.js';
import { TokenBudget } from './budget/token-budget.js';
import { TOOLS, createToolHandlers } from './tools/handlers.js';

// Session-level instances
const memory = new SessionMemory({ maxEntries: 500 });
const diffEngine = new DiffEngine();
const budget = new TokenBudget({
  budget: process.env.SCREEN_AGENT_BUDGET || 'normal',
  model: process.env.SCREEN_AGENT_MODEL || 'claude-sonnet',
});

const TOOL_HANDLERS = createToolHandlers({ memory, diffEngine, budget });

// ============================================================
//  MCP Server Setup
// ============================================================

const server = new Server(
  { name: "wade", version: "0.2.0" },
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
