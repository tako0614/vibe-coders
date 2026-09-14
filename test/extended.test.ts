import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { fixture, eventually } from './helpers';
import { verifyProvider } from '../src/server/credentials';
import { searchWeb, extractPdf } from '../src/server/content';
import { prune } from '../src/server/retention';
import { conversations, messages, events } from '../src/server/db/schema';

test('H11: invalid credentials reopen the same card; transient failures retain the saved key', async () => {
  let code = 401;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('{}', { status: code }),
  });
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    r.config.update(r.config.read().revision, (c) => {
      c.provider = {
        revision: 1,
        baseUrl: `${server.url}v1`,
        model: 'test',
        keyRequired: true,
        supportsImages: true,
      };
    });
    r.human.verifyCredential = (target, revision) => verifyProvider(r.config, r.vault, revision);
    const card = r.human.create(r.id, {
      kind: 'secret',
      title: 'Key',
      targetId: 'provider:main',
      fields: [{ name: 'key', label: 'Key', type: 'secret' }],
    });
    const operationId = crypto.randomUUID();
    r.human.submitSecret(card.id, { revision: 1, operationId, values: { key: 'bad-private-key' } });
    await eventually(() => r.human.get(card.id).revision === 2);
    expect(r.human.get(card.id).state).toBe('pending');
    expect(() =>
      r.human.answer(
        card.id,
        { revision: 1, operationId, values: { key: 'bad-private-key' } },
        true,
      ),
    ).toThrow();
    code = 503;
    r.human.submitSecret(card.id, {
      revision: 2,
      operationId: crypto.randomUUID(),
      values: { key: 'good-private-key' },
    });
    await eventually(() => r.human.get(card.id).result?.verification === 'temporary_error');
    expect(r.vault.get('provider:main', 1)).toBe('good-private-key');
    expect(r.human.get(card.id).state).toBe('resolved');
    code = 200;
    await r.human.verify(card.id);
    expect(r.human.get(card.id).result?.verification).toBe('verified');
    expect(JSON.stringify(r.store.snapshot(r.id))).not.toContain('private-key');
  } finally {
    await r.dispose();
    server.stop(true);
  }
});

test('event schedules see consumed events once and exclude events older than registration', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    r.store.event(r.id, 'run.completed', { runId: 'target' });
    const schedule = r.scheduler.create(r.id, {
      title: 'After target',
      prompt: 'Check',
      nextAt: 1,
      trigger: { event: 'run.completed', runId: 'target', repeat: true },
    });
    r.scheduler.tick();
    expect(r.scheduler.get(schedule.id).lastAt).toBeNull();
    r.store.event(r.id, 'run.completed', { runId: 'other' });
    r.store.event(r.id, 'run.completed', { runId: 'target' });
    r.store.db.update(events).set({ consumed: true }).run();
    r.scheduler.tick();
    r.scheduler.tick();
    const fired = r.store.inbox(r.id).filter((e) => e.type === 'schedule.fired');
    expect(fired.length).toBe(1);
    expect(fired[0].payload.trigger).toBe('run.completed');
    r.agent.stopAll();
    r.store.event(r.id, 'run.completed', { runId: 'target' });
    r.scheduler.tick();
    expect(r.store.inbox(r.id).filter((e) => e.type === 'schedule.fired').length).toBe(1);
  } finally {
    await r.dispose();
  }
});

test('retention removes expired images and idle history while protecting pending human work', async () => {
  const r = await fixture();
  try {
    const old = Date.now() - 100 * 86400000;
    r.agent.pause(r.id, true);
    r.store.message(r.id, {
      role: 'user',
      content: 'Keep text',
      images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    });
    r.store.db.update(messages).set({ createdAt: old }).run();
    const abandoned = r.store.createConversation('Expired');
    const pending = r.store.createConversation('Needs user');
    r.store.db
      .update(conversations)
      .set({ createdAt: old })
      .where(eq(conversations.id, abandoned.id))
      .run();
    r.store.db
      .update(conversations)
      .set({ createdAt: old })
      .where(eq(conversations.id, pending.id))
      .run();
    r.human.create(pending.id, { kind: 'action', title: 'Wait for user' });
    r.config.update(r.config.read().revision, (c) => {
      c.retention = { imageDays: 30, runDays: 30, conversationDays: null };
    });
    expect(prune(r.store, r.config).images).toBe(1);
    expect(r.store.history(r.id)[0].body.images).toBeUndefined();
    r.config.update(r.config.read().revision, (c) => {
      c.retention!.conversationDays = 90;
    });
    prune(r.store, r.config);
    expect(() => r.store.conversation(abandoned.id)).toThrow();
    expect(r.store.conversation(pending.id).title).toBe('Needs user');
  } finally {
    await r.dispose();
  }
});

test('search returns bounded attributed results using the configured provider', async () => {
  let query = '';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      query = new URL(req.url).searchParams.get('q') || '';
      return Response.json({
        results: [{ title: 'Source', url: 'https://example.org/doc', content: 'Excerpt' }],
      });
    },
  });
  const r = await fixture();
  try {
    r.config.update(r.config.read().revision, (c) => {
      c.search = { revision: 1, engine: 'searxng', baseUrl: `${server.url}search` };
    });
    const found = await searchWeb(r.config, r.vault, 'a & b');
    expect(query).toBe('a & b');
    expect(found.results[0].url).toBe('https://example.org/doc');
    expect(found.nextPage).toBeNull();
  } finally {
    await r.dispose();
    server.stop(true);
  }
});

test('PDF extraction uses an actual PDF text layer and rejects malformed bytes', async () => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 44 >>\nstream\nBT /F1 12 Tf 20 250 Td (PDF evidence) Tj ET\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  expect((await extractPdf(Buffer.from(pdf))).text).toContain('PDF evidence');
  await expect(extractPdf(Buffer.from('not a PDF'))).rejects.toThrow();
});
