import { expect, test } from 'bun:test';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { fixture, eventually } from './helpers';
import { createRuntime } from '../src/server/runtime';
import { runs, requests } from '../src/server/db/schema';

test('H08/H09/C12/C13: reopen restores requests, memory and history; unknown tool outcomes are not replayed', async () => {
  const r = await fixture();
  let reopened: ReturnType<typeof createRuntime> | undefined;
  try {
    r.agent.pause(r.id, true);
    const card = r.human.create(r.id, { kind: 'input', title: 'Persistent request', fields: [] });
    const login = r.human.create(r.id, {
      kind: 'action',
      targetId: 'codex',
      title: 'Interrupted login',
      externalCompletion: true,
    });
    const note = await r.memory.human.write('再起動後も残る記憶');
    r.memory.storage.flush();
    r.store.message(r.id, {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'uncertain-call', name: 'shell_exec', arguments: '{"command":"DO NOT REPLAY"}' },
      ],
    });
    r.store.db
      .insert(runs)
      .values({
        id: 'lost-process',
        conversationId: r.id,
        kind: 'shell',
        title: 'Old process',
        cwd: r.home,
        host: 'test',
        state: 'running',
        createdAt: Date.now(),
      })
      .run();
    await r.close();
    reopened = createRuntime({
      home: r.home,
      directory: r.directory,
      config: r.config,
      timers: false,
      model: {
        async call() {
          throw new Error('Model is offline');
        },
      },
    });
    expect(reopened.human.get(card.id).state).toBe('pending');
    expect(reopened.human.get(login.id).state).toBe('cancelled');
    expect(reopened.codex.userStatus().login).toBeNull();
    expect(reopened.runs.get('lost-process').state).toBe('interrupted');
    expect(
      reopened.store.history(r.id).find((m) => m.body.toolCallId === 'uncertain-call')?.body
        .content,
    ).toContain('unknown');
    expect(
      (await reopened.memory.human.inspect(note.ref)).atom?.text ||
        JSON.stringify(await reopened.memory.human.inspect(note.ref)),
    ).toContain('再起動後');
    reopened.human.answer(card.id, { revision: 1, operationId: crypto.randomUUID(), values: {} });
    expect(reopened.human.get(card.id).state).toBe('resolved');
    expect(reopened.store.conversation(r.id).paused).toBe(true);
  } finally {
    if (reopened) await reopened.close();
    else await r.close();
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('secret-store crash recovery joins the saved operation to its result event', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    r.config.update(r.config.read().revision, (c) => {
      c.provider = {
        revision: 1,
        baseUrl: 'https://example.com/v1',
        model: 'test',
        keyRequired: true,
        supportsImages: true,
      };
    });
    const card = r.human.create(r.id, {
      kind: 'secret',
      title: 'Key',
      targetId: 'provider:main',
      fields: [{ name: 'key', label: 'Key', type: 'secret' }],
    });
    const operationId = crypto.randomUUID();
    r.store.db
      .update(requests)
      .set({ state: 'processing', operationId })
      .where(eq(requests.id, card.id))
      .run();
    r.vault.put('provider:main', 1, operationId, 'recovery-secret');
    r.human.recover();
    r.human.recover();
    expect(r.human.get(card.id).state).toBe('resolved');
    expect(r.store.inbox(r.id).filter((e) => e.type === 'human.resolved')).toHaveLength(1);
  } finally {
    await r.dispose();
  }
});

test('terminal handoff hides human input from durable logs and invalidates the old epoch', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const pty = r.runs.terminal(r.id, ['/bin/bash', '--noprofile', '--norc']);
    const human = r.runs.handoff(pty.id, 'human');
    const secret = 'human-only-interval';
    r.runs.write(pty.id, `printf '${secret}\\n'\n`, 'human', human.epoch);
    await eventually(() => r.runs.read(pty.id).text.includes(secret));
    await Bun.sleep(100);
    expect(r.runs.get(pty.id).output).not.toContain(secret);
    const back = r.runs.handoff(pty.id, 'agent');
    expect(r.runs.read(pty.id, 0, 32000, true).text).not.toContain(secret);
    expect(() => r.runs.write(pty.id, 'pwd\n', 'agent', pty.epoch)).toThrow('ownership changed');
    r.runs.write(pty.id, 'exit\n', 'agent', back.epoch);
    await eventually(() => r.runs.get(pty.id).state === 'completed');
  } finally {
    await r.dispose();
  }
});

test('known credentials split across process output chunks remain redacted', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    r.vault.put('test', 1, 'test', 'stream-secret-value');
    const run = r.runs.shell(r.id, 'printf stream-se; sleep 0.1; printf cret-value');
    await eventually(() => r.runs.get(run.id).state === 'completed');
    expect(r.runs.read(run.id).text).toBe('[REDACTED]');
    expect(r.runs.get(run.id).output).not.toContain('stream-secret-value');
  } finally {
    await r.dispose();
  }
});
