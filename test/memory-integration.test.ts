import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { fixture, calls, eventually, answer } from './helpers';
import { createRuntime } from '../src/server/runtime';

test('agent memory_write survives restart and is recalled in a different conversation', async () => {
  let step = 0;
  const note = 'このリポジトリの公開コード名は SAPPHIRE_OTTER_914 です。';
  const r = await fixture({
    async call() {
      return step++ === 0 ? calls(['memory_write', { text: note }]) : answer;
    },
  });
  let reopened: ReturnType<typeof createRuntime> | undefined;
  try {
    r.agent.submit(r.id, '公開コード名を覚えて。', crypto.randomUUID());
    await eventually(() => r.store.conversation(r.id).state === 'idle' && step === 2);
    const result = r.store.history(r.id).find((m) => m.body.role === 'tool');
    expect(result?.body.content).not.toContain('error');
    expect((await r.memory.recall('このリポジトリの公開コード名', 6000)).text).toContain(
      'SAPPHIRE_OTTER_914',
    );
    await r.close();
    let system = '';
    reopened = createRuntime({
      home: r.home,
      directory: r.directory,
      config: r.config,
      timers: false,
      model: {
        async call(input) {
          system = input.system;
          return answer;
        },
      },
      codex: { credentialFile: `${r.root}/codex-auth.json` },
    });
    const conversation = reopened.store.createConversation('別の会話');
    reopened.agent.submit(conversation.id, 'このリポジトリの公開コード名は？', crypto.randomUUID());
    await eventually(
      () => reopened!.store.conversation(conversation.id).state === 'idle' && !!system,
    );
    expect(system).toContain(note);
    expect(
      reopened.store
        .history(conversation.id)
        .some((m) => m.body.content.includes('SAPPHIRE_OTTER_914')),
    ).toBe(false);
  } finally {
    await (reopened || r).close();
    rmSync(r.root, { recursive: true, force: true });
  }
});
