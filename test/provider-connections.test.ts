import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { fixture } from './helpers';
import { Config, Vault } from '../src/server/config';
import {
  saveProvider,
  providerConnections,
  savedProviderCredential,
} from '../src/server/provider-connections';
import { providerId, providerPresets } from '../src/shared/models';
import { createHttp } from '../src/server/http';
import { providerModels } from '../src/server/provider-models';
import { conversations } from '../src/server/db/schema';

const headers = {
  Authorization: `Basic ${Buffer.from('owner:test-only-password-123').toString('base64')}`,
  'X-Vibe-Coder': '1',
  'Content-Type': 'application/json',
};

test('API connections retain separate keys, models and efforts across Codex switches and process reload', async () => {
  const r = await fixture();
  try {
    const router = {
      ...providerPresets[1],
      model: 'router-model',
      reasoningEffort: 'high' as const,
    };
    const openai = {
      ...providerPresets[2],
      model: 'openai-model',
      reasoningEffort: 'low' as const,
    };
    const codex = { ...providerPresets[0], model: 'codex-model', reasoningEffort: 'max' as const };
    const save = (provider: typeof router | typeof openai | typeof codex, credential?: string) =>
      saveProvider(r.config, r.vault, r.config.read().revision, provider, credential);
    save(router, 'router-private-token');
    save(codex);
    save(openai, 'openai-private-token');
    save(codex);
    // Re-open both stores, as a new process would after a restart.
    const config = new Config(r.config.directory),
      vault = new Vault(r.config.directory);
    const { app } = createHttp(r);
    const activate = (id: string, revision = config.read().revision) =>
      app.request('/api/config/provider/activate', {
        method: 'POST',
        headers,
        body: JSON.stringify({ revision, id }),
      });
    expect((await activate(providerId(router))).status).toBe(200);
    expect(config.read().provider).toMatchObject(router);
    expect(vault.get('provider:main', config.read().provider!.revision)).toBe(
      'router-private-token',
    );
    expect((await activate(providerId(openai))).status).toBe(200);
    expect(config.read().provider).toMatchObject(openai);
    expect(vault.get('provider:main', config.read().provider!.revision)).toBe(
      'openai-private-token',
    );
    expect(
      providerConnections(config, vault).find((c) => c.id === 'codex')?.provider,
    ).toMatchObject(codex);
    const status = await (await app.request('/api/status', { headers })).text();
    for (const secret of ['router-private-token', 'openai-private-token']) {
      expect(status).not.toContain(secret);
      expect(readFileSync(config.path, 'utf8')).not.toContain(secret);
      expect(readFileSync(`${config.directory}/vault.enc`).includes(Buffer.from(secret))).toBe(
        false,
      );
      expect(JSON.stringify(r.store.snapshot(r.id))).not.toContain(secret);
      expect(vault.redact(`log ${secret}`)).toBe('log [REDACTED]');
    }
    expect((await activate(providerId(router), config.read().revision - 1)).status).toBe(400);
    expect(config.read().provider?.baseUrl).toBe(openai.baseUrl);
    r.store.db
      .update(conversations)
      .set({ state: 'running' })
      .where(eq(conversations.id, r.id))
      .run();
    expect((await activate(providerId(router))).status).toBe(400);
    expect(config.read().provider?.baseUrl).toBe(openai.baseUrl);
    r.store.db.update(conversations).set({ state: 'idle' }).where(eq(conversations.id, r.id)).run();
  } finally {
    await r.dispose();
  }
});

test('keys from legacy config and later dedicated secret inputs are archived before switching', async () => {
  const r = await fixture();
  try {
    const provider = { ...providerPresets[1], model: 'legacy-model' };
    r.config.update(r.config.read().revision, (config) => {
      config.provider = { ...provider, revision: 8 };
    });
    r.vault.put('provider:main', 8, crypto.randomUUID(), 'legacy-private-key');
    saveProvider(r.config, r.vault, r.config.read().revision, providerPresets[0]);
    expect(savedProviderCredential(r.config, r.vault, provider.baseUrl)).toBe('legacy-private-key');
    saveProvider(r.config, r.vault, r.config.read().revision, provider);
    const card = r.human.create(r.id, {
      kind: 'secret',
      title: 'Replace API key',
      targetId: 'provider:main',
      fields: [{ name: 'value', label: 'API key', type: 'secret', required: true }],
    });
    r.human.answer(
      card.id,
      {
        revision: card.revision,
        operationId: crypto.randomUUID(),
        values: { value: 'replacement-private-key' },
      },
      true,
    );
    saveProvider(r.config, r.vault, r.config.read().revision, providerPresets[0]);
    expect(savedProviderCredential(r.config, r.vault, provider.baseUrl)).toBe(
      'replacement-private-key',
    );
    saveProvider(r.config, r.vault, r.config.read().revision, provider);
    expect(r.vault.get('provider:main', r.config.read().provider!.revision)).toBe(
      'replacement-private-key',
    );
  } finally {
    await r.dispose();
  }
});

