import { useState } from 'react';
import { api, type Status } from './api';
import type { Action } from './App';
export function DesktopSettings({
  status,
  action,
  onCredential,
}: {
  status: Status;
  action: Action;
  onCredential: (target: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState('');
  const [busy, setBusy] = useState(false);
  const definition = status.config.desktops.find((d) => d.id === editing);
  const [kind, setKind] = useState<'auto' | 'virtual' | 'external'>('external');
  const edit = (id: string) => {
    setEditing(id);
    setKind(status.config.desktops.find((d) => d.id === id)?.kind || 'external');
  };
  const perform = (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void action(fn).finally(() => setBusy(false));
  };
  return (
    <section className="form-card">
      <div className="section-heading">
        <div>
          <h2>デスクトップ</h2>
          <p>画面ごとにブラウザと操作権を管理します。</p>
        </div>
        <button onClick={() => edit('new')}>VNCを追加</button>
      </div>
      {status.desktops.map((d) => (
        <div className="connection-row" key={d.id}>
          <span>
            <strong>{d.name}</strong>
            <small>
              {d.owner === 'human' ? 'あなたが操作中' : 'AIが操作可能'} · {d.display || d.setup}
            </small>
          </span>
          <button onClick={() => edit(d.id)}>編集</button>
          <button disabled={busy || status.desktops.length === 1} onClick={() => setRemoving(d.id)}>
            削除
          </button>
          {removing === d.id && (
            <span>
              この画面を終了して削除します。
              <button
                className="danger"
                disabled={busy}
                onClick={() =>
                  perform(async () => {
                    await api(`/desktops/${d.id}`, 'DELETE');
                    setRemoving('');
                  })
                }
              >
                削除する
              </button>
              <button onClick={() => setRemoving('')}>取消</button>
            </span>
          )}
        </div>
      ))}
      {editing && (
        <form
          key={editing}
          className="nested-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const name = String(f.get('name'));
            const value = {
              name,
              kind,
              ...(kind === 'external'
                ? {
                    connection: {
                      name,
                      mode: String(f.get('mode')),
                      display: String(f.get('display')),
                      vncHost: '127.0.0.1',
                      vncPort: Number(f.get('port')),
                    },
                  }
                : {}),
            };
            perform(async () => {
              await (definition
                ? api(`/desktops/${definition.id}`, 'PUT', {
                    revision: status.config.revision,
                    desktop: { ...value, id: definition.id },
                  })
                : api('/desktops', 'POST', value));
              setEditing(null);
            });
          }}
        >
          <label>
            画面の名前
            <input
              name="name"
              required
              maxLength={100}
              defaultValue={definition?.name || '外部デスクトップ'}
            />
          </label>
          <label>
            接続方式
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              {definition?.kind === 'auto' && (
                <option value="auto">この端末の画面に自動接続</option>
              )}
              <option value="virtual">独立した仮想デスクトップ</option>
              <option value="external">VNCを手動で接続</option>
            </select>
          </label>
          {kind === 'external' && (
            <>
              <label>
                画面の操作方式
                <select name="mode" defaultValue={definition?.connection?.mode || 'vnc'}>
                  <option value="vnc">VNC</option>
                  <option value="x11">このホストのLinux X11</option>
                </select>
              </label>
              <div className="form-grid">
                <label>
                  DISPLAY
                  <input
                    name="display"
                    required
                    defaultValue={definition?.connection?.display || ':0'}
                  />
                </label>
                <label>
                  VNCポート
                  <input
                    name="port"
                    type="number"
                    required
                    min={1}
                    max={65535}
                    defaultValue={definition?.connection?.vncPort || 5900}
                  />
                </label>
              </div>
              <small className="muted">
                別ホストはVNCポートをlocalhostへ転送してください。シェルはインストール先で動きます。
              </small>
            </>
          )}
          <div className="form-actions">
            <button className="primary" disabled={busy}>
              保存
            </button>
            <button type="button" onClick={() => setEditing(null)}>
              取消
            </button>
            {definition?.kind === 'external' && (
              <button type="button" onClick={() => onCredential(`desktop:${definition.id}`)}>
                VNCパスワードを入力
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
