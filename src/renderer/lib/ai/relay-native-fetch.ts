/**
 * Fork (relay): fetch-shaped adapter over the native relay transport.
 *
 * Relay gateways commonly reject CORS preflights (their OPTIONS answers 401
 * without Access-Control-Allow-* headers), so the OpenAI SDK's own fetch
 * would never get past the WebView. This adapter keeps the SDK's request
 * building and SSE parsing, but sends every request through the native Rust
 * host (`relay_chat_stream`), which injects `Authorization` from the
 * `byok.relay` keychain entry. The URL passed by the SDK is validated
 * natively; only the JSON body crosses IPC.
 */
import { platform } from '../../platform';

export function createRelayFetch(baseURL: string): typeof fetch {
  const relayFetch = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawBody = init?.body;
    const body = typeof rawBody === 'string'
      ? rawBody
      : rawBody instanceof Uint8Array
        ? new TextDecoder().decode(rawBody)
        : '';
    const signal = (init?.signal ?? new AbortController().signal) as AbortSignal;
    return platform.relayApi.request(body, baseURL, signal);
  };
  return relayFetch as typeof fetch;
}