test('saved credentials only reach the exact normalized endpoint, including when its connection is inactive', async () => {
  const r = await fixture();
  const seen: { path: string; key: string | null }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      seen.push({ path: new URL(request.url).pathname, key: request.headers.get('authorization') });
      return Response.json({ data: [{ id: 'model' }] });
    },
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}/first`;
    saveProvider(
      r.config,
      r.vault,
      r.config.read().revision,
      { ...providerPresets[1], baseUrl },
      'endpoint-one-key',
    );
    saveProvider(
      r.config,
      r.vault,
      r.config.read().revision,
      { ...providerPresets[1], baseUrl: baseUrl + '-other' },
      'endpoint-two-key',
    );
    saveProvider(r.config, r.vault, r.config.read().revision, providerPresets[0]);
    await providerModels(r.config, r.vault, { baseUrl: baseUrl + '/' });
    await providerModels(r.config, r.vault, { baseUrl: baseUrl + '-other' });
    await providerModels(r.config, r.vault, { baseUrl: baseUrl + '-unknown' });
    await providerModels(r.config, r.vault, { baseUrl, useSavedCredential: false });
    expect(seen.map((s) => s.key)).toEqual([
      'Bearer endpoint-one-key',
      'Bearer endpoint-two-key',
      null,
      null,
    ]);
    saveProvider(r.config, r.vault, r.config.read().revision, {
      ...providerPresets[1],
      baseUrl,
      keyRequired: false,
    });
    await providerModels(r.config, r.vault, { baseUrl });
    expect(seen.at(-1)?.key).toBeNull();
    // Keep the saved key for an explicit switch back to authenticated use.
    saveProvider(r.config, r.vault, r.config.read().revision, { ...providerPresets[1], baseUrl });
    expect(r.vault.get('provider:main', r.config.read().provider!.revision)).toBe(
      'endpoint-one-key',
    );
  } finally {
    server.stop(true);
    await r.dispose();
  }
});

test('deleting a saved key invalidates old input cards and does not resurrect it on a later switch', async () => {
  const r = await fixture();
  try {
    const router = {
      ...providerPresets[1],
      model: 'retained-model',
      reasoningEffort: 'high' as const,
    };
    saveProvider(r.config, r.vault, r.config.read().revision, router, 'remove-me-private-key');
    const card = r.human.create(r.id, {
      kind: 'secret',
      title: 'Old input',
      targetId: 'provider:main',
      fields: [{ name: 'value', label: 'API key', type: 'secret', required: true }],
    });
    const { app } = createHttp(r);
    const response = await app.request('/api/config/provider/credential', {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ revision: r.config.read().revision, id: providerId(router) }),
    });
    expect(response.status).toBe(200);
    expect(() =>
      r.human.answer(
        card.id,
        {
          revision: card.revision,
          operationId: crypto.randomUUID(),
          values: { value: 'stale-key' },
        },
        true,
      ),
    ).toThrow();
    saveProvider(r.config, r.vault, r.config.read().revision, providerPresets[0]);
    saveProvider(r.config, r.vault, r.config.read().revision, router);
    expect(savedProviderCredential(r.config, r.vault, router.baseUrl)).toBeUndefined();
    expect(r.vault.get('provider:main', r.config.read().provider!.revision)).toBeUndefined();
    expect(r.config.read().provider).toMatchObject(router);
    expect(
      providerConnections(r.config, r.vault).find((c) => c.id === providerId(router))
        ?.credentialSaved,
    ).toBe(false);
  } finally {
    await r.dispose();
  }
});
