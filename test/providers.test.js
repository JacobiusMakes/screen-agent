import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, detectProvider, AnthropicProvider, OpenAIProvider } from '../src/providers/index.js';

describe('Provider Factory', () => {
  it('creates Anthropic provider', () => {
    const p = createProvider({ provider: 'anthropic', apiKey: 'sk-ant-test' });
    assert.ok(p instanceof AnthropicProvider);
    assert.equal(p.model, 'claude-sonnet-4-20250514');
  });

  it('creates OpenAI provider', () => {
    const p = createProvider({ provider: 'openai', apiKey: 'sk-test' });
    assert.ok(p instanceof OpenAIProvider);
    assert.equal(p.model, 'gpt-4o');
  });

  it('respects custom model', () => {
    const p = createProvider({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-4.1-mini' });
    assert.equal(p.model, 'gpt-4.1-mini');
  });

  it('throws on unknown provider', () => {
    assert.throws(() => createProvider({ provider: 'gemini', apiKey: 'test' }), /Unknown provider/);
  });
});

describe('detectProvider', () => {
  it('detects Anthropic keys', () => {
    assert.equal(detectProvider('sk-ant-api03-abc123'), 'anthropic');
  });

  it('detects OpenAI keys', () => {
    assert.equal(detectProvider('sk-proj-abc123'), 'openai');
  });

  it('returns unknown for other formats', () => {
    assert.equal(detectProvider('gsk_abc123'), 'unknown');
  });
});

describe('AnthropicProvider', () => {
  it('formats screen state as text blocks', () => {
    const p = new AnthropicProvider({ apiKey: 'test' });
    const state = { app: 'VSCode', title: 'main.ts', elements: [
      { role: 'button', text: 'Save', bounds: [10, 20, 100, 40] },
    ]};
    const content = p.formatScreenState(state);
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
    assert.ok(content[0].text.includes('VSCode'));
    assert.ok(content[0].text.includes('[button] Save'));
  });

  it('formats screenshot as base64 image block', () => {
    const p = new AnthropicProvider({ apiKey: 'test' });
    const screenshot = { image: 'abc123base64data' };
    const content = p.formatScreenState(null, screenshot);
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'image');
    assert.equal(content[0].source.type, 'base64');
    assert.equal(content[0].source.media_type, 'image/jpeg');
  });

  it('combines state and screenshot', () => {
    const p = new AnthropicProvider({ apiKey: 'test' });
    const state = { app: 'Chrome', title: 'Google', elements: [] };
    const screenshot = { image: 'data' };
    const content = p.formatScreenState(state, screenshot);
    assert.equal(content.length, 2);
    assert.equal(content[0].type, 'text');
    assert.equal(content[1].type, 'image');
  });
});

describe('OpenAIProvider', () => {
  it('formats screenshot as image_url with data URI', () => {
    const p = new OpenAIProvider({ apiKey: 'test' });
    const screenshot = { image: 'abc123' };
    const content = p.formatScreenState(null, screenshot);
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'image_url');
    assert.ok(content[0].image_url.url.startsWith('data:image/jpeg;base64,'));
    assert.equal(content[0].image_url.detail, 'low');
  });

  it('formats screen state as text', () => {
    const p = new OpenAIProvider({ apiKey: 'test' });
    const state = { app: 'Finder', title: 'Downloads', elements: [
      { role: 'statictext', text: 'file.pdf', bounds: [0, 0, 200, 20] },
    ]};
    const content = p.formatScreenState(state);
    assert.equal(content[0].type, 'text');
    assert.ok(content[0].text.includes('Finder'));
  });
});
