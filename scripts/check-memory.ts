// Opt-in real Codex subscription check. All memories and history use a disposable Home.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { rmSync } from 'node:fs';
import { fixture, eventually } from '../test/helpers';
import { createRuntime } from '../src/server/runtime';
if (process.env.VIBE_CODER_TEST_REAL_CODEX !== '1')
  throw new Error('Set VIBE_CODER_TEST_REAL_CODEX=1 to run the real subscription check.');
const credentialFile = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
const r = await fixture(null, { credentialFile });
let reopened: ReturnType<typeof createRuntime> | undefined;
const marker = `MEMORY_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
try {
  const choices = await r.codex.models();
  const model = choices.find((m) => m.isDefault) || choices[0];
  assert(model);
  r.config.update(r.config.read().revision, (c) => {
    c.provider = {
      revision: 1,
      kind: 'codex',
      model: model.id,
      reasoningEffort: model.reasoningEfforts?.includes('low') ? 'low' : undefined,
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      keyRequired: false,
      supportsImages: true,
    };
  });
  assert((await r.codex.refresh()).subscriptionReady, 'Sign into native Codex first.');
  r.agent.submit(
    r.id,
    `この一時テストプロジェクトの公開コード名は ${marker} です。次の別の会話でも覚えていてください。Atomの memory_write を使って非秘密の事実として保存し、保存完了だけを返してください。シェルやファイル操作は不要です。`,
    crypto.randomUUID(),
  );
  await eventually(
    () =>
      ['idle', 'error'].includes(r.store.conversation(r.id).state) &&
      r.store.history(r.id).some((m) => m.body.role === 'assistant'),
    90000,
  );
  assert.equal(r.store.conversation(r.id).state, 'idle');
  assert(
    r.store.history(r.id).some((m) => m.body.toolCalls?.some((t) => t.name === 'memory_write')),
  );
  assert(
    (await r.memory.recall('このテストプロジェクトの公開コード名', 6000)).text.includes(marker),
  );
  await r.close();
  reopened = createRuntime({
    home: r.home,
    directory: r.directory,
    config: r.config,
    timers: false,
    codex: { credentialFile },
  });
  const c = reopened.store.createConversation('再起動後の別の会話');
  reopened.agent.submit(
    c.id,
    'このテストプロジェクトの公開コード名は何でしたか。保存済みの記憶だけを使い、コード名のみ返してください。シェルやファイル操作は不要です。',
    crypto.randomUUID(),
  );
  await eventually(
    () =>
      ['idle', 'error'].includes(reopened!.store.conversation(c.id).state) &&
      reopened!.store.history(c.id).some((m) => m.body.role === 'assistant'),
    90000,
  );
  assert.equal(reopened.store.conversation(c.id).state, 'idle');
  assert(
    reopened.store
      .history(c.id)
      .some((m) => m.body.role === 'assistant' && m.body.content.includes(marker)),
  );
  console.log(
    JSON.stringify({
      passed: true,
      model: model.id,
      reasoningEffort: r.config.read().provider?.reasoningEffort,
      writeTool: true,
      restarted: true,
      separateConversation: true,
      correctRecall: true,
      productionMemoryTouched: false,
    }),
  );
} finally {
  await (reopened || r).close();
  rmSync(r.root, { recursive: true, force: true });
}
