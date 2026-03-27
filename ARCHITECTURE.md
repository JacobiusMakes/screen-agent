# ScreenAgent — Technical Architecture Document

> A system-wide AI assistant that sees your screen, understands context, and interacts with your computer through a shared cursor.

**Status:** Architecture Draft v0.1
**Date:** March 27, 2026
**Author:** Jacob Galperin

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Market Analysis](#2-market-analysis)
3. [Core Architecture](#3-core-architecture)
4. [The Token Problem — And How We Solve It](#4-the-token-problem)
5. [Component Design](#5-component-design)
6. [State Representation Protocol](#6-state-representation-protocol)
7. [Interaction Model](#7-interaction-model)
8. [Security & Privacy](#8-security--privacy)
9. [Performance Budget](#9-performance-budget)
10. [Implementation Plan](#10-implementation-plan)
11. [Open Questions](#11-open-questions)

---

## 1. Problem Statement

AI assistants today are blind. You can paste text, upload screenshots, describe what you're looking at — but the AI never actually *sees* what you see. Every interaction requires manual context transfer: copy-pasting error messages, describing UI layouts, uploading screenshots one at a time.

This creates three fundamental problems:

**Context gap.** By the time you describe what's on your screen, you've already spent more effort than the AI saves. The assistant knows your words but not your world.

**Temporal blindness.** AI has no memory of what just happened on your screen. It can't say "the error that flashed 30 seconds ago was X" because it wasn't watching.

**Interaction friction.** When AI tells you "click the Settings button in the top-right corner," you have to find it yourself. When you tell AI "type this in the search box," you have to manually position the cursor and paste. Every instruction crosses the human-computer boundary twice.

**ScreenAgent eliminates all three.** It watches your screen continuously, maintains a compressed temporal memory, and can directly move the cursor, click, and type — with your permission, on your behalf.

---

## 2. Market Analysis

### What Exists (and Why It's Not Enough)

| Product | Sees Screen | Understands Context | Can Interact | Real-time | Cost-efficient |
|---------|:-----------:|:-------------------:|:------------:|:---------:|:--------------:|
| Claude Computer Use | Yes | Yes | Yes | No (batch) | No |
| Cursor/Windsurf | Code only | Code only | Code only | Yes | Yes |
| Rewind.ai | Yes (record) | Search only | No | No | Yes (local) |
| Apple Intelligence | Yes (on-device) | Basic | No | Yes | Yes (local) |
| Claude in Chrome (MCP) | Browser only | Yes | Yes | Partial | Moderate |
| **ScreenAgent** | **Yes (system)** | **Yes (deep)** | **Yes (full)** | **Yes** | **Yes** |

**Claude Computer Use** is the closest comparable. It takes screenshots, reasons about them, and executes actions. But it operates in batch mode — screenshot → think → act → screenshot. There's no continuous awareness, no temporal memory, and each screenshot burns ~1500 tokens. At conversation scale, this costs $5-15/session.

**The gap ScreenAgent fills:** Continuous, cost-efficient, system-wide screen awareness with bidirectional interaction. Not batch screenshots — streaming state.

---

## 3. Core Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        ScreenAgent System                        │
│                                                                  │
│  ┌─────────────┐  ┌─────────────────┐  ┌─────────────────────┐ │
│  │   Capture    │  │  State Engine   │  │    LLM Interface    │ │
│  │   Layer      │──▶│                 │──▶│                     │ │
│  │             │  │  Compresses     │  │  Streams state to   │ │
│  │ - Screen    │  │  screen data    │  │  Claude/GPT/local   │ │
│  │ - A11y tree │  │  into tokens    │  │  LLM via API        │ │
│  │ - OCR       │  │                 │  │                     │ │
│  │ - Events    │  │  - Diff engine  │  │  - Conversation mgr │ │
│  └─────────────┘  │  - Text extract │  │  - Tool definitions │ │
│                    │  - Vectorizer   │  │  - Cost tracker     │ │
│  ┌─────────────┐  └─────────────────┘  └──────────┬──────────┘ │
│  │  Overlay     │                                   │            │
│  │  Renderer    │◀──────────────────────────────────┘            │
│  │             │  LLM emits actions:                            │
│  │ - Cursor    │  - move_cursor(x, y)                           │
│  │ - Highlights│  - click(x, y)                                 │
│  │ - Labels    │  - type(text)                                  │
│  │ - Toasts    │  - highlight(region, color)                    │
│  └─────────────┘  - scroll(direction, amount)                   │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Session Memory (Vector Store)             ││
│  │  Embeds screen states over time for temporal recall          ││
│  │  "What was I looking at 5 minutes ago?" → vector search     ││
│  └─────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **State over frames.** Never stream raw video. Extract structured state (text, element positions, focused app) and only capture screenshots on demand.

2. **Event-driven capture.** Don't poll at fixed intervals. Capture when something changes: window focus, mouse click, scroll, new content. Idle screen = zero tokens.

3. **Layered fidelity.** Three tiers of screen understanding, escalating in cost:
   - **Tier 1 (free):** Focused app name + window title + cursor position
   - **Tier 2 (cheap):** Accessibility tree text + element positions (~200 tokens)
   - **Tier 3 (expensive):** Full screenshot (~1200 tokens) — only when AI requests it

4. **User always in control.** AI never acts without visible intent. Overlay shows what AI wants to do before it does it. Kill switch is always available.

---

## 4. The Token Problem

This is the make-or-break technical challenge. Let's do the math.

### Raw Screenshot Approach (Baseline — DON'T DO THIS)

| Parameter | Value |
|-----------|-------|
| Screenshot resolution | 1920x1080 |
| JPEG quality 80 | ~150KB |
| Tokens per image (Claude) | ~1,200-1,600 |
| Capture rate | 1 fps |
| Tokens per minute | ~72,000-96,000 |
| Cost per minute (Sonnet @ $3/M in) | ~$0.22-0.29 |
| Cost per hour | **~$13-17** |

Completely unusable for a consumer product.

### ScreenAgent Approach (What We Build)

#### Tier 1: Ambient Awareness (~5 tokens/update)
```json
{"app":"Chrome","title":"GitHub - Pull Request #1609","cursor":[834,412]}
```
Sent on every window focus change or significant cursor movement. Costs virtually nothing. Gives AI enough to maintain conversational context ("I see you're looking at a GitHub PR").

#### Tier 2: Structural State (~100-300 tokens/update)
```json
{
  "app": "Chrome",
  "title": "GitHub - Pull Request #1609",
  "url": "https://github.com/huggingface/transformers.js/pull/1609",
  "elements": [
    {"role": "heading", "text": "Emit progress_total events from PreTrainedModel", "bounds": [120,80,800,110]},
    {"role": "button", "text": "Merge pull request", "bounds": [700,160,850,185]},
    {"role": "tab", "text": "Conversation", "selected": true},
    {"role": "tab", "text": "Files changed", "selected": false},
    {"role": "text", "text": "xenova approved these changes", "bounds": [150,220,600,240]}
  ],
  "focused": {"role": "textbox", "placeholder": "Leave a comment", "bounds": [120,500,850,600]}
}
```
Sent on significant content changes (scroll, navigation, form interaction). This is the sweet spot — the AI knows exactly what's on screen, where everything is, and what's interactive. ~200 tokens.

#### Tier 3: Visual Snapshot (~1,200 tokens/capture)
Full screenshot. Only sent when:
- AI explicitly requests it ("I need to see what that looks like")
- OCR/accessibility can't read something (canvas, images, PDFs)
- User triggers it manually ("look at this")

#### Cost Projection

| Scenario | Tier 1 | Tier 2 | Tier 3 | Total tokens/min | Cost/hour |
|----------|--------|--------|--------|-------------------|-----------|
| Idle (reading) | 2/min | 0/min | 0/min | ~10 | ~$0.002 |
| Light browsing | 5/min | 2/min | 0/min | ~425 | ~$0.08 |
| Active coding | 10/min | 5/min | 0.5/min | ~2,100 | ~$0.38 |
| Heavy interaction | 15/min | 10/min | 2/min | ~5,475 | ~$0.99 |

**Average active session: ~$0.30-0.50/hour.** That's 30-50x cheaper than raw screenshots.

---

## 5. Component Design

### 5.1 Capture Layer

**Technology:** macOS ScreenCaptureKit (SCKit) for screenshots, Accessibility API (AXUIElement) for structural data.

**Why SCKit over CGWindowListCreateImage:**
- SCKit is Apple's modern replacement (introduced macOS 12.3)
- Supports per-window and per-display capture
- Built-in content filtering (exclude own overlay window)
- GPU-accelerated — lower CPU overhead
- Supports HDR and high-refresh displays

**Accessibility tree extraction:**
```
AXUIElement (root)
├── AXApplication "Chrome"
│   ├── AXWindow "GitHub - PR #1609"
│   │   ├── AXGroup (toolbar)
│   │   │   ├── AXButton "Back"
│   │   │   ├── AXTextField (URL bar) value="github.com/..."
│   │   │   └── AXButton "Reload"
│   │   ├── AXWebArea
│   │   │   ├── AXHeading "Emit progress_total events..."
│   │   │   ├── AXButton "Merge pull request"
│   │   │   └── AXTextArea "Leave a comment"
```

**Event triggers for capture:**
- `NSWorkspaceDidActivateApplicationNotification` — app switched
- `AXFocusedUIElementChanged` — focus changed within app
- `AXValueChanged` — text field content changed
- Mouse click/scroll (CGEvent tap)
- Timer-based throttled poll for content changes (every 2s when active)

### 5.2 State Engine

The State Engine is the core innovation. It transforms raw screen data into token-efficient state representations.

**Diff Engine:**
- Maintains a snapshot of the last state sent to the LLM
- On each update, computes a structural diff
- Only sends changed elements, not the full tree
- Example: user scrolls → only new elements entering the viewport are sent

**Text Extractor:**
- Primary: Accessibility API (free, structured)
- Fallback: Apple Vision framework OCR (for images, PDFs, canvas)
- Fallback: Tesseract.js (cross-platform, when Vision is unavailable)

**Change Detector:**
- Perceptual hash of each screen region
- Only flags regions as "changed" if the hash differs by >threshold
- Avoids re-sending state for cursor blinks, animations, etc.

**Vectorizer (Session Memory):**
- Every Tier 2 state gets embedded into a 384-dim vector (MiniLM-L6-v2)
- Stored in SQLite with timestamp
- Enables temporal queries: "What was on screen when I was editing the config?"
- Automatic garbage collection: states older than session duration are pruned

### 5.3 LLM Interface

**Provider abstraction:**
```typescript
interface LLMProvider {
  sendState(state: ScreenState): AsyncGenerator<LLMAction>;
  sendScreenshot(image: Buffer): AsyncGenerator<LLMAction>;
  estimateTokens(state: ScreenState): number;

  // Cost tracking
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCost: number;
}
```

**Supported providers (initial):**
- Anthropic Claude (Sonnet 4.6, Opus 4.6) via `@anthropic-ai/sdk`
- OpenAI GPT-4o via `openai` SDK
- Local models via Ollama (LLaVA, etc.) — free but less capable

**Tool definitions for the LLM:**
```typescript
const tools = [
  {
    name: "move_cursor",
    description: "Move the mouse cursor to a screen position",
    parameters: { x: "number", y: "number" }
  },
  {
    name: "click",
    description: "Click at a position (left, right, or double)",
    parameters: { x: "number", y: "number", button: "left|right|double" }
  },
  {
    name: "type_text",
    description: "Type text at the current cursor position",
    parameters: { text: "string" }
  },
  {
    name: "key_press",
    description: "Press a keyboard shortcut",
    parameters: { keys: "string" } // e.g. "cmd+s", "enter", "tab"
  },
  {
    name: "scroll",
    description: "Scroll at the current position",
    parameters: { direction: "up|down|left|right", amount: "number" }
  },
  {
    name: "highlight",
    description: "Highlight a region on screen to guide the user",
    parameters: { x: "number", y: "number", width: "number", height: "number", color: "string", label: "string" }
  },
  {
    name: "request_screenshot",
    description: "Request a full screenshot for visual analysis",
    parameters: {}
  },
  {
    name: "toast",
    description: "Show a notification message to the user",
    parameters: { message: "string", duration: "number" }
  }
];
```

### 5.4 Overlay Renderer

**Technology:** Electron BrowserWindow with transparent background, always-on-top, click-through.

```typescript
const overlay = new BrowserWindow({
  transparent: true,
  frame: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  focusable: false,       // don't steal focus
  hasShadow: false,
  webPreferences: {
    nodeIntegration: true,
  },
  // Cover the entire screen
  width: screen.width,
  height: screen.height,
  x: 0, y: 0,
});

// Make the window click-through (events pass to windows below)
overlay.setIgnoreMouseEvents(true, { forward: true });
```

**Overlay elements:**
- **AI cursor:** A distinct colored cursor showing where AI is "looking" or about to click
- **Highlights:** Colored rectangles around elements AI is referencing
- **Labels:** Small text labels explaining what AI is pointing at
- **Toast notifications:** Status messages ("I'm reading the error message...", "Clicking Submit")
- **Action preview:** Before AI clicks/types, show a preview of what it will do with a confirm/cancel

### 5.5 Input Injector

**Technology:** macOS CGEvent API via native Node addon (or Swift bridge).

```typescript
// Move cursor
CGEventPost(kCGHIDEventTap, CGEventCreateMouseEvent(
  null, kCGEventMouseMoved, CGPointMake(x, y), 0
));

// Left click
CGEventPost(kCGHIDEventTap, CGEventCreateMouseEvent(
  null, kCGEventLeftMouseDown, CGPointMake(x, y), 0
));
CGEventPost(kCGHIDEventTap, CGEventCreateMouseEvent(
  null, kCGEventLeftMouseUp, CGPointMake(x, y), 0
));

// Type text
for (const char of text) {
  const keyDown = CGEventCreateKeyboardEvent(null, 0, true);
  CGEventKeyboardSetUnicodeString(keyDown, 1, char);
  CGEventPost(kCGAnnotatedSessionEventTap, keyDown);
  // ... keyUp
}
```

**Permissions required:**
- Accessibility permission (System Settings → Privacy → Accessibility)
- Screen Recording permission (for ScreenCaptureKit)
- Input Monitoring permission (for event taps)

---

## 6. State Representation Protocol

The protocol defines how screen state is encoded for the LLM. This is the key to token efficiency.

### Message Types

```typescript
// Tier 1: Ambient (sent frequently, ~5 tokens)
interface AmbientState {
  type: "ambient";
  ts: number;
  app: string;           // "Chrome", "VS Code", "Terminal"
  title: string;         // Window title
  cursor: [number, number];
}

// Tier 2: Structural (sent on significant changes, ~100-300 tokens)
interface StructuralState {
  type: "structural";
  ts: number;
  app: string;
  title: string;
  url?: string;          // For browsers
  file?: string;         // For editors
  elements: Element[];   // Visible interactive + text elements
  focused?: Element;     // Currently focused element
  selection?: string;    // Selected text, if any
}

interface Element {
  role: string;          // "button", "textbox", "heading", "link", "text"
  text: string;          // Visible text content
  bounds: [number, number, number, number]; // [x, y, width, height]
  state?: string;        // "disabled", "checked", "selected", "expanded"
}

// Tier 2.5: Diff (sent when small changes occur, ~20-80 tokens)
interface DiffState {
  type: "diff";
  ts: number;
  added: Element[];      // New elements on screen
  removed: string[];     // Element IDs no longer visible
  changed: Partial<Element & { id: string }>[]; // Changed properties
}

// Tier 3: Screenshot (sent on demand, ~1200 tokens)
interface ScreenshotState {
  type: "screenshot";
  ts: number;
  image: string;         // base64 JPEG
  region?: [number, number, number, number]; // Partial screenshot bounds
}
```

### Compression Strategies

1. **Deduplication:** Same elements across updates are not re-sent
2. **Truncation:** Long text content is truncated to first 100 chars with "..."
3. **Pruning:** Off-screen elements are excluded
4. **Batching:** Multiple rapid changes are batched into a single update
5. **Priority:** Interactive elements (buttons, inputs) are sent before static text

---

## 7. Interaction Model

### Modes of Operation

**1. Watch Mode (default)**
- AI passively observes screen state
- Responds to user questions about what's on screen
- "What does this error mean?" → AI reads the error from screen state
- Zero interaction with the computer, pure observation

**2. Guide Mode**
- AI highlights elements and shows instructions
- "Walk me through setting up SSH keys" → AI highlights Terminal, shows overlay arrows
- AI uses `highlight()` and `toast()` tools only
- No cursor control, no typing

**3. Assist Mode**
- AI can move cursor and type with user confirmation
- AI shows a preview of each action before executing
- User confirms with a hotkey (e.g., Enter) or cancels (Esc)
- "Fill in this form with my info" → AI highlights each field, shows what it'll type, waits for confirmation

**4. Auto Mode (advanced, opt-in)**
- AI executes multi-step workflows autonomously
- User approves a plan, AI executes it
- Progress shown via overlay
- Kill switch always available (global hotkey, e.g., Cmd+Shift+Esc)

### Safety Model

```
User says "Click submit"
  → AI identifies Submit button at (750, 400)
  → Overlay shows: highlight on button + label "I'll click Submit"
  → User presses Enter to confirm (or Esc to cancel)
  → AI clicks (750, 400)
  → Overlay shows: "Clicked Submit ✓"
```

**Hard rules:**
- AI never types passwords or sensitive data
- AI never interacts with banking/payment flows
- AI never dismisses security dialogs
- All actions are logged with timestamp, screenshot, and intent

---

## 8. Security & Privacy

### Data Flow

```
Screen pixels → [LOCAL ONLY: capture + extract text]
             → [LOCAL ONLY: compress to state representation]
             → [SENT TO API: text-only state, ~200 tokens]

Screenshots → [SENT TO API: only when explicitly requested]
             → [NOT stored on API side (ephemeral)]
```

**Key principle:** Raw pixels never leave the machine by default. Only structured text state is sent to the LLM API. Screenshots are opt-in and ephemeral.

### Sensitive Content Detection

Before sending ANY state to the API, the State Engine runs a local filter:

- **Password fields:** Detected via accessibility role `AXSecureTextField` → text replaced with `[password field]`
- **Credit card patterns:** Regex detection → redacted
- **API keys/tokens:** Pattern matching for common formats → redacted
- **Private windows:** Detect incognito/private browsing → entire window state omitted
- **User-defined exclusions:** App-level or URL-level blocklist ("never send state from 1Password")

### Local-Only Mode

For maximum privacy, ScreenAgent supports a fully local mode:
- Uses Ollama + LLaVA for vision
- Uses a local LLM (Llama, Mistral) for reasoning
- Zero data leaves the machine
- Reduced capability but complete privacy

---

## 9. Performance Budget

| Component | Target | Measured Baseline |
|-----------|--------|-------------------|
| Accessibility tree extraction | <50ms | ~20-30ms (typical app) |
| OCR fallback (Vision framework) | <200ms | ~100-150ms (full screen) |
| Screenshot capture (SCKit) | <30ms | ~10-15ms (1080p JPEG) |
| State diff computation | <5ms | ~1-3ms |
| Vector embedding (MiniLM) | <100ms | ~50-80ms (single chunk) |
| Overlay render cycle | <16ms (60fps) | ~5-8ms (simple elements) |
| LLM round-trip (Sonnet) | <2s | ~500ms-1.5s |
| End-to-end: user acts → AI responds | <3s | Target |

**Memory budget:**
- Electron base: ~80MB
- Session vector store: ~5-20MB (depends on session length)
- Screenshot buffer (last 10): ~15MB
- Accessibility tree cache: ~2MB
- **Total: ~100-120MB**

**CPU budget:**
- Idle: <1% (no capture when nothing changes)
- Active: <5% (event-driven capture + state diffing)
- Screenshot: <10% spike for ~30ms

---

## 10. Implementation Plan

### Phase 1: Core Capture + State Engine (Week 1-2)

**Deliverables:**
- [ ] macOS screen capture via ScreenCaptureKit
- [ ] Accessibility tree extraction via AXUIElement (Swift/Node bridge)
- [ ] State Engine: diff computation, text extraction, tier classification
- [ ] Event-driven capture triggers (app switch, focus change, click)
- [ ] State Representation Protocol implementation
- [ ] Basic CLI that prints live screen state to stdout

**Tech:** Node.js + native Swift addon (node-addon-api or napi-rs)

### Phase 2: LLM Integration (Week 2-3)

**Deliverables:**
- [ ] Claude provider implementation (streaming)
- [ ] Tool definitions for all interaction types
- [ ] Cost tracker with per-session and per-action breakdowns
- [ ] Conversation manager (maintains context window)
- [ ] Token budget system (automatic tier selection based on budget)

**Tech:** @anthropic-ai/sdk, streaming responses

### Phase 3: Overlay + Input (Week 3-4)

**Deliverables:**
- [ ] Electron overlay window (transparent, click-through)
- [ ] Cursor rendering, highlight boxes, labels, toasts
- [ ] Input injection via CGEvent (cursor, click, type, keypress)
- [ ] Action preview + confirmation flow
- [ ] Global hotkeys (activate, kill switch, mode toggle)

**Tech:** Electron, native CGEvent bindings

### Phase 4: Session Memory + Polish (Week 4-5)

**Deliverables:**
- [ ] Vector store for session states (SQLite + embeddings)
- [ ] Temporal queries ("What was I looking at when...")
- [ ] Sensitive content detection + redaction
- [ ] Settings UI (API key, privacy rules, cost limits)
- [ ] Local-only mode (Ollama)

**Tech:** better-sqlite3, transformers.js for embeddings

### Phase 5: Distribution (Week 5-6)

**Deliverables:**
- [ ] macOS .app bundle (electron-builder)
- [ ] Auto-updater
- [ ] Onboarding flow (permission requests, API key setup)
- [ ] Documentation + demo video

---

## 11. Open Questions

1. **Native addon vs Swift subprocess?** AXUIElement and CGEvent require native code. Options: (a) Swift CLI that communicates via JSON over stdin/stdout, (b) N-API native addon in C/ObjC, (c) napi-rs with objc2 crate. Swift subprocess is simplest to develop; native addon is fastest at runtime.

2. **Electron vs Tauri?** Electron gives us the overlay rendering for free (transparent BrowserWindow) but is heavy (~80MB). Tauri is lighter but transparent overlays are harder on macOS. Electron is pragmatic for MVP.

3. **How to handle web app internals?** Accessibility API sees Chrome's web content via the AX bridge, but the structure is messy. For richer web understanding, could inject a content script (like Chrome extension) that sends clean DOM data. This is a V2 feature.

4. **Multi-monitor support?** ScreenCaptureKit handles it natively. The overlay needs one window per display. State Engine needs to track which display the user is focused on.

5. **Linux/Windows?** Initial build is macOS-only. Windows port would use UI Automation API (equivalent to AX). Linux would use AT-SPI. Architecture is designed so the Capture Layer is the only platform-specific component.

---

*This is a living document. Updated as implementation progresses.*
