import { Check, ChevronRight, Clock3, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { ToolCall } from '../shared/contracts';
import type { Snapshot } from './api';

const names: Record<string, string> = {
  file_read: 'ファイルを読む',
  file_write: 'ファイルを保存',
  file_list: 'ファイルを確認',
  file_replace: 'ファイルを編集',
  shell_exec: 'コマンドを実行',
  terminal_open: '端末を開く',
  terminal_write: '端末を操作',
  memory_write: '記憶を保存',
  memory_search: '記憶を検索',
  human_request: '入力を依頼',
  agent_wait: '入力や実行の完了を待つ',
  environment_inspect: '実行環境を確認',
  mcp_add: 'MCPを追加',
  mcp_connect: 'MCPに接続',
  run_read: '実行結果を確認',
  native_start: 'エージェントを起動',
};
function parse(text?: string): Record<string, any> {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
const bounded = (text: string) =>
  text.length > 12000 ? text.slice(0, 12000) + '\n…表示を省略しました' : text;
export function ToolActivity({ call, snapshot }: { call: ToolCall; snapshot: Snapshot }) {
  const result = snapshot.messages.find((message) => message.body.toolCallId === call.id);
  const output = parse(result?.body.content),
    args = parse(call.arguments);
  const run = snapshot.runs.find((run) => run.id === (output.runId || output.id));
  const request = snapshot.requests.find(
    (request) => request.id === (output.requestId || output.id),
  );
  const failed =
    !!output.error ||
    output.isError === true ||
    output.outcome === 'interrupted' ||
    run?.state === 'failed' ||
    run?.state === 'interrupted';
  const waiting = request?.state === 'pending' || request?.state === 'processing';
  const running = !result || run?.state === 'running' || run?.state === 'stopping';
  const cancelled = request?.state === 'cancelled' || request?.state === 'expired';
  const label = failed
    ? '失敗'
    : cancelled
      ? '中止'
      : waiting
        ? '入力待ち'
        : running
          ? '実行中'
          : '完了';
  const detail = args.path || args.command || args.name || '';
  const title = names[call.name] || (call.name.startsWith('mcp_') ? 'MCPツールを実行' : call.name);
  return (
    <details className={`tool-card ${failed ? 'tool-error' : ''}`}>
      <summary>
        <ChevronRight size={13} />
        {failed ? (
          <TriangleAlert size={14} />
        ) : waiting ? (
          <Clock3 size={14} />
        ) : running ? (
          <LoaderCircle size={14} className="spin" />
        ) : (
          <Check size={14} />
        )}
        <strong>{title}</strong>
        {detail && <code title={String(detail)}>{String(detail).slice(0, 90)}</code>}
        <span>{label}</span>
      </summary>
      <div className="tool-details">
        <small>{call.name}</small>
        <pre>{bounded(call.arguments)}</pre>
        {result && <pre>{bounded(result.body.content)}</pre>}
      </div>
    </details>
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
        接続と実行の履歴<span>{messages.length}</span>
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
