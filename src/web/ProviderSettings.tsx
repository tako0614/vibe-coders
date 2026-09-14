import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, LoaderCircle, RefreshCw } from 'lucide-react';
import { api, type Snapshot, type Status } from './api';
import type { Action, View } from './App';
import { CodexLogin } from './CodexLogin';

export function ProviderSettings({
  status,
  snapshot,
  action,
  onView,
}: {
  status: Status;
  snapshot: Snapshot;
  action: Action;
  onView: (view: View) => void;
}) {
  const provider = status.config.provider;
  const [kind, setKind] = useState(provider?.kind || (provider ? 'openai' : 'codex'));
  const [model, setModel] = useState(provider?.kind === 'codex' ? provider.model : '');
  const [models, setModels] = useState<{ id: string; name: string; isDefault: boolean }[]>([]);
  const [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  useEffect(() => {
    if (kind !== 'codex') return;
    let current = true;
    setLoading(true);
    void api<typeof models>('/codex/models')
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
          setError(
            'モデルを取得できませんでした。サーバーのCodex CLIを確認して、再読み込みしてください。',
          );
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [kind, status.codex?.subscriptionReady, reload]);
  const saveCodex = async () => {
    if (!model) throw new Error('利用するモデルを選択してください。');
    await api('/config/provider', 'PUT', {
      revision: status.config.revision,
      provider: {
        kind: 'codex',
        model,
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        supportsImages: true,
        keyRequired: false,
      },
    });
  };
  const connected = status.providerReady && (provider?.kind || 'openai') === kind;
  return (
    <div className="provider-settings">
      <div className="provider-picker" role="group" aria-label="AIの接続方法">
        <button className={kind === 'codex' ? 'selected' : ''} onClick={() => setKind('codex')}>
          <strong>Codex</strong>
          <span>ChatGPTのサブスクで使う</span>
        </button>
        <button className={kind === 'openai' ? 'selected' : ''} onClick={() => setKind('openai')}>
          <strong>APIキー</strong>
          <span>OpenAI互換のサービス</span>
        </button>
      </div>
      {kind === 'codex' ? (
        <section className="form-card provider-card">
          <div className="section-heading">
            <div>
              <h2>Codexに接続</h2>
              <p>ログインしたアカウントで、チャットやツールを実行します。</p>
            </div>
            <span className={`status-chip ${connected ? 'ready' : ''}`}>
              {connected ? '接続済み' : '未接続'}
            </span>
          </div>
          <label>
            モデル
            <select
              name="model"
              value={model}
              disabled={loading || saving}
              onChange={(e) => setModel(e.target.value)}
            >
              {!model && <option value="">{loading ? 'モデルを取得中…' : 'モデルを選択'}</option>}
              {model && !models.some((m) => m.id === model) && (
                <option value={model}>{model}</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.isDefault ? '（既定）' : ''}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <div className="inline-error" role="alert">
              {error}
              <button type="button" onClick={() => setReload((n) => n + 1)}>
                <RefreshCw size={14} />
                再読み込み
              </button>
            </div>
          )}
          <CodexLogin
            conversationId={snapshot.conversation.id}
            action={action}
            beforeLogin={saveCodex}
          />
          {status.codex?.subscriptionReady && (
            <button
              className="primary connect-button"
              disabled={saving || !model}
              onClick={() =>
                void action(async () => {
                  setSaving(true);
                  try {
                    await saveCodex();
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
          )}
          {!status.codex?.subscriptionReady && (
            <p className="connection-help">
              ログインすると、選択したモデルへの接続も保存されます。
            </p>
          )}
        </section>
      ) : (
        <form
          className="form-card provider-card"
          key={provider?.revision || 0}
          onSubmit={(event) => {
            event.preventDefault();
            const f = new FormData(event.currentTarget);
            void action(async () => {
              setSaving(true);
              try {
                await api('/config/provider', 'PUT', {
                  revision: status.config.revision,
                  provider: {
                    kind: 'openai',
                    baseUrl: String(f.get('baseUrl')),
                    model: String(f.get('model')),
                    supportsImages: f.get('supportsImages') === 'on',
                    keyRequired: f.get('keyRequired') === 'on',
                  },
                });
                if (f.get('keyRequired') === 'on') {
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
              <p>利用するサービスのURLとモデルを指定します。</p>
            </div>
            <span className={`status-chip ${connected ? 'ready' : ''}`}>
              {connected ? '接続済み' : '未接続'}
            </span>
          </div>
          <label>
            APIのURL
            <input
              name="baseUrl"
              type="url"
              defaultValue={
                provider?.kind !== 'codex'
                  ? provider?.baseUrl || 'https://api.openai.com/v1'
                  : 'https://api.openai.com/v1'
              }
              required
            />
          </label>
          <label>
            モデルID
            <input
              name="model"
              defaultValue={provider?.kind !== 'codex' ? provider?.model : ''}
              placeholder="サービスが提供するモデルID"
              required
            />
          </label>
          <div className="form-grid">
            <label className="checkbox">
              <input
                type="checkbox"
                name="supportsImages"
                defaultChecked={provider?.supportsImages ?? true}
              />
              画像を送信できる
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                name="keyRequired"
                defaultChecked={provider?.kind === 'codex' ? true : (provider?.keyRequired ?? true)}
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
          <small className="muted">APIキーは次の専用入力で保存します。</small>
        </form>
      )}
    </div>
  );
}
