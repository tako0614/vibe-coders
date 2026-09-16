import { useState } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { api, type Snapshot, type Status } from './api';
import type { Action, View } from './App';
import { CodexLogin } from './CodexLogin';
import { providerUrl } from '../shared/models';

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
  const [saving, setSaving] = useState(false);
  const selected = provider?.kind === 'codex';
  return (
    <section className="form-card provider-card">
      <div className="section-heading">
        <div>
          <h2>Codex</h2>
          <p>この端末のChatGPT認証を使います。</p>
        </div>
        <span className={`status-chip ${selected ? 'ready' : ''}`}>
          {selected ? '使用中' : '未選択'}
        </span>
      </div>
      <CodexLogin conversationId={snapshot.conversation.id} action={action} />
      <p className="connection-model-note">モデルの選択・変更はチャットの入力欄から行えます。</p>
      <button
        className="primary connect-button"
        disabled={saving || !status.codex?.subscriptionReady}
        onClick={() =>
          void action(async () => {
            if (selected) return onView('chat');
            setSaving(true);
            try {
              await api('/config/provider', 'PUT', {
                revision: status.config.revision,
                provider: {
                  kind: 'codex',
                  model: '',
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
        {saving ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}
        {saving ? '保存中…' : selected ? 'チャットでモデルを選ぶ' : 'Codexを使う'}
      </button>
    </section>
  );
}

function ApiSettings({ status, snapshot, action, onView }: Props) {
  const provider = status.config.provider?.kind !== 'codex' ? status.config.provider : undefined;
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || 'https://openrouter.ai/api/v1');
  const [credential, setCredential] = useState(''),
    [saving, setSaving] = useState(false);
  const [keyRequired, setKeyRequired] = useState(provider?.keyRequired ?? true),
    [supportsImages, setSupportsImages] = useState(provider?.supportsImages ?? true);
  const sameUrl =
    !!provider && baseUrl.replace(/\/+$/, '') === provider.baseUrl.replace(/\/+$/, '');
  const savedKey = sameUrl && status.providerKeySaved;
  const connected = !!provider && (!provider.keyRequired || status.providerKeySaved);
  const changeUrl = (url: string) => {
    setBaseUrl(url);
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
                model: sameUrl ? provider!.model : '',
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
          <p>サービスとAPIキーを設定します。モデルはチャットで選べます。</p>
        </div>
        <span className={`status-chip ${connected ? 'ready' : ''}`}>
          {connected ? '登録済み' : '未登録'}
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
      <p className="connection-model-note">保存後、チャットの入力欄からモデルを選べます。</p>
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
      <button className="primary" disabled={saving}>
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
