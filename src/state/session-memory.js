/**
 * Session Memory — vector store for temporal screen state recall
 *
 * Embeds each screen state into a vector and stores it with a timestamp.
 * This enables temporal queries:
 *   "What was on screen when I was editing the config file?"
 *   "Show me the error that appeared 5 minutes ago"
 *
 * Uses a simple cosine similarity search over embedded state descriptions.
 * States are stored in-memory for the session, with optional SQLite persistence.
 */

import { createHash } from 'node:crypto';

/**
 * Simple in-memory vector store for session state.
 * Stores text descriptions of screen states with timestamps.
 * Uses TF-IDF-like term frequency for lightweight "embedding" without
 * requiring transformers.js (which is heavy). Upgradeable to real
 * embeddings in Phase 4.
 */
export class SessionMemory {
  constructor({ maxEntries = 500, dedupeWindow = 5000 } = {}) {
    /** @type {Array<{ts: number, text: string, state: object, terms: Map<string, number>}>} */
    this.entries = [];
    this.maxEntries = maxEntries;
    this.dedupeWindow = dedupeWindow;
    this.lastHash = '';
  }

  /**
   * Record a screen state into memory.
   * Deduplicates rapid identical states within the dedupeWindow.
   */
  record(state) {
    if (!state) return;

    // Build a text description for search
    const text = this._stateToText(state);
    const hash = createHash('md5').update(text).digest('hex');

    // Dedupe: skip if same as last entry within window
    if (hash === this.lastHash) {
      const last = this.entries[this.entries.length - 1];
      if (last && (Date.now() - (last._recordedAt || last.ts)) < this.dedupeWindow) {
        return; // Skip duplicate
      }
    }
    this.lastHash = hash;

    // Tokenize and compute term frequencies
    const terms = this._tokenize(text);

    this.entries.push({
      ts: state.ts || Date.now(),
      _recordedAt: Date.now(),
      text,
      state,
      terms,
    });

    // Enforce max entries (FIFO)
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /**
   * Search memory for states matching a query.
   * Returns the top-k most relevant states, sorted by relevance.
   *
   * @param {string} query — Natural language query
   * @param {number} topK — Number of results to return
   * @returns {Array<{ts: number, text: string, state: object, score: number}>}
   */
  search(query, topK = 5) {
    if (this.entries.length === 0) return [];

    const queryTerms = this._tokenize(query);
    const scored = this.entries.map(entry => ({
      ...entry,
      score: this._cosineSimilarity(queryTerms, entry.terms),
    }));

    return scored
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ ts, text, state, score }) => ({ ts, text, state, score }));
  }

  /**
   * Get states from a time range.
   *
   * @param {number} fromMs — Start timestamp (ms since epoch)
   * @param {number} toMs — End timestamp (ms since epoch)
   */
  getRange(fromMs, toMs) {
    return this.entries
      .filter(e => e.ts >= fromMs && e.ts <= toMs)
      .map(({ ts, text, state }) => ({ ts, text, state }));
  }

  /**
   * Get the last N states.
   */
  getRecent(n = 10) {
    return this.entries
      .slice(-n)
      .map(({ ts, text, state }) => ({ ts, text, state }));
  }

  /**
   * Get memory stats.
   */
  getStats() {
    const now = Date.now();
    const oldest = this.entries.length > 0 ? this.entries[0].ts : null;
    const newest = this.entries.length > 0 ? this.entries[this.entries.length - 1].ts : null;

    return {
      entries: this.entries.length,
      maxEntries: this.maxEntries,
      oldestMs: oldest ? now - oldest : null,
      newestMs: newest ? now - newest : null,
      uniqueApps: [...new Set(this.entries.map(e => e.state?.app).filter(Boolean))],
    };
  }

  /**
   * Clear all memory.
   */
  clear() {
    this.entries = [];
    this.lastHash = '';
  }

  // ── Internal Methods ──────────────────────────────────────

  /**
   * Convert a screen state to a searchable text description.
   */
  _stateToText(state) {
    const parts = [];
    if (state.app) parts.push(`app:${state.app}`);
    if (state.title) parts.push(`window:${state.title}`);
    if (state.url) parts.push(`url:${state.url}`);

    if (state.elements) {
      for (const el of state.elements) {
        if (el.text) parts.push(el.text);
      }
    }

    if (state.focused?.text) {
      parts.push(`focused:${state.focused.text}`);
    }

    return parts.join(' ');
  }

  /**
   * Tokenize text into term frequency map.
   * Simple bag-of-words with lowercasing and stopword removal.
   */
  _tokenize(text) {
    const stopwords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'can', 'to', 'of', 'in',
      'for', 'on', 'with', 'at', 'by', 'from', 'as', 'or', 'and',
      'not', 'no', 'but', 'if', 'then', 'than', 'that', 'this',
      'it', 'its', 'my', 'your', 'we', 'they', 'he', 'she',
    ]);

    const terms = new Map();
    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !stopwords.has(w));

    for (const word of words) {
      terms.set(word, (terms.get(word) || 0) + 1);
    }

    return terms;
  }

  /**
   * Cosine similarity between two term frequency maps.
   */
  _cosineSimilarity(a, b) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (const [term, freqA] of a) {
      normA += freqA * freqA;
      if (b.has(term)) {
        dotProduct += freqA * b.get(term);
      }
    }

    for (const [, freqB] of b) {
      normB += freqB * freqB;
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
