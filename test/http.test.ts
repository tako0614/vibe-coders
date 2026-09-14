import { describe, expect, test } from 'bun:test';
import { fixture } from './helpers';
import { createHttp } from '../src/server/http';

const auth = `Basic ${Buffer.from('owner:test-only-password-123').toString('base64')}`;
describe('authenticated API boundaries', () => {
  test('C14: API, files, secrets, static assets and socket require authentication', async () => {
    const r = await fixture();
    const { app } = createHttp(r);
    try {
      for (const path of [
        '/api/status',
        '/api/files?path=.',
        '/api/memory',
        '/api/desktop/socket',
        '/',
        '/assets/app.js',
      ])
        expect((await app.request(path)).status).toBe(401);
      const status = await app.request('/api/status', { headers: { Authorization: auth } });
      expect(status.status).toBe(200);
      const serialized = await status.text();
      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('test-only-password');
    } finally {
      await r.dispose();
    }
  });
  test('C14: mutations require a custom header and reject cross-origin requests', async () => {
    const r = await fixture();
    const { app } = createHttp(r);
    try {
      const base = {
        method: 'POST',
        body: '{}',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
      };
      expect((await app.request('/api/conversations', base)).status).toBe(403);
      expect(
        (
          await app.request('/api/conversations', {
            ...base,
            headers: { ...base.headers, 'X-Vibe-Coder': '1', Origin: 'https://hostile.example' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request('/api/conversations', {
            ...base,
            headers: { ...base.headers, 'X-Vibe-Coder': '1', Origin: 'http://127.0.0.1:3100' },
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await app.request('/api/status', {
            headers: { Authorization: auth, Origin: 'https://hostile.example' },
          })
        ).status,
      ).toBe(403);
    } finally {
      await r.dispose();
    }
  });
  test('C14: WebSocket tickets require a real target, current ownership and matching origin', async () => {
    const r = await fixture();
    const { app } = createHttp(r);
    const headers = {
      Authorization: auth,
      'X-Vibe-Coder': '1',
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:3100',
    };
    try {
      expect(
        (await app.request('/api/desktop/ticket', { method: 'POST', headers, body: '{}' })).status,
      ).toBe(400);
      r.config.update(r.config.read().revision, (c) => {
        c.desktop = {
          revision: 1,
          name: 'Test',
          display: ':77',
          vncHost: '127.0.0.1',
          vncPort: 5900,
        };
      });
      r.desktop.handoff('human');
      const ticket = (await (
        await app.request('/api/desktop/ticket', { method: 'POST', headers, body: '{}' })
      ).json()) as { ticket: string };
      expect(
        (
          await app.request(`/api/desktop/socket?ticket=${ticket.ticket}`, {
            headers: { Authorization: auth, Origin: 'https://hostile.example' },
          })
        ).status,
      ).toBe(403);
      r.desktop.handoff('agent');
      expect(
        (await app.request(`/api/desktop/socket?ticket=${ticket.ticket}`, { headers })).status,
      ).toBe(403);
      expect(
        (await app.request('/api/desktop/credential', { method: 'POST', headers, body: '{}' }))
          .status,
      ).toBe(400);
    } finally {
      await r.dispose();
    }
  });
  test('H14: API secret input yields only reference/status; ordinary forms reject secret fields', async () => {
    const r = await fixture();
    const { app } = createHttp(r);
    const headers = {
      Authorization: auth,
      'X-Vibe-Coder': '1',
      'Content-Type': 'application/json',
    };
    try {
      r.agent.pause(r.id, true);
      const bad = await app.request('/api/human', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          conversationId: r.id,
          spec: {
            kind: 'input',
            title: 'Bad',
            fields: [{ name: 'key', type: 'secret', label: 'key' }],
          },
        }),
      });
      expect(bad.status).toBe(400);
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
      const secret = `api-secret-${crypto.randomUUID()}`;
      const response = await app.request(`/api/human/${card.id}/secret`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          revision: card.revision,
          operationId: crypto.randomUUID(),
          values: { key: secret },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(secret);
      expect(JSON.stringify(r.store.snapshot(r.id))).not.toContain(secret);
    } finally {
      await r.dispose();
    }
  });
});
