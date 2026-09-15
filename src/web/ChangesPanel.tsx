import { useEffect, useState } from 'react';
import { api, time } from './api';
import type { Action } from './App';
import type { WorkspaceChanges } from '../server/changes';
type Listing = Awaited<ReturnType<WorkspaceChanges['list']>>;
type Detail = Awaited<ReturnType<WorkspaceChanges['detail']>>;
function diff(before: string | null, after: string | null) {
  const a = (before || '').split('\n'),
    b = (after || '').split('\n');
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  if (start === a.length && start === b.length) return [{ kind: 'same', text: '変更はありません' }];
  return [
    ...a.slice(Math.max(0, start - 3), start).map((text) => ({ kind: 'same', text: ' ' + text })),
    ...a.slice(start, a.length - end).map((text) => ({ kind: 'removed', text: '-' + text })),
    ...b.slice(start, b.length - end).map((text) => ({ kind: 'added', text: '+' + text })),
    ...b
      .slice(b.length - end, b.length - end + 3)
      .map((text) => ({ kind: 'same', text: ' ' + text })),
  ];
}
export function FileEditor({
  path,
  close,
  saved,
}: {
  path: string;
  close: () => void;
  saved: () => void;
}) {
  const [detail, setDetail] = useState<Detail>(),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void api<Detail>(`/changes/file?path=${encodeURIComponent(path)}`)
      .then((d) => {
        if (active) {
          setDetail(d);
          setText(d.after || '');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [path]);
  return (
    <section className="file-editor">
      <div className="heading-row">
        <strong>{path}</strong>
        <button onClick={close}>閉じる</button>
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {detail ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError('');
            try {
              const d = await api<Detail>('/changes/file', 'PUT', {
                path,
                content: text,
                expectedSha256: detail.sha256,
              });
              setDetail(d);
              saved();
            } catch (e) {
              setError(e instanceof Error ? e.message : '保存できませんでした');
            } finally {
              setBusy(false);
            }
          }}
        >
          <textarea
            aria-label="ファイルを編集"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
          <button className="primary" disabled={busy || text === detail.after}>
            {busy ? '保存中…' : 'ファイルを保存'}
          </button>
        </form>
      ) : (
        <p>読み込み中…</p>
      )}
    </section>
  );
}
export function ChangesPanel({ action, back }: { action: Action; back: () => void }) {
  const [listing, setListing] = useState<Listing>(),
    [selected, setSelected] = useState(''),
    [detail, setDetail] = useState<Detail>(),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [editing, setEditing] = useState(false),
    [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let active = true;
    void api<Listing>('/changes')
      .then((v) => {
        if (active) {
          setListing(v);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setConfirm(false);
    setEditing(false);
    if (selected)
      void api<Detail>(`/changes/file?path=${encodeURIComponent(selected)}`)
        .then((d) => {
          if (active) setDetail(d);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [selected, revision]);
  return (
    <section className="page changes-page">
      <div className="heading-row">
        <h1>変更の確認</h1>
        <div>
          <button onClick={() => setRevision((n) => n + 1)}>変更を再読み込み</button>
          <button onClick={back}>ファイル一覧へ</button>
        </div>
      </div>
      <p className="muted">
        {listing
          ? `${time(listing.baseline.createdAt)} に保存した作業フォルダの状態との差分です。手動・AI・外部CLIの変更を含みます。`
          : '変更を確認しています…'}
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {listing?.skipped.length ? (
        <details className="skipped-files">
          <summary>保存対象外のファイル（{listing.skipped.length}）</summary>
          <p>大きなファイル・バイナリ・シンボリックリンクなどは復元対象に含めません。</p>
          <pre>{listing.skipped.slice(0, 100).join('\n')}</pre>
        </details>
      ) : null}
      <div className="changes-layout">
        <div className="change-list">
          {listing?.changes.map((c) => (
            <button
              key={c.path}
              className={selected === c.path ? 'selected' : ''}
              onClick={() => setSelected(c.path)}
            >
              <span>{c.kind === 'added' ? '+' : c.kind === 'deleted' ? '−' : 'M'}</span>
              {c.path}
            </button>
          ))}
          {listing && !listing.changes.length && <p>変更はありません。</p>}
        </div>
        <div className="change-detail">
          {detail ? (
            <>
              <div className="heading-row">
                <strong>{detail.path}</strong>
                <div>
                  <button onClick={() => setEditing(!editing)}>編集する</button>
                  <button disabled={!detail.restorable} onClick={() => setConfirm(!confirm)}>
                    変更前に戻す
                  </button>
                </div>
              </div>
              {confirm && (
                <div className="restore-confirm">
                  <p>
                    {detail.before === null
                      ? '基準に存在しなかったこのファイルを削除します。'
                      : 'このファイルだけを保存済みの内容に戻します。'}
                    表示後に別の変更があれば中止します。
                  </p>
                  <button
                    className="danger"
                    onClick={() =>
                      void action(async () => {
                        await api('/changes/restore', 'POST', {
                          path: detail.path,
                          baselineId: detail.baselineId,
                          expectedSha256: detail.sha256,
                        });
                        setRevision((n) => n + 1);
                      })
                    }
                  >
                    このファイルを復元
                  </button>
                  <button onClick={() => setConfirm(false)}>取り消す</button>
                </div>
              )}
              {editing ? (
                <FileEditor
                  path={detail.path}
                  close={() => setEditing(false)}
                  saved={() => setRevision((n) => n + 1)}
                />
              ) : (
                <pre className="file-diff">
                  {diff(detail.before, detail.after).map((line, i) => (
                    <div key={i} className={line.kind}>
                      {line.text || ' '}
                    </div>
                  ))}
                </pre>
              )}
            </>
          ) : (
            <p>変更されたファイルを選択してください。</p>
          )}
        </div>
      </div>
    </section>
  );
}
