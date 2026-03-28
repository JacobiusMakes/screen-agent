/**
 * Cursor Highlight — Node.js wrapper for the Swift overlay process
 *
 * Manages the CursorHighlight.swift child process lifecycle.
 * Sends fire-and-forget JSON-line commands to draw visual effects.
 *
 * Usage:
 *   import { initHighlight, showMove, showClick, shutdown } from './overlay/highlight.js';
 *   initHighlight();                         // optional — auto-inits on first call
 *   showMove([100, 200], [500, 400]);        // glow + trail + landing dot
 *   showClick([500, 400], 'left');           // ripple effect
 *   shutdown();                               // kill process
 *
 * Disable via env: SCREEN_AGENT_HIGHLIGHT=false
 */

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SWIFT_PATH = join(__dirname, '..', '..', 'swift-bridge', 'CursorHighlight.swift');

let child = null;
let disabled = process.env.SCREEN_AGENT_HIGHLIGHT === 'false';
let spawning = false;

/**
 * Spawn the Swift overlay process (lazy — called on first effect).
 */
export function initHighlight() {
  if (disabled || child || spawning) return;
  spawning = true;

  try {
    child = spawn('swift', [SWIFT_PATH], {
      stdio: ['pipe', 'ignore', 'pipe'],
      detached: false,
    });

    child.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg === 'ready') {
        spawning = false;
      }
    });

    child.on('error', () => {
      child = null;
      spawning = false;
    });

    child.on('exit', () => {
      child = null;
      spawning = false;
    });

    // Clean up on parent exit
    const cleanup = () => {
      if (child) {
        child.kill('SIGTERM');
        child = null;
      }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  } catch {
    child = null;
    spawning = false;
  }
}

/**
 * Send a command to the overlay process. Fire-and-forget.
 */
function send(cmd) {
  if (disabled) return;
  if (!child) initHighlight();
  // Wait a tick for process to spawn if needed
  if (child && child.stdin.writable) {
    try {
      child.stdin.write(JSON.stringify(cmd) + '\n');
    } catch {
      // Process died — will respawn on next call
      child = null;
    }
  }
}

/**
 * Show move effect: glow at origin, arc trail to destination, landing dot.
 * @param {[number, number]} from - Origin [x, y]
 * @param {[number, number]} to - Destination [x, y]
 */
export function showMove(from, to) {
  send({ action: 'move', from, to });
}

/**
 * Show click effect: ripple at position.
 * @param {[number, number]} at - Click position [x, y]
 * @param {'left'|'right'|'double'} button - Click type
 */
export function showClick(at, button = 'left') {
  send({ action: 'click', at, button });
}

/**
 * Hide all effects immediately.
 */
export function hideHighlight() {
  send({ action: 'hide' });
}

/**
 * Kill the overlay process.
 */
export function shutdown() {
  if (child) {
    send({ action: 'quit' });
    setTimeout(() => {
      if (child) {
        child.kill('SIGTERM');
        child = null;
      }
    }, 200);
  }
}

/**
 * Check if highlight is enabled.
 */
export function isEnabled() {
  return !disabled;
}

/**
 * Enable/disable at runtime.
 */
export function setEnabled(enabled) {
  disabled = !enabled;
  if (disabled) shutdown();
}
