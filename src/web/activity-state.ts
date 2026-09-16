import type { ToolCall } from '../shared/contracts';
import type { Snapshot, Status } from './api';

export type WorkSurface = 'terminal' | 'desktop';
/** Infer a surface from actual operations, never just from installed capabilities. */
export function executionSurface(
  snapshot: Snapshot,
  connections: Status['config']['mcp'] = [],
): WorkSurface | null {
  const lastUser = [...snapshot.messages].reverse().find((m) => m.body.role === 'user');
  const turn = lastUser ? snapshot.messages.indexOf(lastUser) : 0;
  const calls = snapshot.messages.slice(Math.max(0, turn)).flatMap((m) => m.body.toolCalls || []);
  for (const call of [...calls].reverse()) {
    if (
      /^desktop_(launch|screenshot|input|handoff)$/.test(call.name) ||
      connections.some(
        (m) => m.targetId?.startsWith('desktop:') && call.name.startsWith(`mcp_${m.name}_`),
      )
    )
      return 'desktop';
    if (call.name === 'terminal_open' || call.name === 'shell_exec') return 'terminal';
    if (/^(run_|terminal_)/.test(call.name)) {
      const args = parse(call.arguments);
      if (snapshot.runs.some((r) => r.id === args.id && ['shell', 'terminal'].includes(r.kind)))
        return 'terminal';
    }
  }
  return snapshot.runs.some(
    (r) =>
      r.owner === 'agent' &&
      ['shell', 'terminal'].includes(r.kind) &&
      ['running', 'stopping'].includes(r.state),
  )
    ? 'terminal'
    : null;
}

