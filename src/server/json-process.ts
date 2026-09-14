import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { shellEnvironment } from './runs';

export class JsonProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events = new EventEmitter();
  readonly exited: Promise<number | null>;
  private sequence = 0;
  private ended = false;
  private pending = new Map<
    number,
    { resolve: (r: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(
    command: string[],
    cwd: string,
    readonly emit: (text: string) => void,
  ) {
    this.child = spawn(command[0], command.slice(1), {
      cwd,
      env: {
        ...shellEnvironment(),
        ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
      },
      detached: process.platform !== 'win32',
      stdio: 'pipe',
    });
    this.exited = new Promise((resolve) => this.child.once('close', resolve));
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) {
        this.fail();
        return;
      }
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined && !message.method) {
            const p = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (p) clearTimeout(p.timer);
            if (message.error) p?.reject(new Error('Native RPC failed.'));
            else p?.resolve(message.result);
          } else this.events.emit('message', message);
        } catch {
          this.fail();
        }
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) => emit(chunk.toString().slice(0, 16000)));
    this.child.on('error', () => this.fail());
    this.child.stdin.on('error', () => this.fail());
    this.child.once('close', () => this.fail(false));
  }
  send(message: unknown) {
    if (this.ended) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method: string, params: unknown, timeoutMs = 20000) {
    if (this.ended) return Promise.reject(new Error('Native connection is closed.'));
    const id = ++this.sequence;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Native RPC timed out.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  private fail(kill = true) {
    if (this.ended) return;
    this.ended = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Native connection ended.'));
    }
    this.pending.clear();
    this.events.emit('ended');
    if (kill) this.child.kill();
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal);
        else this.child.kill(signal);
      } catch {}
    };
    kill('SIGINT');
    const timer = setTimeout(() => kill('SIGKILL'), 2000);
    await this.exited;
    clearTimeout(timer);
  }
}
