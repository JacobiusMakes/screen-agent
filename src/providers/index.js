/**
 * Multi-Provider Abstraction Layer
 *
 * Supports sending screen state to different LLM providers:
 *   - Anthropic (Claude) — native vision + tool use
 *   - OpenAI (GPT-4o, Codex) — function calling + vision
 *   - Generic — any provider that accepts messages
 *
 * Each provider adapts the screen state into the format that
 * provider expects, handling the differences in how they accept
 * images, tool definitions, and system prompts.
 */

/**
 * @typedef {Object} ProviderConfig
 * @property {'anthropic'|'openai'|'generic'} provider
 * @property {string} apiKey
 * @property {string} [model]
 * @property {string} [baseUrl]
 * @property {number} [maxTokens]
 */

/**
 * @typedef {Object} ScreenMessage
 * @property {string} role
 * @property {Array<{type: string, text?: string, image?: string}>} content
 */

// ============================================================
//  Anthropic (Claude)
// ============================================================

class AnthropicProvider {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'claude-sonnet-4-20250514';
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    this.maxTokens = config.maxTokens || 4096;
  }

  /**
   * Format screen state as Claude message content blocks.
   */
  formatScreenState(state, screenshot = null) {
    const content = [];

    // Text content: accessibility tree
    if (state) {
      content.push({
        type: 'text',
        text: `[Screen State] App: ${state.app} | Window: ${state.title || '(none)'}\n` +
          (state.elements || []).map(e =>
            `  [${e.role}] ${e.text} @ (${e.bounds?.join(',')})`
          ).join('\n'),
      });
    }

    // Image content: screenshot
    if (screenshot) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: screenshot.image,
        },
      });
    }

    return content;
  }

  /**
   * Send a message to Claude and get a response.
   */
  async chat(messages, { system, tools } = {}) {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
    };
    if (system) body.system = system;
    if (tools) body.tools = tools;

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic ${res.status}: ${err}`);
    }

    const data = await res.json();
    return {
      content: data.content,
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
        cacheReadTokens: data.usage?.cache_read_input_tokens || 0,
        cacheCreateTokens: data.usage?.cache_creation_input_tokens || 0,
      },
      stopReason: data.stop_reason,
    };
  }
}

// ============================================================
//  OpenAI (GPT-4o, Codex, o-series)
// ============================================================

class OpenAIProvider {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'gpt-4o';
    this.baseUrl = config.baseUrl || 'https://api.openai.com';
    this.maxTokens = config.maxTokens || 4096;
  }

  /**
   * Format screen state as OpenAI message content blocks.
   * OpenAI uses a different image format than Anthropic.
   */
  formatScreenState(state, screenshot = null) {
    const content = [];

    if (state) {
      content.push({
        type: 'text',
        text: `[Screen State] App: ${state.app} | Window: ${state.title || '(none)'}\n` +
          (state.elements || []).map(e =>
            `  [${e.role}] ${e.text} @ (${e.bounds?.join(',')})`
          ).join('\n'),
      });
    }

    if (screenshot) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${screenshot.image}`,
          detail: 'low', // 'low' = 85 tokens fixed, 'high' = resolution-based
        },
      });
    }

    return content;
  }

  /**
   * Send a message to OpenAI and get a response.
   */
  async chat(messages, { system, tools } = {}) {
    const formattedMessages = [];

    if (system) {
      formattedMessages.push({ role: 'system', content: system });
    }
    formattedMessages.push(...messages);

    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: formattedMessages,
    };

    if (tools) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema || t.input_schema,
        },
      }));
    }

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI ${res.status}: ${err}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];

    return {
      content: choice?.message?.content || '',
      toolCalls: choice?.message?.tool_calls || [],
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens || 0,
        cacheCreateTokens: 0,
      },
      stopReason: choice?.finish_reason,
    };
  }
}

// ============================================================
//  Factory
// ============================================================

/**
 * Create a provider instance from config.
 * @param {ProviderConfig} config
 */
export function createProvider(config) {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    default:
      throw new Error(`Unknown provider: ${config.provider}. Use 'anthropic' or 'openai'.`);
  }
}

/**
 * Detect provider from API key format.
 * @param {string} apiKey
 * @returns {'anthropic'|'openai'|'unknown'}
 */
export function detectProvider(apiKey) {
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('sk-')) return 'openai';
  return 'unknown';
}

export { AnthropicProvider, OpenAIProvider };
