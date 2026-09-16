import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { mcpSchema, desktopIdSchema } from '../shared/contracts';
import type { McpService } from './mcp';
import { shellEnvironment } from './runs';

export const mcpInstallSchema = z
  .object({
    conversationId: z.string(),
    operationId: z.string().uuid(),
    name: mcpSchema.shape.name,
    package: z
      .string()
      .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/)
      .max(214),
    version: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,100}$/)
      .default('latest'),
    bin: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/)
      .optional(),
    args: z.array(z.string().max(4000)).max(50).default([]),
    credentialEnv: mcpSchema.shape.credentialEnv,
    desktopId: desktopIdSchema.optional(),
  })
  .strict();

async function command(
  argv: string[],
  cwd: string,
  signal: AbortSignal,
  emit: (text: string) => void,
) {
  signal.throwIfAborted();
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: shellEnvironment(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    overflow = false,
    failure = false;
  const kill = (sig: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {}
  };
  let hard: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    kill('SIGTERM');
    hard ??= setTimeout(() => kill('SIGKILL'), 2000);
  };
  const deadline = setTimeout(stop, 10 * 60 * 1000);
  signal.addEventListener('abort', stop, { once: true });
  child.stdout.on('data', (data: Buffer) => {
    stdout += data;
    if (stdout.length > 1024 * 1024) {
      overflow = true;
      stop();
    }
    emit(data.toString());
  });
  child.stderr.on('data', (data: Buffer) => emit(data.toString()));
  child.on('error', () => {
    failure = true;
  });
  try {
    const code = await new Promise<number | null>((done) => child.once('close', done));
    signal.throwIfAborted();
    if (failure || overflow || code !== 0)
      throw new Error('npmの処理に失敗しました。実行ログを確認して再試行してください。');
    return stdout;
  } finally {
    clearTimeout(deadline);
    clearTimeout(hard);
    signal.removeEventListener('abort', stop);
  }
}

/** App-owned, version-pinned installations; AI availability is not a prerequisite. */
export class McpInstaller {
  private names = new Set<string>();
  private packages = new Map<string, Promise<void>>();
  constructor(
    readonly mcp: McpService,
    readonly npm = ['npm'],
  ) {}
  start(value: unknown) {
    const input = mcpInstallSchema.parse(value),
      { store, config, runs } = this.mcp;
    store.assertEnabled();
    store.conversation(input.conversationId);
    const key = `mcp-install:${input.operationId}`,
      fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous = store.get<{ runId: string; fingerprint: string } | null>(key, null);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('導入IDは別の操作に使用済みです。');
      return runs.get(previous.runId);
    }
    if (this.names.has(input.name) || config.read().mcp.some((c) => c.name === input.name))
      throw new Error('この接続名は使用中です。既存接続は「接続」から再試行できます。');
    this.names.add(input.name);
    const run = runs.managed(
      input.conversationId,
      `MCP導入: ${input.name}`,
      async (signal, emit, update) => {
        let stage = 'resolving',
          version = input.version;
        const progress = () => {
          update({ install: true, name: input.name, package: input.package, version, stage });
          emit(`\n[${stage}] ${input.package}@${version}\n`);
        };
        try {
          progress();
          const metadata = JSON.parse(
            await command(
              [
                ...this.npm,
                'view',
                `${input.package}@${input.version}`,
                'version',
                'bin',
                '--json',
              ],
              this.mcp.home,
              signal,
              emit,
            ),
          );
          version = z
            .string()
            .regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/)
            .parse(metadata.version);
          const bins: Record<string, string> =
            typeof metadata.bin === 'string'
              ? { [basename(input.package)]: metadata.bin }
              : metadata.bin || {};
          const bin =
            input.bin ||
            (bins[basename(input.package)]
              ? basename(input.package)
              : Object.keys(bins).length === 1
                ? Object.keys(bins)[0]
                : undefined);
          if (!bin || typeof bins[bin] !== 'string')
            throw new Error(
              `実行ファイル名を指定してください。候補: ${Object.keys(bins).join(', ') || 'なし'}`,
            );
          const root = join(config.directory, 'mcp-packages');
          await mkdir(root, { recursive: true, mode: 0o700 });
          const target = join(
            root,
            createHash('sha256').update(`${input.package}@${version}`).digest('hex').slice(0, 24),
          );
          const previousInstall = this.packages.get(target) || Promise.resolve();
          let release!: () => void;
          const lock = new Promise<void>((done) => {
            release = done;
          });
          const queued = previousInstall.then(() => lock);
          this.packages.set(target, queued);
          await previousInstall;
          try {
            signal.throwIfAborted();
            stage = 'installing';
            progress();
            const manifest = join(target, 'node_modules', input.package, 'package.json');
            let installed = false;
            try {
              installed = JSON.parse(await readFile(manifest, 'utf8')).version === version;
            } catch {}
            if (!installed) {
              const temp = await mkdtemp(join(root, '.install-'));
              try {
                await command(
                  [
                    ...this.npm,
                    'install',
                    '--prefix',
                    temp,
                    '--no-audit',
                    '--no-fund',
                    '--save-exact',
                    `${input.package}@${version}`,
                  ],
                  this.mcp.home,
                  signal,
                  emit,
                );
                if (
                  JSON.parse(
                    await readFile(
                      join(temp, 'node_modules', input.package, 'package.json'),
                      'utf8',
                    ),
                  ).version !== version
                )
                  throw new Error('導入されたバージョンを確認できませんでした。');
                await rm(target, { recursive: true, force: true });
                await rename(temp, target);
              } finally {
                await rm(temp, { recursive: true, force: true });
              }
            }
          } finally {
            release();
            if (this.packages.get(target) === queued) this.packages.delete(target);
          }
          const packageRoot = join(target, 'node_modules', input.package),
            executable = resolve(packageRoot, bins[bin]);
          if (
            relative(packageRoot, executable).startsWith('..') ||
            !(await Bun.file(executable).exists())
          )
            throw new Error('パッケージ内の実行ファイルが見つかりません。');
          signal.throwIfAborted();
          store.assertEnabled();
          stage = 'connecting';
          progress();
          const next = this.mcp.configure(
            config.read().revision,
            {
              name: input.name,
              transport: 'stdio',
              command: executable,
              args: input.args,
              enabled: true,
              ...(input.credentialEnv ? { credentialEnv: input.credentialEnv } : {}),
              ...(input.desktopId ? { targetId: `desktop:${input.desktopId}` } : {}),
            },
            true,
          );
          await this.mcp.connect(
            next.mcp.find((c) => c.name === input.name)!,
            input.conversationId,
            signal,
          );
          return {
            install: true,
            name: input.name,
            package: input.package,
            version,
            stage:
              this.mcp.status().find((c) => c.name === input.name)?.state === 'connected'
                ? 'ready'
                : 'awaiting_auth',
            ...this.mcp.status().find((c) => c.name === input.name),
          };
        } catch (e) {
          const error = this.mcp.vault.redact(
            e instanceof Error ? e.message : 'MCPの導入に失敗しました。',
          );
          emit(`\n${error}\n`);
          return {
            install: true,
            name: input.name,
            package: input.package,
            version,
            stage,
            isError: true,
            error,
          };
        } finally {
          this.names.delete(input.name);
        }
      },
    );
    store.set(key, { runId: run.id, fingerprint });
    return run;
  }
}
