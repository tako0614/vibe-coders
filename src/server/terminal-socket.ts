import type { Hono } from 'hono';
import type { UpgradeWebSocket, WSContext } from 'hono/ws';
import { z } from 'zod';
import type { Runtime } from './runtime';

const frame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('input'),
    id: z.number().int().nonnegative(),
    text: z.string().min(1).max(16000),
  }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(20).max(300),
    rows: z.number().int().min(5).max(150),
  }),
  z.object({ type: z.literal('ack'), offset: z.number().int().nonnegative() }),
  z.object({ type: z.literal('ping') }),
]);
type Ticket = { runId: string; epoch: number; offset: number; expires: number };

export class TerminalSockets {
  private tickets = new Map<string, Ticket>();
  constructor(
    private readonly runtime: Runtime,
    private readonly origin: () => string,
  ) {}
  authorize(path: string, token: string, origin?: string) {
    const ticket = this.tickets.get(token);
    if (
      !ticket ||
      origin !== this.origin() ||
      ticket.expires <= Date.now() ||
      this.runtime.store.stopped ||
      path !== `/api/runs/${ticket.runId}/socket`
    )
      return false;
    try {
      return this.runtime.runs.get(ticket.runId).epoch === ticket.epoch;
    } catch {
      return false;
    }
  }
  install(app: Hono, upgrade: UpgradeWebSocket) {
    const r = this.runtime;
    app.post('/api/runs/:id/ticket', async (c) => {
      r.store.assertEnabled();
      const run = r.runs.get(c.req.param('id'));
      if (run.kind !== 'terminal') throw new Error('This run has no interactive terminal.');
      const { offset } = z
        .object({ offset: z.number().int().nonnegative().default(0) })
        .parse(await c.req.json());
      for (const [key, ticket] of this.tickets)
        if (ticket.expires <= Date.now()) this.tickets.delete(key);
      if (this.tickets.size >= 256) this.tickets.delete(this.tickets.keys().next().value!);
      const ticket = crypto.randomUUID();
      this.tickets.set(ticket, {
        runId: run.id,
        epoch: run.epoch,
        offset,
        expires: Date.now() + 30000,
      });
      return c.json({ ticket });
    });
    app.get(
      '/api/runs/:id/socket',
      async (c, next) => {
        if (!this.authorize(c.req.path, c.req.query('ticket') || '', c.req.header('Origin')))
          return c.json({ error: 'Invalid or expired terminal ticket.' }, 403);
        await next();
      },
      upgrade((c) => {
        const token = c.req.query('ticket')!,
          ticket = this.tickets.get(token)!;
        this.tickets.delete(token);
        let client: WSContext | undefined,
          offset = ticket.offset,
          acknowledged = offset,
          ended = false,
          lastState = '',
          lastInput = -1;
        const cleanup = () => {
          ended = true;
          r.runs.output.off(ticket.runId, pump);
          r.store.changes.off('change', changed);
        };
        const close = () => {
          cleanup();
          client?.close(1000, 'Terminal state changed');
        };
        const valid = () => !r.store.stopped && r.runs.get(ticket.runId).epoch === ticket.epoch;
        const send = (value: unknown) => {
          if (!client || ended) return;
          const raw = client.raw as { getBufferedAmount?: () => number } | undefined;
          if ((raw?.getBufferedAmount?.() || 0) > 512 * 1024) {
            cleanup();
            client.close(1013, 'Reconnect to resume output');
            return;
          }
          client.send(JSON.stringify(value));
        };
        const pump = () => {
          if (ended || !client) return;
          try {
            if (!valid()) return close();
            // Acknowledgments follow xterm rendering, keeping both network and render queues bounded.
            while (offset - acknowledged < 64 * 1024 && !ended) {
              const data = r.runs.read(ticket.runId, offset, 16000);
              if (!data.text) break;
              if (data.truncated) acknowledged = data.offset;
              offset = data.nextOffset;
              send({
                type: 'output',
                text: data.text,
                offset: data.offset,
                nextOffset: offset,
                truncated: data.truncated,
              });
              if (!data.hasMore) break;
            }
          } catch {
            close();
          }
        };
        const changed = () => {
          if (ended || !client) return;
          try {
            if (!valid()) return close();
            const run = r.runs.get(ticket.runId);
            const state = { type: 'state', state: run.state, owner: run.owner, epoch: run.epoch };
            if (JSON.stringify(state) !== lastState) {
              lastState = JSON.stringify(state);
              send(state);
            }
            pump();
          } catch {
            close();
          }
        };
        return {
          onOpen(_event, ws) {
            client = ws;
            r.runs.output.on(ticket.runId, pump);
            r.store.changes.on('change', changed);
            changed();
          },
          onMessage(event) {
            if (ended) return;
            try {
              if (!valid()) return close();
              if (typeof event.data !== 'string' || event.data.length > 100000)
                throw new Error('Invalid terminal frame.');
              const value = frame.parse(JSON.parse(event.data));
              if (value.type === 'input') {
                if (value.id <= lastInput) throw new Error('Duplicate terminal input.');
                r.runs.write(ticket.runId, value.text, 'human', ticket.epoch);
                lastInput = value.id;
                send({ type: 'accepted', id: value.id });
              } else if (value.type === 'resize') {
                r.runs.resize(ticket.runId, value.cols, value.rows);
              } else if (value.type === 'ack') {
                if (value.offset > offset) throw new Error('Invalid terminal acknowledgment.');
                acknowledged = Math.max(acknowledged, value.offset);
                pump();
              } else send({ type: 'pong' });
            } catch (error) {
              send({
                type: 'error',
                message:
                  error instanceof z.ZodError
                    ? 'Invalid terminal frame.'
                    : r.vault.redact(
                        error instanceof Error ? error.message : 'Terminal operation failed.',
                      ),
              });
            }
          },
          onClose: cleanup,
          onError: cleanup,
        };
      }),
    );
  }
}
