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
}: {
  conversationId: string;
  action: Action;
  requestId?: string;
}) {
  const [auth, setAuth] = useState<Auth>();
  const [error, setError] = useState('');
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
  const busy = auth?.state === 'starting' || auth?.state === 'waiting';
  const login = !requestId || auth?.requestId === requestId ? auth?.login : null;
  const start = (method: 'device' | 'browser') =>
    action(async () => {
      await api('/codex/auth/login', 'POST', { conversationId, method });
      setAuth(await api<Auth>('/codex/auth'));
    });
  return (
    <div className="codex-login">
      <p>
        <strong>{labels[auth?.state || 'unchecked']}</strong>
        {auth?.mode ? ` · ${auth.mode}` : ''}
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
        {!auth?.subscriptionReady && !busy && (
          <>
            <button
              type="button"
              className="primary"
              disabled={auth?.installed === false}
              onClick={() => void start('device')}
            >
              コードでログイン
            </button>
            <button
              type="button"
              disabled={auth?.installed === false}
              onClick={() => void start('browser')}
            >
              このPCのブラウザでログイン
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
        {!busy && auth?.ready && (
          <button
            type="button"
            onClick={() => void action(() => api('/desktop/handoff', 'POST', { owner: 'agent' }))}
          >
            安全な画面でAIに返す
          </button>
        )}
      </div>
    </div>
  );
}