const names: Record<string, string> = {
  file_read: 'ファイルを読む',
  file_write: 'ファイルを保存',
  file_replace: 'ファイルを編集',
  file_list: 'ファイルを確認',
  file_glob: 'ファイルを探す',
  shell_exec: 'コマンドを実行',
  run_write: '端末に入力',
  run_read: '実行結果を確認',
  run_list: '実行を確認',
  run_wait: '実行を待つ',
  run_stop: '実行を停止',
  run_end_input: '入力を終了',
  run_handoff: '手動操作に切り替える',
  terminal_open: '端末を開く',
  terminal_screen: '端末の画面を確認',
  terminal_resize: '端末の表示を調整',
  memory_write: '記憶を保存',
  memory_search: '記憶を検索',
  memory_inspect: '記憶を読む',
  memory_revise: '記憶を更新',
  human_request: '入力を依頼',
  human_cancel: '入力依頼を取り消す',
  agent_wait: '完了を待つ',
  environment_inspect: '実行環境を確認',
  connections_list: '接続を確認',
  mcp_add: 'ツールを追加',
  mcp_connect: 'ツールに接続',
  codex_status: 'Codexの接続を確認',
  codex_login: 'Codexの認証を依頼',
  schedule_list: '予定を確認',
  schedule_create: '予定を作成',
  schedule_delete: '予定を削除',
  web_search: 'Webを検索',
  web_fetch: 'ページを読む',
  desktop_screenshot: '画面を確認',
  desktop_click: '画面をクリック',
  desktop_type: '画面に入力',
};
function parse(text?: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
export type ActivityState =
  'running' | 'queued' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export type Activity = {
  call: ToolCall;
  title: string;
  detail: string;
  state: ActivityState;
  result?: string;
};
export const activityLabels: Record<ActivityState, string> = {
  running: '実行中',
  queued: '順番待ち',
  waiting: '入力待ち',
  completed: '完了',
  failed: '失敗',
  interrupted: '中断',
  cancelled: '取消',
};
export function collectActivities(snapshot: Snapshot): Map<string, Activity> {
  const results = new Map(
    snapshot.messages
      .filter((m) => m.body.role === 'tool')
      .map((m) => [m.body.toolCallId, m.body.content]),
  );
  const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  const requests = new Map(snapshot.requests.map((request) => [request.id, request]));
  const activities = new Map<string, Activity>();
  const currentBatch = [...snapshot.messages].reverse().find((m) => m.body.toolCalls?.length)?.id;
  let hasForeground = false;
  for (const message of snapshot.messages)
    for (const call of message.body.toolCalls || []) {
      const result = results.get(call.id),
        output = parse(result),
        args = parse(call.arguments);
      // Only a tool that starts a process follows that process's lifetime.
      // Reading its output is complete as soon as the read returns.
      const startsRun =
        call.name === 'shell_exec' || call.name === 'terminal_open' || call.name.startsWith('mcp_');
      const run = startsRun ? runs.get(String(output.runId || output.id || '')) : undefined;
      const request = requests.get(String(output.requestId || output.id || ''));
      let state: ActivityState;
      if (output.outcome === 'interrupted' || run?.state === 'interrupted') state = 'interrupted';
      else if (output.error || output.isError === true || run?.state === 'failed') state = 'failed';
      else if (request?.state === 'cancelled' || request?.state === 'expired') state = 'cancelled';
      else if (request?.state === 'pending' || request?.state === 'processing') state = 'waiting';
      else if (run?.state === 'running' || run?.state === 'stopping') state = 'running';
      else if (result === undefined) {
        if (
          message.id !== currentBatch ||
          snapshot.stopped ||
          snapshot.conversation.paused ||
          snapshot.conversation.state !== 'running'
        )
          state = 'interrupted';
        else {
          state = hasForeground ? 'queued' : 'running';
          hasForeground = true;
        }
      } else state = 'completed';
      const detail = [args.path, args.command, args.query, args.name, args.pattern].find(
        (value) => typeof value === 'string',
      );
      activities.set(call.id, {
        call,
        title:
          names[call.name] || (call.name.startsWith('mcp_') ? '外部ツールを実行' : 'ツールを実行'),
        detail: typeof detail === 'string' ? detail : '',
        state,
        result,
      });
    }
  return activities;
}
export type Progress = {
  kind: 'running' | 'waiting' | 'paused' | 'error' | 'background' | 'setup';
  title: string;
  detail?: string;
};
export function executionProgress(
  snapshot: Snapshot,
  providerReady: boolean,
  activities: Map<string, Activity>,
): Progress | null {
  const c = snapshot.conversation;
  const background = snapshot.runs.filter(
    (run) =>
      run.owner === 'agent' &&
      ['shell', 'terminal'].includes(run.kind) &&
      ['running', 'stopping'].includes(run.state),
  );
  if (snapshot.stopped) return null;
  if (c.state === 'error') return { kind: 'error', title: '処理が止まりました' };
  if (c.paused || c.state === 'paused')
    return {
      kind: 'paused',
      title: 'AIは一時停止中',
      detail: background.length ? `シェル${background.length}件は引き続き動いています` : undefined,
    };
  if (c.state === 'running') {
    const current = [...activities.values()].find(
      (activity) => activity.state === 'running' && activity.result === undefined,
    );
    const name = current?.call.name || '';
    return current
      ? {
          kind: 'running',
          title: /^(shell_|terminal_|run_)/.test(name)
            ? 'シェルで作業中'
            : /^desktop_/.test(name)
              ? '画面を操作中'
              : /^file_/.test(name)
                ? 'ファイルを確認・編集しています'
                : /^mcp_/.test(name)
                  ? '接続したツールで作業中'
                  : current.title,
        }
      : { kind: 'running', title: snapshot.draft ? '回答を作成しています' : '考えています' };
  }
  const pending = snapshot.requests.filter(
    (request) => request.state === 'pending' || request.state === 'processing',
  );
  if (pending.length)
    return { kind: 'waiting', title: '入力を待っています', detail: pending[0].spec.title };
  if (c.state === 'waiting')
    return {
      kind: 'waiting',
      title: c.wait?.wakeOn.some((w) => w.type === 'run.completed')
        ? '実行の完了を待っています'
        : '次の入力を待っています',
      detail: c.wait?.reason,
    };
  if (background.length) return { kind: 'background', title: 'シェルは引き続き動いています' };
  if (!providerReady && snapshot.messages.some((m) => m.body.role === 'user'))
    return { kind: 'setup', title: 'モデルの接続を確認してください' };
  return null;
}

export function executionDesktop(
  snapshot: Snapshot,
  connections: { name: string; targetId?: string }[],
) {
  for (const message of [...snapshot.messages].reverse()) {
    if (message.body.role === 'user') break;
    for (const call of [...(message.body.toolCalls || [])].reverse()) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments);
      } catch {}
      if (typeof args.desktopId === 'string') return args.desktopId;
      if (typeof args.id === 'string') {
        const run = snapshot.runs.find((r) => r.id === args.id);
        if (run) return run.desktopId || undefined;
      }
      if (call.name.startsWith('desktop_')) return 'default';
      const connection = connections.find((c) => call.name.startsWith(`mcp_${c.name}_`));
      if (connection?.targetId?.startsWith('desktop:')) return connection.targetId.slice(8);
    }
  }
}
