import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { eq, inArray } from 'drizzle-orm';
import { runs } from './db/schema';
import { Store } from './store';
import { Vault } from './config';

type Live = {
  kill: () => void;
  write?: (text: string) => void;
  resize?: (cols: number, rows: number) => void;
  screen?: HeadlessTerminal;
  flushed?: Promise<void>;
  output: string;
  offset: number;
  redactionPending?: string;
  timer?: ReturnType<typeof setTimeout>;
};
const OUTPUT_LIMIT = 256 * 1024;
export function shellEnvironment() {
  const env: Record<string, string> = {};
  for (const key of [
    'HOME',
    'PATH',
    'SHELL',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'SSH_AUTH_SOCK',
    'XDG_RUNTIME_DIR',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'PATHEXT',
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  return { ...env, TERM: 'xterm-256color', LANG: env.LANG || 'C.UTF-8' };
}
export class RunService {
  readonly output = new EventEmitter();
  private live = new Map<string, Live>();
  constructor(
    readonly store: Store,
    readonly home: string,
    readonly vault: Vault,
  ) {}
  get(id: string) {
    const row = this.store.db.select().from(runs).where(eq(runs.id, id)).get();
    if (!row) throw new Error('Run not found.');
    return row;
  }
  private create(
    conversationId: string,
    kind: 'shell' | 'terminal' | 'mcp' | 'native',
    title: string,
    cwd?: string,
  ) {
    this.store.assertEnabled();
    this.store.conversation(conversationId);
    const row = this.store.db
      .insert(runs)
      .values({
        id: crypto.randomUUID(),
        conversationId,
        kind,
        title: this.vault.redact(title),
        cwd: resolve(this.home, cwd || '.'),
        host: hostname(),
        state: 'running',
        createdAt: Date.now(),
      })
      .returning()
      .get();
    this.store.notify();
    return row;
  }
  private append(id: string, text: string, final = false) {
    const live = this.live.get(id);
    if (!live) return;
    // Human-owned output is ephemeral and visible only to the authenticated owner.
    // Agent-owned output buffers only an actual possible secret prefix.
    const humanOwned = this.get(id).owner === 'human';
    const value = (live.redactionPending || '') + text;
    const safe = humanOwned ? { text: value, pending: '' } : this.vault.redactStream(value, final);
    text = safe.text;
    live.redactionPending = safe.pending;
    live.output += text;
    if (live.output.length > OUTPUT_LIMIT) {
      const remove = live.output.length - OUTPUT_LIMIT;
      live.output = live.output.slice(remove);
      live.offset += remove;
    }
    if (live.screen && !humanOwned)
      live.flushed = new Promise<void>((done) => live.screen!.write(text, done));
    if (text) this.output.emit(id);
    if (!live.timer)
      live.timer = setTimeout(() => {
        live.timer = undefined;
        this.flush(id);
      }, 250);
  }
  private flush(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    if (this.get(id).owner !== 'human')
      this.store.db
        .update(runs)
        .set({ output: l.output, outputOffset: l.offset })
        .where(eq(runs.id, id))
        .run();
  }
  private finish(id: string, exitCode: number | null, result?: Record<string, unknown>) {
    const live = this.live.get(id);
    if (!live) return;
    this.append(id, '', true);
    clearTimeout(live.timer);
    this.flush(id);
    live.screen?.dispose();
    this.live.delete(id);
    const row = this.get(id);
    this.store.db.transaction(() => {
      this.store.db
        .update(runs)
        .set({
          state: exitCode === 0 ? 'completed' : 'failed',
          exitCode,
          endedAt: Date.now(),
          result,
        })
        .where(eq(runs.id, id))
        .run();
      this.store.event(
        row.conversationId,
        'run.completed',
        { runId: id, kind: row.kind, exitCode, ...(result ? { result } : {}) },
        `run:${id}`,
      );
    });
    this.store.notify();
  }
  shell(conversationId: string, command: string, cwd?: string) {
    const row = this.create(conversationId, 'shell', command, cwd);
    let child: ChildProcess;
    try {
      child = spawn(
        process.platform === 'win32'
          ? process.env.ComSpec || 'cmd.exe'
          : process.env.SHELL || '/bin/sh',
        process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command],
        {
          cwd: row.cwd,
          env: shellEnvironment(),
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch {
      this.live.set(row.id, { kill() {}, output: '', offset: 0 });
      this.finish(row.id, -1, { error: 'Process could not start.' });
      return this.get(row.id);
    }
    this.live.set(row.id, {
      output: '',
      offset: 0,
      kill: () => this.killGroup(row.id, child.pid, () => child.kill('SIGTERM')),
    });
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream!.on('data', (data: Buffer) => this.append(row.id, decoder.write(data)));
      stream!.on('end', () => this.append(row.id, decoder.end()));
    }
    child.once('error', () => this.finish(row.id, -1, { error: 'Process could not start.' }));
    child.once('close', (code) => this.finish(row.id, code));
    return row;
  }
  terminal(conversationId: string, command?: string[], cwd?: string, cols = 100, rows = 30) {
    const defaultShell =
      process.platform === 'win32'
        ? process.env.ComSpec || 'cmd.exe'
        : process.env.SHELL || '/bin/bash';
    const row = this.create(conversationId, 'terminal', (command || [defaultShell]).join(' '), cwd);
    const decoder = new StringDecoder('utf8');
    const screen = new HeadlessTerminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
    this.live.set(row.id, { kill() {}, output: '', offset: 0, screen });
    try {
      if (process.platform === 'win32') {
        const pty = createRequire(import.meta.url)('node-pty') as typeof import('node-pty');
        const program = command || [defaultShell];
        const child = pty.spawn(program[0], program.slice(1), {
          cwd: row.cwd,
          env: shellEnvironment(),
          cols,
          rows,
          name: 'xterm-256color',
        });
        child.onData((text) => this.append(row.id, text));
        child.onExit(({ exitCode }) => this.finish(row.id, exitCode));
        Object.assign(this.live.get(row.id)!, {
          kill: () => child.kill(),
          write: (text: string) => child.write(text),
          resize: (c: number, r: number) => {
            child.resize(c, r);
            screen.resize(c, r);
          },
        });
        return this.get(row.id);
      }
      const terminal = new Bun.Terminal({
        cols,
        rows,
        data: (_term, data) => this.append(row.id, decoder.write(Buffer.from(data))),
      });
      const proc = Bun.spawn(command || [defaultShell, '-i'], {
        cwd: row.cwd,
        env: shellEnvironment(),
        detached: true,
        terminal,
      });
      Object.assign(this.live.get(row.id)!, {
        kill: () => this.killGroup(row.id, proc.pid, () => proc.kill()),
        write: (text: string) => terminal.write(text),
        resize: (c: number, r: number) => {
          terminal.resize(c, r);
          screen.resize(c, r);
        },
      });
      void proc.exited
        .then((code) => {
          this.append(row.id, decoder.end());
          terminal.close();
          this.finish(row.id, code);
        })
        .catch(() => this.finish(row.id, -1));
    } catch {
      this.finish(row.id, -1, { error: 'PTY could not start.' });
    }
    return this.get(row.id);
  }
  managed(
    conversationId: string,
    title: string,
    execute: (
      signal: AbortSignal,
      emit: (text: string) => void,
      update: (metadata: Record<string, unknown>) => void,
    ) => Promise<Record<string, unknown>>,
    kind: 'mcp' | 'native' = 'mcp',
    cwd?: string,
  ) {
    const row = this.create(conversationId, kind, title, cwd),
      controller = new AbortController();
    this.live.set(row.id, { output: '', offset: 0, kill: () => controller.abort() });
    // Long external calls, including elicitation, never retain the parent loop.
    void Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        this.store.assertEnabled();
        return execute(
          controller.signal,
          (text) => this.append(row.id, text),
          (metadata) => {
            if (!this.live.has(row.id)) return;
            this.store.db
              .update(runs)
              .set({ result: JSON.parse(this.vault.redact(JSON.stringify(metadata))) })
              .where(eq(runs.id, row.id))
              .run();
            this.store.notify();
          },
        );
      })
      .then((result) => {
        const safe = JSON.parse(this.vault.redact(JSON.stringify(result))) as Record<
          string,
          unknown
        >;
        this.append(row.id, JSON.stringify(safe, null, 2));
        this.finish(row.id, safe.isError === true ? 1 : 0, safe);
      })
      .catch(() =>
        this.finish(row.id, -1, {
          error: controller.signal.aborted
            ? 'Cancelled.'
            : 'External operation failed. Check connection status.',
        }),
      );
    return row;
  }
  read(id: string, offset = 0, limit = 16000, asAgent = false) {
    const row = this.get(id);
    if (asAgent && row.owner === 'human')
      throw new Error('This terminal is handed to the user; observation is suspended.');
    const live = this.live.get(id),
      output = live?.output ?? row.output,
      base = live?.offset ?? row.outputOffset;
    const start = Math.max(offset, base),
      text = output.slice(start - base, start - base + limit);
    return {
      ...row,
      output: undefined,
      text,
      offset: start,
      nextOffset: start + text.length,
      truncated: offset < base,
      hasMore: start + text.length < base + output.length,
      capabilities: {
        pty: row.kind === 'terminal',
        read: true,
        stop: row.state === 'running',
        immediateInput: row.kind === 'terminal' && !!live?.write,
        nextTurnViaResume: row.kind === 'native',
      },
      turnState:
        row.kind === 'native' && row.state !== 'interrupted'
          ? row.result?.turnState || 'unknown'
          : 'unknown',
    };
  }
  async screen(id: string) {
    const row = this.get(id);
    if (row.owner === 'human') throw new Error('User owns this terminal.');
    const live = this.live.get(id);
    if (!live?.screen) throw new Error('No live PTY screen.');
    await live.flushed;
    if (this.get(id).owner !== 'agent' || this.get(id).epoch !== row.epoch)
      throw new Error('Ownership changed during terminal observation.');
    const b = live.screen.buffer.active;
    return {
      text: Array.from(
        { length: live.screen.rows },
        (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) || '',
      ).join('\n'),
      cols: live.screen.cols,
      rows: live.screen.rows,
      epoch: row.epoch,
      host: row.host,
    };
  }
  write(id: string, text: string, actor: 'human' | 'agent', epoch: number) {
    this.store.assertEnabled();
    const row = this.get(id),
      live = this.live.get(id);
    if (row.epoch !== epoch || row.owner !== actor)
      throw new Error('Terminal ownership changed. Observe it again.');
    if (!live?.write) throw new Error('No live writable PTY.');
    live.write(text);
  }
  resize(id: string, cols: number, rows: number, actor: 'human' | 'agent' = 'human') {
    this.store.assertEnabled();
    if (this.get(id).owner !== actor) throw new Error('Terminal ownership changed.');
    const live = this.live.get(id);
    if (!live?.resize) throw new Error('No live PTY.');
    live.resize(cols, rows);
    this.store.notify();
  }
  handoff(id: string, owner: 'human' | 'agent') {
    const row = this.get(id),
      live = this.live.get(id);
    if (owner === 'agent' && row.owner === 'human' && live) {
      live.offset += live.output.length;
      live.output = '\r\n[Human-controlled interval omitted from the transcript]\r\n';
      live.redactionPending = '';
      live.screen?.reset();
      this.store.db
        .update(runs)
        .set({ output: live.output, outputOffset: live.offset })
        .where(eq(runs.id, id))
        .run();
    }
    this.store.db
      .update(runs)
      .set({ owner, epoch: row.epoch + 1 })
      .where(eq(runs.id, id))
      .run();
    this.store.notify();
    return this.get(id);
  }
  stop(id: string) {
    const live = this.live.get(id);
    if (!live) return this.get(id);
    this.store.db.update(runs).set({ state: 'stopping' }).where(eq(runs.id, id)).run();
    live.kill();
    this.store.notify();
    return this.get(id);
  }
  stopAll() {
    for (const id of this.live.keys()) this.stop(id);
  }
  async close() {
    this.stopAll();
    const until = Date.now() + 5000;
    while (this.live.size && Date.now() < until) await Bun.sleep(25);
    // Do not let a late external callback touch a closed database.
    for (const [id, live] of this.live) {
      clearTimeout(live.timer);
      this.flush(id);
      live.screen?.dispose();
      this.store.db
        .update(runs)
        .set({ state: 'interrupted', endedAt: Date.now() })
        .where(eq(runs.id, id))
        .run();
    }
    this.live.clear();
    this.output.removeAllListeners();
  }
  recover() {
    for (const r of this.store.db
      .select()
      .from(runs)
      .where(inArray(runs.state, ['running', 'stopping']))
      .all()) {
      this.store.db.transaction(() => {
        this.store.db
          .update(runs)
          .set({ state: 'interrupted', endedAt: Date.now() })
          .where(eq(runs.id, r.id))
          .run();
        this.store.event(
          r.conversationId,
          'run.completed',
          {
            runId: r.id,
            outcome: 'interrupted',
            note: 'Backend restarted; execution was not replayed.',
          },
          `run:${r.id}`,
        );
      });
    }
  }
  private killGroup(id: string, pid: number | undefined, fallback: () => unknown) {
    if (!pid) return;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      fallback();
    }
    const timer = setTimeout(() => {
      if (!this.live.has(id)) return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }, 2000);
    timer.unref();
  }
}
