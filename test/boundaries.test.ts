import { expect, test } from 'bun:test';
import { Config } from '../src/server/config';
import { fixture, eventually } from './helpers';
import { writeFileSync, existsSync } from 'node:fs';

test('all-stop cancels a managed operation before its deferred executor starts', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    let executions = 0;
    const run = r.runs.managed(r.id, 'deferred', async () => {
      executions++;
      return { ok: true };
    });
    r.agent.stopAll();
    await eventually(() => !['running', 'stopping'].includes(r.runs.get(run.id).state));
    expect(executions).toBe(0);
    expect(r.runs.get(run.id).state).toBe('failed');
  } finally {
    await r.dispose();
  }
});
test('a dead writer lock is reclaimed; a live writer remains exclusive', async () => {
  const r = await fixture();
  try {
    const child = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' });
    await child.exited;
    writeFileSync(`${r.config.path}.lock`, String(child.pid));
    const old = r.config.read().revision;
    r.config.update(old, (c) => {
      c.retention = { imageDays: 30, runDays: 30, conversationDays: 90 };
    });
    expect(r.config.read().revision).toBe(old + 1);
    expect(existsSync(`${r.config.path}.lock`)).toBe(false);
    r.config.lock(() => {
      expect(() => new Config(r.config.directory).update(old + 1, () => {})).toThrow('locked');
    });
    expect(r.config.read().revision).toBe(old + 1);
  } finally {
    await r.dispose();
  }
});

test('external result fields cannot override a run completion identity or hide tool errors', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const run = r.runs.managed(r.id, 'external', async () => ({
      runId: 'forged-run',
      kind: 'forged-kind',
      isError: true,
    }));
    await eventually(() => r.runs.get(run.id).state !== 'running');
    const event = r.store.inbox(r.id).find((e) => e.type === 'run.completed')!;
    expect(event.payload.runId).toBe(run.id);
    expect(event.payload.kind).toBe('mcp');
    expect(r.runs.get(run.id).state).toBe('failed');
  } finally {
    await r.dispose();
  }
});

test('message retries are idempotent and the same operation ID cannot be reused for different content', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const operationId = crypto.randomUUID();
    r.agent.submit(r.id, 'Original', operationId);
    r.agent.submit(r.id, 'Original', operationId);
    expect(r.store.history(r.id)).toHaveLength(1);
    expect(() => r.agent.submit(r.id, 'Changed', operationId)).toThrow();
    const other = r.store.createConversation();
    r.agent.pause(other.id, true);
    expect(() => r.agent.submit(other.id, 'Original', operationId)).toThrow();
    expect(r.store.history(other.id)).toHaveLength(0);
  } finally {
    await r.dispose();
  }
});

test('CLI and server configuration writers share a lock and reject stale revisions', async () => {
  const r = await fixture();
  try {
    const other = new Config(r.config.directory),
      revision = r.config.read().revision;
    r.config.lock(() => expect(() => other.update(revision, () => {})).toThrow('locked'));
    other.update(revision, () => {});
    expect(() => r.config.update(revision, () => {})).toThrow('changed');
    expect(r.config.read().revision).toBe(revision + 1);
  } finally {
    await r.dispose();
  }
});

test('file edits reject stale content and ambiguous replacements without partial writes', async () => {
  const r = await fixture();
  try {
    const first = await r.files.write({
      path: 'sample.txt',
      content: 'before before',
      expectedSha256: null,
    });
    await expect(r.files.replace('sample.txt', 'before', 'after')).rejects.toThrow('exactly one');
    expect((await r.files.read('sample.txt')).text).toBe('before before');
    await r.files.write({ path: 'sample.txt', content: 'current', expectedSha256: first.sha256 });
    await expect(
      r.files.write({ path: 'sample.txt', content: 'stale', expectedSha256: first.sha256 }),
    ).rejects.toThrow('changed');
    expect((await r.files.read('sample.txt')).text).toBe('current');
  } finally {
    await r.dispose();
  }
});
