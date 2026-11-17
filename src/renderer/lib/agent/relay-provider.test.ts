/**
 * Fork (relay provider): the OpenAI-compatible relay (中转站) BYOK route.
 * Covers the contract shapes, the conservative no-reasoning profiles, the
 * base-URL setting helper and the wire behavior of the relay client factory.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_PROVIDER_OPTIONS,
  BYOK_AGENT_PROVIDERS,
  agentProviderOption,
  agentProviderModelOption,
  isAgentModelForProvider,
  isByokAgentProvider,
  normalizeAgentProvider,
  normalizeAgentProviderModel,
  normalizeAgentProviderThinking,
  setByokModelCatalog,
} from './runtime/agent-provider-contract';
import { normalizeRelayBaseURL, writeRelayBaseURL } from '../ai/relay-endpoint';
import { OpenAIProvider } from '../ai/client/providers/openai';
import type { AICompletionChunk } from '../ai/types';

describe('relay provider contract', () => {
  it('joins the certified BYOK provider set and normalizes like the others', () => {
    expect(BYOK_AGENT_PROVIDERS).toContain('relay');
    expect(isByokAgentProvider('relay')).toBe(true);
    expect(normalizeAgentProvider('relay')).toBe('relay');
    expect(AGENT_PROVIDER_OPTIONS.find((provider) => provider.value === 'relay')).toBeDefined();
  });

  it('keeps an empty bundled catalog: relay models come from the endpoint or manual entry', () => {
    expect(agentProviderOption('relay').models).toEqual([]);
    // Unset model stays unset; the provider rejects it explicitly on send.
    expect(normalizeAgentProviderModel('relay', undefined)).toBe('');
    expect(agentProviderModelOption('relay', '').value).toBe('');
  });

  it('accepts vendor-prefixed and plain relay model ids, rejecting malformed ones', () => {
    expect(isAgentModelForProvider('relay', 'gpt-4o')).toBe(true);
    expect(isAgentModelForProvider('relay', 'openai/gpt-4o')).toBe(true);
    expect(isAgentModelForProvider('relay', 'deepseek-chat')).toBe(true);
    expect(isAgentModelForProvider('relay', 'claude-3.5-sonnet')).toBe(true);
    expect(isAgentModelForProvider('relay', '')).toBe(false);
    expect(isAgentModelForProvider('relay', '模型名')).toBe(false);
    expect(isAgentModelForProvider('relay', 'a'.repeat(201))).toBe(false);
    expect(normalizeAgentProviderModel('relay', 'openai/gpt-4o')).toBe('openai/gpt-4o');
  });

  it('gives listed relay models a conservative no-reasoning profile', () => {
    setByokModelCatalog('relay', [
      {
        id: 'gpt-4o',
        displayName: null,
        created: null,
        contextWindow: null,
        maxOutputTokens: null,
        adaptiveThinking: null,
        efforts: null,
        defaultEffort: null,
      },
    ]);
    try {
      const option = agentProviderOption('relay').models[0]!;
      expect(option.value).toBe('gpt-4o');
      expect(option.reasoning.thinkingModes).toEqual(['off']);
      expect(option.reasoning.efforts).toEqual([]);
      expect(option.context.contextWindowTokens).toBe(128_000);
      expect(option.context.maxOutputTokens).toBeNull();
      expect(normalizeAgentProviderThinking('relay', 'gpt-4o', 'adaptive')).toBe('off');
    } finally {
      setByokModelCatalog('relay', null);
    }
    expect(agentProviderOption('relay').models).toEqual([]);
  });
});

describe('relay base URL setting', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes base URLs strictly', () => {
    expect(normalizeRelayBaseURL(' https://relay.example.com/v1/ ')).toBe('https://relay.example.com/v1');
    expect(normalizeRelayBaseURL('https://relay.example.com///')).toBe('https://relay.example.com');
    expect(normalizeRelayBaseURL('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080/v1');
    expect(normalizeRelayBaseURL('ftp://relay.example.com')).toBe('');
    expect(normalizeRelayBaseURL('not a url')).toBe('');
    expect(normalizeRelayBaseURL('')).toBe('');
    expect(normalizeRelayBaseURL(undefined)).toBe('');
  });

  it('persists only normalized values when storage is available', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } });
    expect(writeRelayBaseURL('https://relay.example.com/v1///')).toBe('https://relay.example.com/v1');
    expect(store.get('fork.relay-endpoint.baseURL')).toBe('https://relay.example.com/v1');
    expect(writeRelayBaseURL('nope')).toBe('');
    expect(store.has('fork.relay-endpoint.baseURL')).toBe(false);
  });
});

describe('relay client wire behavior', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function installCaptureFetch(requests: Array<{ url: string; body: Record<string, unknown> }>): void {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        body: JSON.parse((init?.body ?? '') as string) as Record<string, unknown>,
      });
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n'
        + 'data: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }));
  }

  async function collect(stream: AsyncIterable<AICompletionChunk>): Promise<AICompletionChunk[]> {
    const chunks: AICompletionChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  }

  it('sends chat completions to the relay base URL and omits reasoning_effort', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    installCaptureFetch(requests);
    const provider = new OpenAIProvider({
      apiKey: 'relay-key',
      baseURL: 'https://relay.example.com/v1',
      defaultModel: 'gpt-6.1-terra',
      omitReasoningEffort: true,
    });
    await collect(provider.stream!({
      model: 'gpt-6.1-terra',
      messages: [{ role: 'user', content: 'Return exactly OK.' }],
      signal: undefined,
    }));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://relay.example.com/v1/chat/completions');
    expect(requests[0]!.body.model).toBe('gpt-6.1-terra');
    expect('reasoning_effort' in requests[0]!.body).toBe(false);
  });

  it('keeps the OpenAI default behavior of lowering reasoning effort when allowed', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    installCaptureFetch(requests);
    const provider = new OpenAIProvider({
      apiKey: 'official-key',
      defaultModel: 'gpt-6.1-terra',
    });
    await collect(provider.stream!({
      model: 'gpt-6.1-terra',
      messages: [{ role: 'user', content: 'Return exactly OK.' }],
      signal: undefined,
    }));
    expect(requests[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(requests[0]!.body.reasoning_effort).toBe('none');
  });
});
