import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Clock3,
  GitBranch,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { api, time, type Status } from './api';
import type { Action } from './App';
import type { MemoryDetail, MemoryItem, MemoryPage, MemoryWrite } from '../shared/memory';

export const originLabel: Record<string, string> = {
  source: '原資料',
  extraction: '抽出',
  organization: '整理',
  derived: '記憶',
  hypothesis: '仮説',
};
export function MemoryPanel({
  action,
  status,
  selected,
  onSelect,
  onConversation,
}: {
  action: Action;
  status: Status;
  selected?: MemoryItem;
  onSelect: (item?: MemoryItem) => void;
  onConversation: (id: string, messageId?: string) => void;
}) {
  const [page, setPage] = useState<MemoryPage>();
  const [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [kind, setKind] = useState('memories');
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [adding, setAdding] = useState(false),
    [revision, setRevision] = useState(0);
  const [conversationId, setConversationId] = useState(status.conversations[0]?.id || '');
  const request = useRef(0);
  const refresh = useCallback(
    async (cursor?: string) => {
      const ticket = ++request.current;
      setLoading(true);
      setError('');
      try {
        const value = await api<MemoryPage>(
          `/memory?q=${encodeURIComponent(search)}&kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        if (ticket === request.current)
          setPage((previous) =>
            cursor && previous
              ? {
                  ...value,
                  items: [
                    ...previous.items,
                    ...value.items.filter(
                      (item) => !previous.items.some((p) => p.ref === item.ref),
                    ),
                  ],
                }
              : value,
          );
      } catch (error) {
        if (ticket === request.current)
          setError(error instanceof Error ? error.message : '記憶を取得できませんでした。');
      } finally {
        if (ticket === request.current) setLoading(false);
      }
    },
    [search, kind],
  );
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh, revision]);
  const pending = page?.jobs.some((job) => job.state === 'queued' || job.state === 'running');
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setRevision((v) => v + 1), 3000);
    return () => clearInterval(timer);
  }, [pending]);
  const changed = () => setRevision((v) => v + 1);
  return (
    <section className="page memory-page">
      <header className="memory-heading">
        <div>
          <div className="eyebrow">ATOM MEMORY</div>
          <h1>記憶</h1>
          <p>会話から残したこと、その根拠とつながり。</p>
        </div>
        <div className="memory-heading-actions">
          <button className="icon-button" aria-label="記憶を更新" onClick={changed}>
            <RefreshCw size={16} />
          </button>
          <button onClick={() => setAdding(!adding)}>
            <Plus size={15} />
            記憶を追加
          </button>
        </div>
      </header>
      {page && (
        <div className="memory-stats">
          <span>
            <strong>{page.total}</strong> 記憶
          </span>
          <span>
            <strong>{page.sourceCount}</strong> 出典
          </span>
          <span>
            <strong>{page.linkCount}</strong> つながり
          </span>
          <small>{page.automatic ? '会話の区切りで自動整理' : '自動整理は停止中'}</small>
        </div>
      )}
      <div className="memory-organizer">
        <div>
          <BookOpen size={16} />
          <span>過去の会話も記憶に整理できます</span>
        </div>
        <select
          aria-label="整理する会話"
          value={conversationId}
          onChange={(e) => setConversationId(e.target.value)}
        >
          <option value="" disabled>
            会話を選択
          </option>
          {status.conversations.map((c) => (
            <option value={c.id} key={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <button
          disabled={!conversationId || status.stopped}
          onClick={() =>
            void action(async () => {
              await api('/memory/organize', 'POST', { conversationId });
              changed();
            })
          }
        >
          この会話を整理
        </button>
      </div>
      {!!page?.jobs.length && (
        <div className="memory-jobs" aria-live="polite">
          {[...page.jobs]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 3)
            .map((job) => (
              <div
                key={job.conversationId}
                className={job.state === 'error' ? 'memory-job-error' : ''}
              >
                {job.state === 'running' ? (
                  <LoaderCircle size={14} className="spin" />
                ) : job.state === 'complete' ? (
                  <Check size={14} />
                ) : (
                  <Clock3 size={14} />
                )}
                <span>
                  {job.title} ·{' '}
                  {
                    {
                      queued: '整理待ち',
                      running: '記憶を整理中',
                      complete: `${job.saved}件を整理済み`,
                      error: '整理を完了できませんでした',
                    }[job.state]
                  }
                  {job.error && <small>{job.error}</small>}
                </span>
                {job.state === 'error' && (
                  <button
                    onClick={() =>
                      void action(async () => {
                        await api('/memory/organize', 'POST', {
                          conversationId: job.conversationId,
                        });
                        changed();
                      })
                    }
                  >
                    再試行
                  </button>
                )}
              </div>
            ))}
        </div>
      )}
      {adding && (
        <MemoryEditor
          onCancel={() => setAdding(false)}
          onSave={async (input) => {
            await api('/memory', 'POST', input);
            setAdding(false);
            changed();
          }}
        />
      )}
      <div className={`memory-browser ${selected ? 'has-selection' : ''}`}>
        <div className="memory-catalog">
          <form
            className="memory-search"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(query);
            }}
          >
            <Search size={16} />
            <input
              aria-label="記憶を検索"
              placeholder="記憶や出典を探す"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" disabled={loading}>
              検索
            </button>
          </form>
          <div className="memory-tabs" role="group" aria-label="記憶の種類">
            {[
              ['memories', '記憶'],
              ['sources', '出典'],
              ['retired', 'アーカイブ'],
            ].map(([id, label]) => (
              <button
                key={id}
                aria-pressed={kind === id}
                onClick={() => {
                  setKind(id);
                  setQuery('');
                  setSearch('');
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {!page && loading ? (
            <p className="panel-loading">記憶を読み込み中…</p>
          ) : !page?.items.length ? (
            <div className="memory-empty">
              <BookOpen size={24} />
              <h2>
                {search
                  ? '一致する記憶がありません'
                  : kind === 'sources'
                    ? '出典はまだありません'
                    : 'ここに記憶が育ちます'}
              </h2>
              <p>
                会話の方針や発見を、出典と一緒に残します。過去の会話は上の「この会話を整理」から取り込めます。
              </p>
            </div>
          ) : (
            <div className="memory-list">
              {page.items.map((item) => (
                <button
                  className={`memory-list-item ${selected?.id === item.id ? 'selected' : ''}`}
                  key={item.ref}
                  onClick={() => onSelect(item)}
                >
                  <div>
                    <span>
                      {item.capturedSource ? '会話の出典' : originLabel[item.origin] || item.origin}
                    </span>
                    <time>{time(Date.parse(item.updatedAt))}</time>
                  </div>
                  <strong>{item.title}</strong>
                  <p>{item.preview.replace(item.title, '').trim() || item.preview}</p>
                  <small>
                    <GitBranch size={12} />
                    {item.links} つながり <BookOpen size={12} />
                    {item.sources} 出典
                  </small>
                </button>
              ))}
            </div>
          )}
          {page?.partial && (
            <p className="memory-note">
              検索範囲に上限があります。検索語を絞るか、続きを取得できます。
            </p>
          )}
          {page?.cursor && (
            <button
              className="memory-more"
              disabled={loading}
              onClick={() => void refresh(page.cursor)}
            >
              {loading ? '読み込み中…' : '続きを表示'}
            </button>
          )}
        </div>
        {selected ? (
          <MemoryInspector
            key={`${selected.id}:${selected.revisionId}`}
            item={selected}
            onSelect={onSelect}
            onClose={() => onSelect()}
            onConversation={onConversation}
            onChanged={changed}
            action={action}
          />
        ) : (
          <div className="memory-detail-placeholder">
            <GitBranch size={28} />
            <h2>記憶のつながりを辿る</h2>
            <p>記憶を選ぶと、元の発言・関連する記憶・変更履歴・参照された会話を確認できます。</p>
          </div>
        )}
      </div>
    </section>
  );
}
function MemoryInspector({
  item,
  onSelect,
  onClose,
  onConversation,
  onChanged,
  action,
}: {
  item: MemoryItem;
  onSelect: (item: MemoryItem) => void;
  onClose: () => void;
  onConversation: (id: string, messageId?: string) => void;
  onChanged: () => void;
  action: Action;
}) {
  const [detail, setDetail] = useState<MemoryDetail>(),
    [error, setError] = useState(''),
    [editing, setEditing] = useState(false);
  useEffect(() => {
    let current = true;
    void api<MemoryDetail>(
      `/memory/atoms/${encodeURIComponent(item.id)}?revision=${encodeURIComponent(item.revisionId)}`,
    )
      .then((value) => {
        if (current) setDetail(value);
      })
      .catch((error) => {
        if (current) setError(error.message);
      });
    return () => {
      current = false;
    };
  }, [item.id, item.revisionId]);
  const current = detail?.latestRevisionId === item.revisionId;
  const link = (value: MemoryItem) => (
    <button className="memory-related" key={value.ref} onClick={() => onSelect(value)}>
      <span>{value.title}</span>
      <ChevronRight size={15} />
    </button>
  );
  return (
    <aside className="memory-inspector" aria-label="記憶の詳細">
      <div className="memory-inspector-top">
        <button onClick={onClose}>
          <ArrowLeft size={15} />
          一覧へ
        </button>
        <span>{originLabel[item.origin]}</span>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!detail ? (
        !error && <p className="panel-loading">記憶を開いています…</p>
      ) : (
        <>
          <h2>{detail.item.title}</h2>
          <p className="memory-note">
            {time(Date.parse(item.updatedAt))}
            {!current && ' · 過去の版'}
            {item.state === 'retired' && ' · アーカイブ済み'}
          </p>
          {detail.stale && (
            <p className="inline-error">
              根拠となる記憶が更新されています。内容の再確認が必要です。
            </p>
          )}
          {editing ? (
            <MemoryEditor
              detail={detail}
              onCancel={() => setEditing(false)}
              onSave={async (input) => {
                await api<{ ref: string }>(`/memory/atoms/${encodeURIComponent(item.id)}`, 'PUT', {
                  ...input,
                  ref: item.ref,
                });
                const latest = await api<MemoryDetail>(
                  `/memory/atoms/${encodeURIComponent(item.id)}`,
                );
                setEditing(false);
                onChanged();
                onSelect(latest.item);
              }}
            />
          ) : (
            <div className="memory-body">{detail.text}</div>
          )}
          {!editing && current && item.state === 'active' && !item.capturedSource && (
            <div className="memory-detail-actions">
              <button onClick={() => setEditing(true)}>内容・つながりを編集</button>
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      'この記憶をアーカイブしますか？履歴は保持し、通常の取得から外します。',
                    )
                  )
                    void action(async () => {
                      await api(`/memory/atoms/${encodeURIComponent(item.id)}/retire`, 'POST', {
                        ref: item.ref,
                      });
                      onChanged();
                      onClose();
                    });
                }}
              >
                アーカイブ
              </button>
            </div>
          )}
          {item.capturedSource && (
            <section>
              <h3>元の会話</h3>
              <button
                className="memory-related"
                onClick={() =>
                  onConversation(
                    item.capturedSource!.conversationId,
                    item.capturedSource!.messageId,
                  )
                }
              >
                {item.capturedSource.title}
                <ArrowUpRight size={15} />
              </button>
              <p className="memory-note">
                {time(item.capturedSource.createdAt)} ·{' '}
                {item.capturedSource.role === 'user'
                  ? 'ユーザー'
                  : item.capturedSource.role === 'tool'
                    ? 'ツールの結果'
                    : 'アシスタントの発言'}
                {item.capturedSource.truncated && ' · 長文のため抜粋'}
              </p>
            </section>
          )}
          <section>
            <h3>
              <BookOpen size={14} />
              出典 <span>{detail.sources.length}</span>
            </h3>
            {detail.sources.length ? (
              detail.sources.map((source, index) =>
                source.item ? (
                  link(source.item)
                ) : (
                  <p key={index} className="memory-note">
                    この出典は利用できません
                  </p>
                ),
              )
            ) : (
              <p className="memory-note">この記憶に登録された出典はありません。</p>
            )}
          </section>
          <section>
            <h3>
              <GitBranch size={14} />
              つながり <span>{detail.links.length + detail.incoming.length}</span>
            </h3>
            {detail.links.map((relation, index) => (
              <div className="memory-relation" key={index}>
                <small>{relation.role}</small>
                {relation.item ? link(relation.item) : <span>参照先を利用できません</span>}
              </div>
            ))}
            {detail.incoming.map((incoming) => (
              <div className="memory-relation" key={incoming.ref}>
                <small>この記憶への参照</small>
                {link(incoming)}
              </div>
            ))}
            {!detail.links.length && !detail.incoming.length && (
              <p className="memory-note">まだ関連付けはありません。</p>
            )}
          </section>
          <section>
            <h3>
              <Clock3 size={14} />
              変更履歴
            </h3>
            {detail.history.map((version) => (
              <button
                className="memory-history-row"
                key={version.revisionId}
                aria-current={version.revisionId === item.revisionId ? 'true' : undefined}
                onClick={() => onSelect(version)}
              >
                <span>{time(Date.parse(version.updatedAt))}</span>
                <span>
                  {version.revisionId === detail.latestRevisionId ? '最新版' : '過去の版'}
                </span>
              </button>
            ))}
            {detail.historyCursor && (
              <button
                onClick={() =>
                  void action(async () => {
                    const next = await api<MemoryDetail>(
                      `/memory/atoms/${encodeURIComponent(item.id)}?revision=${encodeURIComponent(item.revisionId)}&history=${encodeURIComponent(detail.historyCursor!)}`,
                    );
                    setDetail({
                      ...detail,
                      history: [...detail.history, ...next.history],
                      historyCursor: next.historyCursor,
                    });
                  })
                }
              >
                以前の履歴
              </button>
            )}
          </section>
          <section>
            <h3>モデルへ渡した会話</h3>
            {detail.usedIn.length ? (
              detail.usedIn.map((use) => (
                <button
                  className="memory-related"
                  key={use.messageId}
                  onClick={() => onConversation(use.conversationId, use.messageId)}
                >
                  <span>
                    {time(use.at)} の会話{use.revisionId !== item.revisionId && '（別の版）'}
                  </span>
                  <ArrowUpRight size={15} />
                </button>
              ))
            ) : (
              <p className="memory-note">まだ参照された記録はありません。</p>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
function MemoryEditor({
  detail,
  onSave,
  onCancel,
}: {
  detail?: MemoryDetail;
  onSave: (input: MemoryWrite) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(detail?.text || ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [links, setLinks] = useState(
    detail?.links.flatMap((link) =>
      link.item ? [{ ref: link.item.ref, role: link.role, title: link.item.title }] : [],
    ) || [],
  );
  const [query, setQuery] = useState(''),
    [candidates, setCandidates] = useState<MemoryItem[]>([]);
  return (
    <form
      className="memory-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        try {
          await onSave({
            text,
            links: links.map(({ ref, role }) => ({ ref, role })),
            sources:
              detail?.sources.flatMap((source) => (source.item ? [source.item.ref] : [])) || [],
          });
        } catch (error) {
          setError(error instanceof Error ? error.message : '保存できませんでした。');
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        覚えておくこと
        <textarea
          name="text"
          required
          maxLength={16000}
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="最初の行に短い見出し、その下に内容を書きます"
        />
      </label>
      <div className="memory-link-editor">
        <label>
          関連する記憶を探す
          <div>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="検索語" />
            <button
              type="button"
              onClick={() => {
                void api<MemoryPage>(`/memory?q=${encodeURIComponent(query)}`)
                  .then((page) =>
                    setCandidates(page.items.filter((item) => item.id !== detail?.item.id)),
                  )
                  .catch((error) => setError(error.message));
              }}
            >
              探す
            </button>
          </div>
        </label>
        {candidates
          .filter((item) => !links.some((link) => link.ref === item.ref))
          .slice(0, 5)
          .map((item) => (
            <button
              className="memory-related"
              type="button"
              key={item.ref}
              onClick={() => {
                setLinks([...links, { ref: item.ref, role: 'related', title: item.title }]);
                setCandidates([]);
              }}
            >
              {item.title}
              <Plus size={14} />
            </button>
          ))}
        {links.map((link, index) => (
          <div className="memory-edit-link" key={link.ref}>
            <span>{link.title}</span>
            <input
              aria-label={`${link.title}との関係`}
              value={link.role}
              maxLength={80}
              required
              onChange={(e) =>
                setLinks(
                  links.map((value, i) =>
                    i === index ? { ...value, role: e.target.value } : value,
                  ),
                )
              }
            />
            <button
              type="button"
              className="icon-button"
              aria-label="関連を外す"
              onClick={() => setLinks(links.filter((_, i) => i !== index))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="memory-detail-actions">
        <button className="primary" disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          キャンセル
        </button>
      </div>
    </form>
  );
}
