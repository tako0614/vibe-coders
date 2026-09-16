import { expect, test } from 'bun:test';
import { fixture, calls, eventually } from './helpers';
import { memoryWriteSchema } from '../src/shared/memory';

const note = (text: string, extras = {}) => memoryWriteSchema.parse({ text, ...extras });
test('memory catalog, sources, links, revisions and delivered-use records survive real writes', async () => {
  const r = await fixture();
  try {
    r.store.message(
      r.id,
      { role: 'user', content: 'Deploy with the staged package after the checks pass.' },
      'source-message',
    );
    const source = await r.memory.capture(r.id, 'source-message');
    const a = await r.memory.write(
      note('Release procedure\nUse the staged package.', { sources: [source.ref] }),
    );
    const b = await r.memory.write(
      note('Validation\nRun the package checks.', {
        links: [{ role: 'supports', ref: a.ref }],
        sources: [source.ref],
      }),
    );
    const identity = r.memory.identity(a.ref);
    const detail = await r.memory.detail(identity.id);
    expect(detail.sources[0]!.item!.capturedSource?.messageId).toBe('source-message');
    expect(detail.incoming[0]!.ref).toBe(b.ref);
    expect((await r.memory.list()).items).toHaveLength(2);
    expect((await r.memory.list('', 'sources')).items).toHaveLength(1);
    const revised = await r.memory.write(
      note('Release procedure\nUse the checked staged package.', { sources: [source.ref] }),
      { ref: a.ref, actor: 'human' },
    );
    await expect(r.memory.write(note('stale overwrite'), { ref: a.ref })).rejects.toThrow('更新');
    const latest = await r.memory.detail(identity.id);
    expect(latest.history).toHaveLength(2);
    expect((await r.memory.detail(identity.id, identity.revisionId)).text).toBe(a.text);
    r.memory.acknowledge([revised.ref], 'delivered-response', r.id);
    expect((await r.memory.detail(identity.id)).usedIn[0]!.messageId).toBe('delivered-response');
    await expect(r.memory.write(note('rewrite a source'), { ref: source.ref })).rejects.toThrow(
      '出典',
    );
    await r.memory.retire(b.ref);
    expect((await r.memory.list('', 'retired')).items[0]!.id).toBe(r.memory.identity(b.ref).id);
  } finally {
    await r.dispose();
  }
});

test('writer validates source aliases, creates relationships and keeps an idempotent cursor', async () => {
  let callsCount = 0;
  const r = await fixture({
    async call(input) {
      callsCount++;
      const supplied = JSON.parse(input.messages[0]!.content);
      expect(supplied.sources[0].text).toContain('VIOLET_SWITCH');
      return calls([
        'memory_organize',
        {
          notes: [
            { text: 'VIOLET_SWITCH\nDeploys are staged first.', sources: ['S1'], links: [] },
            {
              text: 'Package validation\nCheck the runnable tarball.',
              sources: ['S2'],
              links: [{ target: 'N1', role: 'validates' }],
            },
          ],
        },
      ]);
    },
  });
  try {
    r.store.message(r.id, { role: 'user', content: 'VIOLET_SWITCH must stage releases.' });
    r.store.message(r.id, {
      role: 'tool',
      content: 'The runnable tarball passed its package check.',
    });
    r.memoryWriter.enqueue(r.id);
    await r.memoryWriter.drain();
    const job = r.memoryWriter.jobs()[0]!;
    expect(job.state).toBe('complete');
    expect(job.saved).toBe(2);
    const page = await r.memory.list();
    expect(page.total).toBe(2);
    expect(page.linkCount).toBe(1);
    expect(page.sourceCount).toBe(2);
    expect((await r.memory.recall('VIOLET_SWITCH', 6000)).text).toContain('Package validation');
    r.memoryWriter.enqueue(r.id);
    await r.memoryWriter.drain();
    expect(callsCount).toBe(1);
    expect((await r.memory.list()).total).toBe(2);
  } finally {
    await r.dispose();
  }
});

