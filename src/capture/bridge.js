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
 * Screenshot quality presets — optimized for LLM vision token efficiency.
 *
 * Vision models bill by resolution tile, not file size. But smaller files
 * mean faster base64 encoding and transfer. These presets balance readability
 * against cost.
 *
 *   low:    640x360  q30  ~23KB   — UI layout, button positions, rough text
 *   medium: 960x540  q40  ~56KB   — readable body text, form fields
 *   high:  1280x720  q50  ~111KB  — crisp text, code readability
 *   full:  native    q75  ~1.6MB  — pixel-perfect (rarely needed)
 */
const QUALITY_PRESETS = {
  low:    { width: 640,  height: 360, quality: 30 },
  medium: { width: 960,  height: 540, quality: 40 },
  high:   { width: 1280, height: 720, quality: 50 },
  full:   { width: 0,    height: 0,   quality: 75 }, // 0 = native
};

/**
 * Capture screenshot as base64 for direct LLM consumption.
 * @param {'low'|'medium'|'high'|'full'} [quality='medium'] — preset name
 */
export async function captureScreenshotBase64(quality = 'medium') {
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.medium;
  const rawPath = join(tmpdir(), `screenagent-raw-${Date.now()}.png`);
  const outPath = join(tmpdir(), `screenagent-${Date.now()}.jpg`);

  try {
    // Capture full-res PNG first
    await execP(`screencapture -x -t png "${rawPath}"`, { timeout: 5000 });

    if (preset.width > 0) {
      // Downscale + compress with sips (macOS built-in)
      await execFileP('sips', [
        '-z', String(preset.height), String(preset.width),
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', String(preset.quality),
        rawPath, '--out', outPath,
      ], { timeout: 5000 });
    } else {
      // Full quality — just convert to JPEG
      await execFileP('sips', [
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', String(preset.quality),
        rawPath, '--out', outPath,
      ], { timeout: 5000 });
    }

    const buffer = await readFile(outPath);
    await unlink(rawPath).catch(() => {});
    await unlink(outPath).catch(() => {});

    return {
      type: "screenshot",
      ts: Date.now(),
      format: "jpeg",
      quality,
      resolution: preset.width > 0 ? `${preset.width}x${preset.height}` : 'native',
      sizeBytes: buffer.length,
      sizeKB: Math.round(buffer.length / 1024),
      image: buffer.toString('base64'),
    };
  } catch (err) {
    console.error(`Screenshot failed: ${err.message}`);
    await unlink(rawPath).catch(() => {});
    await unlink(outPath).catch(() => {});
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
