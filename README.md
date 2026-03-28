```
                    ╔═══════════════════════════════════╗
                    ║                                   ║
                    ║          W   A   D   E            ║
                    ║                                   ║
                    ║   Watchful Autonomous Decision    ║
                    ║            Entity                 ║
                    ║                                   ║
                    ╚═══════════════════════════════════╝

                         ┌─────────────────┐
                         │  ┌───────────┐  │
                         │  │  ░░░░░░░  │  │
                         │  │  ░ 👁️  ░  │  │
                         │  │  ░░░░░░░  │  │
                         │  └───────────┘  │
                         │   ╔═══════╗     │
                         │   ║ ||||| ║     │
                         │   ║ ||||| ║     │
                         │   ╚═══════╝     │
                         │  ┌──┐    ┌──┐   │
                         │  │▓▓│    │▓▓│   │
                         │  │▓▓│    │▓▓│   │
                         │  └──┘    └──┘   │
                         └─────────────────┘
                          Your guy in the chair.
```

# WADE

**Watchful Autonomous Decision Entity**

> *Wade doesn't see everything. It sees what matters.*

Your AI's eyes, hands, and instincts on macOS. Wade gives Claude (or any LLM) the ability to see your screen, understand what's happening, and interact with it — all while being pathologically efficient with tokens.

---

## The WADE Protocol

A continuous loop of selective perception and action to maximize output while minimizing token consumption.

```
    ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
    │  👁️       │     │  🧠       │     │  🎯       │     │  ⚡       │
    │  WATCH   │────▶│  ASSESS  │────▶│  DECIDE  │────▶│  EXECUTE │
    │          │     │          │     │          │     │          │
    └──────────┘     └──────────┘     └──────────┘     └─────┬────┘
         ▲                                                    │
         └────────────────────────────────────────────────────┘
```

### 👁️ WATCH
- Observes screen state via macOS Accessibility APIs
- Captures minimal necessary context (ambient = ~5 tokens, structural = ~150)
- Avoids unnecessary token usage — screenshots only when text isn't enough

### 🧠 ASSESS
- Determines relevance using diff detection (only sends what changed)
- Filters signal from noise via the DiffEngine
- Decides whether deeper inspection (screenshot, full tree) is needed

### 🎯 DECIDE
- Selects optimal action based on screen context
- Minimizes compute + tokens via the budget system
- Plans interaction strategy (type, click, scroll, key combo)

### ⚡ EXECUTE
- Performs action via CGEvent (mouse) and AppleScript (keyboard)
- Cursor highlight overlay shows visual feedback (amber ripples)
- Feeds result back into the WATCH phase

---

## Quick Start

### As an MCP Server (recommended)

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "wade": {
      "command": "node",
      "args": ["/path/to/wade/src/mcp-server.js"],
      "env": {
        "SCREEN_AGENT_BUDGET": "normal"
      }
    }
  }
}
```

Restart Claude Code. Wade's 15 tools become available immediately.

### Chat REPL

Talk to your screen in plain English:

```bash
npm run chat
```

```
wade chat
Mode: Claude Code (native auth) | Plan: Max 5x ($100/mo) | Budget: normal
Currently viewing: VS Code — "index.ts"

> click the run button
  [get_screen_state]  [click {"x":450,"y":32}]
Clicked the Run button in the toolbar.
  [1 turn | $0.0312 | session: $0.0312 (0.94% daily Max 5x)]

> scroll down and find the error
  [get_screen_state]  [scroll {"direction":"down","amount":5}]  [get_screen_state]
Found a TypeError on line 47: "Cannot read property 'name' of undefined"
  [2 turns | $0.0856 | session: $0.1168 (3.50% daily Max 5x)]
