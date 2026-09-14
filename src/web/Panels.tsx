import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
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
  Square,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import type { AtomView } from 'atom-memory';
import { api, time, stateLabel, type Snapshot, type Status } from './api';
import type { Action, View } from './App';
import { CodexLogin } from './CodexLogin';

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
      <div className="eyebrow">{eyebrow}</div>
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

export function TerminalPanel({ snapshot, action }: { snapshot: Snapshot; action: Action }) {
  const [selected, setSelected] = useState('');
  const run = snapshot.runs.find((r) => r.id === selected) || snapshot.runs[0];
  return (
    <section className="page terminal-page">
      <Heading
        eyebrow="SESSIONS"
        title="動いている作業を、そのまま。"
        description="エージェントと同じ端末を確認・操作できます。UIを閉じても実行は続きます。"
      >
        <button
          className="primary"
          onClick={() =>
            void action(async () => {
              const run = await api<{ id: string }>('/runs', 'POST', {
                conversationId: snapshot.conversation.id,
                kind: 'terminal',
              });
              setSelected(run.id);
            })
          }
        >
          <Plus size={15} /> ターミナルを開く
        </button>
      </Heading>
      <form
        className="form-card"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void action(async () => {
            const run = await api<{ id: string }>('/native', 'POST', {
              conversationId: snapshot.conversation.id,
              spec: {
                adapter: f.get('adapter'),
                prompt: f.get('prompt'),
                ...(f.get('resumeId') ? { resumeId: f.get('resumeId') } : {}),
              },
            });
            setSelected(run.id);
          });
        }}
      >
        <div className="form-grid">
          <label>
            子エージェント
            <select name="adapter">
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <label>
            再開するID（省略可）
            <input name="resumeId" />
          </label>
        </div>
        <label>
          依頼
          <textarea name="prompt" required />
        </label>
        <button className="primary">子エージェントを起動</button>
        <small className="muted">
          端末側のCLIとログインを使います。同じリポジトリで編集が行われます。
        </small>
      </form>
      {!snapshot.runs.length ? (
        <Empty
          icon={SquareTerminal}
          title="まだ実行はありません"
          text="新しいターミナルを開くか、チャットから作業を依頼してください。"
        />
      ) : (
        <div className="session-layout">
          <div className="session-list">
            {snapshot.runs.map((r) => (
              <button
                className={run?.id === r.id ? 'selected' : ''}
                key={r.id}
                onClick={() => setSelected(r.id)}
              >
                <SquareTerminal size={16} />
                <span>
                  <strong>{r.title}</strong>
                  <small>
                    {stateLabel[r.state]} · {r.kind}
                  </small>
                </span>
                <i className={`live-dot ${r.state === 'running' ? '' : 'off'}`} />
              </button>
            ))}
          </div>
          {run && (
            <div className="terminal-card">
              <div className="terminal-heading">
                <span>
                  <i className={`live-dot ${run.state === 'running' ? '' : 'off'}`} />
                  {stateLabel[run.state]}
                  <code>{run.cwd}</code>
                </span>
                <div>
                  {run.kind === 'terminal' && run.state === 'running' && (
                    <button
                      onClick={() =>
                        void action(() =>
                          api(`/runs/${run.id}/handoff`, 'POST', {
                            owner: run.owner === 'human' ? 'agent' : 'human',
                          }),
                        )
                      }
                    >
                      <Hand size={13} />
                      {run.owner === 'human' ? 'エージェントに返す' : '手動で操作する'}
                    </button>
                  )}
                  {run.state === 'running' && (
                    <button
                      className="danger"
                      onClick={() => void action(() => api(`/runs/${run.id}/stop`, 'POST', {}))}
                    >
                      <Square size={12} />
                      停止
                    </button>
                  )}
                </div>
              </div>
              {run.kind === 'terminal' ? (
                <TerminalView key={run.id} run={run} action={action} />
              ) : (
                <RunOutput key={run.id} run={run} action={action} onStart={setSelected} />
              )}
              <div className="terminal-footer">
                {run.host}
                {run.kind === 'terminal' &&
                  ` · ${run.owner === 'human' ? 'あなたが操作中' : 'エージェントが操作可能'}`}
                <span>
                  終了コード {run.exitCode ?? '—'} · ターン状態{' '}
                  {run.kind === 'native' && run.state !== 'interrupted'
                    ? String(run.result?.turnState || 'unknown')
                    : '不明'}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
function RunOutput({
  run,
  action,
  onStart,
}: {
  run: Snapshot['runs'][number];
  action: Action;
  onStart: (id: string) => void;
}) {
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const current = useRef(run);
  current.current = run;
  useEffect(() => {
    let disposed = false,
      offset = 0,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await api<{ text: string; nextOffset: number; truncated: boolean }>(
          `/runs/${run.id}?offset=${offset}`,
        );
        if (disposed) return;
        setOutput((old) =>
          ((data.truncated ? '[古い出力は省略されています]\n' : old) + data.text).slice(-64000),
        );
        setError('');
        offset = data.nextOffset;
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : '出力を取得できませんでした');
      }
      if (!disposed) timer = setTimeout(poll, current.current.state === 'running' ? 350 : 2500);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [run.id]);
  const adapter = run.result?.adapter;
  const resumeId = run.result?.threadId || run.result?.sessionId;
  const canResume =
    run.kind === 'native' &&
    typeof resumeId === 'string' &&
    (adapter === 'codex' || adapter === 'claude') &&
    !['running', 'stopping'].includes(run.state);
  return (
    <>
      {run.kind === 'native' && (
        <div className="run-details">
          <p>
            実行中は出力の確認と停止ができます。追加指示は終了後に同じセッションの次ターンとして送ります。
          </p>
          {typeof resumeId === 'string' && (
            <p>
              再開ID <code>{resumeId}</code>
            </p>
          )}
          {typeof run.result?.turnId === 'string' && (
            <p>
              ターンID <code>{run.result.turnId}</code>
            </p>
          )}
          {canResume && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const prompt = String(new FormData(event.currentTarget).get('prompt'));
                void action(async () => {
                  const next = await api<{ id: string }>('/native', 'POST', {
                    conversationId: run.conversationId,
                    spec: { adapter, resumeId, prompt, cwd: run.cwd },
                  });
                  onStart(next.id);
                });
              }}
            >
              <label>
                次の指示
                <textarea name="prompt" required maxLength={32000} />
              </label>
              <button className="primary">同じセッションで続ける</button>
            </form>
          )}
        </div>
      )}
      <pre className="run-output" aria-label="実行の出力">
        {output || '出力を待っています'}
        {error && `\n${error}`}
      </pre>
    </>
  );
}
function TerminalView({ run, action }: { run: Snapshot['runs'][number]; action: Action }) {
  const container = useRef<HTMLDivElement>(null),
    current = useRef(run);
  current.current = run;
  useEffect(() => {
    const terminal = new Terminal({
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 3000,
      theme: {
        background: '#202522',
        foreground: '#e6e9e1',
        cursor: '#a6c79e',
        selectionBackground: '#4e6652',
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current!);
    fit.fit();
    let disposed = false,
      offset = 0,
      timer: ReturnType<typeof setTimeout>;
    const resize = () => {
      if (disposed) return;
      fit.fit();
      if (
        current.current.kind === 'terminal' &&
        current.current.owner === 'human' &&
        current.current.state === 'running' &&
        terminal.cols >= 20 &&
        terminal.rows >= 5
      )
        void api(`/runs/${run.id}/resize`, 'POST', {
          cols: Math.min(300, terminal.cols),
          rows: Math.min(150, terminal.rows),
        }).catch(() => {});
    };
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    });
    observer.observe(container.current!);
    const input = terminal.onData((text) => {
      const r = current.current;
      if (r.owner === 'human' && r.state === 'running')
        void action(() => api(`/runs/${r.id}/write`, 'POST', { text, epoch: r.epoch }));
    });
    const poll = async () => {
      try {
        const data = await api<{ text: string; nextOffset: number; truncated: boolean }>(
          `/runs/${run.id}?offset=${offset}`,
        );
        if (disposed) return;
        if (data.truncated) {
          terminal.reset();
          terminal.writeln('[古い出力は保持上限を超えたため省略されています]');
        }
        if (data.text) terminal.write(data.text);
        offset = data.nextOffset;
      } catch (e) {
        if (!disposed) terminal.writeln(`\r\n${e instanceof Error ? e.message : 'Disconnected'}`);
      }
      if (!disposed) timer = setTimeout(poll, current.current.state === 'running' ? 350 : 2500);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      input.dispose();
      terminal.dispose();
    };
  }, [run.id, run.owner, action]);
  return <div className="terminal-surface" ref={container} />;
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
        title="あとで、を実行につなげる。"
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
            <input type="checkbox" name="repeatEvent" defaultChecked={existing?.trigger?.repeat} />
            条件が成立するたびに実行
          </label>
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
  snapshot,
  action,
  onView,
}: {
  status: Status;
  snapshot: Snapshot;
  action: Action;
  onView: (v: View) => void;
}) {
  const [mcpForm, setMcpForm] = useState(false),
    [desktopForm, setDesktopForm] = useState(false),
    [providerKind, setProviderKind] = useState(status.config.provider?.kind || 'openai'),
    [codexModels, setCodexModels] = useState<{ id: string; name: string; isDefault: boolean }[]>(
      [],
    ),
    [codexModel, setCodexModel] = useState(
      status.config.provider?.kind === 'codex' ? status.config.provider.model : '',
    ),
    [modelsError, setModelsError] = useState('');
  useEffect(() => {
    if (providerKind !== 'codex') return;
    let disposed = false;
    void api<{ id: string; name: string; isDefault: boolean }[]>('/codex/models')
      .then((models) => {
        if (disposed) return;
        setCodexModels(models);
        setCodexModel(
          (current) => current || models.find((m) => m.isDefault)?.id || models[0]?.id || '',
        );
        setModelsError('');
      })
      .catch(() => {
        if (!disposed)
          setModelsError(
            'モデル一覧を取得できませんでした。Codex CLIとログインを確認してください。',
          );
      });
    return () => {
      disposed = true;
    };
  }, [providerKind]);
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
        title="あなたの環境につなぐ。"
        description="モデル・接続先・資格情報は、この端末に保存します。リポジトリには含めません。"
      />
      <form
        className="form-card"
        key={`provider-${providerKind}-${status.config.provider?.revision || 0}`}
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void action(() =>
            api('/config/provider', 'PUT', {
              revision: status.config.revision,
              provider: {
                kind: providerKind,
                baseUrl:
                  providerKind === 'codex'
                    ? 'https://chatgpt.com/backend-api/codex'
                    : String(f.get('baseUrl')),
                model: providerKind === 'codex' ? codexModel : String(f.get('model')),
                supportsImages: providerKind === 'codex' || f.get('supportsImages') === 'on',
                keyRequired: providerKind !== 'codex' && f.get('keyRequired') === 'on',
              },
            }),
          );
        }}
      >
        <div className="section-heading">
          <span className="list-icon">
            <Brain size={19} />
          </span>
          <div>
            <h2>親エージェントのモデル</h2>
            <p>
              {providerKind === 'codex'
                ? 'Codexのサブスクで、このエージェントを動かす'
                : 'OpenAI互換のChat Completions API'}
            </p>
          </div>
          <span className={`status-chip ${status.providerReady ? 'ready' : ''}`}>
            {(status.config.provider?.kind || 'openai') !== providerKind
              ? '未保存'
              : status.providerReady
                ? '設定済み'
                : '未設定'}
          </span>
        </div>
        <label>
          親AIの接続方法
          <select
            name="providerKind"
            value={providerKind}
            onChange={(e) => setProviderKind(e.target.value as 'openai' | 'codex')}
          >
            <option value="codex">Codexサブスク（ChatGPTログイン）</option>
            <option value="openai">OpenAI互換API（APIキー）</option>
          </select>
        </label>
        {providerKind === 'codex' ? (
          <>
            <label>
              Codexのモデル
              <input
                name="model"
                list="codex-models"
                value={codexModel}
                onChange={(e) => setCodexModel(e.target.value)}
                required
                placeholder="ログイン後に利用可能なモデルを取得"
              />
              <datalist id="codex-models">
                {codexModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </datalist>
            </label>
            {modelsError && <small className="muted">{modelsError}</small>}
            <p>Codexの契約枠でチャット・MCP・記憶・予定を実行します。</p>
            <h3>Codexログイン</h3>
            <CodexLogin conversationId={snapshot.conversation.id} action={action} />
          </>
        ) : (
          <>
            <label>
              APIのベースURL
              <input
                name="baseUrl"
                type="url"
                defaultValue={
                  status.config.provider?.kind !== 'codex'
                    ? status.config.provider?.baseUrl || 'https://api.openai.com/v1'
                    : 'https://api.openai.com/v1'
                }
                required
              />
            </label>
            <label>
              モデルID
              <input
                name="model"
                defaultValue={
                  status.config.provider?.kind !== 'codex'
                    ? status.config.provider?.model || ''
                    : ''
                }
                placeholder="プロバイダーのモデルID"
                required
              />
            </label>
            <div className="form-grid">
              <label className="checkbox">
                <input
                  type="checkbox"
                  name="supportsImages"
                  defaultChecked={status.config.provider?.supportsImages ?? true}
                />
                画像入力に対応
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  name="keyRequired"
                  defaultChecked={
                    status.config.provider?.kind === 'codex'
                      ? true
                      : (status.config.provider?.keyRequired ?? true)
                  }
                />
                APIキーが必要
              </label>
            </div>
          </>
        )}
        <div className="form-actions">
          <button className="primary">
            {providerKind === 'codex' ? 'Codexを親AIに設定' : '接続先を保存'}
          </button>
          {providerKind !== 'codex' &&
            status.config.provider?.kind !== 'codex' &&
            status.config.provider && (
              <button type="button" onClick={() => void key('provider:main')}>
                APIキーを入力
              </button>
            )}
        </div>
        <small className="muted">
          {providerKind === 'codex'
            ? 'ログイン後、設定を保存するとCodexで元のチャットを続けられます。'
            : '接続先を変更した場合は、APIキーを専用入力で保存し直してください。'}
        </small>
      </form>
      <section className="form-card">
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
                operationId: crypto.randomUUID(),
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
                <button onClick={() => void key(`mcp:${m.name}`)}>認証</button>
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
            <small className="muted">
              接続先が同じブラウザ・画面を扱う場合に選択してください。手動操作中のAIアクセスを連動させます。
            </small>
            <div className="form-actions">
              <button className="primary">接続を登録</button>
              <button type="button" onClick={() => setMcpForm(false)}>
                閉じる
              </button>
            </div>
          </form>
        )}
      </section>
      <section className="form-card">
        <div className="section-heading">
          <span className="list-icon">
            <Monitor size={18} />
          </span>
          <div>
            <h2>共有デスクトップ</h2>
            <p>既存の画面をX11またはVNCで共有</p>
          </div>
          <button onClick={() => setDesktopForm(!desktopForm)}>設定</button>
        </div>
        <p>
          {status.desktop.configured
            ? `${status.desktop.name} / DISPLAY ${status.desktop.display}`
            : 'デスクトップは未接続です。'}
        </p>
        <small className="muted">
          バックエンド側に xdotool と ImageMagick
          が必要です。VNCは同じDISPLAYを共有するサーバーをloopbackに設定してください。
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
      <section className="form-card control-card">
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
    [add, setAdd] = useState(false);
  const search = () =>
    action(async () =>
      setItems((await api<{ items: AtomView[] }>(`/memory?q=${encodeURIComponent(query)}`)).items),
    );
  useEffect(() => {
    void search();
  }, []);
  return (
    <section className="page">
      <Heading
        eyebrow="ATOM MEMORY"
        title="文脈を、次の一歩に。"
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
        <button>検索</button>
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
              setItems(
                (await api<{ items: AtomView[] }>(`/memory?q=${encodeURIComponent(text)}`)).items,
              );
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
      {items.length ? (
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

export function FilesPanel({ action }: { action: Action }) {
  const [path, setPath] = useState('.'),
    [entries, setEntries] = useState<{ name: string; kind: string }[]>([]),
    [file, setFile] = useState<{
      path: string;
      text: string;
      totalLines: number;
      nextLine: number | null;
      sha256: string;
    }>();
  useEffect(() => {
    void action(async () => {
      const listing = await api<{ entries: typeof entries }>(
        `/files?path=${encodeURIComponent(path)}`,
      );
      setEntries(listing.entries);
      setFile(undefined);
    });
  }, [path]);
  return (
    <section className="page">
      <Heading
        eyebrow="FILES"
        title="作業の拠点をひらく。"
        description="親エージェントと、新しく開くターミナルはこのHomeから作業します。"
      />
      <div className="file-browser">
        <div className="file-path">
          <button
            className="icon-button"
            aria-label="親フォルダへ"
            onClick={() =>
              setPath(path === '.' ? '.' : path.split('/').slice(0, -1).join('/') || '.')
            }
          >
            <ArrowLeft size={16} />
          </button>
          <code>{path}</code>
        </div>
        <div className="file-columns">
          <div className="file-list">
            {entries.map((e) => (
              <button
                key={e.name}
                onClick={() =>
                  e.kind === 'directory'
                    ? setPath(`${path}/${e.name}`)
                    : void action(async () =>
                        setFile(
                          await api(`/files/read?path=${encodeURIComponent(`${path}/${e.name}`)}`),
                        ),
                      )
                }
              >
                {e.kind === 'directory' ? <Folder size={16} /> : <FileText size={16} />}
                <span>{e.name}</span>
              </button>
            ))}
          </div>
          <div className="file-content">
            {file ? (
              <>
                <div className="file-info">
                  <code>{file.path.split('/').pop()}</code>
                  <span>{file.totalLines} lines</span>
                </div>
                <pre>{file.text}</pre>
                {file.nextLine && (
                  <button
                    onClick={() =>
                      void action(async () => {
                        const next = await api<typeof file>(
                          `/files/read?path=${encodeURIComponent(file.path)}&startLine=${file.nextLine}`,
                        );
                        if (next?.sha256 !== file.sha256)
                          throw new Error(
                            '読み込み中にファイルが変更されました。開き直してください。',
                          );
                        setFile({ ...next, text: file.text + '\n' + next.text });
                      })
                    }
                  >
                    続きを読む
                  </button>
                )}
              </>
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
  onView: (v: View) => void;
}) {
  const container = useRef<HTMLDivElement>(null),
    [connection, setConnection] = useState('未接続');
  useEffect(() => {
    if (!status.desktop.configured || status.desktop.owner !== 'human') return;
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
      client.addEventListener('connect', () => setConnection('接続済み'));
      client.addEventListener('disconnect', () => setConnection('接続が切れました'));
      client.addEventListener('securityfailure', () =>
        setConnection('VNC認証に失敗しました。設定を確認してください。'),
      );
    });
    return () => {
      disposed = true;
      rfb?.disconnect();
    };
  }, [status.desktop.configured, status.desktop.owner, status.desktop.epoch, action]);
  return (
    <section className="page desktop-page">
      <Heading
        eyebrow="SHARED DESKTOP"
        title="同じ画面を、一緒に。"
        description="手動操作中は、この画面への管理下のAI観測・入力を止めます。親のほかの作業は続きます。"
      >
        {status.desktop.configured && (
          <button
            className="primary"
            onClick={() =>
              void action(() =>
                api('/desktop/handoff', 'POST', {
                  owner: status.desktop.owner === 'human' ? 'agent' : 'human',
                }),
              )
            }
          >
            <Hand size={15} />
            {status.desktop.owner === 'human' ? '安全な画面でAIに返す' : '画面を開いて手動操作'}
          </button>
        )}
      </Heading>
      {!status.desktop.configured ? (
        <div className="empty-panel">
          <Monitor size={30} />
          <h3>デスクトップを接続する</h3>
          <p>既存デスクトップのX11またはVNC接続を設定します。</p>
          <button onClick={() => onView('settings')}>
            接続設定へ <ArrowUpRight size={14} />
          </button>
        </div>
      ) : (
        <div className="desktop-card">
          <div className="terminal-heading">
            <span>
              <Monitor size={15} />
              {status.desktop.name} · {status.desktop.display}
            </span>
            <span>
              {status.desktop.owner === 'human'
                ? `あなたが操作中 · ${connection}`
                : 'エージェントが操作可能'}
            </span>
          </div>
          {status.desktop.owner === 'human' ? (
            <div className="desktop-surface" ref={container} />
          ) : (
            <div className="empty-panel">
              <Monitor size={30} />
              <h3>画面はバックエンドに接続されています</h3>
              <p>手動操作に切り替えると、同じ画面をここに表示します。</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
