import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DiffEngine } from '../src/state/diff-engine.js';

describe('DiffEngine', () => {
  let engine;

  beforeEach(() => {
    engine = new DiffEngine();
  });

  it('returns full state on first capture', () => {
    const state = { type: 'structural', ts: 1000, app: 'Chrome', title: 'GitHub', elements: [] };
    const result = engine.computeUpdate(state);
    assert.equal(result.type, 'structural');
    assert.equal(result.app, 'Chrome');
  });

  it('returns null when nothing changed', () => {
    const state = { type: 'structural', ts: 1000, app: 'Chrome', title: 'GitHub', elements: [
      { role: 'button', text: 'Submit', bounds: [10, 20, 100, 30] }
    ]};
    engine.computeUpdate(state);
    const diff = engine.computeUpdate({ ...state, ts: 2000 });
    assert.equal(diff, null);
  });

  it('returns full state on app change', () => {
    engine.computeUpdate({ type: 'structural', ts: 1000, app: 'Chrome', title: 'GitHub', elements: [] });
    const result = engine.computeUpdate({ type: 'structural', ts: 2000, app: 'VS Code', title: 'index.js', elements: [] });
    assert.equal(result.type, 'structural');
    assert.equal(result.app, 'VS Code');
  });

  it('returns diff when elements change slightly', () => {
    const baseElements = [
      { role: 'button', text: 'Save', bounds: [10, 10, 80, 30] },
      { role: 'button', text: 'Cancel', bounds: [100, 10, 80, 30] },
      { role: 'text', text: 'Hello world', bounds: [10, 50, 200, 20] },
    ];

    engine.computeUpdate({ type: 'structural', ts: 1000, app: 'App', title: 'Win', elements: baseElements });

    const newElements = [
      ...baseElements,
      { role: 'button', text: 'New Button', bounds: [200, 10, 80, 30] },
    ];

    const diff = engine.computeUpdate({ type: 'structural', ts: 2000, app: 'App', title: 'Win', elements: newElements });
    assert.equal(diff.type, 'diff');
    assert.ok(diff.added.length > 0);
    assert.equal(diff.added[0].text, 'New Button');
  });

  it('detects removed elements', () => {
    const elements = [
      { role: 'button', text: 'A', bounds: [0, 0, 50, 20] },
      { role: 'button', text: 'B', bounds: [60, 0, 50, 20] },
    ];
    engine.computeUpdate({ type: 'structural', ts: 1000, app: 'App', title: 'Win', elements });
    
    const diff = engine.computeUpdate({ type: 'structural', ts: 2000, app: 'App', title: 'Win', elements: [elements[0]] });
    assert.equal(diff.type, 'diff');
    assert.ok(diff.removed.length > 0);
  });

  it('sends full state when >60% changed', () => {
    const elements = Array.from({ length: 10 }, (_, i) => ({ role: 'text', text: `Item ${i}`, bounds: [0, i*20, 100, 20] }));
    engine.computeUpdate({ type: 'structural', ts: 1000, app: 'App', title: 'Win', elements });

    // Replace 8 of 10 elements
    const newElements = Array.from({ length: 10 }, (_, i) => ({ role: 'text', text: `New ${i}`, bounds: [0, i*20, 100, 20] }));
    const result = engine.computeUpdate({ type: 'structural', ts: 2000, app: 'App', title: 'Win', elements: newElements });
    assert.equal(result.type, 'structural'); // Full state, not diff
  });

  it('reset clears baseline', () => {
    engine.computeUpdate({ type: 'structural', ts: 1000, app: 'Chrome', title: 'X', elements: [] });
    engine.reset();
    assert.equal(engine.lastState, null);
  });
});
