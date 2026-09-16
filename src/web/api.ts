import type { Store } from '../server/store';
import type { Config } from '../server/config';
import type { Desktop } from '../server/desktop';
import type { McpService } from '../server/mcp';
import type { CodexAuth } from '../server/codex-auth';
export type Snapshot = ReturnType<Store['snapshot']> & { draft: string };
export type Status = {
  home: string;
  conversations: ReturnType<Store['listConversations']>;
  config: ReturnType<Config['public']>;
  mcp: ReturnType<McpService['status']>;
  desktops: ReturnType<Desktop['list']>;
  stopped: boolean;
  providerReady: boolean;
  providerKeySaved: boolean;
  codex: ReturnType<CodexAuth['status']>;
};
let authorization = '';
export function operationId() {
  // randomUUID is unavailable on HTTP LAN origins. getRandomValues remains
  // available there and supplies the same cryptographic randomness for UUID v4.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function setLogin(username: string, password: string) {
  authorization = `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${username}:${password}`)))}`;
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T = unknown>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      ...(method !== 'GET' ? { 'X-Vibe-Coder': '1', 'Content-Type': 'application/json' } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const body = await response.json();
  if (!response.ok) throw new ApiError(body.error || '操作に失敗しました。', response.status);
  return body as T;
}
export async function listen(
  signal: AbortSignal,
  onChange: () => void,
  onConnection: (connected: boolean) => void = () => {},
) {
  while (!signal.aborted) {
    const connection = new AbortController();
    const offline = () => {
      onConnection(false);
      connection.abort();
    };
    window.addEventListener('offline', offline);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => connection.abort(), 25000);
    };
    try {
      heartbeat();
      const response = await fetch('/api/events', {
        signal: AbortSignal.any([signal, connection.signal]),
        credentials: 'same-origin',
        headers: authorization ? { Authorization: authorization } : {},
      });
      if (!response.ok || !response.body) throw new Error('Event connection failed.');
      onConnection(true);
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = '';
      while (!signal.aborted) {
        const part = await reader.read();
        if (part.done) break;
        heartbeat();
        buffer += decoder.decode(part.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (event.includes('event: change')) onChange();
        }
      }
    } catch {
      if (signal.aborted) break;
    } finally {
      clearTimeout(watchdog);
      window.removeEventListener('offline', offline);
      connection.abort();
    }
    if (signal.aborted) break;
    onConnection(false);
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, 2000);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}

export const time = (date: number | null) =>
  date
    ? new Intl.DateTimeFormat('ja', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
    : '—';
export const stateLabel: Record<string, string> = {
  idle: '待機中',
  running: '実行中',
  waiting: '条件を待機中',
  paused: '一時停止',
  error: 'エラー',
  pending: '未回答',
  processing: '保存中',
  resolved: '回答済み',
  cancelled: '取り消し済み',
  expired: '期限切れ',
  completed: '終了',
  failed: '失敗',
  interrupted: '中断',
  stopping: '停止を要求済み',
  connected: '接続済み',
  disconnected: '未接続',
  connecting: '接続中',
  awaiting_auth: '認証待ち',
};
