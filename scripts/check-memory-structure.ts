// Opt-in model integration in a disposable Home. The production memory is untouched.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { rmSync } from 'node:fs';
import { fixture } from '../test/helpers';
import { createRuntime } from '../src/server/runtime';
if (process.env.VIBE_CODER_TEST_REAL_CODEX !== '1')
  throw new Error('Set VIBE_CODER_TEST_REAL_CODEX=1.');
const credentialFile = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
const r = await fixture(null, { credentialFile });
let reopened: ReturnType<typeof createRuntime> | undefined;
const marker = `ORCHID_${crypto.randomUUID().slice(0, 8)}`;
try {
  const models = await r.codex.models();
  const selected =
    models.find((model) => model.id === process.env.VIBE_CODER_TEST_MODEL) ||
    models.find((model) => model.isDefault) ||
    models[0];
  assert(selected);
  r.config.update(r.config.read().revision, (config) => {
    config.provider = {
      kind: 'codex',
      revision: 1,
      model: selected.id,
      reasoningEffort: selected.reasoningEfforts?.includes('low') ? 'low' : undefined,
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      keyRequired: false,
      supportsImages: true,
    };
  });
  r.store.message(r.id, {
    role: 'user',
    content: `このテストプロジェクトの公開コード名は ${marker}。リリース担当の作業方針として、成果物は先にステージ環境で確認する。`,
  });
  r.store.message(r.id, {
    role: 'user',
    content:
      'ステージ確認では、実際に配布するtarballをインストールしてログインと端末操作を試す。これは先ほどのリリース方針の検証手順として残したい。',
  });
  r.store.message(r.id, {
    role: 'user',
    content:
      '端末操作は同じシェルを継続利用する。cdした作業ディレクトリ、exportした環境変数、定義した関数が次のコマンドに残ることを確認する。',
  });
  r.memoryWriter.enqueue(r.id);
  await r.memoryWriter.drain();
  const job = r.memoryWriter.jobs()[0]!;
  assert.equal(job.state, 'complete', job.error || 'Memory writer did not finish.');
  const page = await r.memory.list();
  assert(page.total > 0);
  assert(page.items.every((item) => item.sources > 0));
  const recalled = await r.memory.recall(marker, 6000);
  assert(recalled.text.includes(marker));
  await r.close();
  reopened = createRuntime({
    home: r.home,
    directory: r.directory,
    config: r.config,
    timers: false,
    codex: { credentialFile },
  });
  assert((await reopened.memory.recall(marker, 6000)).text.includes(marker));
  assert.equal(reopened.memoryWriter.jobs()[0]!.cursor, job.cursor);
  console.log(
    JSON.stringify({
      passed: true,
      model: selected.id,
      notes: page.total,
      links: page.linkCount,
      sources: page.sourceCount,
      writerUsesRealModel: true,
      sourceBacked: true,
      restartedRecall: true,
      productionMemoryTouched: false,
    }),
  );
} finally {
  await (reopened || r).close();
  rmSync(r.root, { recursive: true, force: true });
}
