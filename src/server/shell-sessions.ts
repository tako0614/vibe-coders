import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store';
import { RunService, shellEnvironment } from './runs';
import type { Desktop } from './desktop';
import type { ShellSession, ShellCommand } from '../shared/shell';
import { eq } from 'drizzle-orm';
import { runs as runRows } from './db/schema';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export class ShellSessions {
  private opening = new Map<string, Promise<ReturnType<ShellSessions['read']>>>();
  private watchers = new Map<
    string,
    {
      nonce: string;
      offset: number;
      carry: string;
      epoch: number;
      queued?: ReturnType<typeof setTimeout>;
      read: () => void;
      file: string;
    }
  >();
  constructor(
    readonly store: Store,
    readonly runs: RunService,
    readonly directory: string,
    readonly desktops: Desktop,
  ) {
    this.store.changes.on('change', this.check);
  }
  list(conversationId: string) {
    const available = new Set(
      this.store.db
        .select({ id: runRows.id })
        .from(runRows)
        .where(eq(runRows.conversationId, conversationId))
        .all()
        .map((run) => run.id),
    );
    return this.store
      .get<string[]>(`shell-sessions:${conversationId}`, [])
      .filter((id) => available.has(id))
      .map((id) => this.session(id));
  }
  session(id: string): ShellSession {
    const session = this.store.get<ShellSession | null>(`shell-session:${id}`, null);
    if (!session) throw new Error('作業シェルが見つかりません。');
    const run = this.runs.get(id);
    return run.state === 'running'
      ? session
      : {
          ...session,
          state: 'closed',
          ready: false,
          commands: session.commands.map((command) =>
            command.state === 'running'
              ? { ...command, state: 'interrupted', endedAt: run.endedAt || Date.now() }
              : command,
          ),
        };
  }
  private save(session: ShellSession) {
    this.store.set(`shell-session:${session.id}`, session);
  }
  private check = () => {
    for (const [id, watch] of this.watchers) {
      const run = this.runs.get(id);
      if (run.state !== 'running') {
        const session = this.session(id);
        this.watchers.delete(id);
        this.runs.output.off(id, watch.read);
        clearTimeout(watch.queued);
        rmSync(watch.file, { force: true });
        this.save({
          ...session,
          ready: false,
          state: 'closed',
          commands: session.commands.map((command) =>
            command.state === 'running'
              ? { ...command, state: 'interrupted', endedAt: Date.now() }
              : command,
          ),
        });
      } else if (watch.epoch !== run.epoch) {
        watch.epoch = run.epoch;
        watch.carry = '';
        const session = this.session(id);
        this.save({
          ...session,
          ready: false,
          state: 'starting',
          commands: session.commands.map((command) =>
            command.state === 'running'
              ? { ...command, state: 'interrupted', endedAt: Date.now() }
              : command,
          ),
        });
        // A fresh prompt after handoff establishes readiness; never inject input
        // into a program that the human may have left running.
        if (run.owner === 'agent') watch.read();
      }
    }
  };
  async open(
    conversationId: string,
    input: { name?: string; cwd?: string; desktopId?: string } = {},
  ) {
    const key = JSON.stringify([conversationId, input.name || 'main', input.desktopId || '']);
    const existing = this.opening.get(key);
    if (existing) return existing;
    const task = this.openSession(conversationId, input);
    this.opening.set(key, task);
    try {
      return await task;
    } finally {
      this.opening.delete(key);
    }
  }
  private async openSession(
    conversationId: string,
    input: { name?: string; cwd?: string; desktopId?: string },
  ) {
    this.store.assertEnabled();
    const name = input.name || 'main';
    const current = this.list(conversationId).find(
      (session) =>
        session.name === name &&
        this.runs.get(session.id).state === 'running' &&
        (this.runs.get(session.id).desktopId || undefined) === input.desktopId,
    );
    if (current) return this.read(current.id);
    const bash = Bun.which('bash');
    if (!bash)
      throw new Error(
        '作業シェルのコマンド連携にはBashが必要です。通常のターミナルはそのまま使えます。',
      );
    if (input.desktopId) await this.desktops.get(input.desktopId).prepare();
    const env = input.desktopId
      ? this.desktops.get(input.desktopId).environment('agent')
      : shellEnvironment();
    const nonce = crypto.randomUUID().replaceAll('-', '');
    const path = join(this.directory, 'shells');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const file = join(path, nonce + '.bash');
    writeFileSync(
      file,
      `if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n__vibe_report_prompt() { __vibe_last_status=$?; printf '\\033]777;vibe:${nonce};%s;%s\\007' "$__vibe_last_status" "$PWD"; }\nPROMPT_COMMAND="__vibe_report_prompt\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"\n`,
      { mode: 0o600 },
    );
    const run = this.runs.terminal(
      conversationId,
      [bash, '--rcfile', file, '-i'],
      input.cwd,
      100,
      30,
      { env, desktopId: input.desktopId },
    );
    this.runs.rename(run.id, name === 'main' ? '作業シェル' : name);
    const session: ShellSession = {
      id: run.id,
      conversationId,
      name,
      cwd: run.cwd,
      state: 'starting',
      ready: false,
      commands: [],
    };
    this.save(session);
    this.store.set(`shell-sessions:${conversationId}`, [
      ...this.store.get<string[]>(`shell-sessions:${conversationId}`, []),
      run.id,
    ]);
    const watch = {
      nonce,
      epoch: run.epoch,
      offset: 0,
      carry: '',
      queued: undefined as ReturnType<typeof setTimeout> | undefined,
      file,
      read: () => {
        if (!watch.queued)
          watch.queued = setTimeout(() => {
            watch.queued = undefined;
            this.observe(run.id);
          }, 30);
      },
    };
    this.watchers.set(run.id, watch);
    this.runs.output.on(run.id, watch.read);
    this.observe(run.id);
    this.check();
    const until = Date.now() + 5000;
    while (
      !this.session(run.id).ready &&
      this.runs.get(run.id).state === 'running' &&
      Date.now() < until
    )
      await new Promise((resolve) => setTimeout(resolve, 30));
    return this.read(run.id);
  }
  private observe(id: string) {
    const watch = this.watchers.get(id);
    if (!watch) return;
    let output: ReturnType<RunService['read']>;
    try {
      output = this.runs.read(id, watch.offset, 32000, true);
    } catch {
      watch.carry = '';
      return;
    } // Human ownership revokes observation.
    watch.offset = output.nextOffset;
    const text = watch.carry + output.text;
    const regex = new RegExp(
      `\\x1b\\]777;vibe:${watch.nonce};(-?\\d+);([^\\x07]{0,4000})\\x07`,
      'g',
    );
    let end = 0;
    for (const match of text.matchAll(regex)) {
      end = match.index! + match[0].length;
      const session = this.session(id),
        command = [...session.commands].reverse().find((command) => command.state === 'running');
      const at = Date.now();
      this.save({
        ...session,
        cwd: match[2]!,
        ready: true,
        state: 'ready',
        commands: session.commands.map((value) =>
          value.id === command?.id
            ? { ...value, state: 'completed', exitCode: Number(match[1]), endedAt: at }
            : value,
        ),
      });
      if (command) {
        this.store.event(
          session.conversationId,
          'run.completed',
          { runId: id, commandId: command.id, exitCode: Number(match[1]), persistentShell: true },
          `shell-command:${id}:${command.id}`,
        );
        this.store.notify();
      }
    }
    // Only an incomplete OSC sequence can span chunks. Replaying a full marker
    // would incorrectly finish a later command.
    const tail = text.slice(end),
      start = tail.lastIndexOf('\x1b');
    const suffix = start >= 0 ? tail.slice(start) : '';
    const prefix = `\x1b]777;vibe:${watch.nonce};`;
    watch.carry =
      suffix && !suffix.includes('\x07') && (prefix.startsWith(suffix) || suffix.startsWith(prefix))
        ? suffix.slice(-4200)
        : '';
    if (output.hasMore) watch.read();
  }
  read(id: string, offset = 0) {
    const output = this.runs.read(id, offset, 16000, true);
    return {
      session: this.session(id),
      runId: id,
      epoch: output.epoch,
      text: output.text.replace(/\x1b\]777;vibe:[^\x07]*\x07/g, ''),
      nextOffset: output.nextOffset,
      truncated: output.truncated,
      owner: output.owner,
      processState: output.state,
    };
  }
  async execute(
    conversationId: string,
    input: {
      sessionId?: string;
      name?: string;
      desktopId?: string;
      command: string;
      operationId: string;
      timeoutMs?: number;
    },
  ) {
    const opened = input.sessionId
      ? this.read(input.sessionId)
      : await this.open(conversationId, { name: input.name, desktopId: input.desktopId });
    const session = this.session(opened.session.id);
    if (session.conversationId !== conversationId)
      throw new Error('別の会話の作業シェルは操作できません。');
    const existing = session.commands.find((command) => command.id === input.operationId);
    if (existing) {
      if (existing.command !== this.runs.vault.redact(input.command))
        throw new Error('同じ操作IDに別のコマンドは使えません。');
      return this.poll(session.id, existing.id, input.timeoutMs);
    }
    if (!session.ready || session.state !== 'ready')
      throw new Error('このシェルは実行中です。shell_pollで待つか、run_writeで対話してください。');
    const output = this.runs.read(session.id, 0, 1, true);
    const command: ShellCommand = {
      id: input.operationId,
      command: this.runs.vault.redact(input.command),
      state: 'running',
      startedAt: Date.now(),
      offset: this.watchers.get(session.id)?.offset || 0,
    };
    this.save({
      ...session,
      ready: false,
      state: 'running',
      commands: [...session.commands.slice(-49), command],
    });
    try {
      this.runs.write(session.id, `eval -- ${quote(input.command)}\r`, 'agent', output.epoch);
    } catch (error) {
      this.save({
        ...session,
        commands: [
          ...session.commands.slice(-49),
          { ...command, state: 'interrupted', endedAt: Date.now() },
        ],
      });
      throw error;
    }
    return this.poll(session.id, command.id, input.timeoutMs);
  }
  async poll(id: string, commandId?: string, timeoutMs = 1000) {
    const until = Date.now() + Math.min(timeoutMs, 20000);
    let session: ShellSession;
    do {
      this.observe(id);
      session = this.session(id);
      const command = commandId
        ? session.commands.find((command) => command.id === commandId)
        : session.commands.at(-1);
      if (!command || command.state !== 'running' || Date.now() >= until)
        return { ...this.read(id, command?.offset), command };
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (true);
  }
  close() {
    this.store.changes.off('change', this.check);
    for (const [id, watch] of this.watchers) {
      this.runs.output.off(id, watch.read);
      clearTimeout(watch.queued);
      rmSync(watch.file, { force: true });
    }
    this.watchers.clear();
  }
}
