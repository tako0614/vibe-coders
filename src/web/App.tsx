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
import { Chat, RequestCard } from './Chat';
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
    [login, setLoginNeeded] = useState(false),
    [sidebar, setSidebar] = useState(true);
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
      if (e instanceof ApiError && e.status === 401) setLoginNeeded(true);
      else setError(e instanceof Error ? e.message : '接続できませんでした。');
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
    void listen(controller.signal, () => {
      void refresh();
    });
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
            <small>Home repository</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <button className="new-chat" onClick={() => void newChat()}>
          <Plus size={16} /> 新しい会話 <kbd>＋</kbd>
        </button>
        <nav>
          {navigation.map(([id, Icon, name]) => (
            <button key={id} className={view === id ? 'selected' : ''} onClick={() => setView(id)}>
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
            onClick={() => setView('settings')}
          >
            <Settings2 size={16} /> 設定・接続
          </button>
          <div className="daemon-status">
            <span className={`live-dot ${status?.stopped ? 'off' : ''}`} />
            <span>{status?.stopped ? 'すべて停止中' : 'バックエンド接続中'}</span>
            <span className="mono">BUN</span>
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
            <span className="breadcrumb">Workspace</span>
            <span className="divider">/</span>
            <strong>{currentView}</strong>
          </div>
          <div>
            <span className="parent-status">
              <i
                className={`live-dot ${snapshot?.conversation.state === 'running' ? 'pulse' : 'off'}`}
              />{' '}
              親：{stateLabel[snapshot?.conversation.state || 'idle']}
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
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="エラーを閉じる"
              onClick={() => setError('')}
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
              <Chat snapshot={snapshot} status={status} action={action} onView={setView} />
            )}
            {view === 'requests' && (
              <section className="page">
                <div className="page-heading">
                  <div className="eyebrow">HUMAN INPUT</div>
                  <h1>あなたの一手が必要なときに。</h1>
                  <p>回答待ちの間も、エージェントはほかの作業を続けられます。</p>
                </div>
                {snapshot.requests.length ? (
                  <div className="request-list">
                    {snapshot.requests.map((r) => (
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
              </section>
            )}
            {view === 'terminal' && <TerminalPanel snapshot={snapshot} action={action} />}
            {view === 'schedules' && <SchedulesPanel snapshot={snapshot} action={action} />}
            {view === 'settings' && (
              <SettingsPanel status={status} snapshot={snapshot} action={action} onView={setView} />
            )}
            {view === 'memory' && <MemoryPanel action={action} />}
            {view === 'files' && <FilesPanel action={action} />}
            {view === 'desktop' && (
              <DesktopPanel status={status} action={action} onView={setView} />
            )}
          </Suspense>
        )}
      </div>
    </div>
  );
}
export type Action = (work: () => Promise<unknown>) => Promise<void>;
