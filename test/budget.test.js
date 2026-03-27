import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBudget, getBudgetPresets, getModelPricing } from '../src/budget/token-budget.js';

describe('TokenBudget', () => {
  it('initializes with default preset', () => {
    const b = new TokenBudget();
    assert.equal(b.presetName, 'normal');
    assert.equal(b.totalInputTokens, 0);
    assert.equal(b.captures, 0);
  });

  it('supports all preset names', () => {
    for (const name of ['frugal', 'normal', 'rich', 'unlimited']) {
      const b = new TokenBudget({ budget: name });
      assert.equal(b.presetName, name);
    }
  });

  it('supports custom dollar amount', () => {
    const b = new TokenBudget({ budget: 0.10 });
    assert.equal(b.presetName, 'custom');
    assert.equal(b.preset.maxPerHour, 0.10);
  });

  it('records usage and tracks totals', () => {
    const b = new TokenBudget();
    b.recordUsage(100, 50);
    b.recordUsage(200, 100);
    assert.equal(b.totalInputTokens, 300);
    assert.equal(b.totalOutputTokens, 150);
  });

  it('calculates hourly cost', () => {
    const b = new TokenBudget({ model: 'claude-sonnet' }); // $3/M
    b.recordUsage(1000000); // 1M tokens
    const cost = b.getHourlyCost();
    assert.ok(cost >= 2.9 && cost <= 3.1, `Expected ~$3.00, got $${cost}`);
  });

  it('recommends ambient mode when budget exceeded', () => {
    const b = new TokenBudget({ budget: 'frugal' }); // $0.05/hr
    // Record enough to exceed budget
    for (let i = 0; i < 100; i++) b.recordUsage(1000);
    const mode = b.getRecommendedMode();
    assert.equal(mode.capture, 'ambient');
    assert.equal(mode.reason, 'BUDGET_EXCEEDED');
  });

  it('returns OK mode when under budget', () => {
    const b = new TokenBudget({ budget: 'rich' }); // $1/hr
    b.recordUsage(100);
    const mode = b.getRecommendedMode();
    assert.equal(mode.reason, 'BUDGET_OK');
    assert.equal(mode.capture, 'structural');
  });

  it('disables screenshots when budget exceeded', () => {
    const b = new TokenBudget({ budget: 'frugal' });
    for (let i = 0; i < 100; i++) b.recordUsage(1000);
    const mode = b.getRecommendedMode();
    assert.equal(mode.screenshotQuality, null);
  });

  it('tracks captures and screenshots separately', () => {
    const b = new TokenBudget();
    b.recordCapture('structural');
    b.recordCapture('ambient');
    b.recordScreenshot('medium');
    assert.equal(b.captures, 3); // screenshots also count as captures
    assert.equal(b.screenshots, 1);
  });

  it('getStats returns comprehensive report', () => {
    const b = new TokenBudget({ budget: 'normal', model: 'gpt-4o' });
    b.recordUsage(500, 100);
    const stats = b.getStats();
    assert.equal(stats.preset, 'normal');
    assert.equal(stats.model, 'gpt-4o');
    assert.ok(stats.budget.maxPerHour > 0);
    assert.ok(stats.session.totalInputTokens === 500);
    assert.ok(stats.recommended.reason);
  });

  it('shouldCapture respects interval', () => {
    const b = new TokenBudget({ budget: 'frugal' }); // 60s interval
    // Just captured — shouldn't capture again
    assert.equal(b.shouldCapture(Date.now()), false);
    // Captured 2 minutes ago — should capture
    assert.equal(b.shouldCapture(Date.now() - 120000), true);
  });
});

describe('getBudgetPresets', () => {
  it('returns all four presets', () => {
    const presets = getBudgetPresets();
    assert.equal(presets.length, 4);
    assert.ok(presets.find(p => p.name === 'frugal'));
    assert.ok(presets.find(p => p.name === 'unlimited'));
  });
});

describe('getModelPricing', () => {
  it('includes known models', () => {
    const pricing = getModelPricing();
    assert.ok(pricing['claude-sonnet'] > 0);
    assert.ok(pricing['gpt-4o'] > 0);
    assert.ok(pricing['gpt-4.1-nano'] > 0);
  });
});
