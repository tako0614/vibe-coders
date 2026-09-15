import { Hono } from 'hono';
import { TerminalSockets } from './terminal-socket';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic, createBunWebSocket } from 'hono/bun';
import { streamSSE } from 'hono/streaming';
import { timingSafeEqual, createHash } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  providerSchema,
  mcpSchema,
  desktopSchema,
  searchSchema,
  retentionSchema,
} from '../shared/contracts';
import { extractPdf } from './content';
import { prune } from './retention';
import { nativeSchema } from './native';
import { requests } from './db/schema';
import type { Runtime } from './runtime';
import type { WSContext } from 'hono/ws';

export function createHttp(runtime: Runtime, options: { devOrigin?: string } = {}) {
  const r = runtime,
    app = new Hono(),
    { upgradeWebSocket, websocket } = createBunWebSocket();
  const authCache = new Map<string, number>();
  const tickets = new Map<string, { expires: number; epoch: number }>();
  // OAuth redirects come from another origin. This one route authenticates with
  // a durable, expiring, one-use state bound to the target revision and PKCE.
  app.get('/api/mcp/oauth/callback', async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    try {
      const state = z.string().min(50).max(200).parse(c.req.query('state'));
      await r.mcp.finishOAuth(state, c.req.query('error') ? undefined : c.req.query('code'));
      return c.text('認証処理を受け付けました。このタブを閉じてVibe Codersに戻ってください。');
    } catch {
      return c.text('認証を再開できませんでした。Vibe Codersで接続を再読み込みしてください。', 400);
    }
  });
  const origin = () =>
    options.devOrigin ||
    process.env.VIBE_CODER_ORIGIN ||
    r.config.read().web?.origin ||
    `http://${r.config.read().web?.hostname || '127.0.0.1'}:${r.config.read().web?.port || 3100}`;
  const terminals = new TerminalSockets(r, origin);
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    }),
  );
  app.use('*', async (c, next) => {
    const web = r.config.read().web;
    if (!web)
      return c.json({ error: 'Run vibe-coders setup to configure Web authentication.' }, 503);
    const header = c.req.header('Authorization') || '';
    let allowed = terminals.authorize(
      c.req.path,
      c.req.query('ticket') || '',
      c.req.header('Origin'),
    );
    if (c.req.path === '/api/desktop/socket') {
      const ticket = tickets.get(c.req.query('ticket') || '');
      allowed =
        !!ticket &&
        ticket.expires > Date.now() &&
        ticket.epoch === r.desktop.status().epoch &&
        r.desktop.status().owner === 'human' &&
        c.req.header('Origin') === origin() &&
        !r.store.stopped;
    }
    if (header.startsWith('Basic ') && header.length < 4096) {
      const hash = createHash('sha256')
        .update(header + web.passwordHash)
        .digest('hex');
      if ((authCache.get(hash) || 0) > Date.now()) allowed = true;
      else {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'),
          pos = decoded.indexOf(':');
        if (pos >= 0 && decoded.slice(0, pos) === web.username)
          allowed = await Bun.password
            .verify(decoded.slice(pos + 1), web.passwordHash)
            .catch(() => false);
        if (allowed) {
          if (authCache.size > 100) authCache.clear();
          authCache.set(hash, Date.now() + 60000);
        }
      }
    }
    if (!allowed) {
      if (!c.req.path.startsWith('/api/'))
        c.header('WWW-Authenticate', 'Basic realm="Vibe Coders", charset="UTF-8"');
      return c.json({ error: 'Authentication required.' }, 401);
    }
    c.header('Cache-Control', 'no-store');
    const requestOrigin = c.req.header('Origin');
    if (requestOrigin && requestOrigin !== origin())
      return c.json({ error: 'Origin rejected.' }, 403);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('X-Vibe-Coder') !== '1')
      return c.json({ error: 'CSRF header required.' }, 403);
    if (c.req.header('Sec-Fetch-Site') === 'cross-site')
      return c.json({ error: 'Cross-site access rejected.' }, 403);
    await next();
  });
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 6 * 1024 * 1024,
      onError: (c) => c.json({ error: 'Request exceeds 6 MiB.' }, 413),
    }),
  );
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof z.ZodError
            ? error.issues.map((i) => i.message).join(' ')
            : r.vault.redact(error.message).slice(0, 1000),
      },
      400,
    ),
  );
  terminals.install(app, upgradeWebSocket);
  app.get('/api/status', (c) =>
    c.json({
      home: r.home,
      conversations: r.store.listConversations(),
      config: r.config.public(),
      mcp: r.mcp.status(),
      desktop: r.desktop.status(),
      stopped: r.store.stopped,
      codex: r.codex.status(),
      providerReady:
        !!r.config.read().provider &&
        (r.config.read().provider!.kind === 'codex'
          ? r.codex.status().subscriptionReady
          : !r.config.read().provider!.keyRequired ||
            !!r.vault.get('provider:main', r.config.read().provider!.revision)),
    }),
  );
  app.post('/api/conversations', (c) => c.json(r.store.createConversation(), 201));
  app.get('/api/conversations/:id', (c) =>
    c.json({
      ...r.store.snapshot(c.req.param('id')),
      draft: r.agent.drafts.get(c.req.param('id')) || '',
    }),
  );
  app.post('/api/conversations/:id/messages', async (c) => {
    const body = z
      .object({
        text: z.string().max(64000),
        operationId: z.string().uuid(),
        images: z
          .array(
            z.object({
              type: z.literal('image_url'),
              image_url: z.object({
                url: z
                  .string()
                  .max(5 * 1024 * 1024)
                  .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/),
              }),
            }),
          )
          .max(4)
          .optional(),
      })
      .refine(
        (v) => v.text.trim().length || v.images?.length,
        'Enter a message or attach an image.',
      )
      .parse(await c.req.json());
    r.agent.submit(c.req.param('id'), body.text, body.operationId, body.images);
    return c.json({ accepted: true }, 202);
  });
  app.post('/api/conversations/:id/pause', async (c) => {
    const body = z.object({ paused: z.boolean() }).parse(await c.req.json());
    r.agent.pause(c.req.param('id'), body.paused);
    return c.json({ paused: body.paused });
  });
  app.post('/api/conversations/:id/retry', (c) => {
    r.agent.retry(c.req.param('id'));
    return c.json({ accepted: true }, 202);
  });
  app.post('/api/control', async (c) => {
    const { action } = z.object({ action: z.enum(['stop', 'enable']) }).parse(await c.req.json());
    if (action === 'stop') r.agent.stopAll();
    else r.agent.enable();
    return c.json({ stopped: r.store.stopped });
  });
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let dirty = true,
        lastHeartbeat = Date.now();
      const mark = () => {
        dirty = true;
      };
      r.store.changes.on('change', mark);
      r.store.changes.on('stream', mark);
      stream.onAbort(() => {
        r.store.changes.off('change', mark);
        r.store.changes.off('stream', mark);
      });
      try {
        while (!stream.aborted) {
          if (dirty) {
            dirty = false;
            await stream.writeSSE({ event: 'change', data: String(Date.now()) });
            lastHeartbeat = Date.now();
          } else if (Date.now() - lastHeartbeat >= 10000) {
            await stream.write(': heartbeat\n\n');
            lastHeartbeat = Date.now();
          }
          await stream.sleep(300);
        }
      } finally {
        r.store.changes.off('change', mark);
        r.store.changes.off('stream', mark);
      }
    }),
  );
  app.post('/api/human/:id/answer', async (c) =>
    c.json(r.human.answer(c.req.param('id'), await c.req.json())),
  );
  app.post('/api/attachments/pdf', async (c) => {
    const { data } = z
      .object({
        data: z
          .string()
          .max(5600000)
          .regex(/^[A-Za-z0-9+/=]+$/),
      })
      .parse(await c.req.json());
    const result = await extractPdf(Buffer.from(data, 'base64'));
    return c.json({ ...result, text: r.vault.redact(result.text) });
  });
  app.put('/api/config/search', async (c) => {
    const { revision, search } = z
      .object({ revision: z.number().int(), search: searchSchema })
      .parse(await c.req.json());
    r.config.update(revision, (v) => {
      v.search = { ...search, revision: (v.search?.revision || 0) + 1 };
    });
    r.store.notify();
    return c.json(r.config.public());
  });
  app.put('/api/config/retention', async (c) => {
    const { revision, retention } = z
      .object({ revision: z.number().int(), retention: retentionSchema })
      .parse(await c.req.json());
    r.config.update(revision, (v) => {
      v.retention = retention;
    });
    r.store.notify();
    return c.json(r.config.public());
  });
  app.post('/api/retention/prune', (c) => c.json(prune(r.store, r.config)));
  app.post('/api/human/:id/secret', async (c) =>
    c.json(r.human.submitSecret(c.req.param('id'), await c.req.json())),
  );
  app.post('/api/human/:id/verify', async (c) => {
    await r.human.verify(c.req.param('id'));
    return c.json(r.human.get(c.req.param('id')));
  });
  app.post('/api/human/:id/cancel', (c) => c.json(r.human.close(c.req.param('id'))));
  app.post('/api/human', async (c) => {
    const body = z
      .object({ conversationId: z.string(), spec: z.unknown() })
      .parse(await c.req.json());
    return c.json(r.human.create(body.conversationId, body.spec), 201);
  });
  app.get('/api/runs/:id', (c) =>
    c.json(
      r.runs.read(
        c.req.param('id'),
        z.coerce
          .number()
          .int()
          .min(0)
          .parse(c.req.query('offset') || 0),
        32000,
      ),
    ),
  );
  app.post('/api/runs', async (c) => {
    await r.changes.ready;
    const body = z
      .object({
        conversationId: z.string(),
        kind: z.enum(['shell', 'terminal']),
        command: z.string().max(32000).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      body.kind === 'terminal'
        ? r.runs.handoff(r.runs.terminal(body.conversationId).id, 'human')
        : r.runs.shell(body.conversationId, z.string().min(1).parse(body.command)),
      201,
    );
  });
  app.post('/api/native/:id/input', async (c) =>
    c.json(await r.native.input(c.req.param('id'), await c.req.json())),
  );
  app.post('/api/native', async (c) => {
    const body = z
      .object({ conversationId: z.string(), spec: nativeSchema })
      .parse(await c.req.json());
    return c.json(r.native.start(body.conversationId, body.spec), 202);
  });
  app.post('/api/runs/:id/stop', (c) => c.json(r.runs.stop(c.req.param('id'))));
  app.post('/api/runs/:id/handoff', async (c) => {
    const { owner } = z.object({ owner: z.enum(['agent', 'human']) }).parse(await c.req.json());
    return c.json(r.runs.handoff(c.req.param('id'), owner));
  });
  app.post('/api/runs/:id/write', async (c) => {
    const body = z
      .object({ text: z.string().max(32000), epoch: z.number().int() })
      .parse(await c.req.json());
    r.runs.write(c.req.param('id'), body.text, 'human', body.epoch);
    return c.json({ sent: true });
  });
  app.post('/api/runs/:id/resize', async (c) => {
    const b = z
      .object({ cols: z.number().int().min(20).max(300), rows: z.number().int().min(5).max(150) })
      .parse(await c.req.json());
    r.runs.resize(c.req.param('id'), b.cols, b.rows);
    return c.json({ resized: true });
  });
  app.post('/api/schedules', async (c) => {
    const body = z
      .object({ conversationId: z.string(), spec: z.unknown() })
      .parse(await c.req.json());
    return c.json(r.scheduler.create(body.conversationId, body.spec), 201);
  });
  app.put('/api/schedules/:id', async (c) =>
    c.json(r.scheduler.update(c.req.param('id'), await c.req.json())),
  );
  app.delete('/api/schedules/:id', (c) => {
    r.scheduler.remove(c.req.param('id'));
    return c.json({ deleted: true });
  });
  app.post('/api/schedules/:id/fire', (c) => {
    r.scheduler.fire(c.req.param('id'), Date.now(), true);
    return c.json({ fired: true });
  });
  app.get('/api/changes', async (c) => c.json(await r.changes.list()));
  app.get('/api/changes/file', async (c) =>
    c.json(await r.changes.detail(z.string().min(1).parse(c.req.query('path')))),
  );
  app.put('/api/changes/file', async (c) => {
    r.store.assertEnabled();
    const body = z
      .object({
        path: z.string().min(1),
        content: z.string().max(2 * 1024 * 1024),
        expectedSha256: z.string().nullable(),
      })
      .parse(await c.req.json());
    return c.json(await r.changes.edit(body.path, body.content, body.expectedSha256));
  });
  app.post('/api/changes/restore', async (c) => {
    r.store.assertEnabled();
    const body = z
      .object({
        path: z.string().min(1),
        expectedSha256: z.string().nullable(),
        baselineId: z.string().uuid(),
      })
      .parse(await c.req.json());
    return c.json(await r.changes.restore(body.path, body.expectedSha256, body.baselineId));
  });
  app.get('/api/files', async (c) => c.json(await r.files.list(c.req.query('path') || '.')));
  app.get('/api/files/read', async (c) =>
    c.json(
      await r.files.read(
        z.string().parse(c.req.query('path')),
        z.coerce
          .number()
          .int()
          .min(1)
          .parse(c.req.query('startLine') || 1),
        500,
      ),
    ),
  );
  app.get('/api/memory', async (c) =>
    c.json(await r.memory.human.search(c.req.query('q') || 'このリポジトリの記憶')),
  );
  app.post('/api/memory', async (c) => {
    const { text } = z.object({ text: z.string().min(1).max(32000) }).parse(await c.req.json());
    const result = await r.memory.human.write(r.vault.redact(text));
    r.memory.storage.flush();
    return c.json(result, 201);
  });
  app.put('/api/config/provider', async (c) => {
    const { revision, provider } = z
      .object({ revision: z.number().int(), provider: providerSchema })
      .parse(await c.req.json());
    const config = r.config.update(revision, (v) => {
      v.provider = {
        ...provider,
        ...(provider.kind === 'codex'
          ? {
              baseUrl: 'https://chatgpt.com/backend-api/codex',
              keyRequired: false,
              supportsImages: true,
            }
          : {}),
        revision: (v.provider?.revision || 0) + 1,
      };
    });
    r.store.notify();
    if (provider.kind === 'codex') void r.codex.refresh().catch(() => {});
    return c.json(r.config.public());
  });
  app.post('/api/config/secret-request', async (c) => {
    const { conversationId, targetId } = z
      .object({ conversationId: z.string(), targetId: z.string() })
      .parse(await c.req.json());
    return c.json(
      r.human.create(conversationId, {
        kind: 'secret',
        title: `${targetId} の認証情報`,
        message: 'この端末の資格情報ストアに保存します。チャットやモデルには送信しません。',
        targetId,
        fields: [
          {
            name: 'credential',
            label:
              targetId === 'desktop'
                ? 'VNCパスワード'
                : targetId.startsWith('oauth-client:')
                  ? 'OAuthクライアントシークレット'
                  : 'APIキー / トークン',
            type: 'secret',
            required: true,
          },
        ],
      }),
      201,
    );
  });
  app.put('/api/config/mcp', async (c) => {
    const { revision, connection } = z
      .object({ revision: z.number().int(), connection: mcpSchema })
      .parse(await c.req.json());
    r.mcp.configure(revision, connection);
    return c.json(r.config.public());
  });
  app.post('/api/config/mcp/:name/connect', async (c) => {
    const { conversationId } = z.object({ conversationId: z.string() }).parse(await c.req.json());
    return c.json(r.mcp.connectRun(conversationId, c.req.param('name')), 202);
  });
  app.post('/api/config/mcp/:name/disconnect', async (c) => {
    await r.mcp.disconnect(c.req.param('name'));
    return c.json(r.config.public());
  });
  app.delete('/api/config/mcp/:name', async (c) => {
    await r.mcp.remove(r.config.read().revision, c.req.param('name'));
    return c.json(r.config.public());
  });
  app.post('/api/mcp/install', async (c) => c.json(r.mcpInstaller.start(await c.req.json()), 202));
  app.post('/api/mcp/setup', async (c) => {
    const { conversationId, request, operationId } = z
      .object({
        conversationId: z.string(),
        request: z.string().trim().min(1).max(8000),
        operationId: z.string().uuid(),
      })
      .strict()
      .parse(await c.req.json());
    r.store.assertEnabled();
    r.agent.submit(
      conversationId,
      `MCPで次の機能を使えるようにしてください。必要な環境の確認・導入・接続設定・接続後の動作確認まで進めてください。\n${request}`,
      operationId,
    );
    return c.json({ conversationId, queued: true }, 202);
  });
  app.get('/api/codex/models', async (c) => c.json(await r.codex.models()));
  app.get('/api/codex/auth', (c) => c.json(r.codex.userStatus()));
  app.post('/api/codex/auth/refresh', async (c) => c.json(await r.codex.refresh()));
  app.post('/api/codex/auth/login', async (c) => {
    const { conversationId, method } = z
      .object({
        conversationId: z.string(),
        method: z.enum(['device', 'browser']).default('device'),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(r.codex.start(conversationId, method, true), 202);
  });
  app.post('/api/codex/auth/cancel', async (c) => c.json(await r.codex.cancel()));
  app.put('/api/config/desktop', async (c) => {
    const { revision, desktop } = z
      .object({ revision: z.number().int(), desktop: desktopSchema })
      .parse(await c.req.json());
    r.config.update(revision, (v) => {
      v.desktop = { ...desktop, revision: (v.desktop?.revision || 0) + 1 };
    });
    r.desktop.handoff('agent');
    return c.json(r.config.public());
  });
  app.post('/api/desktop/prepare', async (c) => c.json(await r.desktop.prepare()));
  app.get('/api/desktop/preview', async (c) => c.json(await r.desktop.preview()));
  app.post('/api/desktop/launch', async (c) => {
    const { app, url } = z
      .object({ app: z.enum(['browser', 'terminal']), url: z.url().optional() })
      .parse(await c.req.json());
    return c.json(await r.desktop.launch(app, url, 'human'));
  });
  app.post('/api/desktop/handoff', async (c) => {
    const { owner } = z.object({ owner: z.enum(['human', 'agent']) }).parse(await c.req.json());
    return c.json(r.desktop.handoff(owner));
  });
  // VNC credentials only reach this authenticated user route, never model tools.
  app.post('/api/desktop/credential', (c) => {
    const d = r.desktop.target();
    if (!d || r.desktop.status().owner !== 'human') throw new Error('Take desktop control first.');
    return c.json({ password: r.desktop.credential() || '' });
  });
  app.post('/api/desktop/ticket', (c) => {
    r.store.assertEnabled();
    if (r.desktop.status().owner !== 'human' || !r.desktop.target())
      throw new Error('Configure a desktop and take control first.');
    for (const [key, t] of tickets) if (t.expires < Date.now()) tickets.delete(key);
    const ticket = crypto.randomUUID();
    tickets.set(ticket, { expires: Date.now() + 30000, epoch: r.desktop.status().epoch });
    return c.json({ ticket });
  });
  app.get(
    '/api/desktop/socket',
    async (c, next) => {
      if (c.req.header('Origin') !== origin())
        return c.json({ error: 'WebSocket Origin rejected.' }, 403);
      const ticket = c.req.query('ticket') || '',
        value = tickets.get(ticket);
      tickets.delete(ticket);
      if (
        r.store.stopped ||
        !value ||
        value.expires < Date.now() ||
        value.epoch !== r.desktop.status().epoch ||
        r.desktop.status().owner !== 'human'
      )
        return c.json({ error: 'Invalid or expired desktop ticket.' }, 403);
      await next();
    },
    upgradeWebSocket(() => {
      let socket: Socket | undefined, ws: WSContext | undefined;
      const epoch = r.desktop.status().epoch;
      const cleanup = () => {
        socket?.destroy();
        r.store.changes.off('change', changed);
      };
      const changed = () => {
        if (
          r.desktop.status().epoch !== epoch ||
          r.desktop.status().owner !== 'human' ||
          r.store.stopped
        ) {
          ws?.close();
          cleanup();
        }
      };
      return {
        onOpen(_event, client) {
          ws = client;
          const d = r.desktop.target();
          if (!d) return client.close();
          socket = createConnection({ host: d.vncHost, port: d.vncPort });
          socket.on('data', (data) =>
            client.send(typeof data === 'string' ? data : new Uint8Array(data)),
          );
          socket.on('error', () => client.close());
          socket.on('close', () => client.close());
          r.store.changes.on('change', changed);
        },
        onMessage(event, client) {
          if (epoch !== r.desktop.status().epoch || r.store.stopped) return client.close();
          if (typeof event.data === 'string') socket?.write(Buffer.from(event.data));
          else if (event.data instanceof ArrayBuffer) socket?.write(Buffer.from(event.data));
        },
        onClose() {
          cleanup();
        },
        onError() {
          cleanup();
        },
      };
    }),
  );
  const webRoot = fileURLToPath(new URL('../../dist/web/', import.meta.url));
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('*', serveStatic({ path: `${webRoot}/index.html` }));
  return { app, websocket };
}
