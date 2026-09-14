import { useEffect, useRef, useState } from 'react';
import {
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
}: {
  snapshot: Snapshot;
  status: Status;
  action: Action;
  onView: (view: View) => void;
}) {
  const [text, setText] = useState(''),
    [images, setImages] = useState<ImagePart[]>([]),
    [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null),
    area = useRef<HTMLTextAreaElement>(null),
    attachment = useRef<HTMLInputElement>(null);
  const messages = s.messages.filter((m) => m.body.role !== 'tool');
  const pending = s.requests.filter((r) => r.state === 'pending' || r.state === 'processing');
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [s.messages.length]);
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
    });
    setBusy(false);
    area.current?.focus();
  };
  return (
    <main className="chat-layout">
      <div className="chat-scroll">
        {!messages.length ? (
          <div className="welcome">
            <div className="welcome-mark">
              <span />
              <span />
              <span />
              <span />
            </div>
            <div className="eyebrow">YOUR REPOSITORY. YOUR AGENT.</div>
            <h1>今日、何を進めますか。</h1>
            <p>
              調べる、つくる、確かめる。
              <br />
              このリポジトリから、作業を一緒に進めましょう。
            </p>
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
            {!status.providerReady && (
              <button className="setup-nudge" onClick={() => onView('settings')}>
                <i className="live-dot amber" /> 最初にモデル接続を設定する{' '}
                <ArrowUpRight size={14} />
              </button>
            )}
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
                  {m.body.toolCalls?.map((call) => {
                    const result = s.messages.find(
                      (message) => message.body.toolCallId === call.id,
                    );
                    return (
                      <details className="tool-card" key={call.id}>
                        <summary>
                          <ChevronRight size={13} />
                          {result ? (
                            <Check size={13} />
                          ) : (
                            <LoaderCircle size={13} className="spin" />
                          )}
                          <code>{call.name}</code>
                          <span>{result ? '結果を表示' : '実行中'}</span>
                        </summary>
                        <pre>{call.arguments}</pre>
                        {result && <pre>{result.body.content}</pre>}
                      </details>
                    );
                  })}
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
        <div ref={end} />
      </div>
      <div className="composer-area">
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
              <span className="model-label">
                <i className={`live-dot ${status.providerReady ? '' : 'off'}`} />
                {status.config.provider?.model || 'モデル未設定'}
              </span>
              <span className="home-pill">Home</span>
            </div>
            <div>
              {['running', 'paused', 'error', 'waiting'].includes(s.conversation.state) && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={
                    s.conversation.paused || s.conversation.state === 'error'
                      ? '親を再開'
                      : '親を一時停止'
                  }
                  onClick={() =>
                    void action(() =>
                      api(`/conversations/${s.conversation.id}/pause`, 'POST', {
                        paused: !(s.conversation.paused || s.conversation.state === 'error'),
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
                disabled={busy || (!text.trim() && !images.length)}
              >
                <ArrowUp size={18} />
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
            この端末で作業します。
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
