import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, stateLabel, type Snapshot, type Status } from './api';
import type { Action, View } from './App';
import { McpInstall } from './McpInstall';

type Connection = Status['config']['mcp'][number];
type Props = { status: Status; snapshot: Snapshot; action: Action; onView: (v: View) => void };
export function McpSettings({ status, snapshot, action, onView }: Props) {
  const [editor, setEditor] = useState<{ connection?: Connection; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const perform = (task: () => Promise<unknown>) => {
    setBusy(true);
    void action(task).finally(() => setBusy(false));
  };
  const secret = (targetId: string) =>
    perform(async () => {
      await api('/config/secret-request', 'POST', {
        conversationId: snapshot.conversation.id,
        targetId,
      });
      onView('requests');
    });
  return (
    <section className="form-card mcp-settings">
      <div className="section-heading">
        <div>
          <h2>MCPサーバー</h2>
          <p>ローカルのコマンドやHTTPサーバーを接続します。</p>
        </div>
        <button disabled={busy} onClick={() => setEditor({ revision: status.config.revision })}>
          <Plus size={14} />
          接続を追加
        </button>
      </div>
      {editor && (
        <ConnectionForm
          key={editor.connection?.name || 'new'}
          {...editor}
          status={status}
          snapshot={snapshot}
          action={action}
          onClose={() => setEditor(null)}
        />
      )}
      {status.config.mcp.length
        ? status.config.mcp.map((connection) => {
            const m = status.mcp.find((item) => item.name === connection.name);
            return (
              <div className="connection-row" key={connection.name} data-mcp-name={connection.name}>
                <span>
                  <strong>{connection.name}</strong>
                  <small>
                    {stateLabel[m?.state || 'disconnected']} · {m?.tools || 0} tools
                  </small>
                  <code className="mcp-endpoint" title={connection.command || connection.url}>
                    {connection.transport === 'stdio'
                      ? [connection.command, ...connection.args].join(' ')
                      : connection.url}
                  </code>
                  {m?.error && <small className="danger">{m.error}</small>}
                </span>
                <div>
                  <button
                    disabled={busy}
                    onClick={() => setEditor({ connection, revision: status.config.revision })}
                  >
                    編集
                  </button>
                  <button
                    disabled={busy || m?.state === 'connecting'}
                    onClick={() =>
                      perform(() =>
                        m?.state === 'connected'
                          ? api(`/config/mcp/${connection.name}/disconnect`, 'POST', {})
                          : api(`/config/mcp/${connection.name}/connect`, 'POST', {
                              conversationId: snapshot.conversation.id,
                            }),
                      )
                    }
                  >
                    {m?.state === 'connected'
                      ? '切断'
                      : m?.state === 'connecting'
                        ? '接続中…'
                        : '接続'}
                  </button>
                  {connection.oauthClientSecret && (
                    <button
                      disabled={busy}
                      onClick={() => secret(`oauth-client:${connection.name}`)}
                    >
                      クライアント認証
                    </button>
                  )}
                  {connection.oauth ? (
                    <button onClick={() => onView('requests')}>認証を確認</button>
                  ) : (
                    (connection.transport === 'http' || connection.credentialEnv) && (
                      <button disabled={busy} onClick={() => secret(`mcp:${connection.name}`)}>
                        認証情報
                      </button>
                    )
                  )}
                  <button
                    disabled={busy}
                    className="icon-button danger"
                    aria-label={`${connection.name}を削除`}
                    onClick={() =>
                      perform(() => api(`/config/mcp/${connection.name}`, 'DELETE', {}))
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })
        : !editor && (
            <p className="muted mcp-empty">
              接続はまだありません。「接続を追加」からサーバーを登録できます。
            </p>
          )}
      <McpInstall snapshot={snapshot} action={action} onRun={() => onView('terminal')} />
    </section>
  );
}

function ConnectionForm({
  connection,
  revision,
  status,
  snapshot,
  action,
  onClose,
}: {
  connection?: Connection;
  revision: number;
  status: Status;
  snapshot: Snapshot;
  action: Action;
  onClose: () => void;
}) {
  const [transport, setTransport] = useState(connection?.transport || 'stdio');
  const [oauth, setOauth] = useState(connection?.oauth || false);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="nested-form mcp-connection-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        const f = new FormData(e.currentTarget);
        setBusy(true);
        void action(async () => {
          const name = String(f.get('name'));
          if (!connection && status.config.mcp.some((m) => m.name === name))
            throw new Error('同じ名前の接続があります。一覧の「編集」から変更してください。');
          const args = transport === 'stdio' ? JSON.parse(String(f.get('args') || '[]')) : [];
          if (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))
            throw new Error('引数は文字列のJSON配列で入力してください。');
          await api('/config/mcp', 'PUT', {
            revision,
            connection: {
              name,
              transport,
              args,
              enabled: true,
              ...(transport === 'stdio'
                ? {
                    command: String(f.get('command')),
                    ...(f.get('credentialEnv')
                      ? { credentialEnv: String(f.get('credentialEnv')).trim() }
                      : {}),
                  }
                : {
                    url: String(f.get('url')),
                    oauth,
                    ...(oauth && f.get('oauthClientId')
                      ? {
                          oauthClientId: String(f.get('oauthClientId')),
                          oauthClientSecret: f.get('oauthClientSecret') === 'on',
                        }
                      : {}),
                    ...(oauth && f.get('oauthScope')
                      ? { oauthScope: String(f.get('oauthScope')) }
                      : {}),
                  }),
              ...(f.get('desktop') === 'on'
                ? { targetId: 'desktop' }
                : connection?.targetId && connection.targetId !== 'desktop'
                  ? { targetId: connection.targetId }
                  : {}),
            },
          });
          onClose();
          await api(`/config/mcp/${name}/connect`, 'POST', {
            conversationId: snapshot.conversation.id,
          });
        }).finally(() => setBusy(false));
      }}
    >
      <h3>{connection ? `${connection.name}を編集` : '接続を追加'}</h3>
      <div className="form-grid">
        <label>
          接続名
          <input
            name="name"
            defaultValue={connection?.name}
            readOnly={!!connection}
            pattern="[A-Za-z][A-Za-z0-9_-]{0,39}"
            required
            placeholder="my-tools"
          />
        </label>
        <label>
          通信方法
          <select
            name="transport"
            value={transport}
            onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}
          >
            <option value="stdio">ローカルコマンド（stdio）</option>
            <option value="http">HTTP</option>
          </select>
        </label>
      </div>
      {transport === 'stdio' ? (
        <>
          <label>
            実行コマンド
            <input
              name="command"
              defaultValue={connection?.command || ''}
              required
              placeholder="npx"
            />
          </label>
          <label>
            引数（JSON配列）
            <input
              name="args"
              defaultValue={JSON.stringify(connection?.args || [])}
              required
              placeholder='["-y", "@example/mcp-server"]'
            />
          </label>
          <details>
            <summary>認証情報を渡す場合</summary>
            <label>
              環境変数名
              <input
                name="credentialEnv"
                defaultValue={connection?.credentialEnv || ''}
                pattern="[A-Z][A-Za-z0-9_]{0,99}"
                placeholder="SERVICE_API_KEY"
              />
            </label>
            <small className="muted">値は保存後に「認証情報」から入力します。</small>
          </details>
        </>
      ) : (
        <>
          <label>
            HTTPエンドポイント
            <input
              name="url"
              type="url"
              required
              defaultValue={connection?.url || ''}
              placeholder="https://example.com/mcp"
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              name="oauth"
              checked={oauth}
              onChange={(e) => setOauth(e.target.checked)}
            />
            OAuth認証を使う
          </label>
          {oauth && (
            <details>
              <summary>事前登録したOAuthクライアント</summary>
              <label>
                クライアントID
                <input name="oauthClientId" defaultValue={connection?.oauthClientId || ''} />
              </label>
              <label>
                スコープ
                <input
                  name="oauthScope"
                  defaultValue={connection?.oauthScope || ''}
                  placeholder="スペース区切り"
                />
              </label>
              <label className="checkbox">
                <input
                  name="oauthClientSecret"
                  type="checkbox"
                  defaultChecked={connection?.oauthClientSecret || false}
                />
                クライアントシークレットを使う
              </label>
              <small className="muted">
                シークレットは保存後の「クライアント認証」から入力します。リダイレクト先は{' '}
                {location.origin}/api/mcp/oauth/callback です。
              </small>
            </details>
          )}
        </>
      )}
      <label className="checkbox">
        <input name="desktop" type="checkbox" defaultChecked={connection?.targetId === 'desktop'} />
        共有デスクトップと同じ画面を操作する
      </label>
      <small className="muted">
        選択すると、画面の手動操作中はこの接続へのAIアクセスも止まります。
      </small>
      <div className="form-actions">
        <button className="primary" disabled={busy}>
          {busy ? '保存中…' : '保存して接続'}
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          キャンセル
        </button>
      </div>
    </form>
  );
}
