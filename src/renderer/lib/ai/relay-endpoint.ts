/**
 * Fork (relay provider): the OpenAI-compatible relay endpoint's base URL.
 *
 * The base URL is a non-secret configuration value, so unlike provider keys
 * it is kept in localStorage directly (the settings store is a store-layer
 * module; this one stays in lib so the AI client factories can read it
 * without an architecture-boundary violation). The key itself never lands
 * here — it lives in the OS keychain under `byok.relay`.
 */

const STORAGE_KEY = 'fork.relay-endpoint.baseURL';

/** Trim, drop trailing slashes; '' unless it looks like an http(s) origin+path. */
export function normalizeRelayBaseURL(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\/+$/u, '');
  return /^https?:\/\/\S{1,500}$/iu.test(trimmed) ? trimmed : '';
}

export function readRelayBaseURL(): string {
  try {
    return normalizeRelayBaseURL(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return '';
  }
}

export function writeRelayBaseURL(value: string): string {
  const normalized = normalizeRelayBaseURL(value);
  try {
    if (normalized) window.localStorage.setItem(STORAGE_KEY, normalized);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Persistence is best effort; the relay still works for this session via
    // the caller's own in-memory value.
  }
  return normalized;
}

export function relayEndpointConfigured(): boolean {
  return readRelayBaseURL() !== '';
}
