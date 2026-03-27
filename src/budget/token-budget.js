/**
 * Token Budget Manager — prevents runaway costs
 *
 * Tracks token usage across all capture modes and enforces hard limits.
 * Automatically downgrades capture quality when approaching limits.
 *
 * Budget tiers:
 *   frugal:  $0.05/hr — ambient only, screenshots on demand
 *   normal:  $0.20/hr — full state every 30s, screenshots when needed
 *   rich:    $1.00/hr — full state + low-res screenshots every 30s
 *   unlimited: no limit (not recommended)
 */

/** Pricing per million tokens (input) as of March 2026 */
const PRICING = {
  'claude-sonnet': 3.0,
  'claude-haiku': 0.80,
  'claude-opus': 15.0,
  'gpt-4o': 2.50,
  'gpt-4o-mini': 0.15,
  'gpt-4.1': 2.0,
  'gpt-4.1-mini': 0.40,
  'gpt-4.1-nano': 0.10,
  'codex-mini': 1.50, // estimated
  'o3-mini': 1.10,
  'default': 3.0,
};

/** Budget presets: max dollars per hour */
const BUDGET_PRESETS = {
  frugal:    { maxPerHour: 0.05, defaultCapture: 'ambient',    screenshotQuality: 'low',    captureInterval: 60000 },
  normal:    { maxPerHour: 0.20, defaultCapture: 'structural',  screenshotQuality: 'medium', captureInterval: 30000 },
  rich:      { maxPerHour: 1.00, defaultCapture: 'structural',  screenshotQuality: 'high',   captureInterval: 15000 },
  unlimited: { maxPerHour: Infinity, defaultCapture: 'structural', screenshotQuality: 'high', captureInterval: 10000 },
};

export class TokenBudget {
  /**
   * @param {Object} options
   * @param {'frugal'|'normal'|'rich'|'unlimited'|number} [options.budget='normal'] — preset or custom $/hr
   * @param {string} [options.model='claude-sonnet'] — for pricing lookup
   */
  constructor({ budget = 'normal', model = 'claude-sonnet' } = {}) {
    if (typeof budget === 'string' && BUDGET_PRESETS[budget]) {
      this.preset = BUDGET_PRESETS[budget];
      this.presetName = budget;
    } else if (typeof budget === 'number') {
      this.preset = { ...BUDGET_PRESETS.normal, maxPerHour: budget };
      this.presetName = 'custom';
    } else {
      this.preset = BUDGET_PRESETS.normal;
      this.presetName = 'normal';
    }

    this.model = model;
    this.pricePerMillion = PRICING[model] || PRICING.default;

    // Usage tracking
    this.sessionStart = Date.now();
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.captures = 0;
    this.screenshots = 0;
    this.downgrades = 0;

    // Rolling window: track tokens in the last hour
    this.hourlyWindow = [];
  }

  /**
   * Record token usage from an API call.
   */
  recordUsage(inputTokens, outputTokens = 0) {
    const now = Date.now();
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.hourlyWindow.push({ ts: now, input: inputTokens, output: outputTokens });

    // Prune entries older than 1 hour
    const oneHourAgo = now - 3600000;
    this.hourlyWindow = this.hourlyWindow.filter(e => e.ts > oneHourAgo);
  }

  /**
   * Record a capture event.
   */
  recordCapture(type = 'structural') {
    this.captures++;
    // Estimate tokens based on type
    const estimates = { ambient: 26, structural: 143, screenshot_low: 85, screenshot_medium: 300, screenshot_high: 800 };
    this.recordUsage(estimates[type] || 100);
  }

  /**
   * Record a screenshot event.
   */
  recordScreenshot(quality = 'medium') {
    this.screenshots++;
    this.recordCapture(`screenshot_${quality}`);
  }

  /**
   * Get tokens used in the last hour.
   */
  getHourlyTokens() {
    const oneHourAgo = Date.now() - 3600000;
    return this.hourlyWindow
      .filter(e => e.ts > oneHourAgo)
      .reduce((sum, e) => sum + e.input + e.output, 0);
  }

