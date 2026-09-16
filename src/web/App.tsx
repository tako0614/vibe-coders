import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Brain,
  Clock3,
  FolderOpen,
  Inbox,
  MessageSquare,
  Monitor,
  SquarePen,
  ChevronDown,
  Settings2,
  Search,
  SquareTerminal,
  X,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { api, ApiError, listen, setLogin, type Snapshot, type Status } from './api';
import { RequestCard, type ComposerDraft } from './Chat';
import { AgentWorkspace } from './AgentWorkspace';
const TerminalPanel = lazy(() =>
  import('./TerminalWorkspace').then((m) => ({ default: m.TerminalPanel })),
);
const SchedulesPanel = lazy(() => import('./Panels').then((m) => ({ default: m.SchedulesPanel })));
const SettingsPanel = lazy(() => import('./Panels').then((m) => ({ default: m.SettingsPanel })));
const MemoryPanel = lazy(() => import('./Panels').then((m) => ({ default: m.MemoryPanel })));
const FilesPanel = lazy(() => import('./Panels').then((m) => ({ default: m.FilesPanel })));
const DesktopPanel = lazy(() => import('./Panels').then((m) => ({ default: m.DesktopPanel })));

export type View =
  'chat' | 'requests' | 'terminal' | 'desktop' | 'schedules' | 'memory' | 'files' | 'settings';
