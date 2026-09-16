import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { Monitor, SquareTerminal, Plus, Settings2 } from 'lucide-react';
import { Chat, type ComposerDraft } from './Chat';
import type { Action, View } from './App';
import { api, type Snapshot, type Status } from './api';
import { executionDesktop, executionSurface, type WorkSurface } from './activity-state';
const TerminalPanel = lazy(() =>
  import('./TerminalWorkspace').then((m) => ({ default: m.TerminalPanel })),
);
const DesktopPanel = lazy(() => import('./Panels').then((m) => ({ default: m.DesktopPanel })));

export function AgentWorkspace({
  snapshot,
  status,
  action,
  onView,
  drafts,
}: {
  snapshot: Snapshot;
  status: Status;
  action: Action;
  onView: (view: View, section?: string) => void;
  drafts: Map<string, ComposerDraft>;
}) {
  const storageKey = `vibe-desktop:${snapshot.conversation.id}`;
  const [selection, setSelection] = useState(() => {
    try {
      return localStorage.getItem(storageKey) || '';
    } catch {
      return '';
    }
  });
  const [surface, setSurface] = useState<WorkSurface>('desktop');
  const [creating, setCreating] = useState(false);
  const panelId = useId();
  const turn = [...snapshot.messages].reverse().find((m) => m.body.role === 'user')?.id || '';
  const manualTurn = useRef<string | null>(null);
  const workingSurface = executionSurface(snapshot, status.config.mcp);
  const workingDesktop = executionDesktop(snapshot, status.config.mcp);
  const running =
    !snapshot.stopped &&
    !snapshot.conversation.paused &&
    ['running', 'waiting'].includes(snapshot.conversation.state);
  const desktop = status.desktops.find((d) => d.id === selection) || status.desktops[0];
  const host = selection === 'host';
  const choose = (id: string) => {
    manualTurn.current = turn;
    setSelection(id);
    if (id === 'host') setSurface('terminal');
  };
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, selection);
    } catch {}
  }, [storageKey, selection]);
  useEffect(() => {
    if (!running || !workingSurface || manualTurn.current === turn || desktop.owner === 'human')
      return;
    setSurface(workingSurface);
    setSelection(workingDesktop || (workingSurface === 'terminal' ? 'host' : desktop.id));
  }, [running, workingSurface, workingDesktop, turn, desktop.id, desktop.owner]);
  const open = (next: WorkSurface) => {
    const target = executionDesktop(snapshot, status.config.mcp);
    choose(target || (next === 'terminal' ? 'host' : desktop.id));
    setSurface(next);
  };
  return (
    <div className="agent-workspace workbench-open">
      <Chat
        snapshot={snapshot}
        status={status}
        action={action}
        onView={onView}
        drafts={drafts}
        onWorkspace={open}
        surface={surface}
      />
      <aside className="agent-workbench" aria-label="エージェントの作業画面">
        <header className="desktop-tabs">
          <div
            role="tablist"
            aria-label="デスクトップ"
            onKeyDown={(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
              e.preventDefault();
              const ids = [...status.desktops.map((d) => d.id), 'host'];
              const current = ids.indexOf(host ? 'host' : desktop.id);
              const index =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? ids.length - 1
                    : (current + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
              choose(ids[index]);
              (e.currentTarget.querySelectorAll('button')[index] as HTMLButtonElement)?.focus();
            }}
          >
            {status.desktops.map((d) => (
              <button
                key={d.id}
                role="tab"
                aria-selected={!host && d.id === desktop.id}
                tabIndex={!host && d.id === desktop.id ? 0 : -1}
                aria-controls={panelId}
                onClick={() => choose(d.id)}
                title={d.owner === 'human' ? 'あなたが操作中' : 'AIが操作可能'}
              >
                <Monitor size={14} />
                <span>{d.name}</span>
                <i className={`desktop-owner ${d.owner}`} />
              </button>
            ))}
            <button
              role="tab"
              aria-selected={host}
              tabIndex={host ? 0 : -1}
              aria-controls={panelId}
              onClick={() => choose('host')}
            >
              <SquareTerminal size={14} />
              ホスト
            </button>
          </div>
          <button
            className="icon-button"
            aria-label="デスクトップを追加"
            disabled={creating || status.stopped || status.desktops.length >= 16}
            onClick={() => {
              setCreating(true);
              void action(async () => {
                const d = await api<{ id: string }>('/desktops', 'POST', {
                  name: `デスクトップ${status.desktops.length + 1}`,
                });
                choose(d.id);
                setSurface('desktop');
              }).finally(() => setCreating(false));
            }}
          >
            <Plus size={17} />
          </button>
        </header>
        <div className="workbench-heading">
          <div role="tablist" aria-label="作業画面">
            {(['desktop', 'terminal'] as const)
              .filter((s) => !host || s === 'terminal')
              .map((s) => (
                <button
                  key={s}
                  role="tab"
                  aria-selected={surface === s}
                  aria-controls={panelId}
                  onClick={() => {
                    manualTurn.current = turn;
                    setSurface(s);
                  }}
                >
                  {s === 'desktop' ? <Monitor size={14} /> : <SquareTerminal size={14} />}{' '}
                  {s === 'desktop' ? '画面' : 'シェル'}
                </button>
              ))}
          </div>
          <button
            className="icon-button"
            aria-label="デスクトップの設定"
            onClick={() => onView('settings', 'desktop')}
          >
            <Settings2 size={16} />
          </button>
        </div>
        <div
          role="tabpanel"
          id={panelId}
          className="workbench-content"
          aria-label={`${host ? 'ホスト' : desktop.name}の${surface === 'terminal' ? 'シェル' : '画面'}`}
        >
          <Suspense fallback={<div className="loading">作業画面を読み込み中…</div>}>
            {surface === 'terminal' ? (
              <TerminalPanel
                key={host ? 'host' : desktop.id}
                snapshot={snapshot}
                action={action}
                desktopId={host ? null : desktop.id}
                compact
              />
            ) : (
              <DesktopPanel
                key={desktop.id}
                desktopId={desktop.id}
                status={status}
                action={action}
                onView={onView}
                compact
              />
            )}
          </Suspense>
        </div>
        <footer className="workbench-note">
          {host
            ? 'インストール先のシェル'
            : `${desktop.name} · ${desktop.owner === 'human' ? 'あなたが操作中' : 'AIが操作可能'}`}
        </footer>
      </aside>
    </div>
  );
}
