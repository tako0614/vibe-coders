import { useComposerDraft } from './drafts';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  Inbox,
  LoaderCircle,
  LockKeyhole,
  Paperclip,
  Square,
  SquareTerminal,
  Monitor,
  X,
} from 'lucide-react';
import Markdown from 'react-markdown';
import { api, operationId, stateLabel, time, type Snapshot, type Status } from './api';
import type { Action, View } from './App';
import type { HumanRequest } from '../server/db/schema';
import { CodexLogin } from './CodexLogin';
import type { ImagePart, ToolCall } from '../shared/contracts';
import { ActivityHistory, ToolActivityGroup, ExecutionStatus } from './Activity';
import { collectActivities, type WorkSurface } from './activity-state';
import { ChatModelPicker } from './ChatModelPicker';

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
                  r.spec.fields.map((f) => [
                    f.name,
                    f.type === 'multiChoice'
                      ? JSON.stringify(data.getAll(f.name))
                      : String(data.get(f.name) || ''),
                  ]),
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
                  {f.type === 'multiChoice' ? (
                    <select
                      name={f.name}
                      multiple
                      required={f.required && (f.minItems ?? 0) > 0}
                      defaultValue={Array.isArray(f.default) ? f.default : []}
                      aria-label={f.label}
                    >
                      {f.options?.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : f.type === 'choice' || f.type === 'boolean' ? (
                    <select
                      name={f.name}
                      required={f.required}
                      defaultValue={String(f.default ?? '')}
                    >
                      <option value="" disabled={f.required}>
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
                      defaultValue={f.type === 'secret' ? undefined : String(f.default ?? '')}
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
                  {f.description && <small className="muted">{f.description}</small>}
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
  onWorkspace,
  surface,
}: {
  snapshot: Snapshot;
  status: Status;
  action: Action;
  onView: (view: View) => void;
  drafts: Map<string, ComposerDraft>;
  onWorkspace: (surface: WorkSurface) => void;
  surface: WorkSurface | null;
}) {
  const persisted = useComposerDraft(
    `${status.config.username}:${status.home}:${s.conversation.id}`,
    s.conversation.id,
    drafts,
  );
  const { text, images } = persisted.draft;
  const setText = (value: string | ((text: string) => string)) =>
    persisted.update((current) => ({
      ...current,
      text: typeof value === 'function' ? value(current.text) : value,
    }));
  const setImages = (value: ImagePart[] | ((images: ImagePart[]) => ImagePart[])) =>
    persisted.update((current) => ({
      ...current,
      images: typeof value === 'function' ? value(current.images) : value,
    }));
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const end = useRef<HTMLDivElement>(null),
    area = useRef<HTMLTextAreaElement>(null),
    attachment = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  useEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(240, node.scrollHeight)}px`;
  }, [text]);
  const messages = s.messages.filter(
    (m) => m.body.role !== 'tool' && m.body.role !== 'system' && !m.id.startsWith('event-'),
  );
  const activities = s.messages.filter(
    (m) => m.body.role === 'system' || m.id.startsWith('event-'),
  );
  const toolActivities = collectActivities(s);
  const entries: (
    | { kind: 'message'; message: Snapshot['messages'][number] }
    | { kind: 'tools'; calls: ToolCall[] }
  )[] = [];
  for (const message of messages) {
    if (message.body.content || message.body.images?.length || message.body.role === 'user')
      entries.push({ kind: 'message', message });
    if (message.body.toolCalls?.length) {
      const previous = entries.at(-1);
      if (previous?.kind === 'tools') previous.calls.push(...message.body.toolCalls);
      else entries.push({ kind: 'tools', calls: [...message.body.toolCalls] });
    }
  }
  const pending = s.requests.filter((r) => r.state === 'pending' || r.state === 'processing');
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    else setShowLatest(true);
  }, [s.messages.length, s.draft, pending.length]);
  const send = async () => {
    if (busy || status.stopped || (!text.trim() && !images.length)) return;
    setBusy(true);
    await action(async () => {
      await api(`/conversations/${s.conversation.id}/messages`, 'POST', {
        text,
        images,
        operationId: operationId(),
      });
      await persisted.clear();
      follow.current = true;
    });
    setBusy(false);
    area.current?.focus();
  };
  return (
    <main className={`chat-layout ${messages.length ? '' : 'chat-empty'}`}>
      {s.context && (
        <div className="draft-notice">
          以前の会話を要約して継続しています。元の履歴は保存されています。
        </div>
      )}
      {persisted.error && (
        <div className="draft-notice" role="status">
          {persisted.error}
        </div>
      )}
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
            <h1>何から始めますか？</h1>
            {!status.providerReady &&
              !status.codex?.subscriptionReady &&
              !status.config.provider && (
                <button className="welcome-connect" onClick={() => onView('settings')}>
                  CodexまたはAPIを接続する <ArrowUpRight size={14} />
                </button>
              )}
          </div>
        ) : (
          <div className="message-list">
            {entries.map((entry) => {
              if (entry.kind === 'tools')
                return (
                  <ToolActivityGroup
                    key={entry.calls[0].id}
                    calls={entry.calls}
                    activities={toolActivities}
                  />
                );
              const m = entry.message;
              return (
                <article
                  className={`message ${m.body.role}`}
                  key={m.id}
                  aria-label={
                    m.body.role === 'assistant'
                      ? '回答'
                      : m.body.role === 'system'
                        ? 'システム'
                        : 'あなたのメッセージ'
                  }
                >
                  {m.body.role === 'system' && <div className="message-system-label">システム</div>}
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
                  </div>
                  {m.body.role === 'assistant' && m.body.content && (
                    <div className="message-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="回答をコピー"
                        title={copied === m.id ? 'コピーしました' : '回答をコピー'}
                        onClick={() =>
                          void action(async () => {
                            if (navigator.clipboard?.writeText)
                              await navigator.clipboard.writeText(m.body.content);
                            else {
                              const field = document.createElement('textarea');
                              field.value = m.body.content;
                              field.style.position = 'fixed';
                              field.style.opacity = '0';
                              document.body.append(field);
                              field.select();
                              const ok = document.execCommand('copy');
                              field.remove();
                              if (!ok)
                                throw new Error(
                                  'コピーできませんでした。テキストを選択してコピーしてください。',
                                );
                            }
                            setCopied(m.id);
                            clearTimeout(copyTimer.current);
                            copyTimer.current = setTimeout(() => setCopied(''), 2000);
                          })
                        }
                      >
                        {copied === m.id ? <Check size={15} /> : <Copy size={15} />}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
            {s.draft && (
              <article className="message assistant" aria-label="回答を作成中" aria-busy="true">
                <div className="message-content">
                  <Markdown>{s.draft}</Markdown>
                </div>
              </article>
            )}
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
        {messages.length > 0 && (
          <div className="work-surfaces" aria-label="作業環境">
            <button aria-expanded={surface === 'terminal'} onClick={() => onWorkspace('terminal')}>
              <SquareTerminal size={15} />
              シェル
              <span>
                {s.runs.filter(
                  (r) => ['terminal', 'shell'].includes(r.kind) && r.state === 'running',
                ).length || ''}
              </span>
            </button>
            <button aria-expanded={surface === 'desktop'} onClick={() => onWorkspace('desktop')}>
              <Monitor size={15} />
              画面
            </button>
          </div>
        )}
        <ExecutionStatus
          snapshot={s}
          providerReady={status.providerReady}
          activities={toolActivities}
          action={action}
          onView={onView}
        />
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
            placeholder="メッセージを入力…"
            aria-label="エージェントへのメッセージ"
            rows={1}
            maxLength={64000}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
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
              <ChatModelPicker
                status={status}
                action={action}
                onSettings={() => onView('settings')}
              />
            </div>
            <div>
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
        {!messages.length && (
          <div className="suggestions" aria-label="会話のヒント">
            {[
              ['コードを調べる', 'このリポジトリの構成と、次に取り組むとよさそうなことを調べて。'],
              ['開発環境を整える', 'このプロジェクトの実行方法を確認して、必要な環境を整えて。'],
              ['変更をレビュー', '現在の変更を確認して、不具合や改善すべき点をレビューして。'],
            ].map(([label, prompt]) => (
              <button
                key={label}
                onClick={() => {
                  setText(prompt);
                  area.current?.focus();
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="composer-footnote">
          {s.conversation.state === 'running'
            ? '実行中も追加の指示を送れます'
            : 'Enterで送信 · Shift + Enterで改行'}
        </div>
      </div>
    </main>
  );
}
function ClockIcon() {
  return <span className="live-dot amber" />;
}
