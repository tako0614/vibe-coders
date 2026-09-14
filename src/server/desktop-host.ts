import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostConfig } from './config';
import { atomicWrite } from './config';
import { RfbClient } from './rfb';
import { shellEnvironment } from './runs';

type Target = NonNullable<HostConfig['desktop']>;
type Lease = { pid: number; start: string };
const dependencies = {
  xdpyinfo: 'x11-utils',
  x11vnc: 'x11vnc',
  Xvfb: 'xvfb',
  xauth: 'xauth',
  openbox: 'openbox',
  xterm: 'xterm',
};
export function missingDesktopPackages(virtual: boolean, which = Bun.which) {
  return Object.entries(dependencies)
    .filter(([command]) => (virtual || ['xdpyinfo', 'x11vnc'].includes(command)) && !which(command))
    .map(([, pkg]) => pkg);
}
function processStart(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  } catch {
    return undefined;
  }
}
function killOwned(lease: Lease, signal: NodeJS.Signals) {
  if (processStart(lease.pid) !== lease.start) return;
  try {
    process.kill(-lease.pid, signal);
  } catch {
    /* Already exited. */
  }
}

/** Owns only the display bridge and processes launched by this Home. */
export class DesktopHost {
  target?: Target;
  password = '';
  environment: Record<string, string | undefined> = {};
  state: 'idle' | 'preparing' | 'ready' | 'error' = 'idle';
  message = 'インストール先の画面を自動で接続します。';
  source: 'host' | 'virtual' | undefined;
  private pending?: Promise<Target>;
  private children = new Map<ChildProcess, Lease>();
  private commands = new Set<{ kill: () => void }>();
  private closed = false;
  private generation = 0;
  readonly directory: string;
  constructor(
    readonly home: string,
    directory: string,
    readonly notify: () => void,
  ) {
    this.directory = join(directory, 'computer');
  }
  private progress(message: string) {
    this.message = message;
    this.notify();
  }
  private assert(generation: number) {
    if (this.closed || generation !== this.generation)
      throw new Error('デスクトップの準備を中断しました。');
  }
  private async command(
    args: string[],
    env: Record<string, string | undefined> = shellEnvironment(),
    input?: string,
    timeout = 15000,
  ) {
    if (this.closed) throw new Error('Desktop closed.');
    const p = Bun.spawn(args, {
      env,
      stdin: input === undefined ? 'ignore' : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout,
    });
    this.commands.add(p);
    if (input !== undefined && p.stdin && typeof p.stdin !== 'number') {
      p.stdin.write(input);
      p.stdin.end();
    }
    const [, error, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    this.commands.delete(p);
    if (code !== 0) throw new Error(`${args[0]}: ${error.trim().slice(-1200) || `exit ${code}`}`);
  }
  private async install(virtual: boolean, allowInstall: boolean) {
    const packages = missingDesktopPackages(virtual);
    if (!packages.length) return;
    const instruction = `sudo apt-get install -y ${packages.join(' ')}`;
    if (!allowInstall || !Bun.which('apt-get'))
      throw new Error(`必要なデスクトップ機能がありません。Debian / Ubuntu: ${instruction}`);
    const prefix = process.getuid?.() === 0 ? [] : ['sudo', '-n'];
    if (prefix.length) {
      try {
        await this.command([...prefix, 'true']);
      } catch {
        throw new Error(
          `インストール権限が必要です。ホストの端末で実行してください: ${instruction}`,
        );
      }
    }
    this.progress(`画面の準備に必要なパッケージをインストールしています: ${packages.join(', ')}`);
    const env = { ...shellEnvironment(), DEBIAN_FRONTEND: 'noninteractive' };
    const install = () =>
      this.command(
        [...prefix, 'apt-get', 'install', '-y', '--no-install-recommends', ...packages],
        env,
        undefined,
        180000,
      );
    try {
      await install();
    } catch (error) {
      if (
        this.closed ||
        !/Unable to locate package|no installation candidate|Failed to fetch|404/.test(
          String(error),
        )
      )
        throw error;
      this.progress('パッケージ一覧を更新しています…');
      await this.command([...prefix, 'apt-get', 'update'], env, undefined, 180000);
      await install();
    }
    if (missingDesktopPackages(virtual).length)
      throw new Error(`インストールを確認してください: ${instruction}`);
  }
  private persist() {
    atomicWrite(
      join(this.directory, 'processes.json'),
      JSON.stringify([...this.children.values()]),
    );
  }
  private start(args: string[], env: Record<string, string | undefined>, critical = false) {
    const p = spawn(args[0], args.slice(1), {
      cwd: this.home,
      env,
      detached: true,
      stdio: 'ignore',
    });
    const start = p.pid && processStart(p.pid);
    if (p.pid && start) {
      this.children.set(p, { pid: p.pid, start });
      this.persist();
    }
    p.on('error', () => {});
    p.on('exit', () => {
      this.children.delete(p);
      this.persist();
      if (critical && this.state === 'ready' && !this.closed) {
        this.target = undefined;
        this.state = 'error';
        this.progress('デスクトップとの接続が終了しました。再接続してください。');
      }
    });
    return p;
  }
  private async reap() {
    let old: Lease[] = [];
    try {
      old = JSON.parse(readFileSync(join(this.directory, 'processes.json'), 'utf8'));
    } catch {
      /* First launch. */
    }
    for (const lease of old) killOwned(lease, 'SIGTERM');
    if (old.length) await Bun.sleep(250);
    for (const lease of old) killOwned(lease, 'SIGKILL');
    this.children.clear();
    this.persist();
  }
  private async stopChildren() {
    const children = [...this.children.keys()];
    const exits = children.map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => child.once('exit', () => resolve())),
    );
    const leases = [...this.children.values()];
    for (const lease of leases) killOwned(lease, 'SIGTERM');
    if (leases.length) await Bun.sleep(300);
    for (const lease of leases) killOwned(lease, 'SIGKILL');
    await Promise.race([Promise.all(exits), Bun.sleep(1000)]);
    this.children.clear();
    this.persist();
  }
  prepare(virtual = false, allowInstall = true): Promise<Target> {
    if (this.closed) return Promise.reject(new Error('Desktop closed.'));
    if (this.target) return Promise.resolve(this.target);
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.state = 'preparing';
    this.progress('インストール先の画面を確認しています…');
    this.pending = this.setup(virtual, allowInstall, generation)
      .catch(async (error) => {
        await this.stopChildren();
        this.target = undefined;
        if (!this.closed) {
          this.state = 'error';
          this.progress(error instanceof Error ? error.message : String(error));
        }
        throw error;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async setup(virtual: boolean, allowInstall: boolean, generation: number) {
    if (process.platform !== 'linux')
      throw new Error('自動接続はLinuxで利用できます。この環境では設定からVNCを接続してください。');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    await this.reap();
    this.assert(generation);
    await this.install(false, allowInstall);
    this.assert(generation);
    let display: string | undefined;
    let env: Record<string, string | undefined> = shellEnvironment();
    if (!virtual) {
      const candidates = process.env.DISPLAY ? [process.env.DISPLAY] : [':0', ':1'];
      for (const candidate of candidates.filter((d) => /^:\d+(\.\d+)?$/.test(d))) {
        try {
          await this.command(['xdpyinfo', '-display', candidate], env, undefined, 2000);
          display = candidate;
          break;
        } catch {
          /* No accessible X11 session. Never borrow another user's Xauthority. */
        }
      }
    }
    this.assert(generation);
    this.source = display ? 'host' : 'virtual';
    if (!display) {
      await this.install(true, allowInstall);
      this.assert(generation);
      const number = Array.from({ length: 120 }, (_, i) => 90 + i).find(
        (n) => !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`),
      );
      if (number === undefined) throw new Error('仮想画面用の空きDISPLAYがありません。');
      display = `:${number}`;
      this.progress('このホストに専用デスクトップを起動しています…');
      const authority = join(this.directory, 'Xauthority');
      writeFileSync(authority, '', { mode: 0o600 });
      chmodSync(authority, 0o600);
      await this.command(
        ['xauth', '-f', authority],
        env,
        `add ${display} . ${randomBytes(16).toString('hex')}\n`,
      );
      this.assert(generation);
      env = { ...env, DISPLAY: display, XAUTHORITY: authority };
      const x = this.start(
        [
          'Xvfb',
          display,
          '-screen',
          '0',
          '1280x800x24',
          '-nolisten',
          'tcp',
          '-noreset',
          '-auth',
          authority,
        ],
        env,
        true,
      );
      let ready = false;
      for (let i = 0; i < 50; i++) {
        this.assert(generation);
        if (x.exitCode !== null) throw new Error('仮想デスクトップを起動できませんでした。');
        try {
          await this.command(['xdpyinfo', '-display', display], env, undefined, 1000);
          ready = true;
          break;
        } catch {
          await Bun.sleep(100);
        }
      }
      if (!ready) throw new Error('仮想デスクトップの起動がタイムアウトしました。');
      this.start(['openbox', '--sm-disable'], env, true);
    } else env = { ...env, DISPLAY: display };
    this.assert(generation);
    this.environment = env;
    this.password = randomBytes(6).toString('base64url');
    const passwordFile = join(this.directory, 'vnc-password');
    writeFileSync(passwordFile, this.password + '\n', { mode: 0o600 });
    chmodSync(passwordFile, 0o600);
    const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = reserve.port!;
    await reserve.stop(true);
    this.assert(generation);
    const vnc = this.start(
      [
        'x11vnc',
        '-norc',
        '-display',
        display,
        '-localhost',
        '-listen',
        '127.0.0.1',
        '-rfbport',
        String(port),
        '-passwdfile',
        passwordFile,
        '-forever',
        '-shared',
        '-noxdamage',
        '-quiet',
        '-safer',
        '-nocmds',
      ],
      env,
      true,
    );
    let ready = false;
    for (let i = 0; i < 50; i++) {
      this.assert(generation);
      if (vnc.exitCode !== null) throw new Error('画面の接続サーバーを起動できませんでした。');
      const client = new RfbClient('127.0.0.1', port);
      try {
        await client.connect(this.password);
        await client.screenshot();
        ready = true;
        break;
      } catch {
        await Bun.sleep(100);
      } finally {
        client.close();
      }
    }
    this.assert(generation);
    if (!ready) throw new Error('デスクトップへの接続がタイムアウトしました。');
    this.target = {
      name: this.source === 'host' ? 'このホストのデスクトップ' : 'このホストの専用デスクトップ',
      display,
      mode: 'vnc',
      vncHost: '127.0.0.1',
      vncPort: port,
      revision: Date.now(),
    };
    this.state = 'ready';
    this.progress(
      this.source === 'host'
        ? 'インストール先の画面に接続しました。'
        : '画面のない環境のため、このホストに専用画面を用意しました。',
    );
    if (this.source === 'virtual') this.launch('terminal');
    return this.target;
  }
  launch(app: 'browser' | 'terminal', url?: string) {
    if (!this.target) throw new Error('デスクトップを準備してください。');
    let args: string[];
    if (app === 'terminal') {
      if (!Bun.which('xterm')) throw new Error('このホストにxtermをインストールしてください。');
      args = [
        'xterm',
        '-title',
        'vibe coders',
        '-fa',
        'monospace',
        '-fs',
        '12',
        '-geometry',
        '100x30+36+36',
      ];
    } else {
      const command = [
        'google-chrome',
        'google-chrome-stable',
        'chromium',
        'chromium-browser',
      ].find((x) => Bun.which(x));
      if (!command) throw new Error('このホストにChromeまたはChromiumをインストールしてください。');
      if (url && !/^https?:$/.test(new URL(url).protocol))
        throw new Error('HTTPまたはHTTPSのURLを指定してください。');
      args = [
        command,
        `--user-data-dir=${join(this.directory, 'chrome')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
        url || 'about:blank',
      ];
    }
    this.start(args, this.environment);
    return { launched: app, display: this.target.display };
  }
  async close() {
    this.closed = true;
    this.generation++;
    for (const p of this.commands) p.kill();
    await this.pending?.catch(() => {});
    await this.stopChildren();
    this.target = undefined;
    this.password = '';
    for (const name of ['Xauthority', 'vnc-password'])
      rmSync(join(this.directory, name), { force: true });
  }
}
