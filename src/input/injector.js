/**
 * Input Injector — move cursor, click, type, scroll, press keys
 *
 * Uses nut.js when available (best cross-platform support).
 * Falls back to AppleScript/osascript on macOS.
 *
 * All actions are logged for safety/audit and can be previewed
 * before execution via the confirmation flow.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(exec);

let nutjs = null;
let useNutJs = false;

// Try to load nut.js — graceful fallback if not installed
try {
  nutjs = await import('@nut-tree-fork/nut-js');
  useNutJs = true;
} catch {
  // nut.js not installed — use AppleScript fallback
}

/** Action log for audit trail */
const actionLog = [];

function logAction(action, params, success = true) {
  actionLog.push({
    ts: Date.now(),
    action,
    params,
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
//  Cursor Movement
// ============================================================

export async function moveCursor(x, y) {
  try {
    if (useNutJs) {
      await nutjs.mouse.setPosition({ x, y });
    } else {
      // AppleScript: uses CoreGraphics via python one-liner
      await execP(
        `python3 -c "import Quartz; Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (${x}, ${y}), 0))"`,
        { timeout: 3000 }
      );
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
      // AppleScript fallback
      const buttonMap = {
        left: 'kCGEventLeftMouseDown, kCGEventLeftMouseUp',
        right: 'kCGEventRightMouseDown, kCGEventRightMouseUp',
      };
      const [down, up] = (buttonMap[button] || buttonMap.left).split(', ');

      await execP(
        `python3 -c "
import Quartz, time
pos = (${x}, ${y})
Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, pos, 0))
time.sleep(0.05)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.${down}, pos, 0))
time.sleep(0.05)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.${up}, pos, 0))
"`,
        { timeout: 3000 }
      );

      if (button === 'double') {
        // Second click for double-click
        await execP(
          `python3 -c "
import Quartz, time
pos = (${x}, ${y})
time.sleep(0.1)
e = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, pos, 0)
Quartz.CGEventSetIntegerValueField(e, Quartz.kCGMouseEventClickState, 2)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
time.sleep(0.05)
e2 = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, pos, 0)
Quartz.CGEventSetIntegerValueField(e2, Quartz.kCGMouseEventClickState, 2)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, e2)
"`,
          { timeout: 3000 }
        );
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
    if (useNutJs) {
      await nutjs.keyboard.type(text);
    } else {
      // AppleScript: keystroke command
      // Escape special chars for AppleScript string
      const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await execP(
        `osascript -e 'tell application "System Events" to keystroke "${escaped}"'`,
        { timeout: 5000 }
      );
    }
    logAction('type_text', { text: text.substring(0, 50) + (text.length > 50 ? '...' : '') });
    return { success: true, length: text.length };
  } catch (err) {
    logAction('type_text', { text: text.substring(0, 20) }, false);
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

export async function keyPress(keys) {
  try {
    if (useNutJs) {
      // Parse "cmd+s" format
      const parts = keys.toLowerCase().split('+');
      const modifiers = [];
      let key = parts[parts.length - 1];

      for (const part of parts.slice(0, -1)) {
        if (part === 'cmd' || part === 'command') modifiers.push(nutjs.Key.LeftCmd);
        if (part === 'ctrl' || part === 'control') modifiers.push(nutjs.Key.LeftControl);
        if (part === 'alt' || part === 'option') modifiers.push(nutjs.Key.LeftAlt);
        if (part === 'shift') modifiers.push(nutjs.Key.LeftShift);
      }

      // Map key names to nut.js keys
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
      // Parse "cmd+s" into AppleScript
      const parts = keys.toLowerCase().split('+');
      const key = parts[parts.length - 1];
      const mods = parts.slice(0, -1);

      const modFlags = mods.map(m => {
        if (m === 'cmd' || m === 'command') return 'command down';
        if (m === 'ctrl' || m === 'control') return 'control down';
        if (m === 'alt' || m === 'option') return 'option down';
        if (m === 'shift') return 'shift down';
        return '';
      }).filter(Boolean);

      const mappedKey = KEY_MAP[key] || key;
      const modStr = modFlags.length ? ` using {${modFlags.join(', ')}}` : '';

      if (mappedKey.length === 1) {
        await execP(
          `osascript -e 'tell application "System Events" to keystroke "${mappedKey}"${modStr}'`,
          { timeout: 3000 }
        );
      } else {
        await execP(
          `osascript -e 'tell application "System Events" to key code ${getKeyCode(mappedKey)}${modStr}'`,
          { timeout: 3000 }
        );
      }
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
      await execP(
        `python3 -c "
import Quartz
e = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 2, ${dy}, ${dx})
Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)
"`,
        { timeout: 3000 }
      );
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