const navigation = [
  ['chat', MessageSquare, 'チャット'],
  ['requests', Inbox, '入力依頼'],
  ['terminal', SquareTerminal, 'ターミナル'],
  ['desktop', Monitor, 'デスクトップ'],
  ['schedules', Clock3, '予定'],
  ['memory', Brain, '記憶'],
  ['files', FolderOpen, 'ファイル'],
] as const;
export function App() {
  const [status, setStatus] = useState<Status>(),
    [snapshot, setSnapshot] = useState<Snapshot>();
  const [selected, setSelected] = useState(''),
    selectedRef = useRef('');
  const [view, setView] = useState<View>('chat'),
    [error, setError] = useState(''),
    [connectionError, setConnectionError] = useState(''),
    [login, setLoginNeeded] = useState(false),
    [sidebar, setSidebar] = useState(() => !window.matchMedia('(max-width: 760px)').matches),
    [connected, setConnected] = useState(false),
    [settingsSection, setSettingsSection] = useState('model');
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [historyQuery, setHistoryQuery] = useState('');
  const side = useRef<HTMLElement>(null),
    menu = useRef<HTMLButtonElement>(null);
  const toolsMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const node = toolsMenu.current;
      if (node?.open && !node.contains(event.target as Node)) node.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      const node = toolsMenu.current;
      if (event.key === 'Escape' && node?.open) {
        node.open = false;
        node.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const changed = () => {
      setMobile(query.matches);
      setSidebar(!query.matches);
    };
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    if (!mobile || !sidebar) return;
    side.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebar(false);
      }
    };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
      requestAnimationFrame(() => menu.current?.focus());
    };
  }, [mobile, sidebar]);
  const drafts = useRef(new Map<string, ComposerDraft>());
  const inFlight = useRef(false),
    refreshAgain = useRef(false),
    mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (inFlight.current) {
      refreshAgain.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const status = await api<Status>('/status');
      if (!mounted.current) return;
      setStatus(status);
      setConnectionError('');
      setLoginNeeded(false);
      let saved = '';
      try {
        saved = localStorage.getItem(`vibe-conversation:${status.home}`) || '';
      } catch {}
      const id =
        selectedRef.current ||
        (saved === 'new' || status.conversations.some((c) => c.id === saved) ? saved : 'new');
      if (id) {
        if (!selectedRef.current) {
          selectedRef.current = id;
          setSelected(id);
        }
        const snapshot = await api<Snapshot>(
          `/conversations/${id === 'new' ? status.workspaceId : id}`,
        );
        if (mounted.current && id === selectedRef.current) setSnapshot(snapshot);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setLoginNeeded(true);
        setError('ユーザー名またはパスワードを確認してください。');
      } else setConnectionError(e instanceof Error ? e.message : '接続できませんでした。');
    } finally {
      inFlight.current = false;
      if (refreshAgain.current && mounted.current) {
        refreshAgain.current = false;
        void refresh();
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const controller = new AbortController();
    void listen(
      controller.signal,
      () => {
        void refresh();
      },
      setConnected,
    );
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [refresh]);
  const action = useCallback(
    async (work: () => Promise<unknown>) => {
      setError('');
      try {
        await work();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : '操作に失敗しました。');
      }
    },
    [refresh],
  );
  const navigate = (next: View, section = 'model') => {
    if (next === 'settings') setSettingsSection(section);
    setView(next);
    if (toolsMenu.current) toolsMenu.current.open = false;
    if (mobile) setSidebar(false);
  };
  const choose = (id: string) => {
    selectedRef.current = id;
    setSelected(id);
    setSnapshot(undefined);
    setView('chat');
    if (toolsMenu.current) toolsMenu.current.open = false;
    if (mobile) setSidebar(false);
    try {
      if (status) localStorage.setItem(`vibe-conversation:${status.home}`, id);
    } catch {}
    void refresh();
  };
  const newChat = () => {
    setHistoryQuery('');
    if (selectedRef.current === 'new') navigate('chat');
    else choose('new');
  };
  const started = (id: string) => {
    // A send may finish after the user has navigated to another conversation.
    if (selectedRef.current === 'new') choose(id);
  };
  const pending =
    snapshot?.requests.filter((r) => ['pending', 'processing'].includes(r.state)) || [];
  const activeRuns = snapshot?.runs.filter((r) => r.state === 'running') || [];
  const currentView = navigation.find((n) => n[0] === view)?.[2] || '設定';

  if (login)
    return (
      <div className="login-screen">
        <form
          className="login-card"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            setError('');
            setLogin(String(data.get('username')), String(data.get('password')));
            e.currentTarget.reset();
            void refresh();
          }}
        >
          <div className="wordmark">Vibe Coders</div>
          <h1>ログイン</h1>
          <p>このワークスペースのユーザー名とパスワードを入力してください。</p>
          <label>
            ユーザー名
            <input name="username" autoComplete="username" required />
          </label>
          <label>
            パスワード
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <button className="primary" type="submit">
            ログイン <ArrowUpRight size={16} />
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      </div>
    );
  return (
    <div className={`app-shell ${sidebar ? '' : 'sidebar-hidden'}`}>
      {mobile && sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="メニューを閉じる"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        ref={side}
        id="app-sidebar"
        className="sidebar"
        aria-label="ナビゲーション"
        role={mobile && sidebar ? 'dialog' : undefined}
        aria-modal={mobile && sidebar ? true : undefined}
        onKeyDown={(e) => {
          if (!mobile || !sidebar || e.key !== 'Tab') return;
          const nodes = Array.from(
            side.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') || [],
          ).filter((node) => node.getClientRects().length > 0);
          if (!nodes?.length) return;
          if (e.shiftKey && document.activeElement === nodes[0]) {
            e.preventDefault();
            nodes[nodes.length - 1].focus();
          } else if (!e.shiftKey && document.activeElement === nodes[nodes.length - 1]) {
            e.preventDefault();
            nodes[0].focus();
          }
        }}
      >
        <div className="sidebar-heading">
          <span className="wordmark">Vibe Coders</span>
          {mobile && (
            <button
              className="icon-button"
              aria-label="サイドバーを閉じる"
              onClick={() => setSidebar(false)}
            >
              <X size={18} />
            </button>
          )}
        </div>
        <button className="new-chat" aria-label="新しい会話" onClick={() => void newChat()}>
          <SquarePen size={16} /> 新しい会話
        </button>
        <div className="history-search">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label="会話を検索"
            placeholder="会話を検索"
            value={historyQuery}
            onChange={(e) => setHistoryQuery(e.target.value)}
          />
        </div>
        <div className="history-label">最近の会話</div>
        <div className="conversation-list" aria-label="会話履歴">
          {status?.conversations
            .filter((c) => c.title.toLocaleLowerCase().includes(historyQuery.toLocaleLowerCase()))
            .map((c) => (
              <button
                key={c.id}
                className={selected === c.id ? 'current' : ''}
                aria-current={selected === c.id && view === 'chat' ? 'page' : undefined}
                onClick={() => choose(c.id)}
                title={c.title}
              >
                <span>{c.title}</span>
                {c.state === 'running' && <i className="live-dot" />}
              </button>
            ))}
          {historyQuery &&
            !status?.conversations.some((c) =>
              c.title.toLocaleLowerCase().includes(historyQuery.toLocaleLowerCase()),
            ) && <p className="history-empty">見つかりませんでした</p>}
        </div>
        <div className="sidebar-bottom">
          <button className="workspace-path" onClick={() => navigate('files')} title={status?.home}>
            <FolderOpen size={15} />
            <span>{status?.home.split('/').pop() || 'ワークスペース'}</span>
            <ArrowUpRight size={13} />
          </button>
          <button
            className={view === 'settings' ? 'selected' : ''}
            onClick={() => navigate('settings')}
            aria-label="設定・接続"
          >
            <Settings2 size={16} /> 設定・接続
            <span
              className={`live-dot ${!connected || status?.stopped ? 'off' : ''}`}
              title={
                !connected
                  ? 'サーバーへ再接続中'
                  : status?.stopped
                    ? 'すべて停止中'
                    : 'サーバー接続済み'
              }
            />
          </button>
        </div>
      </aside>
      <div className="workspace" inert={mobile && sidebar}>
        <header className="topbar">
          <div className="topbar-leading">
            <button
              className="icon-button"
              ref={menu}
              title="サイドバーを切り替え"
              aria-label="サイドバーを切り替え"
              aria-expanded={sidebar}
              aria-controls="app-sidebar"
              onClick={() => {
                if (toolsMenu.current) toolsMenu.current.open = false;
                setSidebar(!sidebar);
              }}
            >
              {sidebar ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>
            {!sidebar && (
              <button
                className="icon-button"
                aria-label="新しい会話"
                title="新しい会話"
                onClick={() => void newChat()}
              >
                <SquarePen size={18} />
              </button>
            )}
            <button
              className={`chat-tab ${view === 'chat' ? 'active' : ''}`}
              onClick={() => navigate('chat')}
              aria-label="チャット"
              aria-current={view === 'chat' ? 'page' : undefined}
            >
              チャット
            </button>
            {view !== 'chat' && <span className="current-tool">{currentView}</span>}
          </div>
          <div className="topbar-actions">
            <details
              className="workspace-menu"
              ref={toolsMenu}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && toolsMenu.current?.open) {
                  e.preventDefault();
                  toolsMenu.current.open = false;
                  toolsMenu.current.querySelector('summary')?.focus();
                }
              }}
            >
              <summary aria-label="作業ツール">
                作業ツール{pending.length > 0 && <span className="count">{pending.length}</span>}
                <ChevronDown size={14} />
              </summary>
              <nav className="workspace-menu-content" aria-label="作業ツールの一覧">
                {navigation
                  .filter(([id]) => id !== 'chat')
                  .map(([id, Icon, name]) => (
                    <button
                      key={id}
                      className={view === id ? 'selected' : ''}
                      onClick={() => navigate(id)}
                      aria-current={view === id ? 'page' : undefined}
                      aria-label={name}
                    >
                      <Icon size={16} />
                      <span>{name}</span>
                      {id === 'requests' && pending.length > 0 && (
                        <b className="count">{pending.length}</b>
                      )}
                      {id === 'terminal' && activeRuns.length > 0 && <i className="live-dot" />}
                    </button>
                  ))}
              </nav>
            </details>
          </div>
        </header>
        {!connected && status && !connectionError && (
          <div className="connection-banner" role="status">
            サーバーに再接続しています。入力中の内容は保持されます。
          </div>
        )}
        {(error || connectionError) && (
          <div className="error-banner" role="alert">
            <span>{error || connectionError}</span>
            <button
              className="icon-button"
              aria-label="エラーを閉じる"
              onClick={() => {
                setError('');
                setConnectionError('');
              }}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {status?.stopped && (
          <div className="stop-banner">
            すべての新規実行を停止しています。
            <button
              onClick={() => void action(() => api('/control', 'POST', { action: 'enable' }))}
            >
              実行を有効にする
            </button>
          </div>
        )}
        {!status || !snapshot ? (
          <div className="loading">
            <span className="live-dot pulse" /> ワークスペースを読み込み中…
          </div>
        ) : (
          <Suspense fallback={<div className="loading">画面を読み込み中…</div>}>
            {view === 'chat' && (
              <AgentWorkspace
                key={selected}
                onStarted={selected === 'new' ? started : undefined}
                snapshot={snapshot}
                status={status}
                action={action}
                onView={navigate}
                drafts={drafts.current}
              />
            )}
            {view === 'requests' && (
              <section className="page">
                <div className="page-heading">
                  <h1>入力依頼</h1>
                  <p>回答や認証が必要な操作を確認できます。</p>
                </div>
                {pending.length ? (
                  <div className="request-list">
                    {pending.map((r) => (
                      <RequestCard key={r.id} request={r} action={action} />
                    ))}
                  </div>
                ) : (
                  <div className="empty-panel">
                    <h3>入力依頼はありません</h3>
                    <p>回答や本人操作が必要になったら、ここに届きます。</p>
                  </div>
                )}
                {snapshot.requests.length > pending.length && (
                  <details className="request-history">
                    <summary>
                      完了した入力依頼（{snapshot.requests.length - pending.length}）
                    </summary>
                    <div className="request-list">
                      {snapshot.requests
                        .filter((r) => !['pending', 'processing'].includes(r.state))
                        .map((r) => (
                          <RequestCard key={r.id} request={r} action={action} />
                        ))}
                    </div>
                  </details>
                )}
              </section>
            )}
            {view === 'terminal' && <TerminalPanel snapshot={snapshot} action={action} />}
            {view === 'schedules' && <SchedulesPanel snapshot={snapshot} action={action} />}
            {view === 'settings' && (
              <SettingsPanel
                initialSection={settingsSection}
                status={status}
                snapshot={snapshot}
                action={action}
                onView={navigate}
              />
            )}
            {view === 'memory' && <MemoryPanel action={action} />}
            {view === 'files' && <FilesPanel action={action} />}
            {view === 'desktop' && (
              <DesktopPanel status={status} action={action} onView={navigate} />
            )}
          </Suspense>
        )}
      </div>
    </div>
  );
}
export type Action = (work: () => Promise<unknown>) => Promise<void>;
