import { useState } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { api, type Snapshot, type Status } from './api';
import type { Action, View } from './App';
import { CodexLogin } from './CodexLogin';
import { providerId, providerUrl, type Provider } from '../shared/models';
import { ConnectionPicker } from './ConnectionPicker';

type Props = { status: Status; snapshot: Snapshot; action: Action; onView: (view: View) => void };
type Connection = Status['providers'][number];
export function ProviderSettings(props: Props) {
  const [selected, setSelected] = useState(
    props.status.config.provider ? providerId(props.status.config.provider) : 'codex',
  );
  const connection = props.status.providers.find((value) => value.id === selected);
  return (
    <div className="provider-settings">
      <ConnectionPicker status={props.status} value={selected} onChange={setSelected} allowAdd />
      {connection?.provider.kind === 'codex' ? (
        <CodexSettings {...props} connection={connection} />
      ) : (
        <ApiSettings key={selected} {...props} connection={connection} />
      )}
    </div>
  );
}
function CodexSettings({
  status,
  snapshot,
  action,
  onView,
  connection,
}: Props & { connection: Connection }) {
  const [saving, setSaving] = useState(false);
  return (
    <section className="form-card provider-card">
      <div className="section-heading">
        <div>
          <h2>Codex</h2>
          <p>この端末のChatGPT認証を使います。</p>
        </div>
        <span className={`status-chip ${connection.active ? 'ready' : ''}`}>
          {connection.active ? '使用中' : '未選択'}
        </span>
      </div>
      <CodexLogin conversationId={snapshot.conversation.id} action={action} />
      <p className="connection-model-note">
        {connection.provider.model
          ? `前回のモデル: ${connection.provider.model}`
          : 'モデルはチャットの入力欄から選べます。'}
      </p>
      <button
        className="primary connect-button"
        disabled={saving || status.working || !status.codex?.subscriptionReady}
        onClick={() => {
          if (connection.active) return onView('chat');
          setSaving(true);
          void action(async () => {
            await api('/config/provider/activate', 'POST', {
              revision: status.config.revision,
              id: connection.id,
            });
            onView('chat');
          }).finally(() => setSaving(false));
        }}
      >
        {saving ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}
        {saving ? '切り替え中…' : connection.active ? 'チャットでモデルを選ぶ' : 'Codexを使う'}
      </button>
    </section>
  );
}
function ApiSettings({
  status,
  snapshot,
  action,
  onView,
  connection,
}: Props & { connection?: Connection }) {
  const [baseUrl, setBaseUrl] = useState(connection?.provider.baseUrl || '');
  const [credential, setCredential] = useState(''),
    [saving, setSaving] = useState(false);
  const [keyRequired, setKeyRequired] = useState(connection?.provider.keyRequired ?? true);
  const [supportsImages, setSupportsImages] = useState(connection?.provider.supportsImages ?? true);
  let matching: Connection | undefined;
  try {
    matching = status.providers.find(
      (value) =>
        value.provider.kind !== 'codex' &&
        providerUrl(value.provider.baseUrl) === providerUrl(baseUrl),
    );
  } catch {}
  const savedKey = !!matching?.credentialSaved;
  const connected = savedKey || (!!matching && !keyRequired);
  const disabled = saving || status.working;
  const activate = () => {
    if (!connection || disabled) return;
    setSaving(true);
    void action(async () => {
      await api('/config/provider/activate', 'POST', {
        revision: status.config.revision,
        id: connection.id,
      });
      onView('chat');
    }).finally(() => setSaving(false));
  };
  return (
    <form
      className="form-card provider-card"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        setSaving(true);
        void action(async () => {
          const provider: Provider = {
            ...(matching?.provider || {}),
            kind: 'openai',
            baseUrl: providerUrl(baseUrl),
            model: matching?.provider.model || '',
            supportsImages,
            keyRequired,
          };
          const result = await api<{ credentialReady: boolean }>('/config/provider', 'PUT', {
            revision: status.config.revision,
            provider,
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
        }).finally(() => setSaving(false));
      }}
    >
      <div className="section-heading">
        <div>
          <h2>{connection?.name || 'APIに接続'}</h2>
          <p>APIキーとモデルを接続先ごとに保存します。</p>
        </div>
        <span className={`status-chip ${connected ? 'ready' : ''}`}>
          {connection?.active ? '使用中' : connected ? '保存済み' : '未登録'}
        </span>
      </div>
      <label>
        APIのURL
        <input
          name="baseUrl"
          type="url"
          value={baseUrl}
          required
          disabled={disabled}
          placeholder="https://api.example.com/v1"
          onChange={(e) => {
            setBaseUrl(e.target.value);
            setCredential('');
          }}
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
            disabled={disabled}
            placeholder={
              savedKey ? '保存済みのキーを使用（変更する場合だけ入力）' : 'APIキーを入力'
            }
          />
          <small className="muted">
            この端末に暗号化して保存します。チャットには送信しません。
          </small>
        </label>
      )}
      {matching?.provider.model && (
        <p className="connection-model-note">
          前回のモデル: {matching.provider.model}
          {matching.provider.reasoningEffort ? ` · ${matching.provider.reasoningEffort}` : ''}
        </p>
      )}
      <div className="form-grid">
        <label className="checkbox">
          <input
            type="checkbox"
            name="supportsImages"
            checked={supportsImages}
            disabled={disabled}
            onChange={(e) => setSupportsImages(e.target.checked)}
          />
          画像を送信できる
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            name="keyRequired"
            checked={keyRequired}
            disabled={disabled}
            onChange={(e) => setKeyRequired(e.target.checked)}
          />
          APIキーを使用する
        </label>
      </div>
      <div className="connection-actions">
        <button className="primary" disabled={disabled}>
          {saving ? '保存中…' : '保存して接続する'}
        </button>
        {connection && !connection.active && connected && (
          <button type="button" disabled={disabled} onClick={activate}>
            保存済みの設定で使う
          </button>
        )}
        {connection?.active && (
          <button type="button" onClick={() => onView('chat')}>
            チャットへ戻る
            <ArrowRight size={14} />
          </button>
        )}
      </div>
      {savedKey && matching && (
        <button
          type="button"
          className="connection-remove-key"
          disabled={disabled}
          onClick={() => {
            if (!window.confirm(`${matching.name}の保存済みAPIキーを削除しますか？`)) return;
            setSaving(true);
            void action(async () => {
              await api('/config/provider/credential', 'DELETE', {
                revision: status.config.revision,
                id: matching.id,
              });
              setCredential('');
            }).finally(() => setSaving(false));
          }}
        >
          保存済みAPIキーを削除
        </button>
      )}
    </form>
  );
}