test('writer refuses fabricated citations and ordinary conversation continues when recall fails', async () => {
  const r = await fixture({
    async call(input) {
      if (input.tools.some((t) => t.name === 'memory_organize'))
        return calls([
          'memory_organize',
          { notes: [{ text: 'Unjustified assertion', sources: ['invented'], links: [] }] },
        ]);
      return { role: 'assistant', content: 'The conversation still works.' };
    },
  });
  try {
    r.store.message(r.id, { role: 'user', content: 'A real source.' });
    r.memoryWriter.enqueue(r.id);
    await r.memoryWriter.drain();
    expect(r.memoryWriter.jobs()[0]!.state).toBe('error');
    expect((await r.memory.list()).total).toBe(0);
    r.memory.recall = async () => {
      throw new Error('SQLITE_BUSY');
    };
    r.agent.submit(r.id, 'Continue.', crypto.randomUUID());
    await eventually(
      () =>
        r.store.conversation(r.id).state === 'idle' &&
        r.store.history(r.id).some((m) => m.body.content === 'The conversation still works.'),
    );
    const response = r.store
      .history(r.id)
      .find((m) => m.body.content === 'The conversation still works.');
    expect(response?.body.memoryWarning).toContain('記憶の取得に失敗');
  } finally {
    await r.dispose();
  }
});

test('a stale writer plan is regenerated on retry and keeps the concurrent human revision', async () => {
  let attempts = 0;
  let r: Awaited<ReturnType<typeof fixture>>;
  r = await fixture({
    async call(input) {
      attempts++;
      const supplied = JSON.parse(input.messages[0]!.content);
      expect(supplied.memories[0].text).toContain('MAGENTA_CHECK');
      if (attempts === 1) {
        const item = (await r.memory.list()).items[0]!;
        await r.memory.write(note('MAGENTA_CHECK\nHuman added a rollback requirement.'), {
          ref: item.ref,
          actor: 'human',
        });
      } else expect(supplied.memories[0].text).toContain('rollback');
      return calls([
        'memory_organize',
        {
          notes: [
            {
              text:
                attempts === 1
                  ? 'MAGENTA_CHECK\nWould overwrite the human revision.'
                  : 'MAGENTA_CHECK\nPreserve rollback and verify the staged package.',
              sources: ['S1'],
              revise: 'M1',
              links: [],
            },
          ],
        },
      ]);
    },
  });
  try {
    await r.memory.write(note('MAGENTA_CHECK\nVerify the staged package.'));
    r.store.message(r.id, {
      role: 'user',
      content: 'MAGENTA_CHECK needs staged package verification.',
    });
    r.memoryWriter.enqueue(r.id);
    await r.memoryWriter.drain();
    expect(r.memoryWriter.jobs()[0]!.state).toBe('error');
    expect((await r.memory.list()).items[0]!.preview).toContain('Human added');
    r.memoryWriter.enqueue(r.id);
    await r.memoryWriter.drain();
    expect(r.memoryWriter.jobs()[0]!.state).toBe('complete');
    expect(attempts).toBe(2);
    expect((await r.memory.list()).total).toBe(1);
    expect((await r.memory.list()).items[0]!.preview).toContain('Preserve rollback');
  } finally {
    await r.dispose();
  }
});

test('catalog paging stays newest-first and search respects source and archive tabs', async () => {
  const r = await fixture();
  try {
    for (let i = 0; i < 32; i++) await r.memory.write(note(`Catalog item ${i}`));
    const first = await r.memory.list();
    const second = await r.memory.list('', 'memories', first.cursor);
    expect(first.items).toHaveLength(30);
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(32);
    expect(first.items[0]!.updatedAt >= first.items.at(-1)!.updatedAt).toBe(true);
    r.store.message(
      r.id,
      { role: 'user', content: 'Searchable source MAGENTA_NEEDLE' },
      'search-source',
    );
    await r.memory.capture(r.id, 'search-source');
    expect((await r.memory.list('MAGENTA_NEEDLE', 'sources')).items).toHaveLength(1);
    expect((await r.memory.list('MAGENTA_NEEDLE', 'memories')).items).toHaveLength(0);
    const archived = await r.memory.write(note('Archived MAGENTA_NEEDLE'));
    await r.memory.retire(archived.ref);
    expect((await r.memory.list('MAGENTA_NEEDLE', 'retired')).items).toHaveLength(1);
  } finally {
    await r.dispose();
  }
});
