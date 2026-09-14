import { expect, test } from 'bun:test';
import { fixture, eventually } from './helpers';
import { createHttp } from '../src/server/http';
const BunSocket = WebSocket as unknown as {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};
const auth = `Basic ${Buffer.from('owner:test-only-password-123').toString('base64')}`;

test('ordinary output is immediate even when the vault contains a long credential', async () => {
  const r = await fixture();
  try {
    r.vault.put('test', 1, 'test', 'credential-' + 'x'.repeat(2000));
    const run = r.runs.shell(r.id, 'printf prompt-ready; sleep 5');
    await eventually(() => r.runs.read(run.id).text === 'prompt-ready', 350);
  } finally {
    await r.dispose();
  }
});

test('terminal stream uses bound one-use tickets, immediate input, replay and ownership revocation', async () => {
  const r = await fixture(),
    { app, websocket } = createHttp(r);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket });
  r.config.update(r.config.read().revision, (c) => {
    c.web!.port = server.port!;
  });
  const origin = `http://127.0.0.1:${server.port}`,
    headers = {
      Authorization: auth,
      Origin: origin,
      'X-Vibe-Coder': '1',
      'Content-Type': 'application/json',
    };
  const run = r.runs.handoff(
    r.runs.terminal(r.id, ['/bin/bash', '--noprofile', '--norc']).id,
    'human',
  );
  const issue = async (offset = 0) => {
    const response = await fetch(`${origin}/api/runs/${run.id}/ticket`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ offset }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).ticket as string;
  };
  const sockets: WebSocket[] = [];
  const open = async (ticket: string, requestOrigin = origin, target = run.id) => {
    const socket = new BunSocket(
      `${origin.replace('http', 'ws')}/api/runs/${target}/socket?ticket=${ticket}`,
      { headers: { Origin: requestOrigin } },
    );
    sockets.push(socket);
    const packets: any[] = [];
    socket.onmessage = (e) => {
      const data = JSON.parse(String(e.data));
      packets.push(data);
      if (data.type === 'output')
        socket.send(JSON.stringify({ type: 'ack', offset: data.nextOffset }));
    };
    const accepted = await new Promise<boolean>((resolve) => {
      socket.onopen = () => resolve(true);
      socket.onerror = () => resolve(false);
    });
    return { socket, packets, accepted };
  };
  try {
    const ticket = await issue();
    expect((await open(ticket, 'https://untrusted.example')).accepted).toBe(false);
    const other = r.runs.terminal(r.id, ['/bin/bash', '--noprofile', '--norc']);
    expect((await open(ticket, origin, other.id)).accepted).toBe(false);
    const first = await open(ticket);
    expect(first.accepted).toBe(true);
    expect((await open(ticket)).accepted).toBe(false);
    await eventually(() => first.packets.some((p) => p.type === 'state'));
    const started = performance.now();
    first.socket.send(
      JSON.stringify({ type: 'input', id: 1, text: 'printf "__SOCKET_ECHO__\\n"\n' }),
    );
    await eventually(
      () => first.packets.some((p) => p.type === 'output' && p.text.includes('__SOCKET_ECHO__')),
      1000,
    );
    expect(performance.now() - started).toBeLessThan(300);
    const offset = Math.max(
      0,
      ...first.packets.filter((p) => p.type === 'output').map((p) => p.nextOffset),
    );
    first.socket.close();
    r.runs.write(run.id, 'printf "__WHILE_DISCONNECTED__\\n"\n', 'human', run.epoch);
    await eventually(() => r.runs.read(run.id).text.includes('__WHILE_DISCONNECTED__'));
    const second = await open(await issue(offset));
    await eventually(() =>
      second.packets.some((p) => p.type === 'output' && p.text.includes('__WHILE_DISCONNECTED__')),
    );
    expect(second.packets.filter((p) => p.type === 'output').every((p) => p.offset >= offset)).toBe(
      true,
    );
    const stale = await issue();
    r.runs.handoff(run.id, 'agent');
    await eventually(() => second.socket.readyState === WebSocket.CLOSED);
    expect((await open(stale)).accepted).toBe(false);
    expect((await r.runs.screen(run.id)).text).not.toContain('__WHILE_DISCONNECTED__');
  } finally {
    for (const socket of sockets) socket.close();
    server.stop(true);
    await r.dispose();
  }
}, 15000);
