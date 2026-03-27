/**
 * Screen Capture Bridge — uses macOS built-in tools for screen understanding
 *
 * Approach: hybrid of multiple capture methods, no compilation needed
 *
 * 1. screencapture (built-in) — always works, no permissions beyond Screen Recording
 * 2. osascript/JXA — needs Accessibility permission for element tree
 * 3. Pure AppKit via swift CLI — needs matching Xcode toolchain (optional)
 *
 * Falls back gracefully: if accessibility isn't available, uses screenshot only.
 */

import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';

const execFileP = promisify(execFile);
const execP = promisify(exec);

/**
 * Capture the frontmost app and window info via osascript.
 * Requires Accessibility permission for full UI tree.
 * Falls back to basic app/window info if not granted.
 */
export async function captureState() {
  try {
    // Try full accessibility tree first
    const { stdout } = await execFileP('osascript', ['-l', 'JavaScript', '-e', `
      const se = Application("System Events");
      const proc = se.processes.whose({frontmost: true})[0];
      const appName = proc.name();

      // Get windows
      const wins = proc.windows();
      const windowInfo = wins.length > 0 ? {
        title: wins[0].title(),
        position: wins[0].position(),
        size: wins[0].size()
      } : { title: "", position: [0,0], size: [0,0] };

      // Extract UI elements (limited depth to keep fast)
      let elements = [];
      try {
        const uiElems = wins.length > 0 ? wins[0].uiElements() : [];
        for (let i = 0; i < Math.min(uiElems.length, 40); i++) {
          try {
            const el = uiElems[i];
            const role = el.role();
            const title = el.title() || "";
            const value = el.value() ? String(el.value()) : "";
            const desc = el.description() || "";
            const pos = el.position();
            const sz = el.size();
            const text = [title, value, desc].filter(Boolean).join(" — ");
            if (text || ["AXButton","AXTextField","AXLink","AXCheckBox"].includes(role)) {
              elements.push({
                role: role.replace("AX","").toLowerCase(),
                text: text.substring(0, 120),
                bounds: [pos[0], pos[1], sz[0], sz[1]]
              });
            }
          } catch(e) { /* skip inaccessible elements */ }
        }
      } catch(e) { /* accessibility not available */ }

      JSON.stringify({
        type: "structural",
        ts: Date.now(),
        app: appName,
        title: windowInfo.title,
        cursor: [0,0],
        elements: elements,
        screenSize: [0,0]
      });
    `], { timeout: 5000 });

    return JSON.parse(stdout.trim());
  } catch (err) {
    // Accessibility not granted — fall back to basic info
    return captureBasicState();
  }
}

/**
 * Basic state capture without accessibility — just app name and window title.
 */
async function captureBasicState() {
  try {
    const { stdout } = await execFileP('osascript', ['-l', 'JavaScript', '-e', `
      const se = Application("System Events");
      const proc = se.processes.whose({frontmost: true})[0];
      JSON.stringify({
        type: "ambient",
        ts: Date.now(),
        app: proc.displayedName(),
        title: proc.windows().length > 0 ? proc.windows()[0].title() : "",
        cursor: [0,0]
      });
    `], { timeout: 3000 });

    return JSON.parse(stdout.trim());
  } catch {
    // Even basic JXA failed — return minimal state
    try {
      const { stdout } = await execP(
        `osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`,
        { timeout: 3000 }
      );
      return {
        type: "ambient",
        ts: Date.now(),
        app: stdout.trim(),
        title: "",
        cursor: [0, 0]
      };
    } catch {
      return null;
    }
  }
}

/**
 * Lightweight ambient state.
 */
export async function captureAmbient() {
  return captureBasicState();
}

/**
 * Capture screenshot to a temp file, return the path.
 * Uses macOS built-in screencapture — always works.
 */
export async function captureScreenshot(outputPath) {
  const path = outputPath || join(tmpdir(), `screenagent-${Date.now()}.jpg`);

  try {
    await execFileP('screencapture', ['-x', '-t', 'jpg', path], { timeout: 5000 });
    return path;
  } catch (err) {
    console.error(`Screenshot failed: ${err.message}`);
    return null;
  }
}

/**
 * Capture screenshot as base64 for direct LLM consumption.
 */
export async function captureScreenshotBase64() {
  const path = join(tmpdir(), `screenagent-${Date.now()}.jpg`);

  try {
    await execFileP('screencapture', ['-x', '-t', 'jpg', path], { timeout: 5000 });
    const buffer = await readFile(path);
    await unlink(path); // clean up

    return {
      type: "screenshot",
      ts: Date.now(),
      format: "jpeg",
      sizeBytes: buffer.length,
      image: buffer.toString('base64')
    };
  } catch (err) {
    console.error(`Screenshot failed: ${err.message}`);
    return null;
  }
}

/**
 * Watch screen state continuously, yielding on changes.
 */
export async function* watchState({ interval = 2000, ambientOnly = false } = {}) {
  let lastHash = '';

  while (true) {
    try {
      const state = ambientOnly ? await captureAmbient() : await captureState();

      if (state) {
        const hash = `${state.app}:${state.title}:${state.elements?.length || 0}`;

        if (hash !== lastHash) {
          lastHash = hash;
          yield state;
        }
      }
    } catch (err) {
      console.error(`[watch] ${err.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
