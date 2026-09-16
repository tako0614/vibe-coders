import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, LoaderCircle } from 'lucide-react';
import { api, type Snapshot, type Status } from './api';
import type { Action, View } from './App';
import { CodexLogin } from './CodexLogin';
import { ModelPicker } from './ModelPicker';
import { providerUrl, type ModelChoice } from '../shared/models';

type Props = { status: Status; snapshot: Snapshot; action: Action; onView: (view: View) => void };
export function ProviderSettings(props: Props) {
  const provider = props.status.config.provider;
  const [kind, setKind] = useState(provider?.kind || (provider ? 'openai' : 'codex'));
  return (
    <div className="provider-settings">
      <div className="provider-picker" role="group" aria-label="AIの接続方法">
        <button className={kind === 'codex' ? 'selected' : ''} onClick={() => setKind('codex')}>
          <strong>Codex</strong>
          <span>端末のChatGPT認証で使う</span>
        </button>
        <button className={kind === 'openai' ? 'selected' : ''} onClick={() => setKind('openai')}>
          <strong>APIキー</strong>
          <span>OpenRouter・OpenAI互換</span>
        </button>
      </div>
      {kind === 'codex' ? <CodexSettings {...props} /> : <ApiSettings {...props} />}
    </div>
  );
}

function CodexSettings({ status, snapshot, action, onView }: Props) {
  const provider = status.config.provider;
  const [model, setModel] = useState(provider?.kind === 'codex' ? provider.model : '');
  const [models, setModels] = useState<ModelChoice[]>([]),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    void api<ModelChoice[]>('/codex/models')
      .then((value) => {
        if (!current) return;
        setModels(value);
        setModel(
          (previous) => previous || value.find((m) => m.isDefault)?.id || value[0]?.id || '',
        );
        setError('');
      })
      .catch(() => {
        if (current)
          setError('一覧を取得できません。モデル名を直接入力するか、Codex CLIを確認してください。');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [status.codex?.subscriptionReady, reload]);
  const connected = status.providerReady && provider?.kind === 'codex';
  return (
    <section className="form-card provider-card">
      <div className="section-heading">
        <div>
          <h2>Codexに接続</h2>
          <p>この端末のCodexに保存された認証情報を使います。</p>
        </div>
        <span className={`status-chip ${connected ? 'ready' : ''}`}>
          {connected ? '接続済み' : '未接続'}
        </span>
      </div>
      <CodexLogin conversationId={snapshot.conversation.id} action={action} />
      <ModelPicker
        value={model}
        onChange={setModel}
        models={models}
        loading={loading}
        error={error}
        reload={() => setReload((n) => n + 1)}
        disabled={saving}
      />
      <button
        className="primary connect-button"
        disabled={saving || !model.trim() || !status.codex?.subscriptionReady}
        onClick={() =>
          void action(async () => {
            setSaving(true);
            try {
              await api('/config/provider', 'PUT', {
                revision: status.config.revision,
                provider: {
                  kind: 'codex',
                  model: model.trim(),
                  baseUrl: 'https://chatgpt.com/backend-api/codex',
                  supportsImages: true,
                  keyRequired: false,
                },
              });
              onView('chat');
            } finally {
              setSaving(false);
            }
          })
        }
      >
        {saving ? (
          <LoaderCircle size={16} className="spin" />
        ) : connected ? (
          <CheckCircle2 size={16} />
        ) : (
          <ArrowRight size={16} />
        )}
        {saving
          ? '接続を保存中…'
          : connected && provider?.model === model
            ? 'チャットを開く'
            : 'このモデルでチャットを始める'}
      </button>
    </section>
  );
}

function ApiSettings({ status, snapshot, action, onView }: Props) {
  const provider = status.config.provider?.kind !== 'codex' ? status.config.provider : undefined;
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || 'https://openrouter.ai/api/v1');
  const [model, setModel] = useState(provider?.model || ''),
    [credential, setCredential] = useState('');
  const [keyRequired, setKeyRequired] = useState(provider?.keyRequired ?? true),
    [supportsImages, setSupportsImages] = useState(provider?.supportsImages ?? true);
  const [models, setModels] = useState<ModelChoice[]>([]),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  const credentialRef = useRef(credential);
  credentialRef.current = credential;
  const savedKey =
    !!provider &&
    baseUrl.replace(/\/+$/, '') === provider.baseUrl.replace(/\/+$/, '') &&
    status.providerKeySaved;
  const connected = status.providerReady && !!provider;
  useEffect(() => {
    let current = true;
    setModels([]);
    setError('');
    setLoading(true);
    const timer = setTimeout(() => {
      void api<ModelChoice[]>('/config/provider/models', 'POST', {
        baseUrl,
        useSavedCredential: keyRequired,
        ...(credentialRef.current && keyRequired ? { credential: credentialRef.current } : {}),
      })
        .then((value) => {
          if (current) {
            setModels(value);
            setError('');
          }
        })
        .catch((e) => {
          if (current) setError(e instanceof Error ? e.message : '一覧を取得できません。');
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [baseUrl, reload, keyRequired, savedKey]);
  const changeUrl = (url: string) => {
    setBaseUrl(url);
    setModel('');
    setCredential('');
  };
  return (
    <form
      className="form-card provider-card"
      onSubmit={(event) => {
        event.preventDefault();
        void action(async () => {
          setSaving(true);
          try {
            const result = await api<{ credentialReady: boolean }>('/config/provider', 'PUT', {
              revision: status.config.revision,
              provider: {
                kind: 'openai',
                baseUrl: providerUrl(baseUrl),
                model: model.trim(),
                supportsImages,
                keyRequired,
              },
              ...(credential && keyRequired ? { credential } : {}),
            });
            setCredential('');
            if (!result.credentialReady) {
              await api('/config/secret-request', 'POST', {
                conversationId: snapshot.conversation.id,
                targetId: 'provider:main',
              });
              onView('requests');
            } else onView('chat');
          } finally {
            setSaving(false);
          }
        });
      }}
    >
      <div className="section-heading">
        <div>
          <h2>APIに接続</h2>
          <p>サービスを選んで、モデル一覧から接続できます。</p>
        </div>
        <span className={`status-chip ${connected ? 'ready' : ''}`}>
          {connected ? '接続済み' : '未接続'}
        </span>
      </div>
      <div className="provider-presets" role="group" aria-label="APIサービス">
        <button type="button" onClick={() => changeUrl('https://openrouter.ai/api/v1')}>
          OpenRouter
        </button>
        <button type="button" onClick={() => changeUrl('https://api.openai.com/v1')}>
          OpenAI
        </button>
      </div>
      <label>
        APIのURL
        <input
          name="baseUrl"
          type="url"
          value={baseUrl}
          onChange={(e) => changeUrl(e.target.value)}
          required
          disabled={saving}
        />
      </label>
      {keyRequired && (
        <label>
          APIキー
          <input
            name="credential"
            type="password"
            autoComplete="new-password"
            value={credential}
            maxLength={16000}
            onChange={(e) => setCredential(e.target.value)}
            onBlur={() => {
              if (credential) setReload((n) => n + 1);
            }}
            disabled={saving}
            placeholder={
              savedKey
                ? '保存済みのキーを使用（変更する場合だけ入力）'
                : 'キーを入力するとモデル一覧も取得できます'
            }
          />
          <small className="muted">接続設定専用の入力です。チャットには送信しません。</small>
        </label>
      )}
      <ModelPicker
        value={model}
        onChange={setModel}
        models={models}
        loading={loading}
        error={error}
        reload={() => setReload((n) => n + 1)}
        disabled={saving}
      />
      <div className="form-grid">
        <label className="checkbox">
          <input
            type="checkbox"
            name="supportsImages"
            checked={supportsImages}
            onChange={(e) => setSupportsImages(e.target.checked)}
          />
          画像を送信できる
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            name="keyRequired"
            checked={keyRequired}
            onChange={(e) => setKeyRequired(e.target.checked)}
          />
          APIキーを使用する
        </label>
      </div>
      <button className="primary" disabled={saving || !model.trim()}>
        {saving ? '保存中…' : '保存して接続する'}
      </button>
      {connected && (
        <button type="button" onClick={() => onView('chat')}>
          チャットへ戻る
          <ArrowRight size={14} />
        </button>
      )}
    </form>
  );
}
