import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { byokKeychain, type BYOKProvider } from '../../../lib/byok-keychain';
import {
  codexSubscription,
  isCodexLoginActive,
  type CodexSubscriptionStatus,
} from '../../../lib/codex-subscription';
import { speechKeychain } from '../../../lib/speech/speech-credentials';
import { testByokProviderConnection } from '../../../lib/ai/test-provider-connection';
import { readEnvApiKey } from '../../../lib/ai/credentials/env';
import { readRelayBaseURL, writeRelayBaseURL } from '../../../lib/ai/relay-endpoint';
import { byokModelLists } from '../../../lib/agent/byok-model-catalog';
import { agentProviderOption } from '../../../lib/agent/runtime/agent-provider-contract';
import { events } from '../../../lib/events';
import { useSettingsStore } from '../../../store/settings-store';
import {
  SettingsButton,
  SettingsField,
  SettingsPanelHeader,
  SettingsSectionHeader,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';
import { BrushIcon } from '../../../components/ui/BrushIcon';

/**
 * One way to reach a model or a transcriber: a flat row (components.md,
 * provider connection row): a seal, solid while connected and hollow while
 * not, the name, where the credential comes from in index type, the
 * description, and the actions on a line below.
 */
function ProviderShell({
  name,
  desc,
  live,
  source,
  detail,
  actions,
}: {
  name: string;
  desc: string;
  live: boolean;
  /** Where the credential comes from (Keychain, .ENV (DEV), not connected). */
  source: string;
  /** A line between the description and the actions (a device code). */
  detail?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="set-provider-line">
      {/* The chapter's round seal; hollow like a chapter not yet begun. */}
      <span
        className={`set-provider-line__seal kind-mark kind-mark--chapter${live ? '' : ' kind-mark--hollow'}`}
        style={{ '--sand-c': 'hsl(var(--ink-2))' } as CSSProperties}
        aria-hidden="true"
      >
        <i className="sand sand--blob-2" />
      </span>
      <span className="set-provider-line__name">{name}</span>
      <span className="set-provider-line__source">{source}</span>
      <div className="set-provider-line__desc">{desc}</div>
      {detail && <div className="set-provider-line__row">{detail}</div>}
      {actions && <div className="set-provider-line__row">{actions}</div>}
    </div>
  );
}

/** A connection test's answer, or a sign-in failure. */
function ProviderResult({ tone, children }: { tone: 'ok' | 'error' | 'muted'; children: ReactNode }) {
  return (
    <span className={`set-provider-result${tone === 'error' ? ' set-provider-result--error' : ''}`}>
      {tone !== 'muted' && <BrushIcon name={tone === 'ok' ? 'check' : 'status-stopped'} size={13} />}
      {children}
    </span>
  );
}

function KeyField({ name, value, onChange }: { name: string; value: string; onChange: (next: string) => void }) {
  const { t } = useTranslation();
  return (
    <SettingsField
      mono
      small
      style={{ width: 250 }}
      placeholder={t('settings.byokProvider.keyPlaceholder')}
      aria-label={`${name} API Key`}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      autoFocus
    />
  );
}

function ProviderRow({
  credentialsActive,
  provider,
  name,
  desc,
}: {
  credentialsActive: boolean;
  provider: BYOKProvider;
  name: string;
  desc: string;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [connected, setConnected] = useState(false);
  // A development key handed to the dev server (scripts/dev-agent-keys.mjs)
  // counts as connected; it is read before the keychain, like the Agent does.
  const envKey = Boolean(readEnvApiKey(provider));
  const live = connected || envKey;
  const [loading, setLoading] = useState(true);
  const agentProvider = useSettingsStore((state) => state.agentProvider);
  const agentModel = useSettingsStore((state) => state.agentModel);

  // Settings needs existence only. On macOS this is an attribute-only native
  // query, so merely scrolling this panel into view never asks to decrypt keys.
  useEffect(() => {
    if (!credentialsActive) return;
    let cancelled = false;
    void byokKeychain
      .has(provider)
      .then((value) => {
        if (!cancelled) setConnected(value);
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [credentialsActive, provider]);

  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');

  const testConnection = async () => {
    if (!live) return;
    setTestState('testing');
    setTestMsg('');
    try {
      // Test with the model the Agent would use; other providers fall back
      // to their first catalog model.
      await testByokProviderConnection(provider, {
        ...(provider === agentProvider ? { model: agentModel } : {}),
        signal: new AbortController().signal,
      });
      setTestState('ok');
    } catch (error) {
      setTestState('fail');
      setTestMsg(
        (error as { kind?: string })?.kind === 'auth'
          ? t('settings.byokProvider.invalidKey')
          : t('settings.byokProvider.requestFailed'),
      );
    }
  };

  const save = async () => {
    const value = draft.trim();
    if (!value) {
      await byokKeychain.clear(provider);
      setConnected(false);
    } else {
      await byokKeychain.set(provider, value);
      setConnected(true);
    }
    setDraft('');
    setEditing(false);
    events.emit('byok:keys-changed');
  };

  const disconnect = async () => {
    await byokKeychain.clear(provider);
    setConnected(false);
    events.emit('byok:keys-changed');
  };

  const startEditing = () => {
    setDraft('');
    setEditing(true);
  };
  const keyField = <KeyField name={name} value={draft} onChange={setDraft} />;

  return (
    <ProviderShell
      name={name}
      desc={desc}
      live={live}
      source={live ? (connected ? 'Keychain' : '.ENV (DEV)') : t('settings.byokProvider.notConnected')}
      actions={
        loading ? null : editing ? (
          <>
            {keyField}
            <SettingsButton variant="primary" onClick={save}>
              {t('settings.common.save')}
            </SettingsButton>
            <SettingsButton
              variant="ghost"
              onClick={() => {
                setDraft('');
                setEditing(false);
              }}
            >
              {t('settings.common.cancel')}
            </SettingsButton>
          </>
        ) : live ? (
          <>
            <SettingsButton size="sm" onClick={testConnection} disabled={testState === 'testing'}>
              {testState === 'testing'
                ? t('settings.byokProvider.testing')
                : t('settings.common.test_connection')}
            </SettingsButton>
            <SettingsButton variant="ghost" size="sm" onClick={startEditing}>
              {t('settings.byokProvider.editKey')}
            </SettingsButton>
            {testState === 'ok' && <ProviderResult tone="ok">{t('settings.byokProvider.available')}</ProviderResult>}
            {testState === 'fail' && <ProviderResult tone="error">{testMsg}</ProviderResult>}
            <span style={{ flex: 1 }} />
            {/* An .env key is the dev server's: there is nothing here to disconnect. */}
            {connected && (
              <SettingsButton variant="danger" size="sm" onClick={disconnect}>
                {t('settings.common.disconnect')}
              </SettingsButton>
            )}
          </>
        ) : (
          <SettingsButton variant="primary" size="sm" onClick={startEditing}>
            {t('settings.common.connect')}
          </SettingsButton>
        )
      }
    />
  );
}

/**
 * Fork: the OpenAI-compatible relay (中转站) row. The base URL is a
 * non-secret localStorage setting (`lib/ai/relay-endpoint.ts`); the key is a
 * Keychain entry (`byok.relay`). Editing the URL never touches the stored key,
 * and the connectivity test reads both, exactly like the Agent does.
 */
function RelayProviderRow({ credentialsActive }: { credentialsActive: boolean }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draftURL, setDraftURL] = useState('');
  const [draftKey, setDraftKey] = useState('');
  const [urlError, setUrlError] = useState(false);
  const [connected, setConnected] = useState(false);
  const [baseURL, setBaseURL] = useState('');
  const [loading, setLoading] = useState(true);
  const agentProvider = useSettingsStore((state) => state.agentProvider);
  const agentModel = useSettingsStore((state) => state.agentModel);

  useEffect(() => {
    if (!credentialsActive) return;
    let cancelled = false;
    setBaseURL(readRelayBaseURL());
    void byokKeychain
      .has('relay')
      .then((value) => {
        if (!cancelled) setConnected(value);
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // Fork (relay): warm the endpoint's model list so the connectivity test
    // has a model to use even before the composer menu was ever opened.
    void byokModelLists.relay.refresh().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [credentialsActive]);

  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');

  const testConnection = async () => {
    if (!connected) return;
    setTestState('testing');
    setTestMsg('');
    try {
      // The composer's current model when it points at the relay; otherwise
      // the first model the relay's own list offers, refreshing the list
      // first so a freshly saved URL/key is honored.
      let model = agentProvider === 'relay' ? agentModel.trim() : '';
      if (!model) {
        await byokModelLists.relay.refresh(true);
        model = agentProviderOption('relay').models[0]?.value ?? '';
      }
      if (!model) {
        setTestState('fail');
        setTestMsg(t('settings.relayProvider.needModel'));
        return;
      }
      await testByokProviderConnection('relay', {
        model,
        signal: new AbortController().signal,
      });
      setTestState('ok');
    } catch (error) {
      setTestState('fail');
      setTestMsg(
        (error as { kind?: string })?.kind === 'auth'
          ? t('settings.byokProvider.invalidKey')
          : t('settings.byokProvider.requestFailed'),
      );
    }
  };

  // Fork (relay): explicit re-fetch of the endpoint's /models list, with a
  // count confirmation so a wrong URL or key is visible right here.
  const [refreshState, setRefreshState] = useState<'idle' | 'refreshing' | 'done'>('idle');
  const [refreshMsg, setRefreshMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const refreshModels = async () => {
    if (!connected || refreshState === 'refreshing') return;
    setRefreshState('refreshing');
    setRefreshMsg(null);
    await byokModelLists.relay.refresh(true).catch(() => undefined);
    const count = agentProviderOption('relay').models.length;
    if (count > 0) {
      setRefreshMsg({ tone: 'ok', text: t('settings.relayProvider.modelsFetched', { count: String(count) }) });
    } else {
      setRefreshMsg({ tone: 'error', text: t('settings.relayProvider.refreshEmpty') });
    }
    setRefreshState('done');
  };

  const save = async () => {
    const url = writeRelayBaseURL(draftURL);
    if (!url) {
      setUrlError(true);
      return;
    }
    setUrlError(false);
    setBaseURL(url);
    const key = draftKey.trim();
    if (key) {
      await byokKeychain.set('relay', key);
      setConnected(true);
    }
    setDraftURL('');
    setDraftKey('');
    setEditing(false);
    events.emit('byok:keys-changed');
  };

  const disconnect = async () => {
    await byokKeychain.clear('relay');
    setConnected(false);
    events.emit('byok:keys-changed');
  };

  const startEditing = () => {
    setDraftURL('');
    setDraftKey('');
    setUrlError(false);
    setEditing(true);
  };

  return (
    <ProviderShell
      name={t('settings.relayProvider.name')}
      desc={t('settings.relayProvider.desc')}
      live={connected}
      source={connected ? 'Keychain' : t('settings.byokProvider.notConnected')}
      detail={connected && baseURL ? <span className="set-provider-line__src">{baseURL}</span> : undefined}
      actions={
        loading ? null : editing ? (
          <>
            <SettingsField
              mono
              small
              style={{ width: 320 }}
              placeholder={t('settings.relayProvider.urlPlaceholder')}
              aria-label={t('settings.relayProvider.urlLabel')}
              value={draftURL}
              onChange={(event) => setDraftURL(event.target.value)}
              autoFocus
            />
            <KeyField name={t('settings.relayProvider.name')} value={draftKey} onChange={setDraftKey} />
            <SettingsButton variant="primary" onClick={save}>
              {t('settings.common.save')}
            </SettingsButton>
            <SettingsButton variant="ghost" onClick={startEditing}>
              {t('settings.common.cancel')}
            </SettingsButton>
            {urlError && <ProviderResult tone="error">{t('settings.relayProvider.invalidURL')}</ProviderResult>}
          </>
        ) : connected ? (
          <>
            <SettingsButton size="sm" onClick={testConnection} disabled={testState === 'testing'}>
              {testState === 'testing'
                ? t('settings.byokProvider.testing')
                : t('settings.common.test_connection')}
            </SettingsButton>
            <SettingsButton size="sm" onClick={refreshModels} disabled={refreshState === 'refreshing'}>
              {refreshState === 'refreshing'
                ? t('settings.relayProvider.refreshing')
                : t('settings.relayProvider.refreshModels')}
            </SettingsButton>
            <SettingsButton variant="ghost" size="sm" onClick={startEditing}>
              {t('settings.byokProvider.editKey')}
            </SettingsButton>
            {testState === 'ok' && <ProviderResult tone="ok">{t('settings.byokProvider.available')}</ProviderResult>}
            {testState === 'fail' && <ProviderResult tone="error">{testMsg}</ProviderResult>}
            {refreshMsg && <ProviderResult tone={refreshMsg.tone}>{refreshMsg.text}</ProviderResult>}
            <span style={{ flex: 1 }} />
            <SettingsButton variant="danger" size="sm" onClick={disconnect}>
              {t('settings.common.disconnect')}
            </SettingsButton>
          </>
        ) : (
          <SettingsButton variant="primary" size="sm" onClick={startEditing}>
            {t('settings.common.connect')}
          </SettingsButton>
        )
      }
    />
  );
}

/**
 * Experimental ChatGPT subscription sign-in for General Agent's `openai-codex`
 * route. Deliberately not a `ProviderRow`: there is no key to paste, the OAuth
 * tokens never reach the renderer, and it must not be treated as a BYOK
 * provider. The row drives the Codex device-code flow and polls native status
 * while an attempt is live.
 */
function ChatGptSubscriptionRow({ credentialsActive }: { credentialsActive: boolean }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CodexSubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    if (!credentialsActive) return;
    let cancelled = false;
    void codexSubscription
      .status()
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [credentialsActive]);

  const loginActive = isCodexLoginActive(status);
  useEffect(() => {
    if (!loginActive) return;
    const timer = window.setInterval(() => {
      void codexSubscription
        .status()
        .then(setStatus)
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [loginActive]);

  const signIn = async () => {
    setBusy(true);
    setStartError(null);
    try {
      const login = await codexSubscription.startLogin();
      setStatus((current) => ({
        signedIn: current?.signedIn ?? false,
        account: current?.account ?? null,
        login,
      }));
    } catch {
      setStartError(t('settings.codexSubscription.startFailed'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    await codexSubscription.cancelLogin().catch(() => undefined);
    setStatus(await codexSubscription.status().catch(() => null));
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await codexSubscription.logout();
      setStatus(await codexSubscription.status().catch(() => null));
      events.emit('byok:keys-changed');
    } finally {
      setBusy(false);
    }
  };

  const signedIn = status?.signedIn === true;
  const publishedSignedIn = status?.signedIn;
  useEffect(() => {
    if (publishedSignedIn === undefined) return;
    events.emit('agent:auth-changed');
  }, [publishedSignedIn, status?.account?.accountId, status?.login?.attemptId, status?.login?.phase]);
  const login = status?.login ?? null;
  const account = status?.account ?? null;
  const failureKey = login?.phase === 'failed' ? login.failure ?? 'provider_rejected' : null;
  const accountWord = signedIn
    ? account?.email ?? t('settings.codexSubscription.signedInAs')
    : t('settings.codexSubscription.notSignedIn');
  const codeHint =
    login?.phase === 'exchanging'
      ? t('settings.codexSubscription.exchanging')
      : t('settings.codexSubscription.codeHint');

  return (
    <ProviderShell
      name={t('settings.codexSubscription.name')}
      desc={t('settings.models.providers.openaiCodex')}
      live={signedIn}
      source={signedIn && account?.plan ? `${accountWord} · ${account.plan}` : accountWord}
      detail={
        loginActive && login ? (
          <>
            <span className="set-provider-line__k">{t('settings.codexSubscription.codeLabel')}</span>
            <span className="set-provider-line__code">{login.userCode}</span>
            <BrushIcon name="loader" size={13} className="ui-spin" />
            <span className="set-provider-line__k">{codeHint}</span>
          </>
        ) : null
      }
      actions={
        loading ? null : loginActive && login ? (
          <>
            <SettingsButton variant="primary" size="sm" onClick={() => codexSubscription.openVerification(login)}>
              {t('settings.codexSubscription.openVerification')}
            </SettingsButton>
            <SettingsButton variant="ghost" size="sm" onClick={cancel}>
              {t('settings.common.cancel')}
            </SettingsButton>
          </>
        ) : signedIn ? (
          <>
            <span style={{ flex: 1 }} />
            <SettingsButton variant="danger" size="sm" onClick={signOut} disabled={busy}>
              {t('settings.codexSubscription.signOut')}
            </SettingsButton>
          </>
        ) : (
          <>
            <SettingsButton variant="primary" size="sm" onClick={signIn} disabled={busy}>
              {t('settings.codexSubscription.signIn')}
            </SettingsButton>
            {startError && <ProviderResult tone="error">{startError}</ProviderResult>}
            {failureKey && (
              <ProviderResult tone="error">{t(`settings.codexSubscription.failure.${failureKey}`)}</ProviderResult>
            )}
            {login?.phase === 'cancelled' && (
              <ProviderResult tone="muted">{t('settings.codexSubscription.cancelled')}</ProviderResult>
            )}
          </>
        )
      }
    />
  );
}

/**
 * Voice-transcription credential (DashScope / 阿里云百炼). Deliberately not a
 * `ProviderRow`: it is not an LLM credential and must not join the BYOK
 * provider union. Same keychain-only storage contract as the rows above.
 */
function SpeechCredentialRow({ credentialsActive }: { credentialsActive: boolean }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!credentialsActive) return;
    let cancelled = false;
    void speechKeychain
      .has()
      .then((value) => {
        if (!cancelled) setConnected(value);
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [credentialsActive]);

  const save = async () => {
    const value = draft.trim();
    if (!value) {
      await speechKeychain.clear();
      setConnected(false);
    } else {
      await speechKeychain.set(value);
      setConnected(true);
    }
    setDraft('');
    setEditing(false);
    events.emit('byok:keys-changed');
  };

  const disconnect = async () => {
    await speechKeychain.clear();
    setConnected(false);
    events.emit('byok:keys-changed');
  };

  const startEditing = () => {
    setDraft('');
    setEditing(true);
  };
  const keyField = <KeyField name="阿里云百炼" value={draft} onChange={setDraft} />;

  return (
    <ProviderShell
      name="阿里云百炼"
      desc={t('settings.models.providers.dashscope')}
      live={connected}
      source={connected ? 'Keychain' : t('settings.byokProvider.notConnected')}
      actions={
        loading ? null : editing ? (
          <>
            {keyField}
            <SettingsButton variant="primary" onClick={save}>
              {t('settings.common.save')}
            </SettingsButton>
            <SettingsButton
              variant="ghost"
              onClick={() => {
                setDraft('');
                setEditing(false);
              }}
            >
              {t('settings.common.cancel')}
            </SettingsButton>
          </>
        ) : connected ? (
          <>
            <SettingsButton variant="ghost" size="sm" onClick={startEditing}>
              {t('settings.byokProvider.editKey')}
            </SettingsButton>
            <span style={{ flex: 1 }} />
            <SettingsButton variant="danger" size="sm" onClick={disconnect}>
              {t('settings.common.disconnect')}
            </SettingsButton>
          </>
        ) : (
          <SettingsButton variant="primary" size="sm" onClick={startEditing}>
            {t('settings.common.connect')}
          </SettingsButton>
        )
      }
    />
  );
}

/** The only settings surface allowed to create, edit, test or delete AI keys. */
export function ModelsPanel({
  credentialsActive,
  registerRef,
}: {
  credentialsActive: boolean;
  registerRef: SettingsRegisterRef;
}) {
  const { t } = useTranslation();
  return (
    <section className="set-panel" ref={registerRef} id="models">
      <SettingsPanelHeader
        kicker={t('settings.models.kicker')}
        title={t('settings.models.title')}
        sub={t('settings.models.sub')}
      />
      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.models.credentialsTitle')} hint="BYOK · KEYCHAIN" />
        <p className="set-row__desc">{t('settings.models.credentialsDesc')}</p>
        <ProviderRow
          credentialsActive={credentialsActive}
          provider="deepseek"
          name="DeepSeek"
          desc={t('settings.models.providers.deepseek')}
        />
        <ProviderRow
          credentialsActive={credentialsActive}
          provider="anthropic"
          name="Anthropic"
          desc={t('settings.models.providers.anthropic')}
        />
        <ProviderRow
          credentialsActive={credentialsActive}
          provider="openai"
          name="OpenAI"
          desc={t('settings.models.providers.openai')}
        />
        <RelayProviderRow credentialsActive={credentialsActive} />
        <ChatGptSubscriptionRow credentialsActive={credentialsActive} />
      </div>
      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.models.speechTitle')} hint="BYOK · KEYCHAIN" />
        <p className="set-row__desc">{t('settings.models.speechDesc')}</p>
        <SpeechCredentialRow credentialsActive={credentialsActive} />
      </div>
    </section>
  );
}
