/**
 * Input Injector — move cursor, click, type, scroll, press keys
 *
 * Uses nut.js when available (best cross-platform support).
 * Falls back to AppleScript/osascript on macOS.
 *
 * SECURITY: All shell commands use execFile() with argument arrays
 * to prevent injection. Numeric inputs are validated before use.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { showMove, showClick } from '../overlay/highlight.js';

const execFileP = promisify(execFile);

let nutjs = null;
let useNutJs = false;

// On macOS, prefer CGEvent/AppleScript for mouse — nut.js silently fails
const isMacOS = process.platform === 'darwin';

if (!isMacOS) {
  try {
    nutjs = await import('@nut-tree-fork/nut-js');
    useNutJs = true;
  } catch {
    // nut.js not installed — use AppleScript fallback
  }
}

/** Action log for audit trail */
const actionLog = [];

function logAction(action, params, success = true) {
  // SECURITY: redact typed text from logs
  const safeParams = { ...params };
  if (safeParams.text) safeParams.text = `[${safeParams.text.length} chars]`;
  actionLog.push({
    ts: Date.now(),
    action,
    params: safeParams,
    success,
    method: useNutJs ? 'nut.js' : 'applescript',
  });
}

export function getActionLog() {
  return [...actionLog];
}

export function clearActionLog() {
  actionLog.length = 0;
}

// ============================================================
//  Input Validation
// ============================================================

function validateCoord(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 20000) {
    throw new Error(`Invalid ${name}: ${v} (must be 0-20000)`);
  }
  return Math.round(n);
}

function validateAmount(v) {
  const n = Number(v) || 3;
  return Math.min(Math.max(Math.round(n), 1), 100);
}

const VALID_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const VALID_BUTTONS = new Set(['left', 'right', 'double']);

// ============================================================
//  Python helper — execFile with argument array, no shell
// ============================================================

async function runPython(code, timeout = 3000) {
  return execFileP('python3', ['-c', code], { timeout });
}

async function runOsascript(script, timeout = 3000) {
  return execFileP('osascript', ['-e', script], { timeout });
}

// ============================================================
//  Cursor Position (for highlight origin)
// ============================================================

async function getCursorPosition() {
  try {
    const code = `import Quartz; loc=Quartz.CGEventGetLocation(Quartz.CGEventCreate(None)); print(f'{int(loc.x)},{int(loc.y)}')`;
    const { stdout } = await runPython(code, 2000);
    const [cx, cy] = stdout.trim().split(',').map(Number);
    return { x: cx, y: cy };
  } catch {
    return { x: 0, y: 0 };
  }
}

// ============================================================
//  Cursor Movement
// ============================================================

export async function moveCursor(x, y) {
  try {
    x = validateCoord(x, 'x');
    y = validateCoord(y, 'y');

    const from = await getCursorPosition();
    showMove([from.x, from.y], [x, y]);

    if (useNutJs) {
      await nutjs.mouse.setPosition({ x, y });
    } else {
      const code = [
        'import Quartz',
        `Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (${x}, ${y}), 0))`,
      ].join('; ');
      await runPython(code);
    }
    logAction('move_cursor', { x, y });
    return { success: true, x, y };
  } catch (err) {
    logAction('move_cursor', { x, y }, false);
    return { success: false, error: err.message };
  }
}

// ============================================================
//  Click
// ============================================================

export async function click(x, y, button = 'left') {
  try {
    x = validateCoord(x, 'x');
    y = validateCoord(y, 'y');
    if (!VALID_BUTTONS.has(button)) button = 'left';

    showClick([x, y], button);

    if (useNutJs) {
      await nutjs.mouse.setPosition({ x, y });
      if (button === 'right') {
        await nutjs.mouse.rightClick();
      } else if (button === 'double') {
        await nutjs.mouse.doubleClick();
      } else {
        await nutjs.mouse.leftClick();
      }
    } else {
      const eventMap = {
        left:  ['kCGEventLeftMouseDown', 'kCGEventLeftMouseUp'],
        right: ['kCGEventRightMouseDown', 'kCGEventRightMouseUp'],
      };
      const [down, up] = eventMap[button] || eventMap.left;

      const code = [
        'import Quartz, time',
        `pos = (${x}, ${y})`,
        `Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, pos, 0))`,
        'time.sleep(0.05)',
        `Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.${down}, pos, 0))`,
        'time.sleep(0.05)',
        `Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.${up}, pos, 0))`,
      ].join('\n');
      await runPython(code);

      if (button === 'double') {
        const dblCode = [
          'import Quartz, time',
          `pos = (${x}, ${y})`,
          'time.sleep(0.1)',
          'e = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, pos, 0)',
          'Quartz.CGEventSetIntegerValueField(e, Quartz.kCGMouseEventClickState, 2)',
          'Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)',
          'time.sleep(0.05)',
          'e2 = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, pos, 0)',
          'Quartz.CGEventSetIntegerValueField(e2, Quartz.kCGMouseEventClickState, 2)',
          'Quartz.CGEventPost(Quartz.kCGHIDEventTap, e2)',
        ].join('\n');
        await runPython(dblCode);
      }
    }
    logAction('click', { x, y, button });
    return { success: true, x, y, button };
  } catch (err) {
    logAction('click', { x, y, button }, false);
    return { success: false, error: err.message };
  }
}

// ============================================================
//  Type Text
// ============================================================

