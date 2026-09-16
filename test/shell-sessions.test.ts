import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, eventually } from './helpers';

test('persistent work shell retains cwd, exports and functions, observes completion and deduplicates a retried command', async () => {
  const r = await fixture();
  try {
    mkdirSync(join(r.home, 'working dir'));
    const first = await r.shellSessions.execute(r.id, {
      command:
        "cd 'working dir'; export VIBE_SESSION_PROOF=lasting; proof_fn() { printf 'function-retained'; }; printf 'one\\n'",
      operationId: 'first',
    });
    expect(first.command?.state).toBe('completed');
    expect(first.command?.exitCode).toBe(0);
    expect(first.session.cwd).toBe(join(r.home, 'working dir'));
    const second = await r.shellSessions.execute(r.id, {
      command: 'printf "$VIBE_SESSION_PROOF:"; proof_fn; printf "\\n"',
      operationId: 'second',
    });
    expect(second.session.id).toBe(first.session.id);
    expect(second.text).toContain('lasting:function-retained');
    expect(second.command?.state).toBe('completed');
    await r.shellSessions.execute(r.id, { command: 'printf x >> marker', operationId: 'once' });
    await r.shellSessions.execute(r.id, { command: 'printf x >> marker', operationId: 'once' });
    expect(await Bun.file(join(r.home, 'working dir/marker')).text()).toBe('x');
    const failed = await r.shellSessions.execute(r.id, {
      command: 'false',
      operationId: 'failure',
    });
    expect(failed.command?.exitCode).toBe(1);
    expect(r.runs.get(first.session.id).state).toBe('running');
  } finally {
    await r.dispose();
  }
}, 15000);

test('long commands remain running without a second command injection; human handoff blocks observation', async () => {
  const r = await fixture();
  try {
    const started = await r.shellSessions.execute(r.id, {
      command: 'sleep 0.3; printf "LONG_COMMAND_DONE\\n"',
      operationId: 'long',
      timeoutMs: 0,
    });
    expect(started.command?.state).toBe('running');
    await expect(
      r.shellSessions.execute(r.id, { command: 'echo should-not-run', operationId: 'overlap' }),
    ).rejects.toThrow('実行中');
    const done = await r.shellSessions.poll(started.session.id, 'long', 2000);
    expect(done.command?.state).toBe('completed');
    expect(done.text).toContain('LONG_COMMAND_DONE');
    r.runs.handoff(started.session.id, 'human');
    expect(r.shellSessions.session(started.session.id).ready).toBe(false);
    expect(() => r.shellSessions.read(started.session.id)).toThrow('user');
    await expect(
      r.shellSessions.execute(r.id, { command: 'echo private', operationId: 'private' }),
    ).rejects.toThrow('user');
    r.runs.write(
      started.session.id,
      'echo PRIVATE_HUMAN_OUTPUT\r',
      'human',
      r.runs.get(started.session.id).epoch,
    );
    await Bun.sleep(100);
    const handed = r.runs.handoff(started.session.id, 'agent');
    expect(r.shellSessions.read(started.session.id).text).not.toContain('PRIVATE_HUMAN_OUTPUT');
    r.runs.write(handed.id, '\r', 'agent', handed.epoch);
    await eventually(() => r.shellSessions.session(handed.id).ready);
    const next = await r.shellSessions.execute(r.id, {
      command: 'echo AGENT_BACK',
      operationId: 'back',
    });
    expect(next.command?.state).toBe('completed');
    expect(next.text).toContain('AGENT_BACK');
  } finally {
    await r.dispose();
  }
}, 10000);

test('simultaneous opens share one process and concurrent commands cannot overlap', async () => {
  const r = await fixture();
  try {
    const [a, b] = await Promise.all([r.shellSessions.open(r.id), r.shellSessions.open(r.id)]);
    expect(a.session.id).toBe(b.session.id);
    const outcomes = await Promise.allSettled([
      r.shellSessions.execute(r.id, { command: 'sleep 0.2', operationId: 'one', timeoutMs: 0 }),
      r.shellSessions.execute(r.id, { command: 'echo overlap', operationId: 'two', timeoutMs: 0 }),
    ]);
    expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === 'rejected')).toHaveLength(1);
  } finally {
    await r.dispose();
  }
});

test('temporary local IO stalls preserve the running shell and its completion', async () => {
  const { openSync, writeSync, fsyncSync, closeSync } = await import('node:fs');
  const r = await fixture();
  try {
    const started = await r.shellSessions.execute(r.id, {
      command: 'sleep 0.05; printf "AFTER_IO_STALL\\n"',
      operationId: 'io',
      timeoutMs: 0,
    });
    const fd = openSync(join(r.home, 'io-burst'), 'w');
    try {
      for (let i = 0; i < 64; i++) {
        writeSync(fd, Buffer.alloc(4096));
        fsyncSync(fd);
      }
    } finally {
      closeSync(fd);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    const completed = await r.shellSessions.poll(started.session.id, 'io', 3000);
    expect(completed.command?.exitCode).toBe(0);
    expect(completed.text).toContain('AFTER_IO_STALL');
    expect(completed.processState).toBe('running');
  } finally {
    await r.dispose();
  }
});
