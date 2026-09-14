import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHash } from 'node:crypto';
import { fixture } from './helpers';
import { createHttp } from '../src/server/http';

test('MCP OAuth discovers, registers, checks PKCE/state, reconnects and rejects callback replay', async () => {
  let origin = '',
    challenge = '',
    exchanged = 0;
  const transports: StreamableHTTPServerTransport[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    const json = (value: unknown, status = 200, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server'))
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/register') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      return json({ ...JSON.parse(raw), client_id: 'vibe-client' }, 201);
    }
    if (url.pathname === '/token') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      expect(
        createHash('sha256')
          .update(form.get('code_verifier') || '')
          .digest('base64url'),
      ).toBe(challenge);
      expect(form.get('code')).toBe('one-time-code');
      exchanged++;
      return json({ access_token: 'oauth-private-access', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.pathname === '/mcp') {
      if (req.headers.authorization !== 'Bearer oauth-private-access')
        return json({}, 401, {
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        });
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      const mcp = new McpServer({ name: 'oauth-fixture', version: '1.0.0' });
      mcp.registerTool('ready', { inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'ready' }],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      transports.push(transport);
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    json({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const config = {
      name: 'oauth',
      transport: 'http' as const,
      url: `${origin}/mcp`,
      args: [],
      enabled: true,
      revision: 1,
      oauth: true,
    };
    r.config.update(r.config.read().revision, (c) => {
      c.mcp = [config];
    });
    await r.mcp.connect(config, r.id);
    expect(r.mcp.status()[0].state).toBe('awaiting_auth');
    const card = r.store.snapshot(r.id).requests[0],
      url = new URL(card.spec.url!);
    expect(card.spec.externalCompletion).toBe(true);
    challenge = url.searchParams.get('code_challenge')!;
    expect(challenge.length).toBeGreaterThan(20);
    const { app } = createHttp(r);
    expect((await app.request('/api/mcp/oauth/callback?state=bad&code=bad')).status).toBe(400);
    const callback = `/api/mcp/oauth/callback?state=${url.searchParams.get('state')}&code=one-time-code`;
    expect((await app.request(callback)).status).toBe(200);
    expect(r.mcp.status()[0].state).toBe('connected');
    expect(r.human.get(card.id).result?.verification).toBe('verified');
    expect((await app.request(callback)).status).toBe(400);
    expect(exchanged).toBe(1);
    expect(JSON.stringify(r.store.snapshot(r.id))).not.toContain('oauth-private-access');
    expect(r.vault.redact('oauth-private-access')).toBe('[REDACTED]');
  } finally {
    await r.dispose();
    for (const transport of transports) await transport.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20000);
