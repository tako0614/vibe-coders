import { ChevronRight, Clock3, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { ToolCall } from '../shared/contracts';
import type { Snapshot } from './api';

import type { Action, View } from './App';
import { api } from './api';
import { useState } from 'react';
import { activityLabels, executionProgress, type Activity } from './activity-state';

function parse(text?: string): Record<string, any> {
  try {
    return JSON.parse(text || '{}') || {};
  } catch {
    return {};
  }
}
const bounded = (text: string) =>
  text.length > 12000 ? text.slice(0, 12000) + '\n…表示を省略しました' : text;

function ToolActivity({ activity }: { activity: Activity }) {
  return (
    <details className={`tool-card ${activity.state === 'failed' ? 'tool-error' : ''}`}>
      <summary>
        <ChevronRight size={13} />
        <strong>{activity.title}</strong>
        {activity.detail && <code title={activity.detail}>{activity.detail.slice(0, 90)}</code>}
        <span>{activityLabels[activity.state]}</span>
      </summary>
      <div className="tool-details">
        <small>{activity.call.name}</small>
        <pre>{bounded(activity.call.arguments)}</pre>
        {activity.result && <pre>{bounded(activity.result)}</pre>}
      </div>
    </details>
  );
}
export function ToolActivityGroup({
  calls,
  activities,
}: {
  calls: ToolCall[];
  activities: Map<string, Activity>;
}) {
  const items = calls
    .map((call) => activities.get(call.id))
    .filter((item): item is Activity => !!item);
  const running = items.find((item) => item.state === 'running');
  const waiting = items.some((item) => item.state === 'waiting');
  const failed = items.some((item) => item.state === 'failed');
  const interrupted = items.some(
    (item) => item.state === 'interrupted' || item.state === 'cancelled',
  );
  const queued = items.some((item) => item.state === 'queued');
  const title = failed
    ? '一部の操作に失敗しました'
    : interrupted
      ? '中断した操作があります'
      : running || waiting || queued
        ? `${items.length}件の操作`
        : `${items.length}件の操作を完了`;
  return (
    <details className={`activity-group ${failed ? 'has-error' : ''}`}>
      <summary>
        <ChevronRight size={13} />
        <span>{title}</span>
      </summary>
      <div>
        {items.map((activity) => (
          <ToolActivity key={activity.call.id} activity={activity} />
        ))}
      </div>
    </details>
  );
}
export function ExecutionStatus({
  snapshot,
  providerReady,
  activities,
  action,
  onView,
}: {
  snapshot: Snapshot;
  providerReady: boolean;
  activities: Map<string, Activity>;
  action: Action;
  onView: (view: View) => void;
}) {
  const [busy, setBusy] = useState(false);
  const progress = executionProgress(snapshot, providerReady, activities);
  if (!progress) return null;
  const error =
    progress.kind === 'error'
      ? [...snapshot.messages].reverse().find((m) => m.body.role === 'system')?.body.content
      : undefined;
  const perform = (work: () => Promise<unknown>) => {
    setBusy(true);
    void action(work).finally(() => setBusy(false));
  };
  return (
    <div
      className={`execution-status ${progress.kind === 'setup' ? 'wait-note' : ''}`}
      data-state={progress.kind}
    >
      <div className="execution-line">
        <span className="execution-indicator" aria-hidden="true">
          {progress.kind === 'running' || progress.kind === 'background' ? (
            <LoaderCircle size={14} className="spin" />
          ) : progress.kind === 'error' ? (
            <TriangleAlert size={14} />
          ) : (
            <Clock3 size={14} />
          )}
        </span>
        <div className="execution-description" role="status" aria-live="polite">
          <strong>{progress.title}</strong>
          {progress.detail && <span title={progress.detail}>{progress.detail}</span>}
        </div>
        {(progress.kind === 'running' || progress.kind === 'waiting') && (
          <button
            disabled={busy}
            title="AIの作業を一時停止します。起動済みのコマンドは継続します。"
            onClick={() =>
              perform(() =>
                api(`/conversations/${snapshot.conversation.id}/pause`, 'POST', { paused: true }),
              )
            }
          >
            一時停止
          </button>
        )}
        {progress.kind === 'paused' && (
          <button
            disabled={busy}
            onClick={() =>
              perform(() =>
                api(`/conversations/${snapshot.conversation.id}/pause`, 'POST', { paused: false }),
              )
            }
          >
            再開
          </button>
        )}
        {progress.kind === 'error' && (
          <button
            disabled={busy}
            onClick={() =>
              providerReady
                ? perform(() => api(`/conversations/${snapshot.conversation.id}/retry`, 'POST', {}))
                : onView('settings')
            }
          >
            {providerReady ? '再試行' : '接続設定'}
          </button>
        )}
        {progress.kind === 'background' && (
          <button onClick={() => onView('terminal')}>ターミナルへ</button>
        )}
        {progress.kind === 'waiting' && snapshot.requests.some((r) => r.state === 'pending') && (
          <button onClick={() => onView('requests')}>回答する</button>
        )}
        {progress.kind === 'setup' && <button onClick={() => onView('settings')}>接続設定</button>}
      </div>
      {error && (
        <details className="execution-error">
          <summary>エラーの詳細</summary>
          <pre>{bounded(error)}</pre>
        </details>
      )}
    </div>
  );
}

export function ActivityHistory({ messages }: { messages: Snapshot['messages'] }) {
  if (!messages.length) return null;
  const summarize = (text: string) => {
    if (!text.startsWith('[Runtime event:')) return text;
    const type = text.slice(16, text.indexOf(']'));
    const value = parse(text.slice(text.indexOf('\n') + 1));
    if (type === 'human.resolved')
      return value.outcome === 'cancelled'
        ? '入力依頼を取り消しました'
        : '入力への回答を受け取りました';
    if (type === 'run.completed')
      return value.exitCode === 0 ? '実行が完了しました' : '実行が終了しました';
    if (type === 'schedule.fired') return '予定を実行しました';
    return '実行状態を更新しました';
  };
  return (
    <details className="activity-history">
      <summary>
        <Clock3 size={14} />
        実行ログ<span>{messages.length}</span>
      </summary>
      <div>
        {messages.map((message) => (
          <details className="activity-row" key={message.id}>
            <summary>
              <time>
                {new Date(message.createdAt).toLocaleTimeString('ja', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
              {summarize(message.body.content)}
            </summary>
            <pre>{bounded(message.body.content)}</pre>
          </details>
        ))}
      </div>
    </details>
  );
}
