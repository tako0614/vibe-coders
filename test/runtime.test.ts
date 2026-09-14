import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { fixture, eventually, calls, answer } from './helpers';
import { conversations, events, requests } from '../src/server/db/schema';
import type { ModelInput } from '../src/server/model';

describe('asynchronous human input and durable agent state', () => {
  test('H01/H02: a request returns immediately and the parent reads a file before any answer', async () => {
    let step = 0;
    const observed: ModelInput[] = [];
    const r = await fixture({
      async call(input) {
        observed.push(input);
        if (step++ === 0)
          return calls(
            [
              'human_request',
              {
                kind: 'input',
                title: '質問',
                fields: [{ name: 'name', label: '名前', type: 'text' }],
              },
            ],
            ['human_request', { kind: 'input', title: '質問2', fields: [] }],
            ['file_read', { path: 'AGENT.md' }],
          );
        return answer;
      },
    });
    try {
      r.agent.submit(r.id, '質問を出し、ファイルを確認して。', crypto.randomUUID());
      await eventually(() => r.store.history(r.id).some((m) => m.body.content === answer.content));
      expect(r.store.snapshot(r.id).requests.filter((q) => q.state === 'pending')).toHaveLength(2);
      expect(
        observed[1].messages.some((m) => m.role === 'tool' && m.content.includes('sha256')),
      ).toBe(true);
      expect(r.store.conversation(r.id).state).toBe('idle');
    } finally {
      await r.dispose();
    }
  });
  test('H03/H04: an answer queues without interrupting or overlapping a current inference', async () => {
    let unblock!: () => void,
      started = false,
      count = 0,
      active = 0,
      maxActive = 0;
    const seen: ModelInput[] = [];
    const r = await fixture({
      async call(input) {
        seen.push(input);
        active++;
        maxActive = Math.max(maxActive, active);
        if (count++ === 0) {
          started = true;
          await new Promise<void>((resolve) => {
            unblock = resolve;
          });
        }
        active--;
        return { role: 'assistant', content: `step ${count}` };
      },
    });
    try {
      const card = r.human.create(r.id, {
        kind: 'input',
        title: '入力',
        fields: [{ name: 'answer', label: '回答', type: 'text' }],
      });
      r.agent.submit(r.id, '現在の仕事', crypto.randomUUID());
      await eventually(() => started);
      r.human.answer(card.id, {
        revision: card.revision,
        operationId: crypto.randomUUID(),
        values: { answer: 'new answer' },
      });
      expect(count).toBe(1);
      unblock();
      await eventually(() => count === 2 && r.store.conversation(r.id).state === 'idle');
      expect(maxActive).toBe(1);
      expect(seen[1].messages.some((m) => m.content === 'step 1')).toBe(true);
      expect(seen[1].messages.some((m) => m.content.includes('new answer'))).toBe(true);
    } finally {
      unblock?.();
      await r.dispose();
    }
  });
  test('H05/H06: wait is explicit; already-resolved requests cannot lose a wakeup', async () => {
    let step = 0,
      requestId = '';
    const r = await fixture({
      async call() {
        if (step++ === 0)
          return calls([
            'agent_wait',
            { reason: '回答が必要', wakeOn: [{ type: 'human.resolved', requestId }] },
          ]);
        return answer;
      },
    });
    try {
      const card = r.human.create(r.id, { kind: 'input', title: '入力', fields: [] });
      requestId = card.id;
      r.agent.submit(r.id, '回答を待って。', crypto.randomUUID());
      await eventually(() => r.store.conversation(r.id).state === 'waiting');
      await Bun.sleep(40);
      expect(step).toBe(1);
      r.human.answer(card.id, { revision: 1, operationId: crypto.randomUUID(), values: {} });
      await eventually(() => r.store.conversation(r.id).state === 'idle' && step === 2);
      const waitTool = r.agent.tools(r.id).find((t) => t.name === 'agent_wait')!;
      const result = (await waitTool.execute({
        reason: 'race',
        wakeOn: [{ type: 'human.resolved', requestId }],
      })) as { waiting: boolean };
      expect(result.waiting).toBe(false);
    } finally {
      await r.dispose();
    }
  });
  test('H07/H10/H14: duplicate and stale answers are rejected, paused parents stay paused, secrets never enter state', async () => {
    const r = await fixture();
    try {
      r.agent.pause(r.id, true);
      r.config.update(r.config.read().revision, (c) => {
        c.provider = {
          revision: 1,
          baseUrl: 'https://example.com/v1',
          model: 'test',
          supportsImages: true,
          keyRequired: true,
        };
      });
      const card = r.human.create(r.id, {
        kind: 'secret',
        title: 'Key',
        targetId: 'provider:main',
        dedupeKey: 'key',
        fields: [{ name: 'key', label: 'API key', type: 'secret' }],
      });
      expect(r.human.create(r.id, card.spec).id).toBe(card.id);
      const secret = `sentinel-${crypto.randomUUID()}`,
        operationId = crypto.randomUUID();
      expect(() =>
        r.human.answer(card.id, { revision: 1, operationId, values: { key: secret } }),
      ).toThrow('matching input route');
      const result = r.human.answer(
        card.id,
        { revision: 1, operationId, values: { key: secret } },
        true,
      );
      expect(result.state).toBe('resolved');
      expect(
        r.human.answer(card.id, { revision: 1, operationId, values: { key: secret } }, true).id,
      ).toBe(card.id);
      expect(
        r.store.db.select().from(events).where(eq(events.type, 'human.resolved')).all(),
      ).toHaveLength(1);
      await Bun.sleep(20);
      expect(r.store.conversation(r.id).state).toBe('paused');
      expect(r.vault.get('provider:main', 1)).toBe(secret);
      const stateDump =
        JSON.stringify(r.store.snapshot(r.id)) + JSON.stringify(r.store.inbox(r.id));
      expect(stateDump).not.toContain(secret);
      expect(
        readFileSync(join(r.config.directory, 'vault.enc')).includes(Buffer.from(secret)),
      ).toBe(false);
      expect(existsSync(join(r.home, 'config.json'))).toBe(false);
      expect((await r.memory.human.search(secret)).items).toHaveLength(0);
      const stale = r.human.create(r.id, { ...card.spec, dedupeKey: 'stale' });
      r.config.update(r.config.read().revision, (c) => {
        c.provider!.revision++;
      });
      expect(() =>
        r.human.answer(
          stale.id,
          { revision: 1, operationId: crypto.randomUUID(), values: { key: 'wrong-target-secret' } },
          true,
        ),
      ).toThrow('configuration changed');
      const cancelled = r.human.create(r.id, {
        kind: 'input',
        title: 'Cancel',
        dedupeKey: 'cancel',
      });
      r.human.close(cancelled.id);
      expect(r.human.create(r.id, cancelled.spec).state).toBe('cancelled');
      expect(() =>
        r.human.answer(cancelled.id, { revision: 1, operationId: crypto.randomUUID(), values: {} }),
      ).toThrow('closed');
    } finally {
      await r.dispose();
    }
  });
  test('C02/C03/C04: independent Home cwd, live Unicode PTY screen, and ownership epoch', async () => {
    const r = await fixture();
    try {
      r.agent.pause(r.id, true);
      const a = r.runs.shell(r.id, 'pwd'),
        b = r.runs.shell(r.id, 'cd /tmp && pwd');
      await eventually(
        () => r.runs.get(a.id).state === 'completed' && r.runs.get(b.id).state === 'completed',
      );
      expect(r.runs.read(a.id).text.trim()).toBe(r.home);
      expect(r.runs.read(b.id).text.trim()).toBe('/tmp');
      const pty = r.runs.terminal(r.id, ['/bin/bash', '--noprofile', '--norc']);
      r.runs.write(pty.id, "printf '日本語\\n'\n", 'agent', pty.epoch);
      await eventually(() => r.runs.read(pty.id).text.includes('日本語'));
      expect((await r.runs.screen(pty.id)).text).toContain('日本語');
      const human = r.runs.handoff(pty.id, 'human');
      expect(() => r.runs.write(pty.id, 'echo bad\n', 'agent', pty.epoch)).toThrow(
        'ownership changed',
      );
      expect(() => r.runs.read(pty.id, 0, 1000, true)).toThrow('suspended');
      r.runs.write(pty.id, 'exit\n', 'human', human.epoch);
      await eventually(() => r.runs.get(pty.id).state === 'completed');
    } finally {
      await r.dispose();
    }
  });
  test('C10: Atom recall is refreshed per step, acknowledged after success, and persists', async () => {
    const seen: ModelInput[] = [];
    let count = 0;
    const r = await fixture({
      async call(input) {
        seen.push(input);
        if (count++ === 0) return calls(['file_read', { path: 'AGENT.md' }]);
        return answer;
      },
    });
    try {
      const note = await r.memory.human.write('このリポジトリのUIは緑色を使う。');
      r.agent.submit(r.id, 'このリポジトリのUIの色を確認して。', crypto.randomUUID());
      await eventually(() => r.store.history(r.id).some((m) => m.body.content === answer.content));
      expect(seen).toHaveLength(2);
      expect(seen[0].system).toContain('緑色');
      expect(seen[1].messages.map((m) => m.content).join('\n')).not.toContain(
        'このリポジトリのUIは緑色を使う。',
      );
      expect(
        (await r.memory.human.inspect(note.ref)).atom?.text ||
          JSON.stringify(await r.memory.human.inspect(note.ref)),
      ).toContain('緑色');
    } finally {
      await r.dispose();
    }
  });
  test('C11/C17: timers coalesce missed intervals and all-stop suppresses new launches', async () => {
    const r = await fixture();
    try {
      r.agent.pause(r.id, true);
      const now = Date.now();
      const schedule = r.scheduler.create(r.id, {
        title: 'check',
        prompt: 'status',
        nextAt: now - 100000,
        intervalMs: 1000,
      });
      r.scheduler.tick(now);
      r.scheduler.tick(now);
      expect(r.store.inbox(r.id).filter((e) => e.type === 'schedule.fired')).toHaveLength(1);
      expect(r.scheduler.get(schedule.id).nextAt).toBe(now + 1000);
      r.agent.stopAll();
      r.scheduler.tick(now + 2000);
      expect(r.store.inbox(r.id).filter((e) => e.type === 'schedule.fired')).toHaveLength(1);
      expect(() => r.runs.shell(r.id, 'true')).toThrow('stopped');
      expect(() => r.scheduler.fire(schedule.id)).toThrow('stopped');
      r.agent.enable();
      r.scheduler.tick(now + 2000);
      expect(r.store.inbox(r.id).filter((e) => e.type === 'schedule.fired')).toHaveLength(2);
    } finally {
      await r.dispose();
    }
  });
});
