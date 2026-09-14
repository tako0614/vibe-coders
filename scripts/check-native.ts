import { fixture, eventually } from '../test/helpers';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const adapter = process.argv[2];
if (adapter !== 'codex' && adapter !== 'claude')
  throw new Error(
    'Pass codex or claude explicitly; this check invokes a real model using that CLI login.',
  );
const r = await fixture();
try {
  r.agent.pause(r.id, true);
  const run = r.native.start(r.id, {
    adapter,
    prompt:
      'In this temporary test repository, create native-proof.txt containing exactly NATIVE_E2E_OK followed by a newline. Read the file back, then report success. Do not access other directories, browse the web, or delegate to other agents.',
  });
  await eventually(() => !['running', 'stopping'].includes(r.runs.get(run.id).state), 120000);
  const result = r.runs.get(run.id);
  assert.equal(result.state, 'completed', JSON.stringify(result.result));
  assert.equal(await Bun.file(join(r.home, 'native-proof.txt')).text(), 'NATIVE_E2E_OK\n');
  console.log(
    JSON.stringify({
      adapter,
      passed: true,
      turnState: result.result?.turnState,
      threadId: result.result?.threadId,
      sessionId: result.result?.sessionId,
      costUsd: result.result?.costUsd,
    }),
  );
} finally {
  await r.dispose();
}
