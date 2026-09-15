import { test, expect } from 'bun:test';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { fixture, eventually } from './helpers';
import { ModelContextExceeded } from '../src/server/model';
import { ConversationContext } from '../src/server/context';

test('compaction preserves durable history and complete tool pairs, survives restart and keeps the latest request', async () => {
  const r = await fixture();
  try {
    r.store.message(r.id, {
      role: 'user',
      content: 'Keep the original goal and do not delete files.',
    });
    for (let i = 0; i < 12; i++) {
      r.store.message(r.id, {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `call-${i}`, name: 'file_read', arguments: '{}' }],
      });
      r.store.message(r.id, {
        role: 'tool',
        toolCallId: `call-${i}`,
        content: 'file-content-'.repeat(180),
      });
    }
    r.store.message(r.id, {
      role: 'user',
      content: 'Latest correction: preserve the green theme.',
    });
    const length = r.store.history(r.id).length;
    const model = {
      async call() {
        return {
          role: 'assistant' as const,
          content:
            'Goal: inspect files. Keep files and the green theme. File inspections completed; edits are still pending.',
        };
      },
    };
    const context = new ConversationContext(r.store, model, r.vault);
    const input = await context.prepare(r.id, new AbortController().signal, { budget: 12000 });
    expect(input.length).toBeLessThan(length);
    expect(r.store.history(r.id)).toHaveLength(length);
    expect(context.status(r.id).through).toBeGreaterThan(0);
    const calls = new Set(input.flatMap((m) => (m.toolCalls || []).map((c) => c.id)));
    for (const m of input.filter((m) => m.role === 'tool'))
      expect(calls.has(m.toolCallId!)).toBe(true);
    expect(input.at(-1)?.content).toContain('Latest correction');
    const reloaded = new ConversationContext(r.store, model, r.vault);
    expect(await reloaded.prepare(r.id, new AbortController().signal, { budget: 12000 })).toEqual(
      input,
    );
  } finally {
    await r.dispose();
  }
});

test('failed or aborted summary never advances the durable boundary', async () => {
  const r = await fixture();
  try {
    for (let i = 0; i < 30; i++) r.store.message(r.id, { role: 'user', content: 'x'.repeat(8000) });
    let count = 0;
    const context = new ConversationContext(
      r.store,
      {
        async call() {
          if (++count === 2) throw new Error('offline');
          return { role: 'assistant', content: 'summary' };
        },
      },
      r.vault,
    );
    await expect(
      context.prepare(r.id, new AbortController().signal, { budget: 16000 }),
    ).rejects.toThrow('offline');
    expect(context.status(r.id).through).toBe(0);
    expect(r.store.history(r.id)).toHaveLength(30);
  } finally {
    await r.dispose();
  }
});

test('parent compacts and retries once after the provider rejects context, without dropping history', async () => {
  let calls = 0,
    summaries = 0;
  const r = await fixture({
    async call(input) {
      if (!input.tools.length) {
        summaries++;
        return {
          role: 'assistant',
          content: 'Keep the existing files. The latest correction is authoritative.',
        };
      }
      if (++calls === 1) throw new ModelContextExceeded();
      expect(input.messages.some((m) => m.content.includes('latest correction'))).toBe(true);
      return { role: 'assistant', content: 'Continued.' };
    },
  });
  try {
    for (let i = 0; i < 8; i++)
      r.store.message(r.id, { role: 'user', content: 'Earlier task context. '.repeat(100) });
    r.agent.submit(r.id, 'latest correction: preserve the file', crypto.randomUUID());
    await eventually(() => r.store.history(r.id).some((m) => m.body.content === 'Continued.'));
    expect(calls).toBe(2);
    expect(summaries).toBeGreaterThan(0);
    expect(r.store.history(r.id).length).toBeGreaterThanOrEqual(10);
    expect(r.store.snapshot(r.id).context?.through).toBeGreaterThan(0);
  } finally {
    await r.dispose();
  }
});

test('workspace changes detect external edits, restore exact files and reject stale updates and symlinks', async () => {
  const r = await fixture();
  try {
    await r.changes.ready;
    const original = await r.changes.detail('AGENT.md');
    await writeFile(`${r.home}/AGENT.md`, 'outside CLI edit\n');
    await writeFile(`${r.home}/new.txt`, 'new\n');
    const listing = await r.changes.list();
    expect(listing.changes.map((c) => c.path)).toEqual(
      expect.arrayContaining(['AGENT.md', 'new.txt']),
    );
    const changed = await r.changes.detail('AGENT.md');
    expect(changed.before).toBe(original.after);
    await writeFile(`${r.home}/AGENT.md`, 'newer user edit\n');
    await expect(r.changes.restore('AGENT.md', changed.sha256, changed.baselineId)).rejects.toThrow(
      '変更',
    );
    expect(await Bun.file(`${r.home}/AGENT.md`).text()).toBe('newer user edit\n');
    const latest = await r.changes.detail('AGENT.md');
    await r.changes.restore('AGENT.md', latest.sha256, latest.baselineId);
    expect(await Bun.file(`${r.home}/AGENT.md`).text()).toBe(original.after!);
    const added = await r.changes.detail('new.txt');
    await r.changes.restore('new.txt', added.sha256, added.baselineId);
    expect(await Bun.file(`${r.home}/new.txt`).exists()).toBe(false);
    await symlink(`${r.root}/outside.txt`, `${r.home}/linked`);
    await expect(r.changes.edit('linked', 'no', null)).rejects.toThrow('リンク');
    await expect(r.changes.edit('../outside.txt', 'no', null)).rejects.toThrow();
    await mkdir(`${r.home}/node_modules`, { recursive: true });
    await writeFile(`${r.home}/node_modules/existing`, 'preserve');
    const ignored = await r.changes.detail('node_modules/existing');
    await expect(
      r.changes.restore('node_modules/existing', ignored.sha256, ignored.baselineId),
    ).rejects.toThrow();
  } finally {
    await r.dispose();
  }
});
