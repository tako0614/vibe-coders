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

test('active Codex steering and Claude interruption deliver one additional instruction and reject stale turns', async () => {
  const r = await fixture();
  const program = [
    process.execPath,
    fileURLToPath(new URL('./fixtures/native-cli.ts', import.meta.url)),
  ];
  const native = r.native;
  Object.assign(native.executables, { codex: program, claude: program });
  r.codex.command.splice(0, r.codex.command.length, ...program);
  try {
    r.agent.pause(r.id, true);
    for (const adapter of ['codex', 'claude'] as const) {
      const run = native.start(r.id, { adapter, prompt: 'wait' });
      await eventually(() => !!r.runs.get(run.id).result?.inputMode);
      const turnId = r.runs.get(run.id).result!.turnId;
      await expect(
        native.input(run.id, {
          prompt: 'wrong',
          expectedTurnId: 'stale',
          operationId: crypto.randomUUID(),
        }),
      ).rejects.toThrow('実行状態');
      const input = {
        prompt: `redirected-${adapter}`,
        expectedTurnId: turnId,
        operationId: crypto.randomUUID(),
      };
      expect(r.runs.read(run.id).capabilities.nativeInput).toBe(
        adapter === 'codex' ? 'steer' : 'interrupt',
      );
      expect(
        await r.agent
          .tools(r.id)
          .find((t) => t.name === 'native_input')!
          .execute({ id: run.id, ...input }),
      ).toMatchObject({ state: 'accepted' });
      expect((await native.input(run.id, input)).state).toBe('accepted');
      await eventually(() => r.runs.get(run.id).state === 'completed');
      expect(r.runs.get(run.id).result!.text).toContain(`redirected-${adapter}`);
      await expect(
        native.input(run.id, { ...input, operationId: crypto.randomUUID() }),
      ).rejects.toThrow('実行状態');
    }
  } finally {
    await r.dispose();
  }
});