```

### CLI

```bash
wade state --pretty     # Full screen state as JSON
wade ambient            # Lightweight: app + title + cursor
wade watch              # Stream changes continuously
wade screenshot -o snap.jpg
wade tokens             # Estimate token cost
```

---

## 15 MCP Tools

| Phase | Tool | Cost | What it does |
|-------|------|------|-------------|
| 👁️ WATCH | `get_ambient` | ~5 tok | App name, window title, cursor position |
| 👁️ WATCH | `get_screen_state` | ~150 tok | Full accessibility tree with UI elements |
| 👁️ WATCH | `take_screenshot` | ~85-800 tok | JPEG screenshot (auto quality by budget) |
| 👁️ WATCH | `get_screenshot_path` | 0 tok | Save screenshot to file, return path |
| 🧠 ASSESS | `estimate_tokens` | ~150 tok | Cost analysis of current screen state |
| 🧠 ASSESS | `recall_screen` | 0 tok | Search session memory for past states |
| 🧠 ASSESS | `get_recent_screens` | 0 tok | Last N screen states from memory |
| 🧠 ASSESS | `get_session_stats` | 0 tok | Session metadata + action count |
| 🧠 ASSESS | `get_budget` | 0 tok | Token budget status + hourly cost |
| 🎯 DECIDE | `set_budget` | 0 tok | Change cost limit (frugal/normal/rich) |
| ⚡ EXECUTE | `move_cursor` | 0 tok | Move mouse to coordinates |
| ⚡ EXECUTE | `click` | 0 tok | Left, right, or double click |
| ⚡ EXECUTE | `type_text` | 0 tok | Type text at cursor position |
| ⚡ EXECUTE | `key_press` | 0 tok | Keyboard shortcuts (cmd+s, ctrl+c, etc.) |
| ⚡ EXECUTE | `scroll` | 0 tok | Scroll up/down/left/right |

---

## Budget System

Wade is cost-aware. It tracks every token and auto-downgrades when spending gets high.

| Preset | $/hour | Default Capture | Screenshot Quality | Interval |
|--------|--------|----------------|-------------------|----------|
| `frugal` | $0.05 | ambient | low (640x360) | 60s |
| `normal` | $0.20 | structural | medium (960x540) | 30s |
| `rich` | $1.00 | structural | high (1280x720) | 15s |
| `unlimited` | ∞ | structural | full resolution | 15s |

At >80% budget: drops to ambient-only, low-res screenshots.
At >100%: disables screenshots entirely.

---

## Cursor Highlights

When Wade moves the cursor or clicks, a transparent overlay renders subtle visual feedback:

- **Move start**: Amber glow pulse at origin
- **Move path**: Thin bezier arc trail
- **Click**: Concentric ripple expanding outward
- **Double-click**: Two rapid ripples
- **Right-click**: Blue-tinted ripple

Disable with `SCREEN_AGENT_HIGHLIGHT=false`.

---

## Architecture

```
bin/wade.js              CLI entry point (commander)
bin/wade-chat.js         Natural language REPL (claude CLI backend)
src/mcp-server.js        MCP server (stdio transport)
src/tools/handlers.js    Shared tool handlers (used by MCP + chat)
src/capture/bridge.js    Screen capture (JXA + screencapture + sips)
src/input/injector.js    Input injection (CGEvent + AppleScript)
src/overlay/highlight.js Cursor highlight manager
src/state/session-memory.js   Temporal recall (TF-IDF search)
src/state/diff-engine.js      Minimal state diffs
src/budget/token-budget.js    Cost tracking + auto-downgrade
src/providers/index.js        Multi-provider abstraction
swift-bridge/CursorHighlight.swift  Transparent overlay (Core Animation)
swift-bridge/ScreenState.swift      Accessibility tree extractor
```

---

## Security

- All shell commands use `execFile()` (no string interpolation injection)
- Input coordinates validated and bounded (0-20000)
- Key/modifier whitelisting — only known keys accepted
- Typed text redacted from action logs
- Config files created with `0o600` permissions
- Budget system prevents runaway token spending

---

## Requirements

- macOS (Accessibility + Screen Recording permissions)
- Node.js 18+
- Python 3 with PyObjC (pre-installed on macOS)

---

## License

MIT

---

*Named after Wade Load — the genius in the chair from Kim Possible who sees everything, knows everything, and runs the whole operation from behind a screen.*
