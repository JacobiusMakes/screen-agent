import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionMemory } from '../src/state/session-memory.js';

describe('SessionMemory', () => {
  let mem;

  beforeEach(() => {
    mem = new SessionMemory({ maxEntries: 10, dedupeWindow: 100 });
  });

  it('records and retrieves states', () => {
    mem.record({ ts: 1000, app: 'Chrome', title: 'GitHub', elements: [] });
    assert.equal(mem.entries.length, 1);
    assert.equal(mem.entries[0].state.app, 'Chrome');
  });

  it('deduplicates rapid identical states', () => {
    const state = { ts: 1000, app: 'Chrome', title: 'GitHub', elements: [] };
    mem.record(state);
    mem.record(state); // within dedupeWindow
    assert.equal(mem.entries.length, 1);
  });

  it('enforces maxEntries', () => {
    for (let i = 0; i < 15; i++) {
      mem.record({ ts: i * 1000, app: `App${i}`, title: `Title${i}` });
    }
    assert.equal(mem.entries.length, 10);
    assert.equal(mem.entries[0].state.app, 'App5'); // oldest 5 evicted
  });

  it('searches by text content', () => {
    mem.record({ ts: 1000, app: 'Chrome', title: 'GitHub Pull Request', elements: [] });
    mem.record({ ts: 2000, app: 'VS Code', title: 'index.js', elements: [{ text: 'function render' }] });
    mem.record({ ts: 3000, app: 'Terminal', title: 'npm test', elements: [] });

    const results = mem.search('pull request');
    assert.ok(results.length > 0);
    assert.equal(results[0].state.app, 'Chrome');
  });

  it('returns empty for no matches', () => {
    mem.record({ ts: 1000, app: 'Chrome', title: 'GitHub', elements: [] });
    const results = mem.search('zzzznoexist');
    assert.equal(results.length, 0);
  });

  it('getRecent returns last N', () => {
    for (let i = 0; i < 5; i++) {
      mem.record({ ts: i * 1000, app: `App${i}`, title: `T${i}` });
    }
    const recent = mem.getRecent(2);
    assert.equal(recent.length, 2);
    assert.equal(recent[1].state.app, 'App4');
  });

  it('getRange filters by time', () => {
    mem.record({ ts: 1000, app: 'A', title: '' });
    mem.record({ ts: 2000, app: 'B', title: '' });
    mem.record({ ts: 3000, app: 'C', title: '' });

    const range = mem.getRange(1500, 2500);
    assert.equal(range.length, 1);
    assert.equal(range[0].state.app, 'B');
  });

  it('getStats reports correctly', () => {
    mem.record({ ts: Date.now() - 5000, app: 'Chrome', title: '' });
    mem.record({ ts: Date.now(), app: 'VS Code', title: '' });

    const stats = mem.getStats();
    assert.equal(stats.entries, 2);
    assert.ok(stats.uniqueApps.includes('Chrome'));
    assert.ok(stats.uniqueApps.includes('VS Code'));
  });

  it('clear removes all entries', () => {
    mem.record({ ts: 1000, app: 'A', title: '' });
    mem.clear();
    assert.equal(mem.entries.length, 0);
  });
});
