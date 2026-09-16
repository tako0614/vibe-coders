import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Columns2,
  Hand,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { api, operationId, stateLabel, type Snapshot } from './api';
import type { Action } from './App';
import type { ShellWorkspace } from '../shared/shell';
import { TerminalView } from './TerminalView';

type Run = Snapshot['runs'][number];
const active = (run: Run) => ['running', 'stopping'].includes(run.state);
const interactive = (run: Run) => run.kind === 'terminal' || run.kind === 'shell';

export function TerminalPanel(props: { snapshot: Snapshot; action: Action; compact?: boolean }) {
  return <Workspace key={props.snapshot.conversation.id} {...props} />;
}
function Workspace({
  snapshot,
  action,
  compact = false,
}: {
  snapshot: Snapshot;
  action: Action;
  compact?: boolean;
}) {
  const key = `vibe-shell-view:v1:${snapshot.conversation.id}`;
  const [view, setView] = useState<{ deck: string; selected: string; maximized: boolean }>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '{}');
      return {
        deck: typeof value?.deck === 'string' ? value.deck : 'main',
        selected: typeof value?.selected === 'string' ? value.selected : '',
        maximized: value?.maximized === true,
      };
    } catch {
      return { deck: 'main', selected: '', maximized: false };
    }
  });
  const [creating, setCreating] = useState(false),
    [editingDeck, setEditingDeck] = useState(false),
    [history, setHistory] = useState(false),
    [busy, setBusy] = useState(false),
    [renaming, setRenaming] = useState('');
  const busyRef = useRef(false);
  const workspace = snapshot.workspace;
  const deck = workspace.decks.find((d) => d.id === view.deck) || workspace.decks[0];
  const deckOf = (run: Run) => workspace.placements[run.id] || workspace.decks[0].id;
  const available = snapshot.runs.filter((r) => interactive(r) && !workspace.hidden.includes(r.id));
  const deckRuns = available
    .filter((r) => compact || deckOf(r) === deck.id)
    .sort((a, b) => a.createdAt - b.createdAt);
  const selected =
    deckRuns.find((r) => r.id === view.selected) ||
    (compact
      ? [...deckRuns].reverse().find((r) => r.owner === 'agent' && active(r)) || deckRuns.at(-1)
      : deckRuns[0]);
  const archived = snapshot.runs.filter((r) => workspace.hidden.includes(r.id) || !interactive(r));
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(view));
    } catch {}
  }, [key, view]);
  const perform = (task: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void action(task).finally(() => {
      busyRef.current = false;
      setBusy(false);
    });
  };
  const save = (next: ShellWorkspace) =>
    api(`/conversations/${snapshot.conversation.id}/workspace`, 'PUT', next);
  const select = (id: string) => setView((v) => ({ ...v, selected: id }));
  const create = (spec: Record<string, unknown>) =>
    perform(async () => {
      const run = await api<Run>('/runs', 'POST', {
        conversationId: snapshot.conversation.id,
        spec: { ...spec, deckId: deck.id },
      });
      setView((v) => ({ ...v, deck: deck.id, selected: run.id }));
      setCreating(false);
    });
  const shift = (delta: number) => {
    const decks = [...workspace.decks],
      index = decks.findIndex((d) => d.id === deck.id),
      next = index + delta;
    if (next < 0 || next >= decks.length) return;
    [decks[index], decks[next]] = [decks[next], decks[index]];
    // Unassigned runs belong to the original first deck, including after reordering.
    const placements = { ...workspace.placements };
    snapshot.runs.forEach((r) => {
      placements[r.id] ||= workspace.decks[0].id;
    });
    perform(() => save({ ...workspace, decks, placements }));
  };
  return (
    <section className={`page terminal-page shell-workspace ${compact ? 'shell-compact' : ''}`}>
      <header className="shell-heading">
        <div>
          <h1>ターミナル</h1>
        </div>
        <div className="shell-heading-actions">
          <button disabled={busy || snapshot.stopped} onClick={() => create({ mode: 'pty' })}>
            <Plus size={15} /> ターミナルを開く
          </button>
          <button aria-expanded={creating} onClick={() => setCreating(!creating)} disabled={busy}>
            <ChevronDown size={15} /> コマンドから開く
          </button>
        </div>
      </header>
      <div className="deck-bar">
        <div className="deck-tabs" role="tablist" aria-label="デッキ">
          {workspace.decks.map((d) => (
            <button
              key={d.id}
              role="tab"
              aria-selected={d.id === deck.id}
              onClick={() => {
                setView((v) => ({ ...v, deck: d.id, selected: '' }));
                setEditingDeck(false);
              }}
            >
              {d.name}
              <small>{available.filter((r) => deckOf(r) === d.id).length}</small>
              {available.some((r) => deckOf(r) === d.id && active(r)) && <i className="live-dot" />}
            </button>
          ))}
        </div>
        <button
          aria-label="デッキを追加"
          title="デッキを追加"
          disabled={busy || workspace.decks.length >= 30}
          onClick={() =>
            perform(async () => {
              const id = operationId();
              await save({
                ...workspace,
                decks: [...workspace.decks, { id, name: `デッキ ${workspace.decks.length + 1}` }],
              });
              setView((v) => ({ ...v, deck: id, selected: '' }));
              setEditingDeck(true);
            })
          }
        >
          <Plus size={16} />
        </button>
        <button
          aria-label="デッキを編集"
          title="デッキを編集"
          onClick={() => setEditingDeck(!editingDeck)}
        >
          <Pencil size={14} />
        </button>
      </div>
      {editingDeck && (
        <form
          key={deck.id}
          className="deck-editor"
          onSubmit={(e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get('name')).trim();
            perform(async () => {
              await save({
                ...workspace,
                decks: workspace.decks.map((d) => (d.id === deck.id ? { ...d, name } : d)),
              });
              setEditingDeck(false);
            });
          }}
        >
          <label>
            デッキ名
            <input name="name" defaultValue={deck.name} required maxLength={80} />
          </label>
          <button disabled={busy} type="submit">
            保存
          </button>
          <button
            type="button"
            disabled={busy || deck.id === workspace.decks[0].id}
            aria-label="デッキを左へ"
            onClick={() => shift(-1)}
          >
            <ArrowLeft size={15} />
          </button>
          <button
            type="button"
            disabled={busy || deck.id === workspace.decks.at(-1)!.id}
            aria-label="デッキを右へ"
            onClick={() => shift(1)}
          >
            <ArrowRight size={15} />
          </button>
          <button
            type="button"
            disabled={busy || workspace.decks.length === 1}
            onClick={() =>
              perform(async () => {
                const decks = workspace.decks.filter((d) => d.id !== deck.id),
                  placements = { ...workspace.placements };
                snapshot.runs.forEach((r) => {
                  placements[r.id] = deckOf(r) === deck.id ? decks[0].id : deckOf(r);
                });
                await save({ ...workspace, decks, placements });
                setView((v) => ({ ...v, deck: decks[0].id, selected: '' }));
                setEditingDeck(false);
              })
            }
          >
            <Trash2 size={14} /> デッキを削除・端末は移動
          </button>
        </form>
      )}
      {creating && (
        <form
          className="shell-launch"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            create({
              command: String(data.get('command')),
              mode: data.get('mode'),
              ...(data.get('cwd') ? { cwd: data.get('cwd') } : {}),
              ...(data.get('title') ? { title: data.get('title') } : {}),
            });
          }}
        >
          <label className="shell-command">
            コマンド
            <input
              name="command"
              placeholder="codex / claude / npm run dev"
              required
              autoFocus
              maxLength={32000}
            />
          </label>
          <label>
            名前
            <input name="title" placeholder="省略可" maxLength={120} />
          </label>
          <label>
            作業フォルダ
            <input name="cwd" placeholder="現在の作業フォルダ" />
          </label>
          <label>
            入出力
            <select name="mode" defaultValue="pty">
              <option value="pty">ターミナル</option>
              <option value="pipe">標準入出力</option>
            </select>
          </label>
          <button className="primary" disabled={busy || snapshot.stopped}>
            起動
          </button>
        </form>
      )}
      <div className="shell-switcher">
        <label>
          端末
          <select
            aria-label="表示する端末"
            value={selected?.id || ''}
            onChange={(e) => select(e.target.value)}
            disabled={!deckRuns.length}
          >
            {!deckRuns.length && <option value="">端末なし</option>}
            {deckRuns.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title} · {stateLabel[r.state]}
              </option>
            ))}
          </select>
        </label>
        {compact && (
          <button
            aria-label="シェルを開く"
            title="シェルを開く"
            disabled={busy || snapshot.stopped}
            onClick={() => create({ mode: 'pty' })}
          >
            <Plus size={15} />
          </button>
        )}
        <span className="shell-count">
          {deckRuns.filter(active).length} 実行中 / {deckRuns.length} 端末
        </span>
        <button
          className="shell-layout-toggle"
          aria-label={view.maximized ? '端末を並べて表示' : '選択した端末を最大化'}
          disabled={!deckRuns.length}
          onClick={() => setView((v) => ({ ...v, maximized: !v.maximized }))}
        >
          {view.maximized ? <Columns2 size={15} /> : <Maximize2 size={15} />}
          {view.maximized ? '並べる' : '最大化'}
        </button>
      </div>
      {!deckRuns.length && (
        <div className="shell-empty">
          <h2>{deck.name}</h2>
          <p>ターミナルを開いて作業を始める</p>
          <small>端末は画面を切り替えても動き続けます。</small>
        </div>
      )}
      <div
        className={`shell-grid ${view.maximized || compact ? 'shell-single' : ''} ${deckRuns.length === 1 ? 'shell-one' : ''}`}
      >
        {available
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((run) => {
            const inDeck = compact || deckOf(run) === deck.id,
              focused = selected?.id === run.id;
            return (
              <article
                key={run.id}
                data-run-id={run.id}
                className={`shell-tile ${inDeck ? '' : 'shell-other-deck'} ${focused ? 'shell-focused' : ''}`}
                onFocusCapture={() => {
                  if (inDeck && !focused) select(run.id);
                }}
                onPointerDown={() => {
                  if (inDeck && !focused) select(run.id);
                }}
              >
                <div className="shell-tile-heading">
                  <span className="shell-tile-name">
                    <i className={`live-dot ${active(run) ? '' : 'off'}`} />
                    <strong title={run.title}>{run.title}</strong>
                  </span>
                  <button
                    title="端末名を変更"
                    aria-label="端末名を変更"
                    onClick={() => setRenaming(renaming === run.id ? '' : run.id)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    title={view.maximized ? '並べる' : '最大化'}
                    aria-label="この端末の最大化を切り替え"
                    onClick={() =>
                      setView((v) => ({ ...v, selected: run.id, maximized: !v.maximized }))
                    }
                  >
                    {view.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  </button>
                  <button
                    title="表示を閉じる（実行は継続）"
                    aria-label="端末の表示を閉じる"
                    disabled={busy}
                    onClick={() =>
                      perform(() => save({ ...workspace, hidden: [...workspace.hidden, run.id] }))
                    }
                  >
                    <X size={15} />
                  </button>
                </div>
                {renaming === run.id && (
                  <form
                    className="shell-rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const title = String(new FormData(e.currentTarget).get('title'));
                      perform(async () => {
                        await api(`/runs/${run.id}`, 'PATCH', { title });
                        setRenaming('');
                      });
                    }}
                  >
                    <input
                      aria-label="端末名"
                      name="title"
                      defaultValue={run.title}
                      maxLength={120}
                      required
                    />
                    <button disabled={busy}>保存</button>
                  </form>
                )}
                <div className="shell-tile-meta">
                  <code title={run.cwd}>{run.cwd}</code>
                  <span>{stateLabel[run.state]}</span>
                </div>
                {run.kind === 'terminal' ? (
                  <TerminalView run={run} stopped={snapshot.stopped} focused={inDeck && focused} />
                ) : (
                  <RunOutput run={run} action={action} stopped={snapshot.stopped} />
                )}
                <footer className="shell-tile-footer">
                  <select
                    aria-label="端末の移動先デッキ"
                    value={deckOf(run)}
                    disabled={busy}
                    onChange={(e) => {
                      const id = e.target.value;
                      perform(() =>
                        save({
                          ...workspace,
                          placements: { ...workspace.placements, [run.id]: id },
                        }),
                      );
                    }}
                  >
                    {workspace.decks.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <span>
                    {run.exitCode !== null
                      ? `終了コード ${run.exitCode}`
                      : run.state === 'interrupted'
                        ? '再起動で中断'
                        : run.owner === 'human'
                          ? 'あなたが操作中'
                          : 'AIが操作中'}
                  </span>
                  {run.state === 'running' && (
                    <>
                      <button
                        disabled={busy || snapshot.stopped}
                        onClick={() =>
                          perform(() =>
                            api(`/runs/${run.id}/handoff`, 'POST', {
                              owner: run.owner === 'human' ? 'agent' : 'human',
                            }),
                          )
                        }
                      >
                        <Hand size={13} />
                        {run.owner === 'human' ? 'AIに返す' : '手動操作'}
                      </button>
                      <button
                        disabled={busy}
                        title="プロセスを停止"
                        aria-label="プロセスを停止"
                        onClick={() => perform(() => api(`/runs/${run.id}/stop`, 'POST', {}))}
                      >
                        <Square size={13} />
                      </button>
                    </>
                  )}
                </footer>
              </article>
            );
          })}
      </div>
      {archived.length > 0 && (
        <details
          className="shell-archive"
          open={history}
          onToggle={(e) => setHistory(e.currentTarget.open)}
        >
          <summary>閉じた端末・その他の実行（{archived.length}）</summary>
          {history &&
            archived.map((run) => (
              <div key={run.id} className="shell-archive-row">
                <span>
                  {run.title}
                  <small>
                    {stateLabel[run.state]} · {run.kind}
                  </small>
                </span>
                {interactive(run) ? (
                  <button
                    disabled={busy}
                    onClick={() =>
                      perform(async () => {
                        await save({
                          ...workspace,
                          hidden: workspace.hidden.filter((id) => id !== run.id),
                          placements: { ...workspace.placements, [run.id]: deck.id },
                        });
                        select(run.id);
                      })
                    }
                  >
                    表示を戻す
                  </button>
                ) : (
                  <details>
                    <summary>出力</summary>
                    <RunOutput run={run} action={action} stopped={snapshot.stopped} />
                  </details>
                )}
              </div>
            ))}
        </details>
      )}
    </section>
  );
}

