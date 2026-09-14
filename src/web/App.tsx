import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Brain,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  FolderOpen,
  Inbox,
  MessageSquare,
  Monitor,
  Plus,
  Settings2,
  SquareTerminal,
  X,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { api, ApiError, listen, setLogin, stateLabel, type Snapshot, type Status } from './api';
import { Chat, RequestCard, type ComposerDraft } from './Chat';
const TerminalPanel = lazy(() => import('./Panels').then((m) => ({ default: m.TerminalPanel })));
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
    [sidebar, setSidebar] = useState(true),
    [connected, setConnected] = useState(false),
    [settingsSection, setSettingsSection] = useState('model');
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
      const id = selectedRef.current || status.conversations[0]?.id;
      if (id) {
        if (!selectedRef.current) {
          selectedRef.current = id;
          setSelected(id);
        }
        const snapshot = await api<Snapshot>(`/conversations/${id}`);
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
  };
  const choose = (id: string) => {
    selectedRef.current = id;
    setSelected(id);
    setSnapshot(undefined);
    setView('chat');
    void refresh();
  };
  const newChat = () =>
    action(async () => {
      const c = await api<{ id: string }>('/conversations', 'POST', {});
      choose(c.id);
    });
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
          <div className="wordmark">
            <span className="brand-icon">
              <SquareTerminal size={20} />
            </span>
            Vibe Coders
          </div>
          <h1>作業場所に戻る</h1>
          <p>セットアップで登録した認証情報を入力してください。</p>
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
      <aside className="sidebar">
        <div className="wordmark">
          <span className="brand-icon">
            <SquareTerminal size={19} />
          </span>
          Vibe Coders <span className="version">LOCAL</span>
        </div>
        <button className="home-label" onClick={() => setView('files')} title={status?.home}>
          <span className="repo-avatar">
            {status?.home.split('/').pop()?.slice(0, 1).toUpperCase() || 'V'}
          </span>
          <span>
            <strong>{status?.home.split('/').pop() || 'Workspace'}</strong>
            <small>作業フォルダ</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <button className="new-chat" aria-label="新しい会話" onClick={() => void newChat()}>
          <Plus size={16} /> 新しい会話 <kbd>＋</kbd>
        </button>
        <nav>
          {navigation.map(([id, Icon, name]) => (
            <button
              key={id}
              className={view === id ? 'selected' : ''}
              onClick={() => setView(id)}
              title={name}
              aria-label={name}
            >
              <Icon size={17} />
              <span>{name}</span>
              {id === 'requests' && pending.length > 0 && <b className="count">{pending.length}</b>}
              {id === 'terminal' && activeRuns.length > 0 && <i className="live-dot" />}
            </button>
          ))}
        </nav>
        <div className="history-label">
          最近の会話 <span>{status?.conversations.length || 0}</span>
        </div>
        <div className="conversation-list">
          {status?.conversations.map((c) => (
            <button
              key={c.id}
              className={selected === c.id ? 'current' : ''}
              onClick={() => choose(c.id)}
            >
              <MessageSquare size={13} />
              <span>{c.title}</span>
              {c.state === 'running' && <i className="live-dot" />}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button
            className={view === 'settings' ? 'selected' : ''}
            onClick={() => navigate('settings')}
            aria-label="設定・接続"
            title="設定・接続"
          >
            <Settings2 size={16} /> 設定・接続
          </button>
          <div className="daemon-status">
            <span className={`live-dot ${!connected || status?.stopped ? 'off' : ''}`} />
            <span>
              {!connected ? '再接続中…' : status?.stopped ? 'すべて停止中' : 'サーバー接続済み'}
            </span>
            <span className="mono">LOCAL</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <button
              className="icon-button"
              title="サイドバーを切り替え"
              aria-label="サイドバーを切り替え"
              onClick={() => setSidebar(!sidebar)}
            >
              {sidebar ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>
            <span className="breadcrumb">{status?.home.split('/').pop() || 'Workspace'}</span>
            <span className="divider">/</span>
            <strong>{currentView}</strong>
          </div>
          <div>
            <span className="parent-status">
              <i
                className={`live-dot ${snapshot?.conversation.state === 'running' ? 'pulse' : 'off'}`}
              />{' '}
              {!status?.providerReady
                ? 'AI未接続'
                : stateLabel[snapshot?.conversation.state || 'idle']}
            </span>
            <button
              className="icon-button"
              title="接続を確認"
              aria-label="接続を確認"
              onClick={() => setView('settings')}
            >
              <CircleHelp size={17} />
            </button>
          </div>
        </header>
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
              <Chat
                key={snapshot.conversation.id}
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
                    <Check size={25} />
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