  /**
   * Get cost in the last hour.
   */
  getHourlyCost() {
    return (this.getHourlyTokens() / 1000000) * this.pricePerMillion;
  }

  /**
   * Get total session cost.
   */
  getTotalCost() {
    return ((this.totalInputTokens + this.totalOutputTokens) / 1000000) * this.pricePerMillion;
  }

  /**
   * Check if we're within budget.
   * Returns the recommended capture mode based on remaining budget.
   */
  getRecommendedMode() {
    const hourlyCost = this.getHourlyCost();
    const remaining = this.preset.maxPerHour - hourlyCost;
    const percentUsed = hourlyCost / this.preset.maxPerHour;

    if (percentUsed >= 1.0) {
      this.downgrades++;
      return {
        capture: 'ambient',
        screenshotQuality: null, // no screenshots
        interval: 120000, // 2 minutes
        reason: 'BUDGET_EXCEEDED',
        warning: `Hourly budget of $${this.preset.maxPerHour.toFixed(2)} exceeded ($${hourlyCost.toFixed(4)} used)`,
      };
    }

    if (percentUsed >= 0.8) {
      this.downgrades++;
      return {
        capture: 'ambient',
        screenshotQuality: 'low',
        interval: 60000,
        reason: 'BUDGET_WARNING',
        warning: `80% of hourly budget used ($${hourlyCost.toFixed(4)} / $${this.preset.maxPerHour.toFixed(2)})`,
      };
    }

    if (percentUsed >= 0.5) {
      return {
        capture: this.preset.defaultCapture,
        screenshotQuality: 'low',
        interval: this.preset.captureInterval * 1.5,
        reason: 'BUDGET_MODERATE',
      };
    }

    return {
      capture: this.preset.defaultCapture,
      screenshotQuality: this.preset.screenshotQuality,
      interval: this.preset.captureInterval,
      reason: 'BUDGET_OK',
    };
  }

  /**
   * Get a full stats report.
   */
  getStats() {
    const sessionMinutes = (Date.now() - this.sessionStart) / 60000;
    const hourlyCost = this.getHourlyCost();
    const totalCost = this.getTotalCost();
    const mode = this.getRecommendedMode();

    return {
      preset: this.presetName,
      model: this.model,
      pricePerMillion: this.pricePerMillion,
      budget: {
        maxPerHour: this.preset.maxPerHour,
        currentHourlyCost: Number(hourlyCost.toFixed(6)),
        percentUsed: Number(((hourlyCost / this.preset.maxPerHour) * 100).toFixed(1)),
        remaining: Number((this.preset.maxPerHour - hourlyCost).toFixed(6)),
      },
      session: {
        durationMinutes: Number(sessionMinutes.toFixed(1)),
        totalCost: Number(totalCost.toFixed(6)),
        totalInputTokens: this.totalInputTokens,
        totalOutputTokens: this.totalOutputTokens,
        captures: this.captures,
        screenshots: this.screenshots,
        downgrades: this.downgrades,
      },
      recommended: mode,
    };
  }

  /**
   * Should we capture right now? Respects budget intervals.
   * @param {number} lastCaptureTs — timestamp of last capture
   */
  shouldCapture(lastCaptureTs) {
    const mode = this.getRecommendedMode();
    return Date.now() - lastCaptureTs >= mode.interval;
  }
}

/** List available budget presets */
export function getBudgetPresets() {
  return Object.entries(BUDGET_PRESETS).map(([name, p]) => ({
    name,
    maxPerHour: p.maxPerHour === Infinity ? 'unlimited' : `$${p.maxPerHour.toFixed(2)}`,
    defaultCapture: p.defaultCapture,
    screenshotQuality: p.screenshotQuality,
    captureIntervalSec: p.captureInterval / 1000,
  }));
}

/** List known model pricing */
export function getModelPricing() {
  return { ...PRICING };
}
