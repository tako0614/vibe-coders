import type { ModelAdapter, ModelInput } from './model';

export class ModelFailure extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(code);
  }
}
export function modelFailure(error: unknown): ModelFailure {
  if (error instanceof ModelFailure) return error;
  const value = error as
    { status?: number; code?: string; name?: string; message?: string } | undefined;
  const status = typeof value?.status === 'number' ? value.status : undefined;
  if (status === 401 || status === 403) return new ModelFailure('MODEL_AUTH_REJECTED', status);
  if (status === 402) return new ModelFailure('MODEL_CREDIT_REQUIRED', status);
  if (status === 429) return new ModelFailure('MODEL_RATE_LIMIT', status, true);
  if (status === 408 || status === 409 || status === 425 || (status && status >= 500))
    return new ModelFailure('MODEL_TEMPORARILY_UNAVAILABLE', status, true);
  if (status) return new ModelFailure('MODEL_REQUEST_REJECTED', status);
  if (value?.message === 'MODEL_RESPONSE_INCOMPLETE')
    return new ModelFailure('MODEL_RESPONSE_INCOMPLETE', undefined, true);
  if (
    ['APIConnectionError', 'APIConnectionTimeoutError', 'TimeoutError'].includes(
      value?.name || '',
    ) ||
    ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(value?.code || '')
  )
    return new ModelFailure('MODEL_CONNECTION_INTERRUPTED', undefined, true);
  return new ModelFailure('MODEL_UNKNOWN_ERROR');
}
export const failureMessage = (error: ModelFailure) =>
  (({
    MODEL_AUTH_REJECTED:
      '接続先が認証を受け付けませんでした。保存済みの認証情報を確認してください。',
    MODEL_CREDIT_REQUIRED: '接続先の残高・利用枠が不足しています。',
    MODEL_RATE_LIMIT:
      '接続先の混雑・呼び出し制限が続いています。作業を保持して停止しました。少し待って再開できます。',
    MODEL_TEMPORARILY_UNAVAILABLE:
      '接続先が一時的に応答できません。再接続を試しましたが復旧しませんでした。作業を保持しているので再開できます。',
    MODEL_REQUEST_REJECTED:
      '接続先がリクエストを拒否しました。モデルのツール・画像・effort対応を確認してください。',
    MODEL_RESPONSE_INCOMPLETE:
      '応答の受信が途中で中断しました。未完成のツール呼び出しは実行していません。再開できます。',
    MODEL_CONNECTION_INTERRUPTED:
      '通信の切断・タイムアウトが続いています。会話と実行中のシェルは保持されています。再開できます。',
    MODEL_UNKNOWN_ERROR: 'モデルの処理を完了できませんでした。会話を保持しています。再開できます。',
  })[error.code] || 'モデルの処理を完了できませんでした。') +
  (error.status ? `（HTTP ${error.status}）` : '');

/** Inference may repeat, but tool execution starts only after a complete response. */
export class ReliableModel implements ModelAdapter {
  constructor(
    readonly inner: ModelAdapter,
    readonly delayMs = 1000,
    readonly idleTimeoutMs = 300000,
  ) {}
  isConfigured() {
    return this.inner.isConfigured?.() ?? true;
  }
  async call(input: ModelInput) {
    for (let attempt = 0; ; attempt++) {
      input.signal.throwIfAborted();
      const idle = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const progress = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => idle.abort(new ModelFailure('MODEL_CONNECTION_INTERRUPTED', undefined, true)),
          this.idleTimeoutMs,
        );
        input.onProgress?.();
      };
      progress();
      let caught: unknown;
      try {
        return await this.inner.call({
          ...input,
          signal: AbortSignal.any([input.signal, idle.signal]),
          onProgress: progress,
          onText: (text) => {
            progress();
            input.onText?.(text);
          },
        });
      } catch (error) {
        caught = idle.signal.aborted ? idle.signal.reason : error;
      } finally {
        clearTimeout(timer!);
      }
      {
        input.signal.throwIfAborted();
        const failure = modelFailure(caught);
        if (!failure.retryable || attempt >= 2) throw caught;
        input.onRetry?.(attempt + 1, failure.code);
        input.signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(input.signal.reason);
          };
          const timer = setTimeout(
            () => {
              input.signal.removeEventListener('abort', abort);
              resolve();
            },
            this.delayMs * (attempt + 1),
          );
          input.signal.addEventListener('abort', abort, { once: true });
        });
      }
    }
  }
}
