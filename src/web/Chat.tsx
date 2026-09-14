import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronRight,
  FileCode2,
  Inbox,
  LoaderCircle,
  LockKeyhole,
  Paperclip,
  Pause,
  Play,
  Square,
  SquareTerminal,
  X,
} from 'lucide-react';
import Markdown from 'react-markdown';
import { api, operationId, stateLabel, time, type Snapshot, type Status } from './api';
import type { Action, View } from './App';
import type { HumanRequest } from '../server/db/schema';
import { CodexLogin } from './CodexLogin';
import type { ImagePart } from '../shared/contracts';
import { ActivityHistory, ToolActivity } from './Activity';

export type ComposerDraft = { text: string; images: ImagePart[] };

export function RequestCard({ request: r, action }: { request: HumanRequest; action: Action }) {
  const [busy, setBusy] = useState(false),
    [later, setLater] = useState(false);
  const open = r.state === 'pending';
  return (
    <article className={`request-card ${r.spec.kind === 'secret' ? 'secret-card' : ''}`}>
      <div className="request-heading">
        <span className="request-symbol">
          {r.spec.kind === 'secret' ? <LockKeyhole size={17} /> : <Inbox size={17} />}
        </span>
        <div>
          <strong>{r.spec.title}</strong>
          <span>
            {r.spec.kind === 'secret'
              ? '専用の秘密入力'
              : r.spec.kind === 'action'
                ? '本人による操作'
                : '入力依頼'}{' '}
            · {stateLabel[r.state]}
          </span>
        </div>
        {open && (
          <button
            className="icon-button"
            aria-label="入力依頼を後回しにする"
            onClick={() => setLater(!later)}
          >
            <ChevronRight className={later ? '' : 'rotate'} size={16} />
          </button>
        )}
      </div>
      {!later && (
        <>
          <p>{r.spec.message}</p>
          {r.result?.message && <p role="status">{String(r.result.message)}</p>}
          {open && r.spec.url && (
            <a href={r.spec.url} target="_blank" rel="noopener noreferrer" className="primary">
              認証・操作ページを開く <ArrowUpRight size={14} />
            </a>
          )}
          {r.spec.targetId && (
            <div className="target-label">
              使用先 <code>{r.spec.targetId}</code>
            </div>
          )}
          {open && r.spec.targetId === 'codex' && r.spec.externalCompletion ? (
            <CodexLogin conversationId={r.conversationId} action={action} requestId={r.id} />
          ) : open ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (busy) return;
                const form = e.currentTarget,
                  data = new FormData(form);
                const values = Object.fromEntries(
                  r.spec.fields.map((f) => [f.name, String(data.get(f.name) || '')]),
                );
                setBusy(true);
                await action(async () => {
                  await api(
                    `/human/${r.id}/${r.spec.kind === 'secret' ? 'secret' : 'answer'}`,
                    'POST',
                    { revision: r.revision, operationId: operationId(), values },
                  );
                  form.reset();
                });
                setBusy(false);
              }}
            >
              {r.spec.fields.map((f) => (
                <label key={f.name}>
                  {f.label}
                  {f.type === 'choice' || f.type === 'boolean' ? (
                    <select name={f.name} required={f.required} defaultValue="">
                      <option value="" disabled>
                        選択してください
                      </option>
                      {(f.type === 'boolean'
                        ? [
                            { value: 'true', label: 'はい' },
                            { value: 'false', label: 'いいえ' },
                          ]
                        : f.options
                      )?.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      name={f.name}
                      type={
                        f.type === 'secret'
                          ? 'password'
                          : ['number', 'integer'].includes(f.type)
                            ? 'number'
                            : 'text'
                      }
                      min={f.minimum}
                      max={f.maximum}
                      step={f.type === 'integer' ? 1 : 'any'}
                      minLength={f.minLength}
                      maxLength={f.maxLength}
                      required={f.required}
                      autoComplete={f.type === 'secret' ? 'off' : undefined}
                      spellCheck={f.type !== 'secret'}
                    />
                  )}
                </label>
              ))}
              {r.spec.kind === 'secret' && (
                <small className="muted">
                  端末の資格情報ストアへ保存します。モデルやチャットには渡しません。
                </small>
              )}
              <div className="form-actions">
                <button className="primary" disabled={busy || r.spec.externalCompletion}>
                  {busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{' '}
                  {r.spec.kind === 'action'
                    ? r.spec.externalCompletion
                      ? '認証完了を待っています'
                      : '操作を完了しました'
                    : r.spec.kind === 'secret'
                      ? '安全に保存'
                      : '回答する'}
                </button>
                <button type="button" className="text-button" onClick={() => setLater(true)}>
                  あとで
                </button>
                <button
                  type="button"
                  className="text-button danger"
                  onClick={() => void action(() => api(`/human/${r.id}/cancel`, 'POST', {}))}
                >
                  中止
                </button>
              </div>
            </form>
          ) : (
            <p className="request-result">
              {r.state === 'resolved'
                ? r.spec.kind === 'secret'
                  ? r.result?.verification === 'verified'
                    ? '保存して認証を確認しました。'
                    : '保存済み。認証の確認状況は上に表示します。'
                  : r.spec.kind === 'action'
                    ? r.result?.verification === 'verified'
                      ? '認証の完了を確認しました。'
                      : '完了の申告を受け付けました。接続成功はまだ確認していません。'
                    : '回答を届けました。'
                : stateLabel[r.state]}
            </p>
          )}
          {!open &&
            r.state === 'resolved' &&
            r.spec.kind === 'secret' &&
            r.result?.verification !== 'verified' && (
              <button onClick={() => void action(() => api(`/human/${r.id}/verify`, 'POST', {}))}>
                接続を再確認
              </button>
            )}
        </>
      )}
    </article>
  );
}
export function Chat({
  snapshot: s,
  status,
  action,
  onView,
  drafts,
}: {
  snapshot: Snapshot;
  status: Status;
  action: Action;
  onView: (view: View) => void;
  drafts: Map<string, ComposerDraft>;
}) {
  const [text, setText] = useState(drafts.get(s.conversation.id)?.text || ''),
    [images, setImages] = useState<ImagePart[]>(drafts.get(s.conversation.id)?.images || []),
    [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null),
    area = useRef<HTMLTextAreaElement>(null),
    attachment = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const messages = s.messages.filter(
    (m) => m.body.role !== 'tool' && m.body.role !== 'system' && !m.id.startsWith('event-'),
  );
  const activities = s.messages.filter(
    (m) => m.body.role === 'system' || m.id.startsWith('event-'),
  );
  const failure =
    s.conversation.state === 'error'
      ? [...s.messages].reverse().find((m) => m.body.role === 'system')?.body.content
      : undefined;
  const pending = s.requests.filter((r) => r.state === 'pending' || r.state === 'processing');
  useEffect(() => {
    drafts.set(s.conversation.id, { text, images });
  }, [text, images, drafts, s.conversation.id]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    else setShowLatest(true);
  }, [s.messages.length, s.draft, pending.length]);
  const retry = () => action(() => api(`/conversations/${s.conversation.id}/retry`, 'POST', {}));
  const send = async () => {
    if (busy || (!text.trim() && !images.length)) return;
    setBusy(true);
    await action(async () => {
      await api(`/conversations/${s.conversation.id}/messages`, 'POST', {
        text,
        images,
        operationId: operationId(),
      });
      setText('');
      setImages([]);
      drafts.delete(s.conversation.id);
      follow.current = true;
      if (!status.providerReady) onView('settings');
    });
    setBusy(false);
    area.current?.focus();
  };
  return (
    <main className="chat-layout">
      <div
        className="chat-scroll"
        ref={scroll}
        onScroll={() => {
          const node = scroll.current;
          if (!node) return;
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
          if (follow.current) setShowLatest(false);
        }}
      >
        {!messages.length ? (
          <div className="welcome">
            <div className="welcome-repo">
              <SquareTerminal size={22} />
              <span>{status.home.split('/').pop()}</span>
            </div>
            <h1>{status.providerReady ? '何をつくりますか？' : 'AIを接続して、作業を始める'}</h1>
            <p>
              {status.providerReady
                ? 'コードの調査から実装、動作確認まで。やりたいことを伝えてください。'
                : 'Codexのサブスクリプション、またはAPIキーで接続できます。'}
            </p>
            {!status.providerReady && (
              <button className="primary welcome-connect" onClick={() => onView('settings')}>
                AIを接続する <ArrowUpRight size={15} />
              </button>
            )}
            <div className="suggestions">
              {[
                [
                  'リポジトリを知る',
                  'このリポジトリの構成と、次に取り組むとよさそうなことを調べて。',
                  FileCode2,
                ],
                [
                  '開発環境を整える',
                  'このプロジェクトの実行方法を確認して、必要な環境を整えて。',
                  SquareTerminal,
                ],
              ].map(([label, prompt, Icon]) => {
                const Glyph = Icon as typeof FileCode2;
                return (
                  <button
                    key={String(label)}
                    onClick={() => {
                      setText(String(prompt));
                      area.current?.focus();
                    }}
                  >
                    <Glyph size={18} />
                    <span>{String(label)}</span>
                    <ArrowUpRight size={15} />
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="message-list">
            {messages.map((m) => (
              <article className={`message ${m.body.role}`} key={m.id}>
                <div className="message-meta">
                  <span className={`message-avatar ${m.body.role}`}>
                    {m.body.role === 'assistant' ? (
                      <SquareTerminal size={13} />
                    ) : m.body.role === 'system' ? (
                      'i'
                    ) : (
                      'Y'
                    )}
                  </span>
                  <strong>
                    {m.body.role === 'assistant'
                      ? 'Vibe Coders'
                      : m.body.role === 'system'
                        ? 'システム'
                        : m.body.content.startsWith('[Runtime event:')
                          ? '実行イベント'
                          : 'あなた'}
                  </strong>
                  <time>
                    {new Date(m.createdAt).toLocaleTimeString('ja', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                <div className="message-content">
                  <Markdown>{m.body.content}</Markdown>
                  {m.body.images?.map((image, index) => (
                    <img
                      className="message-image"
                      src={image.image_url.url}
                      key={index}
                      alt="添付画像"
                    />
                  ))}
                  {m.body.toolCalls?.map((call) => (
                    <ToolActivity key={call.id} call={call} snapshot={s} />
                  ))}
                </div>
              </article>
            ))}
            {s.draft && (
              <article className="message assistant">
                <div className="message-meta">
                  <span className="message-avatar assistant">
                    <SquareTerminal size={13} />
                  </span>
                  <strong>Vibe Coders</strong>
                  <LoaderCircle size={13} className="spin" />
                </div>
                <div className="message-content">
                  <Markdown>{s.draft}</Markdown>
                </div>
              </article>
            )}
          </div>
        )}
        {failure && messages.length > 0 && (
          <div className="chat-error" role="alert">
            <strong>作業が止まりました</strong>
            <p>{failure}</p>
            <div>
              <button onClick={() => (status.providerReady ? void retry() : onView('settings'))}>
                {status.providerReady ? 'もう一度試す' : 'AI接続を設定'}
              </button>
              <button className="text-button" onClick={() => onView('settings')}>
                設定を確認
              </button>
            </div>
          </div>
        )}
        {pending.length > 0 && (
          <div className="inline-requests">
            {pending.slice(0, 2).map((r) => (
              <RequestCard key={r.id} request={r} action={action} />
            ))}
            {pending.length > 2 && (
              <button className="text-button" onClick={() => onView('requests')}>
                残り {pending.length - 2} 件を見る
              </button>
            )}
          </div>
        )}
        <ActivityHistory messages={activities} />
        <div ref={end} />
      </div>
      <div className="composer-area">
        {showLatest && (
          <button
            className="latest-button"
            onClick={() => {
              follow.current = true;
              setShowLatest(false);
              end.current?.scrollIntoView({ block: 'end' });
            }}
          >
            <ArrowDown size={14} />
            最新へ
          </button>
        )}
        {!status.providerReady && messages.length > 0 && (
          <div className="wait-note">
            メッセージは保存済みです。AI接続後に作業を始めます。
            <button onClick={() => onView('settings')}>AIを接続</button>
          </div>
        )}
        {s.conversation.wait && (
          <div className="wait-note">
            <ClockIcon /> {s.conversation.wait.reason}
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {images.length > 0 && (
            <div className="attachment-preview">
              {images.map((image, i) => (
                <div key={i}>
                  <img src={image.image_url.url} alt={`添付 ${i + 1}`} />
                  <button
                    type="button"
                    aria-label="添付を削除"
                    onClick={() => setImages(images.filter((_, index) => index !== i))}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={area}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="やりたいことを伝えてください…"
            aria-label="エージェントへのメッセージ"
            rows={2}
            maxLength={64000}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-toolbar">
            <div>
              <button
                type="button"
                className="icon-button"
                aria-label="画像やテキストファイルを添付"
                onClick={() => attachment.current?.click()}
              >
                <Paperclip size={17} />
              </button>
              <button
                type="button"
                className="model-label"
                onClick={() => onView('settings')}
                title="AI接続を変更"
              >
                <i className={`live-dot ${status.providerReady ? '' : 'off'}`} />
                {status.config.provider?.model || 'モデル未設定'}
              </button>
            </div>
            <div>
              {['running', 'paused', 'error', 'waiting'].includes(s.conversation.state) && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={
                    s.conversation.paused || s.conversation.state === 'error'
                      ? '作業を再開'
                      : '作業を一時停止'
                  }
                  onClick={() =>
                    s.conversation.state === 'error'
                      ? void retry()
                      : void action(() =>
                          api(`/conversations/${s.conversation.id}/pause`, 'POST', {
                            paused: !s.conversation.paused,
                          }),
                        )
                  }
                >
                  {s.conversation.paused || s.conversation.state === 'error' ? (
                    <Play size={15} />
                  ) : (
                    <Pause size={15} />
                  )}
                </button>
              )}
              <button
                className="send-button"
                aria-label="メッセージを送信"
                disabled={busy || status.stopped || (!text.trim() && !images.length)}
              >
                {busy ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={18} />}
              </button>
            </div>
          </div>
        </form>
        <input
          ref={attachment}
          className="visually-hidden"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/*,.md,.json,.ts,.tsx,.py"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            void action(async () => {
              if (file.size > 3 * 1024 * 1024) throw new Error('添付は3 MiB以下にしてください。');
              if (file.type.startsWith('image/')) {
                if (images.length >= 4) throw new Error('画像は4枚まで添付できます。');
                const url = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result));
                  reader.onerror = reject;
                  reader.readAsDataURL(file);
                });
                setImages((current) => [...current, { type: 'image_url', image_url: { url } }]);
              } else if (
                file.type === 'application/pdf' ||
                file.name.toLowerCase().endsWith('.pdf')
              ) {
                const data = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result).split(',')[1]);
                  reader.onerror = reject;
                  reader.readAsDataURL(file);
                });
                const parsed = await api<{ text: string; note: string; truncated: boolean }>(
                  '/attachments/pdf',
                  'POST',
                  { data },
                );
                if (parsed.text.length + text.length > 60000)
                  throw new Error('テキスト添付が長すぎます。');
                setText(
                  (current) =>
                    `${current}\n\n[PDF: ${file.name}; ${parsed.note}${parsed.truncated ? '; 本文を省略' : ''}]\n${parsed.text}`,
                );
              } else {
                const content = await file.text();
                if (content.length + text.length > 60000)
                  throw new Error('テキスト添付が長すぎます。');
                setText((current) => `${current}\n\n[添付: ${file.name}]\n${content}`);
              }
            });
          }}
        />
        <div className="composer-footnote">
          <span>
            コードと実行結果を確認しながら進めましょう。
            <button onClick={() => onView('settings')}>
              接続を管理 <ArrowUpRight size={11} />
            </button>
          </span>
          <span>Enterで送信 · Shift + Enterで改行</span>
        </div>
      </div>
    </main>
  );
}
function ClockIcon() {
  return <span className="live-dot amber" />;
}