export async function typeText(text) {
  try {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('Text must be a non-empty string');
    }
    if (text.length > 10000) {
      throw new Error('Text too long (max 10000 chars)');
    }

    if (useNutJs) {
      await nutjs.keyboard.type(text);
    } else {
      // SECURITY: Use osascript with -e flag via execFile (no shell).
      // AppleScript string escaping: backslash and double-quote.
      const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `tell application "System Events" to keystroke "${escaped}"`;
      await runOsascript(script, 5000);
    }
    logAction('type_text', { text });
    return { success: true, length: text.length };
  } catch (err) {
    logAction('type_text', { text }, false);
    return { success: false, error: err.message };
  }
}

// ============================================================
//  Key Press (shortcuts)
// ============================================================

const KEY_MAP = {
  'enter': 'return', 'tab': 'tab', 'escape': 'escape',
  'space': 'space', 'delete': 'delete', 'backspace': 'delete',
  'up': 'up arrow', 'down': 'down arrow',
  'left': 'left arrow', 'right': 'right arrow',
};

const VALID_MODS = new Set(['cmd', 'command', 'ctrl', 'control', 'alt', 'option', 'shift']);
const VALID_SINGLE_KEYS = new Set([
  ...Object.keys(KEY_MAP),
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  'f1','f2','f3','f4','f5','f6','f7','f8','f9','f10','f11','f12',
]);

export async function keyPress(keys) {
  try {
    if (typeof keys !== 'string' || keys.length === 0) {
      throw new Error('Keys must be a non-empty string');
    }

    const parts = keys.toLowerCase().split('+');
    const key = parts[parts.length - 1];
    const mods = parts.slice(0, -1);

    // Validate all parts
    for (const mod of mods) {
      if (!VALID_MODS.has(mod)) {
        throw new Error(`Invalid modifier: "${mod}". Valid: cmd, ctrl, alt, shift`);
      }
    }
    if (!VALID_SINGLE_KEYS.has(key) && key.length !== 1) {
      throw new Error(`Invalid key: "${key}"`);
    }

    if (useNutJs) {
      const modifiers = [];
      for (const mod of mods) {
        if (mod === 'cmd' || mod === 'command') modifiers.push(nutjs.Key.LeftCmd);
        if (mod === 'ctrl' || mod === 'control') modifiers.push(nutjs.Key.LeftControl);
        if (mod === 'alt' || mod === 'option') modifiers.push(nutjs.Key.LeftAlt);
        if (mod === 'shift') modifiers.push(nutjs.Key.LeftShift);
      }
      const nutKey = nutjs.Key[key.charAt(0).toUpperCase() + key.slice(1)] || nutjs.Key[key.toUpperCase()];
      if (nutKey) {
        if (modifiers.length) {
          await nutjs.keyboard.pressKey(...modifiers, nutKey);
          await nutjs.keyboard.releaseKey(...modifiers, nutKey);
        } else {
          await nutjs.keyboard.pressKey(nutKey);
          await nutjs.keyboard.releaseKey(nutKey);
        }
      }
    } else {
      const modFlags = mods.map(m => {
        if (m === 'cmd' || m === 'command') return 'command down';
        if (m === 'ctrl' || m === 'control') return 'control down';
        if (m === 'alt' || m === 'option') return 'option down';
        if (m === 'shift') return 'shift down';
        return '';
      }).filter(Boolean);

      const mappedKey = KEY_MAP[key] || key;
      const modStr = modFlags.length ? ` using {${modFlags.join(', ')}}` : '';

      let script;
      if (mappedKey.length === 1) {
        // Single character — use keystroke (safe: validated above)
        const escaped = mappedKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        script = `tell application "System Events" to keystroke "${escaped}"${modStr}`;
      } else {
        // Named key — use key code
        script = `tell application "System Events" to key code ${getKeyCode(mappedKey)}${modStr}`;
      }
      await runOsascript(script);
    }
    logAction('key_press', { keys });
    return { success: true, keys };
  } catch (err) {
    logAction('key_press', { keys }, false);
    return { success: false, error: err.message };
  }
}

function getKeyCode(keyName) {
  const codes = {
    'return': 36, 'tab': 48, 'space': 49, 'delete': 51,
    'escape': 53, 'up arrow': 126, 'down arrow': 125,
    'left arrow': 123, 'right arrow': 124,
  };
  return codes[keyName] || 0;
}

// ============================================================
//  Scroll
// ============================================================

export async function scroll(direction = 'down', amount = 3) {
  try {
    if (!VALID_DIRECTIONS.has(direction)) direction = 'down';
    amount = validateAmount(amount);

    if (useNutJs) {
      const dir = direction === 'up' || direction === 'left' ? -amount : amount;
      if (direction === 'left' || direction === 'right') {
        await nutjs.mouse.scrollRight(dir);
      } else {
        await nutjs.mouse.scrollDown(dir);
      }
    } else {
      const dy = direction === 'up' ? amount : direction === 'down' ? -amount : 0;
      const dx = direction === 'left' ? amount : direction === 'right' ? -amount : 0;
      const code = [
        'import Quartz',
        `e = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 2, ${dy}, ${dx})`,
        'Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)',
      ].join('\n');
      await runPython(code);
    }
    logAction('scroll', { direction, amount });
    return { success: true, direction, amount };
  } catch (err) {
    logAction('scroll', { direction, amount }, false);
    return { success: false, error: err.message };
  }
}

// ============================================================
//  Capability Check
// ============================================================

export function getCapabilities() {
  return {
    backend: useNutJs ? 'nut.js' : 'applescript+python',
    moveCursor: true,
    click: true,
    typeText: true,
    keyPress: true,
    scroll: true,
    doubleClick: true,
    rightClick: true,
  };
}
