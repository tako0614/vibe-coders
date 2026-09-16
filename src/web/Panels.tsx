import { McpInstall } from './McpInstall';
import { ChangesPanel, FileEditor } from './ChangesPanel';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Brain,
  Check,
  Clock3,
  Folder,
  FileText,
  Hand,
  Link2,
  Monitor,
  Play,
  Plus,
  Search,
  RefreshCw,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { AtomView } from 'atom-memory';
import { api, operationId, time, stateLabel, type Snapshot, type Status } from './api';
import type { Action, View } from './App';
import { ProviderSettings } from './ProviderSettings';

function Heading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div className="heading-row">
        <h1>{title}</h1>
        {children}
      </div>
      <p>{description}</p>
    </div>
  );
}
function Empty({ icon: Icon, title, text }: { icon: typeof Brain; title: string; text: string }) {
  return (
    <div className="empty-panel">
      <Icon size={27} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

const localTimeInput = (ms: number) => {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export function SchedulesPanel({ snapshot, action }: { snapshot: Snapshot; action: Action }) {
  const [editing, setEditing] = useState<string | null>(null);
  const existing = snapshot.schedules.find((s) => s.id === editing);
  return (
    <section className="page">
      <Heading
        eyebrow="SCHEDULES"
        title="予定"
        description="指定した時刻に指示やコマンドを実行します。停止中に過ぎた周期は一回にまとめます。"
      >
        <button className="primary" onClick={() => setEditing('new')}>
          <Plus size={15} />
          予定を追加
        </button>
      </Heading>
      {editing && (
        <form
          className="form-card"
          key={editing}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void action(async () => {
              const spec = {
                title: String(f.get('title')),
                prompt: String(f.get('prompt')),
                action: String(f.get('action')),
                nextAt: new Date(String(f.get('nextAt'))).getTime(),
                intervalMs: f.get('interval') ? Number(f.get('interval')) * 60000 : null,
                enabled: f.get('enabled') === 'on',
                timeZone: String(f.get('timeZone')),
                ...(f.get('event')
                  ? {
                      trigger: {
                        event: String(f.get('event')),
                        repeat: f.get('repeatEvent') === 'on',
                        ...(f.get('runId') ? { runId: String(f.get('runId')) } : {}),
                        ...(f.get('requestId') ? { requestId: String(f.get('requestId')) } : {}),
                      },
                    }
                  : {}),
              };
              await api(
                existing ? `/schedules/${existing.id}` : '/schedules',
                existing ? 'PUT' : 'POST',
                existing ? spec : { conversationId: snapshot.conversation.id, spec },
              );
              setEditing(null);
            });
          }}
        >
          <div className="heading-row">
            <h3>{existing ? '予定を編集' : '新しい予定'}</h3>
            <button
              type="button"
              className="icon-button"
              aria-label="予定フォームを閉じる"
              onClick={() => setEditing(null)}
            >
              <X size={16} />
            </button>
          </div>
          <label>
            名前
            <input
              name="title"
              defaultValue={existing?.title}
              required
              placeholder="進捗を確認する"
            />
          </label>
          <label>
            実行すること
            <textarea
              name="prompt"
              defaultValue={existing?.prompt}
              required
              placeholder="動いている作業を確認して、必要な対応を進めて。"
            />
          </label>
          <div className="form-grid">
            <label>
              実行方法
              <select name="action" defaultValue={existing?.action || 'prompt'}>
                <option value="prompt">親に指示を届ける</option>
                <option value="shell">コマンドを実行</option>
              </select>
            </label>
            <label>
              次回日時
              <input
                name="nextAt"
                type="datetime-local"
                defaultValue={localTimeInput(existing?.nextAt || Date.now() + 600000)}
                required
              />
            </label>
            <label>
              繰り返し（分）
              <input
                name="interval"
                type="number"
                min="1"
                defaultValue={existing?.intervalMs ? existing.intervalMs / 60000 : ''}
                placeholder="空欄なら一回だけ"
              />
            </label>
            <label>
              タイムゾーン
              <input
                name="timeZone"
                defaultValue={
                  existing?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone
                }
                required
              />
            </label>
          </div>
          <label className="checkbox">
            <input type="checkbox" name="enabled" defaultChecked={existing?.enabled ?? true} />
            有効にする
          </label>
          <details className="advanced-options" open={!!existing?.trigger}>
            <summary>イベントを条件に実行</summary>
            <div>
              <label>
                起動条件
                <select name="event" defaultValue={existing?.trigger?.event || ''}>
                  <option value="">指定日時・周期</option>
                  <option value="run.completed">実行が終了したら</option>
                  <option value="human.resolved">入力依頼が解決したら</option>
                  <option value="user.message">メッセージを受信したら</option>
                </select>
              </label>
              <div className="form-grid">
                <label>
                  対象の実行ID（省略可）
                  <input name="runId" defaultValue={existing?.trigger?.runId} />
                </label>
                <label>
                  対象の入力依頼ID（省略可）
                  <input name="requestId" defaultValue={existing?.trigger?.requestId} />
                </label>
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  name="repeatEvent"
                  defaultChecked={existing?.trigger?.repeat}
                />
                条件が成立するたびに実行
              </label>
            </div>
          </details>
          <small className="muted">
            親への周期指示ではモデル利用料金が発生する場合があります。
          </small>
          <button className="primary">保存</button>
        </form>
      )}
      {snapshot.schedules.length ? (
        <div className="item-list">
          {snapshot.schedules.map((s) => (
            <article className="list-card" key={s.id}>
              <div className="list-icon">
                <Clock3 size={19} />
              </div>
              <div className="list-body">
                <h3>
                  {s.title}
                  <span className="tag">{s.source === 'repo' ? 'atom.toml' : 'この端末'}</span>
                </h3>
                <p>{s.prompt}</p>
                <small>
                  {s.enabled
                    ? s.trigger
                      ? `条件: ${s.trigger.event}`
                      : `次回 ${time(s.nextAt)}`
                    : '無効'}{' '}
                  · {s.intervalMs ? `${s.intervalMs / 60000} 分ごと` : '一回だけ'} · {s.timeZone}
                  {s.lastAt ? ` · 前回 ${time(s.lastAt)}` : ''}
                </small>
              </div>
              <div className="list-actions">
                <button
                  title="今すぐ実行"
                  aria-label="今すぐ実行"
                  onClick={() => void action(() => api(`/schedules/${s.id}/fire`, 'POST', {}))}
                >
                  <Play size={15} />
                </button>
                {s.source === 'local' && (
                  <>
                    <button onClick={() => setEditing(s.id)}>編集</button>
                    <button
                      className="danger"
                      title="予定を削除"
                      aria-label="予定を削除"
                      onClick={() => void action(() => api(`/schedules/${s.id}`, 'DELETE', {}))}
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        !editing && (
          <Empty
            icon={Clock3}
            title="予定はまだありません"
            text="定期的に確認したいことや、後で動かしたい作業を登録できます。"
          />
        )
      )}
    </section>
  );
}

export function SettingsPanel({
  status,
  initialSection = 'model',
  snapshot,
  action,
  onView,
}: {
  status: Status;
  initialSection?: string;
  snapshot: Snapshot;
  action: Action;
  onView: (v: View, section?: string) => void;
}) {
  const [mcpForm, setMcpForm] = useState(false),
    [desktopForm, setDesktopForm] = useState(false);
  const [section, setSection] = useState(initialSection);
  const key = (targetId: string) =>
    action(async () => {
      await api('/config/secret-request', 'POST', {
        conversationId: snapshot.conversation.id,
        targetId,
      });
      onView('requests');
    });
  return (
    <section className="page settings-page">
      <Heading
        eyebrow="SETTINGS & CONNECTIONS"
        title="設定・接続"
        description="AIやツールの接続、実行環境を管理します。"
      />
      <div className="settings-tabs" role="tablist" aria-label="設定の種類">
        {[
          ['model', 'AI接続'],
          ['mcp', 'MCP'],
          ['desktop', 'デスクトップ'],
          ['search', 'Web検索'],
          ['system', '保存と実行'],
        ].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={section === id} onClick={() => setSection(id)}>
            {label}
          </button>
        ))}
      </div>
      {section === 'model' && (
        <ProviderSettings status={status} snapshot={snapshot} action={action} onView={onView} />
      )}
      <section className="form-card" hidden={section !== 'mcp'}>
        <div className="section-heading">
          <span className="list-icon">
            <Link2 size={18} />
          </span>
          <div>
            <h2>MCP接続</h2>
            <p>使いたい機能の導入から接続・動作確認まで依頼</p>
          </div>
          <button onClick={() => setMcpForm(!mcpForm)}>
            <Plus size={14} />
            手動で設定
          </button>
        </div>
        <form
          className="nested-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const request = String(new FormData(form).get('request') || '');
            void action(async () => {
              await api('/mcp/setup', 'POST', {
                conversationId: snapshot.conversation.id,
                request,
                operationId: operationId(),
              });
              form.reset();
              onView('chat');
            });
          }}
        >
          <label>
            追加したい機能
            <textarea
              name="request"
              rows={3}
              required
              maxLength={8000}
              placeholder="Chromeを導入してMCPで接続し、ページを操作できるようにして"
            />
          </label>
          <div className="form-actions">
            <button className="primary" disabled={!status.providerReady}>
              AIに導入を依頼
            </button>
          </div>
          {!status.providerReady && (
            <small className="muted">
              先に親AIの接続方法を選び、CodexログインまたはAPIキーを設定してください。
            </small>
          )}
        </form>
        <McpInstall snapshot={snapshot} action={action} onRun={() => onView('terminal')} />
        {status.mcp.length ? (
          status.mcp.map((m) => (
            <div className="connection-row" key={m.name}>
              <span>
                <strong>{m.name}</strong>
                <small>
                  {stateLabel[m.state]} · {m.tools} tools{m.targetId ? ` · ${m.targetId}` : ''}
                </small>
                {m.error && <small className="danger">{m.error}</small>}
              </span>
              <div>
                <button
                  onClick={() =>
                    void action(() =>
                      api(`/config/mcp/${m.name}/connect`, 'POST', {
                        conversationId: snapshot.conversation.id,
                      }),
                    )
                  }
                >
                  接続
                </button>
                {m.state === 'connected' && (
                  <button
                    onClick={() =>
                      void action(() => api(`/config/mcp/${m.name}/disconnect`, 'POST', {}))
                    }
                  >
                    切断
                  </button>
                )}
                {status.config.mcp.find((c) => c.name === m.name)?.oauthClientSecret && (
                  <button onClick={() => void key(`oauth-client:${m.name}`)}>
                    クライアント認証
                  </button>
                )}
                {status.config.mcp.find((c) => c.name === m.name)?.oauth ? (
                  <button onClick={() => onView('requests')}>認証の進行を確認</button>
                ) : (
                  <button onClick={() => void key(`mcp:${m.name}`)}>認証</button>
                )}
                <button
                  className="icon-button danger"
                  aria-label={`${m.name}を削除`}
                  onClick={() => void action(() => api(`/config/mcp/${m.name}`, 'DELETE', {}))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="muted">
            まだ接続がありません。追加後に接続して、実際のツール一覧を取得します。
          </p>
        )}
        {mcpForm && (
          <form
            className="nested-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void action(async () => {
                const transport = String(f.get('transport'));
                const connection = {
                  name: String(f.get('name')),
                  transport,
                  args: JSON.parse(String(f.get('args') || '[]')),
                  enabled: true,
                  oauth: f.get('oauth') === 'on',
                  ...(f.get('oauthClientId')
                    ? {
                        oauthClientId: String(f.get('oauthClientId')),
                        oauthClientSecret: f.get('oauthClientSecret') === 'on',
                      }
                    : {}),
                  ...(f.get('oauthScope') ? { oauthScope: String(f.get('oauthScope')) } : {}),
                  ...(String(f.get('credentialEnv') || '').trim()
                    ? { credentialEnv: String(f.get('credentialEnv')).trim() }
                    : {}),
                  ...(transport === 'stdio'
                    ? { command: String(f.get('command')) }
                    : { url: String(f.get('url')) }),
                  ...(f.get('desktop') === 'on' ? { targetId: 'desktop' } : {}),
                };
                await api('/config/mcp', 'PUT', { revision: status.config.revision, connection });
                setMcpForm(false);
                await api(`/config/mcp/${connection.name}/connect`, 'POST', {
                  conversationId: snapshot.conversation.id,
                });
              });
            }}
          >
            <label>
              接続名
              <input
                name="name"
                pattern="[A-Za-z][A-Za-z0-9_-]{0,39}"
                required
                placeholder="tools"
              />
            </label>
            <label>
              通信方法
              <select name="transport">
                <option value="stdio">ローカルプロセス (stdio)</option>
                <option value="http">HTTP</option>
              </select>
            </label>
            <div className="form-grid">
              <label>
                実行コマンド
                <input name="command" placeholder="npx" />
              </label>
              <label>
                引数（JSON配列）
                <input name="args" defaultValue="[]" />
              </label>
            </div>
            <label>
              HTTPエンドポイント
              <input name="url" type="url" placeholder="https://example.com/mcp" />
            </label>
            <label>
              stdio接続に認証情報を渡す環境変数名（任意）
              <input name="credentialEnv" placeholder="SERVICE_API_KEY" />
            </label>
            <small className="muted">
              秘密の値は登録後の専用入力で保存します。この接続のプロセスにだけ渡します。
            </small>
            <label className="checkbox">
              <input type="checkbox" name="desktop" />
              共有デスクトップと同じ対象を操作する
            </label>
            <label className="checkbox">
              <input type="checkbox" name="oauth" />
              HTTP接続でOAuth認証を使う
            </label>
            <details>
              <summary>事前登録したOAuthクライアント（任意）</summary>
              <label>
                クライアントID
                <input name="oauthClientId" />
              </label>
              <label>
                スコープ
                <input name="oauthScope" placeholder="スペース区切り" />
              </label>
              <label className="checkbox">
                <input name="oauthClientSecret" type="checkbox" />
                クライアントシークレットを使う
              </label>
              <small className="muted">
                シークレットは登録後の「クライアント認証」から保存してください。リダイレクト先には、この画面のURLの
                /api/mcp/oauth/callback を登録します。
              </small>
            </details>
            <small className="muted">
              接続先が同じブラウザ・画面を扱う場合に選択してください。手動操作中のAIアクセスを連動させます。
            </small>
            <div className="form-actions">
              <button className="primary">登録して接続</button>
              <button type="button" onClick={() => setMcpForm(false)}>
                閉じる
              </button>
            </div>
          </form>
        )}
      </section>
      <section className="form-card" hidden={section !== 'desktop'}>
        <div className="section-heading">
          <span className="list-icon">
            <Monitor size={18} />
          </span>
          <div>
            <h2>共有デスクトップ</h2>
            <p>インストール先の画面を自動で共有</p>
          </div>
          <button onClick={() => setDesktopForm(!desktopForm)}>手動接続の設定</button>
        </div>
        <p>
          {status.desktop.configured
            ? `${status.desktop.name} / DISPLAY ${status.desktop.display}`
            : status.desktop.message}
        </p>
        <small className="muted">
          Linuxでは利用可能な画面を自動接続し、画面のない環境では専用デスクトップを起動します。
          別のVNCを使う場合は手動接続を設定してください。
        </small>
        {desktopForm && (
          <form
            className="nested-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void action(async () => {
                await api('/config/desktop', 'PUT', {
                  revision: status.config.revision,
                  desktop: {
                    name: String(f.get('name')),
                    mode: String(f.get('mode')),
                    display: String(f.get('display')),
                    vncHost: '127.0.0.1',
                    vncPort: Number(f.get('port')),
                  },
                });
                setDesktopForm(false);
              });
            }}
          >
            <label>
              画面の名前
              <input
                name="name"
                required
                defaultValue={status.config.desktop?.name || 'この端末のデスクトップ'}
              />
            </label>
            <div className="form-grid">
              <label>
                DISPLAY
                <input
                  name="display"
                  required
                  defaultValue={status.config.desktop?.display || ':0'}
                />
              </label>
              <label>
                VNCポート
                <input
                  name="port"
                  type="number"
                  required
                  min="1"
                  max="65535"
                  defaultValue={status.config.desktop?.vncPort || 5900}
                />
              </label>
            </div>
            <label>
              画面の操作方式
              <select name="mode" defaultValue={status.config.desktop?.mode || 'x11'}>
                <option value="x11">このホストのLinux X11</option>
                <option value="vnc">VNC経由（Wayland / macOS / Windows / 別ホスト）</option>
              </select>
            </label>
            <small className="muted">
              別ホストはSSH等でVNCポートをlocalhostへ転送します。対象画面のVNCサーバーはOS側で有効にしてください。
            </small>
            <div className="form-actions">
              <button className="primary">保存</button>
              {status.desktop.configured && (
                <button type="button" onClick={() => void key('desktop')}>
                  VNCパスワードを入力
                </button>
              )}
            </div>
          </form>
        )}
      </section>
      <section className="form-card control-card" hidden={section !== 'system'}>
        <h2>実行の制御</h2>
        <p>全停止は、親・管理下プロセス・予定からの新規実行を止めます。</p>
        <button
          className="danger"
          onClick={() =>
            void action(() =>
              api('/control', 'POST', { action: status.stopped ? 'enable' : 'stop' }),
            )
          }
        >
          <Square size={13} />
          {status.stopped ? '実行を再び有効にする' : 'すべての実行を停止'}
        </button>
      </section>
      <form
        hidden={section !== 'search'}
        className="form-card"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void action(() =>
            api('/config/search', 'PUT', {
              revision: status.config.revision,
              search: { engine: f.get('engine'), baseUrl: f.get('baseUrl') },
            }),
          );
        }}
      >
        <h2>Web検索</h2>
        <label>
          検索サービス
          <select name="engine" defaultValue={status.config.search?.engine || 'searxng'}>
            <option value="searxng">SearXNG</option>
            <option value="brave">Brave Search</option>
          </select>
        </label>
        <label>
          検索APIのURL
          <input
            name="baseUrl"
            type="url"
            required
            defaultValue={status.config.search?.baseUrl}
            placeholder="https://search.example.com/search"
          />
        </label>
        <small className="muted">
          SearXNGはJSON形式を有効にしてください。BraveのURLは
          https://api.search.brave.com/res/v1/web/search です。
        </small>
        <div className="form-actions">
          <button className="primary">検索設定を保存</button>
          {status.config.search && (
            <button type="button" onClick={() => void key('search')}>
              検索APIキーを入力
            </button>
          )}
        </div>
      </form>
      <form
        hidden={section !== 'system'}
        className="form-card"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void action(() =>
            api('/config/retention', 'PUT', {
              revision: status.config.revision,
              retention: Object.fromEntries(
                ['imageDays', 'runDays', 'conversationDays'].map((name) => [
                  name,
                  f.get(name) ? Number(f.get(name)) : null,
                ]),
              ),
            }),
          );
        }}
      >
        <h2>保存期間</h2>
        <p>
          期限を過ぎた画像・終了済み実行・会話を自動整理します。進行中の作業と未回答の依頼がある会話は保持します。空欄は無期限です。
        </p>
        <div className="form-grid">
          {(
            [
              ['imageDays', '画像', 30],
              ['runDays', '終了済み実行', 30],
              ['conversationDays', '会話', 90],
            ] as const
          ).map(([name, label, fallback]) => (
            <label key={name}>
              {label}（日）
              <input
                type="number"
                min="1"
                name={name}
                defaultValue={
                  status.config.retention ? (status.config.retention[name] ?? '') : fallback
                }
              />
            </label>
          ))}
        </div>
        <div className="form-actions">
          <button className="primary">保存期間を設定</button>
          <button
            type="button"
            onClick={() => void action(() => api('/retention/prune', 'POST', {}))}
          >
            今すぐ期限を確認
          </button>
        </div>
      </form>
    </section>
  );
}

