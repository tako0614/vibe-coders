import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { fixture, eventually } from './helpers';
import { NativeService } from '../src/server/native';

test('native adapters report actual structured turn/session results; all-stop terminates a child', async () => {
  const r = await fixture();
  const program = [
    process.execPath,
    fileURLToPath(new URL('./fixtures/native-cli.ts', import.meta.url)),
  ];
  const native = new NativeService(r.store, r.runs, r.human, { codex: program, claude: program });
  try {
    r.agent.pause(r.id, true);
    const codex = native.start(r.id, { adapter: 'codex', prompt: 'hello' });
    await eventually(() => r.runs.get(codex.id).state === 'completed');
    expect(r.runs.get(codex.id).kind).toBe('native');
    expect(r.runs.get(codex.id).result?.threadId).toBe('native-thread');
    expect(r.runs.get(codex.id).result?.turnState).toBe('completed');
    expect(r.store.snapshot(r.id).runs.find((run) => run.id === codex.id)?.result).toMatchObject({
      threadId: 'native-thread',
      turnState: 'completed',
    });
    expect(r.runs.read(codex.id).capabilities).toMatchObject({
      pty: false,
      immediateInput: false,
      nextTurnViaResume: true,
    });
    const claude = native.start(r.id, { adapter: 'claude', prompt: 'structured input' });
    await eventually(() => r.runs.get(claude.id).state === 'completed');
    expect(r.runs.get(claude.id).result?.sessionId).toBe('claude-session');
    expect(r.runs.get(claude.id).result?.text).toBe('structured input');
    const waiting = native.start(r.id, { adapter: 'codex', prompt: 'wait' });
    await eventually(() => r.runs.read(waiting.id).text.includes('native-thread'));
    r.agent.stopAll();
    await eventually(() => r.runs.get(waiting.id).state === 'failed');
    expect(r.runs.get(waiting.id).result?.turnState).not.toBe('completed');
  } finally {
    await r.dispose();
  }
}, 15000);
