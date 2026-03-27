/**
 * Diff Engine — computes minimal state updates between screen captures
 *
 * Instead of sending the full accessibility tree every time, we compute
 * what changed and only send the delta. This dramatically reduces token
 * usage for incremental updates.
 *
 * A full state might be 200 tokens. A diff is typically 20-50 tokens.
 */

export class DiffEngine {
  constructor() {
    /** @type {object|null} Last known state */
    this.lastState = null;
    /** @type {Map<string, object>} Element cache keyed by role+text hash */
    this.elementCache = new Map();
  }

  /**
   * Compute the diff between the current state and the last known state.
   * Returns either a full state (if too much changed) or a diff.
   *
   * @param {object} newState — Current screen state
   * @returns {{ type: 'structural'|'diff', ... }}
   */
  computeUpdate(newState) {
    if (!this.lastState) {
      // First capture — send full state
      this.lastState = newState;
      this._cacheElements(newState.elements || []);
      return newState;
    }

    // Check if app or window changed — if so, send full state
    if (newState.app !== this.lastState.app || newState.title !== this.lastState.title) {
      this.lastState = newState;
      this.elementCache.clear();
      this._cacheElements(newState.elements || []);
      return newState;
    }

    // Same app/window — compute element diff
    const oldElements = this.lastState.elements || [];
    const newElements = newState.elements || [];

    const oldKeys = new Set(oldElements.map(e => this._elementKey(e)));
    const newKeys = new Set(newElements.map(e => this._elementKey(e)));

    const added = newElements.filter(e => !oldKeys.has(this._elementKey(e)));
    const removed = oldElements
      .filter(e => !newKeys.has(this._elementKey(e)))
      .map(e => `${e.role}:${e.text.substring(0, 30)}`);

    // Check for changed elements (same role+position, different text)
    const changed = [];
    for (const newEl of newElements) {
      const key = this._positionKey(newEl);
      const oldEl = oldElements.find(e => this._positionKey(e) === key && e.text !== newEl.text);
      if (oldEl) {
        changed.push({
          role: newEl.role,
          oldText: oldEl.text.substring(0, 60),
          newText: newEl.text.substring(0, 60),
          bounds: newEl.bounds,
        });
      }
    }

    // Check focus change
    const focusChanged = JSON.stringify(newState.focused) !== JSON.stringify(this.lastState.focused);

    // If diff is small, send diff. If >60% changed, send full state.
    const totalChanges = added.length + removed.length + changed.length;
    const totalElements = Math.max(oldElements.length, newElements.length, 1);

    this.lastState = newState;
    this._cacheElements(newElements);

    if (totalChanges === 0 && !focusChanged) {
      // Nothing changed
      return null;
    }

    if (totalChanges / totalElements > 0.6) {
      // Too much changed — send full state (cheaper than a big diff)
      return newState;
    }

    // Send diff
    return {
      type: 'diff',
      ts: newState.ts || Date.now(),
      app: newState.app,
      added: added.length > 0 ? added : undefined,
      removed: removed.length > 0 ? removed : undefined,
      changed: changed.length > 0 ? changed : undefined,
      focused: focusChanged ? newState.focused : undefined,
      cursor: newState.cursor,
    };
  }

  /**
   * Reset the diff engine (e.g., after a context window reset).
   */
  reset() {
    this.lastState = null;
    this.elementCache.clear();
  }

  /**
   * Get stats about the diff engine state.
   */
  getStats() {
    return {
      hasBaseline: this.lastState !== null,
      cachedElements: this.elementCache.size,
      lastApp: this.lastState?.app || null,
      lastTitle: this.lastState?.title || null,
    };
  }

  // ── Internal ──────────────────────────────────────

  _elementKey(el) {
    return `${el.role}|${el.text}|${el.bounds?.join(',')}`;
  }

  _positionKey(el) {
    return `${el.role}|${el.bounds?.join(',')}`;
  }

  _cacheElements(elements) {
    this.elementCache.clear();
    for (const el of elements) {
      this.elementCache.set(this._elementKey(el), el);
    }
  }
}
