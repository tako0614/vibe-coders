import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Monitor, SquareTerminal, X } from 'lucide-react';
import { Chat, type ComposerDraft } from './Chat';
import type { Action, View } from './App';
import type { Snapshot, Status } from './api';
import { executionSurface, type WorkSurface } from './activity-state';

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
  const [surface, setSurface] = useState<WorkSurface | null>(null);
  const panelId = useId();
  const closedTurn = useRef<string | undefined>(undefined);
  const opener = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const turn = [...snapshot.messages].reverse().find((m) => m.body.role === 'user')?.id || '';
  const active =
    !snapshot.stopped &&
    !snapshot.conversation.paused &&
    ['running', 'waiting'].includes(snapshot.conversation.state);
  const usedSurface = executionSurface(snapshot, status.config.mcp);
  useEffect(() => {
    if (active && usedSurface && !surface && closedTurn.current !== turn) setSurface(usedSurface);
  }, [active, usedSurface, surface, turn]);
  const open = (next: WorkSurface) => {
    opener.current = document.activeElement as HTMLElement;
    setSurface(next);
    requestAnimationFrame(() => closeButton.current?.focus());
  };
  const close = () => {
    closedTurn.current = turn;
    setSurface(null);
    requestAnimationFrame(() => {
      if (opener.current?.isConnected) opener.current.focus();
      else document.querySelector<HTMLButtonElement>('.work-surfaces button')?.focus();
    });
  };
  return (
    <div className={`agent-workspace ${surface ? 'workbench-open' : ''}`}>
      <Chat
        snapshot={snapshot}
        status={status}
        action={action}
        onView={onView}
        drafts={drafts}
        onWorkspace={open}
        surface={surface}
      />
      {surface && (
        <aside
          className="agent-workbench"
          aria-label="エージェントの作業画面"
          onKeyDown={(e) => {
            // Terminal Escape belongs to the terminal, not to this panel.
            if (
              e.key === 'Escape' &&
              !(e.target as HTMLElement).closest('.terminal-surface, .desktop-surface')
            )
              close();
          }}
        >
          <header className="workbench-heading">
            <div
              role="tablist"
              aria-label="作業画面"
              onKeyDown={(e) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                e.preventDefault();
                const next =
                  e.key === 'Home'
                    ? 'terminal'
                    : e.key === 'End'
                      ? 'desktop'
                      : surface === 'terminal'
                        ? 'desktop'
                        : 'terminal';
                setSurface(next);
                e.currentTarget
                  .querySelector<HTMLButtonElement>(`[data-surface="${next}"]`)
                  ?.focus();
              }}
            >
              <button
                role="tab"
                id={`${panelId}-terminal`}
                data-surface="terminal"
                aria-controls={panelId}
                tabIndex={surface === 'terminal' ? 0 : -1}
                aria-selected={surface === 'terminal'}
                onClick={() => setSurface('terminal')}
              >
                <SquareTerminal size={15} />
                シェル
              </button>
              <button
                role="tab"
                id={`${panelId}-desktop`}
                data-surface="desktop"
                aria-controls={panelId}
                tabIndex={surface === 'desktop' ? 0 : -1}
                aria-selected={surface === 'desktop'}
                onClick={() => setSurface('desktop')}
              >
                <Monitor size={15} />
                画面
              </button>
            </div>
            <button
              className="icon-button"
              aria-label="作業画面を広く開く"
              title="広く開く"
              onClick={() => onView(surface)}
            >
              <ArrowUpRight size={16} />
            </button>
            <button
              ref={closeButton}
              className="icon-button"
              aria-label="作業画面を閉じる"
              title="閉じる（作業は継続）"
              onClick={close}
            >
              <X size={17} />
            </button>
          </header>
          <div
            role="tabpanel"
            id={panelId}
            aria-labelledby={`${panelId}-${surface}`}
            className="workbench-content"
            aria-label={surface === 'terminal' ? 'シェルの作業画面' : 'デスクトップの作業画面'}
          >
            <Suspense fallback={<div className="loading">作業画面を読み込み中…</div>}>
              {surface === 'terminal' ? (
                <TerminalPanel snapshot={snapshot} action={action} compact />
              ) : (
                <DesktopPanel status={status} action={action} onView={onView} compact />
              )}
            </Suspense>
          </div>
          <footer className="workbench-note">
            {surface === 'terminal'
              ? 'この会話のシェル · 画面を閉じても作業は続きます'
              : 'インストール先の共有画面 · 操作権は画面ごとに切り替え'}
          </footer>
        </aside>
      )}
    </div>
  );
}
