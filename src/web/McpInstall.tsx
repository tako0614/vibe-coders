import { useState } from 'react';
import { api, operationId, stateLabel, type Snapshot } from './api';
import type { Action } from './App';

export function McpInstall({
  snapshot,
  action,
  onRun,
}: {
  snapshot: Snapshot;
  action: Action;
  onRun: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const jobs = snapshot.runs.filter((r) => r.result && 'install' in r.result).slice(0, 5);
  return (
    <details className="nested-form mcp-install">
      <summary>npmパッケージから導入</summary>
      <p className="muted">
        AIの接続前でも使えます。指定したパッケージをこの端末に導入し、ツール一覧の取得まで確認します。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          const form = e.currentTarget,
            data = new FormData(form);
          setBusy(true);
          void action(async () => {
            await api('/mcp/install', 'POST', {
              conversationId: snapshot.conversation.id,
              operationId: operationId(),
              name: String(data.get('name')),
              package: String(data.get('package')),
              version: String(data.get('version') || 'latest'),
              args: JSON.parse(String(data.get('args') || '[]')),
              ...(data.get('bin') ? { bin: String(data.get('bin')) } : {}),
              ...(data.get('credentialEnv')
                ? { credentialEnv: String(data.get('credentialEnv')) }
                : {}),
              desktop: data.get('desktop') === 'on',
            });
            form.reset();
          }).finally(() => setBusy(false));
        }}
      >
        <div className="form-grid">
          <label>
            接続名
            <input
              name="name"
              pattern="[A-Za-z][A-Za-z0-9_-]{0,39}"
              required
              placeholder="my-tools"
            />
          </label>
          <label>
            npmパッケージ名
            <input name="package" required placeholder="@example/mcp-server" />
          </label>
          <label>
            バージョンまたはタグ
            <input name="version" defaultValue="latest" />
          </label>
          <label>
            実行ファイル名（複数ある場合）
            <input name="bin" />
          </label>
        </div>
        <label>
          引数（JSON配列）
          <input name="args" defaultValue="[]" />
        </label>
        <label>
          認証情報を渡す環境変数名（任意）
          <input name="credentialEnv" placeholder="SERVICE_API_KEY" />
        </label>
        <label className="checkbox">
          <input name="desktop" type="checkbox" />
          共有デスクトップと同じ画面を操作する
        </label>
        <button className="primary" disabled={busy || snapshot.stopped}>
          {busy ? '開始中…' : '導入して接続'}
        </button>
      </form>
      {jobs.map((r) => {
        const result = r.result!;
        if (!('stage' in result)) return null;
        const stages: Record<string, string> = {
          resolving: 'バージョン確認',
          installing: 'インストール',
          connecting: '接続・ツール確認',
          ready: '利用可能',
          awaiting_auth: '認証情報の入力待ち',
        };
        return (
          <div className="connection-row" key={r.id}>
            <span>
              <strong>{String(result.name)}</strong>
              <small>
                {String(result.package)}@{String(result.version)} · {stages[String(result.stage)]} ·{' '}
                {stateLabel[r.state]}
              </small>
              {!!result.error && <small className="danger">{String(result.error)}</small>}
            </span>
            <button onClick={onRun}>実行ログ</button>
          </div>
        );
      })}
    </details>
  );
}