function RunOutput({ run, action, stopped }: { run: Run; action: Action; stopped: boolean }) {
  const [output, setOutput] = useState(''),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    [sending, setSending] = useState(false),
    [inputOpen, setInputOpen] = useState(true),
    [newline, setNewline] = useState(true);
  const current = useRef(run),
    scroller = useRef<HTMLPreElement>(null),
    follow = useRef(true),
    inputRef = useRef(text),
    busy = useRef(false);
  current.current = run;
  inputRef.current = text;
  useEffect(() => {
    let disposed = false,
      offset = 0,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await api<{
          text: string;
          nextOffset: number;
          truncated: boolean;
          hasMore: boolean;
          capabilities: { immediateInput: boolean };
        }>(`/runs/${run.id}?offset=${offset}`);
        if (disposed) return;
        setError('');
        setOutput((old) =>
          ((data.truncated ? '[古い出力は省略されています]\n' : old) + data.text).slice(-256000),
        );
        setInputOpen(data.capabilities.immediateInput);
        offset = data.nextOffset;
        timer = setTimeout(poll, data.hasMore ? 0 : active(current.current) ? 400 : 2500);
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : '出力を取得できません');
          timer = setTimeout(poll, 2000);
        }
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [run.id]);
  useEffect(() => {
    if (follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [output]);
  const writable =
    run.kind === 'shell' &&
    run.owner === 'human' &&
    run.state === 'running' &&
    !stopped &&
    inputOpen;
  const send = (eof = false) => {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    const sent = text;
    void action(async () => {
      await api(`/runs/${run.id}/${eof ? 'end-input' : 'write'}`, 'POST', {
        epoch: run.epoch,
        ...(!eof ? { text: sent + (newline ? '\n' : '') } : {}),
      });
      if (eof) setInputOpen(false);
      else if (inputRef.current === sent) setText('');
    }).finally(() => {
      busy.current = false;
      setSending(false);
    });
  };
  return (
    <div className="pipe-view">
      <pre
        ref={scroller}
        className="run-output"
        aria-label="実行の出力"
        onScroll={() => {
          const el = scroller.current!;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {output || '出力を待っています'}
        {error && `\n${error}`}
      </pre>
      {run.kind === 'shell' && active(run) && (
        <form
          className="pipe-input"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            aria-label="標準入力"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            maxLength={32000}
            disabled={!writable || sending}
            placeholder={run.owner === 'human' ? 'プロセスに送るテキスト' : 'AIが操作中'}
          />
          <div>
            <label>
              <input
                type="checkbox"
                checked={newline}
                onChange={(e) => setNewline(e.target.checked)}
              />
              末尾に改行
            </label>
            <button disabled={!writable || sending || !text}>送信</button>
            <button type="button" disabled={!writable || sending} onClick={() => send(true)}>
              入力を終了（EOF）
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
