import { expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { conversations } from '../src/server/db/schema';
import { fixture } from './helpers';
import { createHttp } from '../src/server/http';

test('AI settings use the same revisioned configuration as the UI and cannot write secrets or take desktop control', async () => {
  const r = await fixture();
  try {
    const tool = r.agent.tools(r.id).find((t) => t.name === 'settings_update')!;
    expect(tool.parameters.type).toBe('object');
    const revision = r.config.read().revision;
    await tool.execute({
      revision,
      change: {
        section: 'search',
        value: { engine: 'searxng', baseUrl: 'https://search.example' },
      },
    });
    expect(r.config.public().search?.baseUrl).toBe('https://search.example');
    await expect(
      tool.execute({ revision, change: { section: 'retention', value: {} } }),
    ).rejects.toThrow('Configuration changed');
    await expect(
      tool.execute({
        revision: revision + 1,
        change: {
          section: 'search',
          value: { engine: 'brave', baseUrl: 'https://search.example', credential: 'hidden' },
        },
      }),
    ).rejects.toThrow();
    r.desktop.handoff('human');
    const epoch = r.desktop.status().epoch;
    await tool.execute({
      revision: revision + 1,
      change: { section: 'desktop', value: { name: 'New screen', vncPort: 5901 } },
    });
    expect(r.desktop.status().owner).toBe('human');
    expect(r.desktop.status().epoch).toBeGreaterThan(epoch);
    const { app } = createHttp(r);
    const response = await app.request('/api/config/retention', {
      method: 'PUT',
      headers: {
        Authorization: `Basic ${Buffer.from('owner:test-only-password-123').toString('base64')}`,
        'X-Vibe-Coder': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        revision: r.config.read().revision,
        retention: { conversationDays: 45 },
      }),
    });
    expect(response.status).toBe(200);
    expect(r.config.public().retention?.conversationDays).toBe(45);
  } finally {
    await r.dispose();
  }
});

test('AI can change its next model with existing endpoint credentials, but cannot interrupt another running conversation', async () => {
  const r = await fixture();
  try {
    const tool = r.agent.tools(r.id).find((t) => t.name === 'settings_update')!;
    const provider = {
      baseUrl: 'https://provider.example/v1',
      model: 'first',
      keyRequired: true,
      supportsImages: true,
    };
    r.config.update(r.config.read().revision, (c) => {
      c.provider = { ...provider, revision: 1 };
    });
    r.vault.put('provider:main', 1, crypto.randomUUID(), 'test-only-key');
    r.store.db
      .update(conversations)
      .set({ state: 'running' })
      .where(eq(conversations.id, r.id))
      .run();
    const change = { section: 'provider', value: { ...provider, model: 'second' } };
    const result = await tool.execute({ revision: r.config.read().revision, change });
    expect(JSON.stringify(result)).not.toContain('test-only-key');
    expect(r.vault.get('provider:main', r.config.read().provider!.revision)).toBe('test-only-key');
    const other = r.store.createConversation();
    r.store.db
      .update(conversations)
      .set({ state: 'running' })
      .where(eq(conversations.id, other.id))
      .run();
    await expect(
      tool.execute({
        revision: r.config.read().revision,
        change: { section: 'provider', value: { ...provider, model: 'third' } },
      }),
    ).rejects.toThrow('実行が完了');
    r.store.db
      .update(conversations)
      .set({ state: 'idle' })
      .where(eq(conversations.id, other.id))
      .run();
    await tool.execute({
      revision: r.config.read().revision,
      change: {
        section: 'provider',
        value: { ...provider, baseUrl: 'https://another.example/v1' },
      },
    });
    expect(r.vault.get('provider:main', r.config.read().provider!.revision)).toBeUndefined();
  } finally {
    await r.dispose();
  }
});
