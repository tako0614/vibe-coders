import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, initHome } from '../src/server/config';
import { createRuntime } from '../src/server/runtime';
import type { ModelAdapter, ModelInput } from '../src/server/model';
import type { MessageBody } from '../src/shared/contracts';

export async function fixture(
  model: ModelAdapter | null = {
    async call() {
      return { role: 'assistant', content: 'Done.' };
    },
  },
  codex?: Parameters<typeof createRuntime>[0]['codex'],
) {
  const directory = mkdtempSync(join(tmpdir(), 'vibe-coder-test-')),
    home = join(directory, 'repo'),
    data = join(directory, 'data');
  initHome(home);
  mkdirSync(data);
  const config = new Config(join(directory, 'config'));
  config.update(0, (c) => {
    c.web = {
      username: 'owner',
      passwordHash: Bun.password.hashSync('test-only-password-123', {
        algorithm: 'argon2id',
        memoryCost: 1024,
        timeCost: 1,
      }),
      hostname: '127.0.0.1',
      port: 3100,
    };
  });
  const runtime = createRuntime({
    home,
    directory: data,
    config,
    model: model || undefined,
    codex,
    timers: false,
  });
  // Tests explicitly opt into network verification with a local provider fixture.
  runtime.human.verifyCredential = undefined;
  const id = runtime.store.listConversations()[0].id;
  return {
    ...runtime,
    id,
    root: directory,
    async dispose() {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export async function eventually(check: () => boolean, timeout = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Condition did not become true.');
    await Bun.sleep(15);
  }
}
export function calls(...names: [string, Record<string, unknown>][]): MessageBody {
  return {
    role: 'assistant',
    content: '',
    toolCalls: names.map(([name, args]) => ({
      id: crypto.randomUUID(),
      name,
      arguments: JSON.stringify(args),
    })),
  };
}
export const answer: MessageBody = { role: 'assistant', content: '確認しました。' };
