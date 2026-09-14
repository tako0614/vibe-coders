import { expect, test } from 'bun:test';
import { fixture } from './helpers';
import { createHttp } from '../src/server/http';

// The shared tsconfig includes DOM's narrower constructor; Bun additionally
// supports explicit headers for nonbrowser WebSocket clients.
const BunWebSocket = WebSocket as unknown as {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};

test('desktop WebSocket exchanges binary bytes using one-use tickets and closes on handoff', async () => {
  const r = await fixture();
  const tcp = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, bytes) {
        socket.write(bytes);
      },
    },
  });
  r.config.update(r.config.read().revision, (c) => {
    c.desktop = {
      revision: 1,
      name: 'wire-test',
      display: ':77',
      vncHost: '127.0.0.1',
      vncPort: tcp.port!,
    };
  });
  const { app, websocket } = createHttp(r);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket });
  r.config.update(r.config.read().revision, (c) => {
    c.web!.port = server.port!;
  });
  const origin = `http://127.0.0.1:${server.port}`;
  let socket: WebSocket | undefined;
  try {
    r.desktop.handoff('human');
    const response = await fetch(`${origin}/api/desktop/ticket`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from('owner:test-only-password-123').toString('base64')}`,
        'X-Vibe-Coder': '1',
        Origin: origin,
      },
    });
    const { ticket } = (await response.json()) as { ticket: string };
    const url = `ws://127.0.0.1:${server.port}/api/desktop/socket?ticket=${ticket}`;
    socket = new BunWebSocket(url, { headers: { Origin: origin } });
    socket.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      socket!.onopen = () => resolve();
      socket!.onerror = () => reject(new Error('Socket failed to open.'));
    });
    const received = new Promise<ArrayBuffer>((resolve, reject) => {
      socket!.onmessage = (e) => resolve(e.data as ArrayBuffer);
      socket!.onerror = () => reject(new Error('Socket failed.'));
    });
    socket.send(new Uint8Array([0, 10, 127, 255, 1]));
    expect(Array.from(new Uint8Array(await received))).toEqual([0, 10, 127, 255, 1]);
    const reused = new BunWebSocket(url, { headers: { Origin: origin } });
    const reuseResult = await new Promise<boolean>((resolve) => {
      reused.onopen = () => {
        reused.close();
        resolve(true);
      };
      reused.onerror = () => resolve(false);
    });
    expect(reuseResult).toBe(false);
    const closed = new Promise<void>((resolve) => {
      socket!.onclose = () => resolve();
    });
    r.desktop.handoff('agent');
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  } finally {
    socket?.close();
    server.stop(true);
    tcp.stop(true);
    await r.dispose();
  }
}, 10000);
