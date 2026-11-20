import { isTauriRuntime, platform } from '../../platform';
import type { ByokListedModel, ByokModelCatalogResponse } from '../../platform';
import { readRelayBaseURL } from '../ai/relay-endpoint';
import { byokKeychain } from '../byok-keychain';
import { canUseByokProvider } from '../config';
import { events } from '../events';
import {
  BYOK_AGENT_PROVIDERS,
  setByokModelCatalog,
  type ByokAgentProviderId,
} from './runtime/agent-provider-contract';

type ListState = 'idle' | 'loading' | 'ready' | 'error' | 'missing-key';
export interface ByokModelListSnapshot { state: ListState; updatedAt: number | null }

export const BYOK_MODEL_LIST_PROVIDERS = BYOK_AGENT_PROVIDERS;
/** Provider lists change with releases, not per request; the menu re-checks after this. */
export const BYOK_MODEL_LIST_REFRESH_MS = 5 * 60_000;
const MISSING_KEY = 'BYOK_MODELS_MISSING_KEY';

/**
 * One API-key provider's own model list, memory-only. A failed refresh keeps
 * the last successful list; with no list the bundled catalog stays offered.
 * Requests that started before a key change cannot republish afterwards.
 */
export function createByokModelList(
  provider: ByokAgentProviderId,
  source: (provider: ByokAgentProviderId) => Promise<ByokModelCatalogResponse>,
  publish: (provider: ByokAgentProviderId, models: readonly ByokListedModel[] | null) => void,
  available: () => boolean,
  now = Date.now,
) {
  let snapshot: ByokModelListSnapshot = { state: 'idle', updatedAt: null };
  let generation = 0;
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const update = (next: ByokModelListSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const invalidate = () => {
    generation++;
    pending = null;
    publish(provider, null);
    update({ state: 'idle', updatedAt: null });
  };
  const refresh = (force = false): Promise<void> => {
    if (!available()) return Promise.resolve();
    if (pending) return pending;
    // A missing key stays known until Settings reports a key change.
    if (!force && snapshot.state === 'missing-key') return Promise.resolve();
    if (!force && snapshot.state === 'ready' && snapshot.updatedAt !== null
      && now() - snapshot.updatedAt < BYOK_MODEL_LIST_REFRESH_MS) {
      return Promise.resolve();
    }
    const revision = generation;
    const current = () => revision === generation;
    update({ ...snapshot, state: 'loading' });
    const request = Promise.resolve().then(async () => {
      try {
        const { models } = await source(provider);
        if (!current()) return;
        if (!models.length) throw new Error('empty model list');
        publish(provider, models);
        update({ state: 'ready', updatedAt: now() });
      } catch (error) {
        if (!current()) return;
        if (String(error instanceof Error ? error.message : error).includes(MISSING_KEY)) {
          publish(provider, null);
          update({ state: 'missing-key', updatedAt: null });
          return;
        }
        // Keep this key's last successful list. Never expose provider text.
        update({ ...snapshot, state: 'error' });
      } finally {
        if (current()) pending = null;
      }
    });
    pending = request;
    return request;
  };
  return {
    refresh,
    invalidate,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type ByokModelList = ReturnType<typeof createByokModelList>;

/**
 * Fork (relay): the relay's model list is read by the native host (relay
 * gateways reject CORS preflights, and the key must not travel from JS), which
 * serves `GET {baseURL}/models` with the `byok.relay` key. Only sanitized ids
 * are projected; every capability field stays null (unknown, not unsupported).
 */
const RELAY_LIST_MAX_MODELS = 500;

async function relayModelListSource(): Promise<ByokModelCatalogResponse> {
  const baseURL = readRelayBaseURL();
  if (!baseURL) throw new Error(MISSING_KEY);
  if (!(await byokKeychain.has('relay'))) throw new Error(MISSING_KEY);
  const response = await platform.relayApi.listModels(baseURL);
  const models = response.models
    .filter((entry) => entry.id.length > 0 && entry.id.length <= 200)
    .slice(0, RELAY_LIST_MAX_MODELS)
    .map((entry) => ({
      id: entry.id,
      displayName: null,
      created: null,
      contextWindow: null,
      maxOutputTokens: null,
      adaptiveThinking: null,
      efforts: null,
      defaultEffort: null,
    }));
  return { models };
}

export const byokModelLists: Readonly<Record<ByokAgentProviderId, ByokModelList>> = Object.freeze(
  Object.fromEntries(BYOK_MODEL_LIST_PROVIDERS.map((provider) => [
    provider,
    createByokModelList(
      provider,
      (id) => (id === 'relay' ? relayModelListSource() : platform.byokModels.list(id)),
      setByokModelCatalog,
      () => isTauriRuntime() && canUseByokProvider(),
    ),
  ])) as Record<ByokAgentProviderId, ByokModelList>,
);

export function refreshByokModelLists(force = false): Promise<void> {
  return Promise.all(BYOK_MODEL_LIST_PROVIDERS.map((provider) => byokModelLists[provider].refresh(force)))
    .then(() => undefined);
}

// A replaced or removed key may reach a different account's models.
events.on('byok:keys-changed', () => {
  for (const provider of BYOK_MODEL_LIST_PROVIDERS) byokModelLists[provider].invalidate();
});
