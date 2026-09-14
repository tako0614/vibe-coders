import { useEffect, useState } from 'react';
import { api } from './api';
import type { Action } from './App';
import type { CodexAuth } from '../server/codex-auth';

type Auth = ReturnType<CodexAuth['userStatus']>;
const labels: Record<string, string> = {
  unchecked: '未確認',
  missing: 'Codex CLIが未導入',
  signed_out: '未ログイン',
  starting: 'ログインを準備中',
  waiting: '本人のログインを待っています',
  signed_in: 'ログイン済み',
  ready: '利用可能',
  error: '認証状態を確認できませんでした',
};
export function CodexLogin({
  conversationId,
  action,
  requestId,
  beforeLogin,
}: {
  conversationId: string;
  action: Action;
  requestId?: string;
  beforeLogin?: () => Promise<void>;
}) {
  const [auth, setAuth] = useState<Auth>();
  const [error, setError] = useState(''),
    [starting, setStarting] = useState(false);
  const refresh = async () => {
    await api('/codex/auth/refresh', 'POST', {});
    setAuth(await api<Auth>('/codex/auth'));
  };
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Auth>('/codex/auth');
        if (!disposed) {
          setAuth(next);
          setError('');
        }
      } catch (error) {
        if (!disposed)
          setError(error instanceof Error ? error.message : '状態を取得できませんでした');
      }
      if (!disposed) timer = setTimeout(poll, 1500);
    };
    void api('/codex/auth/refresh', 'POST', {}).catch(() => {});
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  const busy = starting || auth?.state === 'starting' || auth?.state === 'waiting';
  const login = !requestId || auth?.requestId === requestId ? auth?.login : null;
  const start = (method: 'device' | 'browser') =>
    action(async () => {
      setStarting(true);
      try {
        await beforeLogin?.();
        await api('/codex/auth/login', 'POST', { conversationId, method });
        setAuth(await api<Auth>('/codex/auth'));
      } finally {
        setStarting(false);
      }
    });
  return (
    <div className="codex-login">
      <p>
        <strong>
          {starting
            ? '接続を準備中…'
            : !auth || auth.state === 'unchecked'
              ? '認証状態を確認中…'
              : labels[auth.state]}
        </strong>
        {auth?.subscriptionReady ? ' · ChatGPT' : ''}
      </p>
      {auth?.ready && !auth.subscriptionReady && (
        <p>ChatGPTのサブスク認証へログインしてください。</p>
      )}
      {auth?.message && <p>{auth.message}</p>}
      {error && <p role="alert">{error}</p>}
      {login && (
        <div className="codex-login-details">
          <a href={login.url} target="_blank" rel="noreferrer">
            Codexの認証ページを開く ↗
          </a>
          {login.code && (
            <p>
              認証ページに入力するコード：<code>{login.code}</code>
            </p>
          )}
          <p>
            ログインの完了を自動確認します。認証画面を閉じ、安全な画面になってからデスクトップをAIへ返してください。
          </p>
        </div>
      )}
      <div className="form-actions">
        <button type="button" disabled={busy} onClick={() => void action(refresh)}>
          認証状態を確認
        </button>
        {auth && auth.state !== 'unchecked' && !auth.subscriptionReady && !busy && (
          <>
            <button
              type="button"
              className="primary"
              disabled={auth?.installed === false}
              onClick={() => void start('device')}
            >
              {beforeLogin ? 'ログインして接続' : 'コードでログイン'}
            </button>
            <button
              type="button"
              disabled={auth?.installed === false}
              onClick={() => void start('browser')}
            >
              サーバー上のブラウザでログイン
            </button>
          </>
        )}
        {busy && (
          <button
            type="button"
            onClick={() =>
              void action(async () => {
                await api('/codex/auth/cancel', 'POST', {});
                setAuth(await api<Auth>('/codex/auth'));
              })
            }
          >
            ログインを中止
          </button>
        )}
        {!busy && auth?.ready && auth.desktopOwner === 'human' && (
          <button
            type="button"
            onClick={() => void action(() => api('/desktop/handoff', 'POST', { owner: 'agent' }))}
          >
            ブラウザ・画面操作をAIに戻す
          </button>
        )}
      </div>
    </div>
  );
}
