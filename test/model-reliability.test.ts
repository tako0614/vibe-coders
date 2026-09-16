import { expect, spyOn, test } from 'bun:test';
import { ReliableModel, modelFailure } from '../src/server/model-errors';
import { Vault } from '../src/server/config';
import { calls, eventually, fixture } from './helpers';
import type { ModelInput } from '../src/server/model';

const input = (): ModelInput => ({
  system: '',
  messages: [],
  tools: [],
  signal: new AbortController().signal,
});

test('transient inference retries are bounded, auth is not retried, and cancellation stops backoff', async () => {
  let attempts = 0;
  const model = new ReliableModel(
    {
      async call() {
        attempts++;
        throw { status: 503 };
      },
    },
    1,
  );
  await expect(model.call(input())).rejects.toMatchObject({ status: 503 });
  expect(attempts).toBe(3);
  attempts = 0;
  const denied = new ReliableModel(
    {
      async call() {
        attempts++;
        throw { status: 401 };
      },
    },
    1,
  );
  await expect(denied.call(input())).rejects.toMatchObject({ status: 401 });
  expect(attempts).toBe(1);
  const controller = new AbortController();
  attempts = 0;
  const retrying = new ReliableModel(
    {
      async call() {
        attempts++;
        throw { code: 'ECONNRESET' };
      },
    },
    10000,
  );
  const pending = retrying.call({
    ...input(),
    signal: controller.signal,
    onRetry() {
      queueMicrotask(() => controller.abort(new Error('cancelled')));
    },
  });
  await expect(pending).rejects.toThrow('cancelled');
  expect(attempts).toBe(1);
  expect(modelFailure({ status: 400 }).retryable).toBe(false);
});

test('interrupted model output resets on retry, split credentials never reach drafts, and the final tool executes once', async () => {
  let attempts = 0;
  const observed: string[] = [];
  const r = await fixture({
    async call(input) {
      attempts++;
      if (attempts === 1) {
        input.onText?.('abandoned-output credential-first');
        input.onText?.('-second');
        throw new Error('MODEL_RESPONSE_INCOMPLETE');
      }
      if (attempts === 2) {
        input.onText?.('Completed output');
        return calls([
          'file_write',
          { path: 'completed-once.txt', content: 'done', expectedSha256: null },
        ]);
      }
      return { role: 'assistant', content: 'Finished.' };
    },
  });
  try {
    r.vault.put('test', 1, 'test', 'credential-first-second');
    r.store.changes.on('stream', () => observed.push(r.agent.drafts.get(r.id) || ''));
    let writes = 0;
    const write = r.files.write.bind(r.files);
    r.files.write = async (...args) => {
      writes++;
      return write(...args);
    };
    r.agent.submit(r.id, 'Complete the operation.', crypto.randomUUID());
    await eventually(
      () =>
        r.store.history(r.id).some((m) => m.body.content === 'Finished.') &&
        r.store.conversation(r.id).state === 'idle',
      8000,
    );
    expect(attempts).toBe(3);
    expect(writes).toBe(1);
    expect(observed.some((value) => value.includes('credential-first'))).toBe(false);
    expect(observed.at(-1)).toBe('Completed output');
    expect(r.store.history(r.id).some((m) => m.body.content.includes('abandoned-output'))).toBe(
      false,
    );
    expect(r.store.get(`model-retry:${r.id}`, false)).toBe(false);
  } finally {
    await r.dispose();
  }
});

test('redaction decrypts once per vault generation and immediately observes external credential rotation', async () => {
  const r = await fixture();
  try {
    const external = new Vault(r.config.directory);
    external.put('test', 1, 'first', 'FIRST_SECRET_TOKEN');
    const read = spyOn(r.vault as unknown as { read(): unknown }, 'read');
    for (let i = 0; i < 1000; i++) expect(r.vault.redact('FIRST_SECRET_TOKEN')).toBe('[REDACTED]');
    expect(read).toHaveBeenCalledTimes(1);
    external.put('test', 2, 'second', 'NEXT_SECRET_TOKEN');
    expect(r.vault.redact('NEXT_SECRET_TOKEN')).toBe('[REDACTED]');
    expect(read).toHaveBeenCalledTimes(2);
    read.mockRestore();
  } finally {
    await r.dispose();
  }
});

test('stream progress extends the idle deadline and a stalled stream retries without hanging', async () => {
  let attempts = 0;
  const stalled = new ReliableModel(
    {
      async call(input) {
        attempts++;
        return await new Promise((_, reject) =>
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }),
        );
      },
    },
    1,
    20,
  );
  await expect(stalled.call(input())).rejects.toMatchObject({
    code: 'MODEL_CONNECTION_INTERRUPTED',
  });
  expect(attempts).toBe(3);
  const progressing = new ReliableModel(
    {
      async call(input) {
        for (let i = 0; i < 8; i++) {
          await Bun.sleep(10);
          input.signal.throwIfAborted();
          input.onProgress?.();
        }
        return { role: 'assistant', content: 'long reasoning completed' };
      },
    },
    1,
    40,
  );
  expect((await progressing.call(input())).content).toBe('long reasoning completed');
});
