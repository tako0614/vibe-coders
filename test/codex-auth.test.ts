import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, eventually, calls, answer } from './helpers';
import { createHttp } from '../src/server/http';
const headers = {
  Authorization: `Basic ${Buffer.from('owner:test-only-password-123').toString('base64')}`,
  'X-Vibe-Coder': '1',
  'Content-Type': 'application/json',
};
const useAuthFixture = async (r: Awaited<ReturnType<typeof fixture>>) => {
  const state = join(r.root, 'auth-state.json');
  await Bun.write(state, '{}');
  r.codex.command.splice(
    0,
    r.codex.command.length,
    process.execPath,
    fileURLToPath(new URL('./fixtures/codex-auth.ts', import.meta.url)),
    state,
  );
  return state;
};

test('Codex sign-in runs independently, keeps private auth out of history, and allows concurrent parent work', async () => {
  let step = 0;
  const r = await fixture({
    async call() {
      return step++ === 0
        ? calls(['codex_login', { method: 'device' }], ['file_read', { path: 'AGENT.md' }])
        : answer;
    },
  });
  const { app } = createHttp(r);
  try {
    const state = await useAuthFixture(r);
    r.agent.submit(r.id, 'Start Codex and keep reading.', crypto.randomUUID());
    await eventually(() => r.codex.status().state === 'waiting' && step >= 2);
    expect(
      r.store
        .history(r.id)
        .some((m) => m.body.role === 'tool' && m.body.content.includes('sha256')),
    ).toBe(true);
    const card = r.human.get(r.codex.status().requestId!);
    expect(r.desktop.status().owner).toBe('human');
    expect(() =>
      r.human.answer(card.id, {
        revision: card.revision,
        operationId: crypto.randomUUID(),
        values: {},
      }),
    ).toThrow();
    expect((await app.request('/api/codex/auth')).status).toBe(401);
    expect(
      (
        await app.request('/api/codex/auth/cancel', {
          method: 'POST',
          headers: { Authorization: headers.Authorization },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    const response = await app.request('/api/codex/auth', { headers });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(((await response.json()) as any).login.code).toBe('PRIVATE-CODE-234');
    const visible = JSON.stringify([
      r.codex.status(),
      r.store.snapshot(r.id),
      r.store.history(r.id),
    ]);
    for (const value of [
      'PRIVATE-CODE-234',
      'auth.openai.com',
      'private-stderr-auth-marker',
      'private-account@example.invalid',
    ])
      expect(visible).not.toContain(value);
    await Bun.write(state, JSON.stringify({ signedIn: true, finish: true }));
    await eventually(() => r.codex.status().state === 'signed_in');
    expect(r.human.get(card.id)).toMatchObject({
      state: 'resolved',
      result: { verification: 'verified' },
    });
    expect(r.codex.userStatus()).toMatchObject({ ready: true, state: 'signed_in', login: null });
    const log = (await Bun.file(`${state}.calls`).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(log.filter((row) => row.method === 'turn/start')).toEqual([]);
    expect(r.desktop.status().owner).toBe('human');
    expect(JSON.stringify(r.store.snapshot(r.id))).not.toContain('private-account');
  } finally {
    await r.dispose();
  }
}, 15000);

test('Codex login cancel/all-stop terminate attempts; mismatched completions and unsafe URLs cannot authenticate', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const state = await useAuthFixture(r);
    const first = r.codex.start(r.id);
    await eventually(() => r.codex.status().state === 'waiting');
    expect(r.codex.start(r.id).requestId).toBe(first.requestId);
    await Bun.write(state, JSON.stringify({ finish: true, wrongId: true }));
    await Bun.sleep(80);
    expect(r.codex.status().ready).toBe(false);
    expect(r.human.get(first.requestId!).state).toBe('pending');
    r.human.close(first.requestId!);
    await eventually(() => !r.codex.status().requestId);
    expect(await Bun.file(`${state}.calls`).text()).toContain('account/login/cancel');
    await Bun.write(state, '{}');
    r.codex.start(r.id, 'browser');
    await eventually(() => r.codex.status().state === 'waiting');
    expect(r.codex.userStatus().login?.url).toContain('private-auth-url-marker');
    expect(JSON.stringify(r.store.snapshot(r.id))).not.toContain('private-auth-url-marker');
    r.agent.stopAll();
    await eventually(() => !r.codex.status().requestId);
    expect(r.codex.userStatus().login).toBeNull();
    expect(() => r.codex.start(r.id)).toThrow();
    r.agent.enable();
    await Bun.write(state, JSON.stringify({ invalidUrl: true }));
    r.codex.start(r.id);
    await eventually(() => !r.codex.status().requestId);
    expect(r.codex.status().ready).toBe(false);
    expect(r.codex.userStatus().login).toBeNull();
  } finally {
    await r.dispose();
  }
}, 15000);

test('failed Codex login cannot unblock a queued run and a missing CLI is reported without a login card', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const state = await useAuthFixture(r);
    const pending = r.codex.ensure(r.id, new AbortController().signal).then(
      () => false,
      () => true,
    );
    await eventually(() => r.codex.status().state === 'waiting');
    await Bun.write(state, JSON.stringify({ finish: true, success: false }));
    expect(await pending).toBe(true);
    expect(await Bun.file(`${state}.calls`).text()).not.toContain('turn/start');
    expect(JSON.stringify(r.store.snapshot(r.id))).not.toContain('private-error-marker');
    r.codex.command.splice(0, r.codex.command.length, '/missing-codex-test-binary');
    expect((await r.codex.refresh()).state).toBe('missing');
    expect(() => r.codex.start(r.id)).toThrow('Install');
  } finally {
    await r.dispose();
  }
}, 15000);
