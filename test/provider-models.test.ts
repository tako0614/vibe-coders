import { expect, test } from 'bun:test';
import { fixture } from './helpers';
import { createHttp } from '../src/server/http';
import { providerModels } from '../src/server/provider-models';
import { fileURLToPath } from 'node:url';

const headers = {
  Authorization: `Basic ${Buffer.from('owner:test-only-password-123').toString('base64')}`,
  'X-Vibe-Coder': '1',
  'Content-Type': 'application/json',
};
test('model discovery works before configuration and keeps temporary credentials out of state and errors', async () => {
  const r = await fixture();
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      seen.push(request.headers.get('authorization') || '');
      if (request.headers.get('authorization') !== 'Bearer transient-key')
        return new Response('transient-key', { status: 401 });
      return Response.json({
        data: [
          { id: 'vendor/b', name: 'Beta' },
          { id: 'vendor/a', name: 'Alpha' },
          { id: 'transient-key', name: 'never expose' },
        ],
      });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}/v1`;
  try {
    const { app } = createHttp(r);
    expect(
      (
        await app.request('/api/config/provider/models', {
          method: 'POST',
          body: JSON.stringify({ baseUrl }),
        })
      ).status,
    ).toBe(401);
    const list = await app.request('/api/config/provider/models', {
      method: 'POST',
      headers,
      body: JSON.stringify({ baseUrl, credential: 'transient-key' }),
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([
      { id: 'vendor/a', name: 'Alpha' },
      { id: 'vendor/b', name: 'Beta' },
    ]);
    expect(seen).toEqual(['Bearer transient-key']);
    expect(r.config.read().provider).toBeUndefined();
    expect(JSON.stringify(r.store.snapshot(r.id))).not.toContain('transient-key');
    expect(r.vault.get('provider:main', 1)).toBeUndefined();
    const rejected = await app.request('/api/config/provider/models', {
      method: 'POST',
      headers,
      body: JSON.stringify({ baseUrl }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain('transient-key');
  } finally {
    server.stop(true);
    await r.dispose();
  }
});

test('changing only the model retains the saved API key; discovery and save never transfer it to another URL', async () => {
  const r = await fixture();
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      seen.push(request.headers.get('authorization') || '');
      return Response.json({ data: [{ id: 'model' }] });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}/first`;
  try {
    const { app } = createHttp(r);
    const save = (url: string, model: string, credential?: string, keyRequired = true) =>
      app.request('/api/config/provider', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          revision: r.config.read().revision,
          provider: { kind: 'openai', baseUrl: url, model, keyRequired },
          ...(credential ? { credential } : {}),
        }),
      });
    expect((await save(baseUrl, 'one', 'saved-key')).status).toBe(200);
    expect((await save(baseUrl + '/', 'two')).status).toBe(200);
    expect(r.vault.get('provider:main', r.config.read().provider!.revision)).toBe('saved-key');
    await providerModels(r.config, r.vault, { baseUrl });
    await providerModels(r.config, r.vault, { baseUrl: baseUrl + '-other' });
    await providerModels(r.config, r.vault, { baseUrl, useSavedCredential: false });
    expect(seen).toEqual(['Bearer saved-key', '', '']);
    expect((await save(baseUrl, 'three', undefined, false)).status).toBe(200);
    expect(r.vault.get('provider:main', r.config.read().provider!.revision)).toBeUndefined();
    expect((await save(baseUrl, 'four', 'new-key')).status).toBe(200);
    expect((await save(baseUrl + '-other', 'five')).status).toBe(200);
    expect(r.vault.get('provider:main', r.config.read().provider!.revision)).toBeUndefined();
    expect(JSON.stringify(r.config.public())).not.toContain('new-key');
    expect(JSON.stringify(r.store.snapshot(r.id))).not.toContain('new-key');
  } finally {
    server.stop(true);
    await r.dispose();
  }
});

test('model discovery refuses redirects and validates malformed catalogs without reflecting remote bodies', async () => {
  const r = await fixture();
  let redirected = false;
  const target = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      redirected = true;
      return Response.json({ data: [] });
    },
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname.startsWith('/redirect')
        ? Response.redirect(`http://127.0.0.1:${target.port}/models`)
        : new Response('remote-secret-body');
    },
  });
  try {
    await expect(
      providerModels(r.config, r.vault, {
        baseUrl: `http://127.0.0.1:${server.port}/redirect`,
        credential: 'key',
      }),
    ).rejects.toThrow('接続');
    expect(redirected).toBe(false);
    await expect(
      providerModels(r.config, r.vault, { baseUrl: `http://127.0.0.1:${server.port}/bad` }),
    ).rejects.toThrow('形式');
  } finally {
    server.stop(true);
    target.stop(true);
    await r.dispose();
  }
});

test('existing native Codex file credentials work without starting a login process or copying secrets', async () => {
  const r = await fixture();
  try {
    const token = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.private-native-token`;
    await Bun.write(
      r.codex.credentialFile,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: token, account_id: 'native-account' },
      }),
    );
    const before = await Bun.file(r.codex.credentialFile).text();
    r.codex.command.splice(0, r.codex.command.length, '/missing-codex-proves-no-login');
    const status = await r.codex.refresh();
    expect(status).toMatchObject({
      subscriptionReady: true,
      credentialSource: 'native-file',
      installed: false,
    });
    expect(await r.codex.subscriptionCredentials()).toEqual({ token, accountId: 'native-account' });
    expect(r.store.snapshot(r.id).requests).toHaveLength(0);
    expect(JSON.stringify(r.codex.userStatus())).not.toContain(token);
    expect(JSON.stringify(r.config.public())).not.toContain(token);
    expect(await Bun.file(r.codex.credentialFile).text()).toBe(before);
  } finally {
    await r.dispose();
  }
});

test('a native account without readable file tokens is not reported as subscription ready or sent into another login', async () => {
  const r = await fixture();
  try {
    const state = `${r.root}/native-account.json`;
    await Bun.write(state, JSON.stringify({ signedIn: true }));
    r.codex.command.splice(
      0,
      r.codex.command.length,
      process.execPath,
      fileURLToPath(new URL('./fixtures/codex-auth.ts', import.meta.url)),
      state,
    );
    expect(await r.codex.refresh()).toMatchObject({
      ready: true,
      subscriptionReady: false,
      credentialSource: null,
    });
    await expect(r.codex.subscriptionCredentials()).rejects.toThrow(
      'CODEX_CREDENTIALS_UNAVAILABLE',
    );
    expect(r.store.snapshot(r.id).requests).toHaveLength(0);
    expect(await Bun.file(`${state}.calls`).text()).not.toContain('account/login/start');
  } finally {
    await r.dispose();
  }
});