export function MemoryPanel({ action }: { action: Action }) {
  const [query, setQuery] = useState(''),
    [items, setItems] = useState<AtomView[]>([]),
    [add, setAdd] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const revision = useRef(0);
  const search = async () => {
    const request = ++revision.current;
    setLoading(true);
    setError('');
    try {
      const result = await api<{ items: AtomView[] }>(`/memory?q=${encodeURIComponent(query)}`);
      if (request === revision.current) setItems(result.items);
    } catch (e) {
      if (request === revision.current)
        setError(e instanceof Error ? e.message : '記憶を取得できませんでした。');
    } finally {
      if (request === revision.current) setLoading(false);
    }
  };
  useEffect(() => {
    void search();
    return () => {
      revision.current++;
    };
  }, []);
  return (
    <section className="page">
      <Heading
        eyebrow="ATOM MEMORY"
        title="記憶"
        description="必要な記憶を推論のたびに取り出します。記憶の保存や修正も、エージェントに依頼できます。"
      >
        <button className="primary" onClick={() => setAdd(!add)}>
          <Plus size={15} />
          記憶を追加
        </button>
      </Heading>
      <form
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Search size={17} />
        <input
          aria-label="記憶を検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="記憶を検索…"
        />
        <button disabled={loading}>{loading ? '検索中…' : '検索'}</button>
      </form>
      {add && (
        <form
          className="form-card"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const text = String(new FormData(form).get('text'));
            void action(async () => {
              await api('/memory', 'POST', { text });
              form.reset();
              setAdd(false);
              await search();
            });
          }}
        >
          <label>
            覚えておくこと
            <textarea name="text" required placeholder="方針や好み、作業で見つけたこと…" />
          </label>
          <button className="primary">保存</button>
        </form>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="panel-loading" role="status">
          記憶を読み込み中…
        </p>
      ) : items.length ? (
        <div className="memory-grid">
          {items.map((m) => (
            <article className="memory-card" key={m.ref}>
              <div>
                <Brain size={16} />
                <span>{m.provenance.origin}</span>
              </div>
              <p>{m.text}</p>
              <code title={m.ref}>{m.ref}</code>
              {m.links.length > 0 && <small>{m.links.length} 件の関連</small>}
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon={Brain}
          title="一致する記憶はありません"
          text="大切な文脈を保存すると、次の作業で取り出せるようになります。"
        />
      )}
    </section>
  );
}

type FilePreview = {
  path: string;
  text: string;
  totalLines: number;
  nextLine: number | null;
  sha256: string;
};
export function FilesPanel({ action }: { action: Action }) {
  const [changes, setChanges] = useState(false),
    [editing, setEditing] = useState(false);
  const [path, setPath] = useState('.'),
    [refresh, setRefresh] = useState(0);
  const [entries, setEntries] = useState<{ name: string; kind: string }[]>([]);
  const [file, setFile] = useState<FilePreview>(),
    [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true),
    [reading, setReading] = useState(false),
    [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const selection = useRef(0);
  useEffect(() => {
    let current = true;
    selection.current++;
    setLoading(true);
    setFile(undefined);
    setSelected('');
    setEditing(false);
    setError('');
    setEntries([]);
    setReading(false);
    setFilter('');
    void api<{ entries: typeof entries }>(`/files?path=${encodeURIComponent(path)}`)
      .then((value) => {
        if (current)
          setEntries(
            value.entries.sort(
              (a, b) =>
                Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
                a.name.localeCompare(b.name),
            ),
          );
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      selection.current++;
    };
  }, [path, refresh]);
  const read = async (target: string, previous?: FilePreview) => {
    const revision = ++selection.current;
    setSelected(target);
    setReading(true);
    setError('');
    if (!previous) setFile(undefined);
    try {
      const value = await api<FilePreview>(
        `/files/read?path=${encodeURIComponent(target)}${previous ? `&startLine=${previous.nextLine}` : ''}`,
      );
      if (selection.current !== revision) return;
      if (previous && previous.sha256 !== value.sha256)
        throw new Error('読み込み中にファイルが変更されました。開き直してください。');
      setFile(previous ? { ...value, text: previous.text + '\n' + value.text } : value);
    } catch (e) {
      if (selection.current === revision)
        setError(e instanceof Error ? e.message : 'ファイルを読み込めませんでした。');
    } finally {
      if (selection.current === revision) setReading(false);
    }
  };
  if (changes)
    return (
      <ChangesPanel
        action={action}
        back={() => {
          setChanges(false);
          setEditing(false);
          setRefresh((n) => n + 1);
        }}
      />
    );
  const visible = entries.filter((entry) =>
    entry.name.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <section className="page">
      <Heading
        eyebrow="FILES"
        title="ファイル"
        description="作業フォルダ内のファイルを確認・編集できます。"
      >
        <button onClick={() => setChanges(true)}>変更を確認</button>
      </Heading>
      <div className="file-browser">
        <div className="file-path">
          <button
            className="icon-button"
            aria-label="親フォルダへ"
            disabled={path === '.'}
            onClick={() => setPath(path.split('/').slice(0, -1).join('/') || '.')}
          >
            <ArrowLeft size={16} />
          </button>
          <button className="text-button" onClick={() => setPath('.')}>
            Home
          </button>
          <code>{path === '.' ? '/' : path.slice(2)}</code>
          <button
            className="icon-button file-refresh"
            aria-label="ファイルを再読み込み"
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw size={15} />
          </button>
        </div>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="file-columns">
          <div className="file-list">
            <input
              className="file-filter"
              aria-label="ファイル名で絞り込み"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="ファイル名で絞り込み"
            />
            {loading ? (
              <p className="panel-loading" role="status">
                読み込み中…
              </p>
            ) : !visible.length ? (
              <p className="panel-loading">
                {filter ? '一致するファイルはありません' : '空のフォルダです'}
              </p>
            ) : (
              visible.map((entry) => {
                const target = `${path}/${entry.name}`;
                return (
                  <button
                    key={entry.name}
                    className={selected === target ? 'selected' : ''}
                    onClick={() =>
                      entry.kind === 'directory' ? setPath(target) : void read(target)
                    }
                  >
                    {entry.kind === 'directory' ? <Folder size={16} /> : <FileText size={16} />}
                    <span>{entry.name}</span>
                  </button>
                );
              })
            )}
          </div>
          <div className="file-content" aria-busy={reading}>
            {editing && selected ? (
              <FileEditor
                key={selected}
                path={selected}
                close={() => setEditing(false)}
                saved={() => void read(selected)}
              />
            ) : file ? (
              <>
                <div className="file-info">
                  <code>{file.path.split('/').pop()}</code>
                  <span>{file.totalLines} 行</span>
                  <button onClick={() => setEditing(true)}>編集する</button>
                </div>
                <pre>{file.text}</pre>
                {file.nextLine && (
                  <button disabled={reading} onClick={() => void read(selected, file)}>
                    {reading ? '読み込み中…' : '続きを読む'}
                  </button>
                )}
              </>
            ) : reading ? (
              <p className="panel-loading" role="status">
                ファイルを読み込み中…
              </p>
            ) : (
              <Empty
                icon={FileText}
                title="ファイルを選択"
                text="ファイルの内容をここで確認できます。"
              />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export function DesktopPanel({
  status,
  action,
  onView,
}: {
  status: Status;
  action: Action;
  onView: (v: View, section?: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null),
    [connection, setConnection] = useState('未接続'),
    [preview, setPreview] = useState(''),
    [attempt, setAttempt] = useState(0);
  const desktop = status.desktop;
  useEffect(() => {
    if (!desktop.configured || desktop.owner !== 'human' || status.stopped) return;
    let disposed = false,
      rfb: { disconnect: () => void } | undefined;
    void action(async () => {
      setConnection('接続中');
      const [{ default: RFB }, { ticket }, credentials] = await Promise.all([
        import('@novnc/novnc'),
        api<{ ticket: string }>('/desktop/ticket', 'POST', {}),
        api<{ password: string }>('/desktop/credential', 'POST', {}),
      ]);
      if (disposed || !container.current) return;
      const client = new RFB(
        container.current,
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/desktop/socket?ticket=${encodeURIComponent(ticket)}`,
        { credentials },
      );
      rfb = client;
      client.scaleViewport = true;
      client.resizeSession = false;
      client.addEventListener('connect', () => {
        if (!disposed) setConnection('接続済み');
      });
      client.addEventListener('disconnect', () => {
        if (!disposed) setConnection('接続が切れました');
      });
      client.addEventListener('securityfailure', () => {
        if (!disposed) setConnection('VNC認証に失敗しました。');
      });
    });
    return () => {
      disposed = true;
      rfb?.disconnect();
    };
  }, [desktop.configured, desktop.owner, desktop.epoch, status.stopped, attempt, action]);
  useEffect(() => {
    setPreview('');
    if (!desktop.configured || desktop.owner !== 'agent' || status.stopped) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        if (document.visibilityState === 'visible') {
          const result = await api<{ image: string }>('/desktop/preview');
          if (!disposed) {
            setPreview(`data:image/png;base64,${result.image}`);
            setConnection('表示中');
          }
        }
      } catch {
        if (!disposed) setConnection('画面への再接続中…');
      }
      if (!disposed) timer = setTimeout(() => void refresh(), 1200);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [desktop.configured, desktop.owner, desktop.epoch, status.stopped, attempt]);
  return (
    <section className="page desktop-page">
      <Heading
        eyebrow="COMPUTER"
        title="デスクトップ"
        description="インストール先の画面を共有します。手動操作中は、この画面へのAIの観測と入力が止まります。"
      >
        {desktop.configured && (
          <button
            className="primary"
            disabled={status.stopped}
            onClick={() =>
              void action(() =>
                api('/desktop/handoff', 'POST', {
                  owner: desktop.owner === 'human' ? 'agent' : 'human',
                }),
              )
            }
          >
            <Hand size={15} />
            {desktop.owner === 'human' ? '安全な画面でAIに返す' : '画面を開いて手動操作'}
          </button>
        )}
      </Heading>
      {!desktop.configured ? (
        <div className="empty-panel desktop-setup">
          <Monitor size={30} />
          <h3>
            {desktop.setup === 'preparing'
              ? 'デスクトップを準備しています'
              : 'このホストの画面を使う'}
          </h3>
          <p>{desktop.message || '画面のない環境では専用デスクトップを自動で用意します。'}</p>
          <button
            className="primary"
            disabled={status.stopped || desktop.setup === 'preparing'}
            onClick={() => void action(() => api('/desktop/prepare', 'POST', {}))}
          >
            {desktop.setup === 'error' ? 'もう一度接続する' : '自動で接続する'}
          </button>
          <button className="text-button" onClick={() => onView('settings', 'desktop')}>
            VNCを手動で設定
          </button>
        </div>
      ) : (
        <div className="desktop-card">
          <div className="terminal-heading">
            <span>
              <Monitor size={15} />
              {desktop.name}
            </span>
            <span>
              {status.stopped
                ? '停止中'
                : desktop.owner === 'human'
                  ? `あなたが操作中 · ${connection}`
                  : 'AIが操作可能 · 画面を表示中'}
            </span>
          </div>
          <div className="desktop-tools">
            {desktop.automatic && (
              <>
                <button
                  disabled={status.stopped}
                  onClick={() =>
                    void action(() => api('/desktop/launch', 'POST', { app: 'browser' }))
                  }
                >
                  Chromeを開く
                </button>
                <button
                  disabled={status.stopped}
                  onClick={() =>
                    void action(() => api('/desktop/launch', 'POST', { app: 'terminal' }))
                  }
                >
                  端末を開く
                </button>
              </>
            )}
            <button disabled={status.stopped} onClick={() => setAttempt((n) => n + 1)}>
              再接続
            </button>
          </div>
          {status.stopped ? (
            <div className="empty-panel">全停止中です。</div>
          ) : desktop.owner === 'human' ? (
            <div className="desktop-surface" ref={container} />
          ) : (
            <div className="desktop-preview">
              {preview ? (
                <img src={preview} alt="インストール先のデスクトップの現在の画面" />
              ) : (
                <p>{connection === '未接続' ? '画面を読み込んでいます…' : connection}</p>
              )}
              <span>表示のみ · 操作するには「画面を開いて手動操作」</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
