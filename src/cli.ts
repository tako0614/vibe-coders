#!/usr/bin/env bun
import { saveProvider } from './server/provider-connections';
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { input, password, confirm } from '@inquirer/prompts';
import { Config, Vault, initHome, loadHome, stateDirectory } from './server/config';
import { providerSchema, mcpSchema, desktopSchema } from './shared/contracts';

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    home: { type: 'string' },
    dev: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    json: { type: 'boolean' },
    username: { type: 'string' },
    'password-stdin': { type: 'boolean' },
    stdin: { type: 'boolean' },
    target: { type: 'string' },
    'base-url': { type: 'string' },
    model: { type: 'string' },
    kind: { type: 'string' },
    'no-key-required': { type: 'boolean' },
  },
});
const command = positionals[0] || 'serve',
  home = resolve(values.home || process.cwd()),
  config = new Config();

async function main() {
  if (values.help) {
    console.log(
      `Vibe Coders — repository-based resident agent\n\n  vibe-coders setup                 Configure Web authentication (masked input)\n  vibe-coders init                  Create atom.toml and AGENT.md without overwriting\n  vibe-coders [--home PATH]          Start the backend and WebUI\n  vibe-coders provider configure    Configure an OpenAI-compatible model\n  vibe-coders mcp add --json        Read a nonsecret MCP configuration from stdin\n  vibe-coders codex login            Sign into Codex using device authorization\n  vibe-coders computer connect --json  Read an X11 or VNC target from stdin\n  vibe-coders secret --target ID --stdin  Save a credential through stdin\n  vibe-coders config               Show nonsecret local configuration\n  vibe-coders doctor               Show available capabilities\n\nSetup automation: setup --username NAME --password-stdin\nCodex subscription: provider configure --kind codex --model ID\nProvider automation: provider configure --base-url URL --model ID [--no-key-required]\nBun >= 1.3.14. PTY: Bun on Linux/macOS, node-pty on Windows. Desktop: automatic on Linux; manual loopback VNC on other systems.\n`,
    );
    return;
  }
  if (command === 'init') {
    initHome(home);
    console.log(`Ready: ${home}/atom.toml and AGENT.md`);
    return;
  }
  if (command === 'setup' || (command === 'auth' && positionals[1] === 'web')) {
    const username =
      values.username || (await input({ message: 'WebUI username', default: 'owner' }));
    const secret = values['password-stdin']
      ? (await Bun.stdin.text()).trimEnd()
      : await password({ message: 'WebUI password (12+ characters)', mask: '*' });
    if (!username || username.includes(':') || secret.length < 12)
      throw new Error('Use a username without : and a password of at least 12 characters.');
    const passwordHash = await Bun.password.hash(secret, {
      algorithm: 'argon2id',
      memoryCost: 16384,
      timeCost: 2,
    });
    const current = config.read();
    config.update(current.revision, (c) => {
      c.web = {
        ...c.web,
        username,
        passwordHash,
        hostname: c.web?.hostname || '127.0.0.1',
        port: c.web?.port || 3100,
      };
    });
    console.log(
      'Web authentication saved outside the repository. Configure the model in WebUI settings or with provider configure.',
    );
    return;
  }
  if (command === 'provider' && positionals[1] === 'configure' && values.kind === 'codex') {
    const model = values.model || (await input({ message: 'Codex model ID' }));
    const provider = providerSchema.parse({
      kind: 'codex',
      model,
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      keyRequired: false,
      supportsImages: true,
    });
    saveProvider(config, new Vault(config.directory), config.read().revision, provider);
    console.log(
      'Parent model uses your Codex subscription. Sign in from WebUI or vibe-coders codex login.',
    );
    return;
  }
  if (command === 'provider' && positionals[1] === 'configure') {
    if (values.kind && values.kind !== 'openai')
      throw new Error('Choose --kind codex or --kind openai.');
    const baseUrl =
      values['base-url'] ||
      (await input({
        message: 'OpenAI-compatible API base URL (including /v1)',
        default: config.read().provider?.baseUrl || 'https://api.openai.com/v1',
      }));
    const model =
      values.model ||
      (await input({ message: 'Model ID', default: config.read().provider?.model }));
    const provider = providerSchema.parse({
      baseUrl,
      model,
      keyRequired: !values['no-key-required'],
      supportsImages: true,
    });
    const current = config.read();
    const { config: next } = saveProvider(
      config,
      new Vault(config.directory),
      current.revision,
      provider,
    );
    if (
      !values.model &&
      provider.keyRequired &&
      (await confirm({ message: 'Save the API key now?', default: true }))
    ) {
      const key = await password({ message: 'API key', mask: '*' });
      if (!key) throw new Error('An API key is required.');
      config.lock(() => {
        if (config.targetVersion('provider:main') !== next.provider!.revision)
          throw new Error('Provider changed during credential entry. Reload and retry.');
        new Vault(config.directory).put(
          'provider:main',
          next.provider!.revision,
          crypto.randomUUID(),
          key,
        );
      });
    }
    console.log('Provider saved. Use the dedicated credential input if its key is missing.');
    return;
  }
  if (command === 'mcp' && positionals[1] === 'add') {
    if (!values.json)
      throw new Error('Use mcp add --json with a nonsecret configuration on stdin.');
    const connection = mcpSchema.parse(JSON.parse(await Bun.stdin.text())),
      current = config.read();
    config.update(current.revision, (c) => {
      const old = c.mcp.find((m) => m.name === connection.name);
      c.mcp = c.mcp.filter((m) => m.name !== connection.name);
      c.mcp.push({ ...connection, revision: (old?.revision || 0) + 1 });
    });
    console.log(JSON.stringify({ saved: true, name: connection.name }));
    return;
  }
  if (command === 'computer' && positionals[1] === 'connect') {
    if (!values.json)
      throw new Error(
        'Use computer connect --json with {name, display, vncHost, vncPort} on stdin.',
      );
    const desktop = desktopSchema.parse(JSON.parse(await Bun.stdin.text())),
      current = config.read();
    config.update(current.revision, (c) => {
      const first = c.desktops[0];
      c.desktops[0] = {
        id: first.id,
        name: desktop.name,
        kind: 'external',
        connection: desktop,
        revision: first.revision + 1,
      };
    });
    console.log(JSON.stringify({ saved: true }));
    return;
  }
  if (command === 'secret') {
    if (!values.stdin || !values.target)
      throw new Error(
        'Use secret --target ID --stdin. Never put a credential in command arguments.',
      );
    const version = config.targetVersion(values.target);
    if (version === undefined) throw new Error('Target must be configured first.');
    const secret = (await Bun.stdin.text()).trimEnd();
    if (!secret) throw new Error('Empty credential.');
    config.lock(() => {
      if (config.targetVersion(values.target!) !== version)
        throw new Error('Target changed during credential entry. Reload and retry.');
      new Vault(config.directory).put(values.target!, version, crypto.randomUUID(), secret);
    });
    console.log(
      JSON.stringify({ saved: true, targetId: values.target, verification: 'unverified' }),
    );
    return;
  }
  if (command === 'config') {
    console.log(JSON.stringify(config.public(), null, 2));
    return;
  }
  if (command === 'doctor') {
    let repoReady = false;
    try {
      loadHome(home);
      repoReady = true;
    } catch {}
    console.log(
      JSON.stringify(
        {
          bun: Bun.version,
          platform: process.platform,
          home,
          repoReady,
          webAuth: !!config.read().web,
          provider: !!config.read().provider,
          pty:
            process.platform === 'win32' ? 'node-pty / ConPTY' : typeof Bun.Terminal === 'function',
          atomMemory: '0.7.0 (Bun SQLite patch)',
          tools: Object.fromEntries(
            [
              'rg',
              'git',
              'xdotool',
              'import',
              'x11vnc',
              'Xvfb',
              'xauth',
              'xdpyinfo',
              'openbox',
              'xterm',
              'pdftotext',
              'codex',
              'claude',
              'npx',
              'google-chrome',
            ].map((t) => [t, !!Bun.which(t)]),
          ),
          desktops: config.public().desktops,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'codex' && positionals[1] === 'login') {
    if (!Bun.which('codex')) throw new Error('Install the Codex CLI first.');
    const child = Bun.spawn(
      ['codex', '-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'],
      {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    process.exitCode = await child.exited;
    return;
  }
  if (command !== 'serve') throw new Error(`Unknown command: ${command}. Use --help.`);
  if (!config.read().web)
    throw new Error('Run `bun run setup` to configure WebUI authentication first.');
  loadHome(home);
  const directory = stateDirectory(home),
    lock = join(directory, 'daemon.lock');
  try {
    mkdirSync(lock);
  } catch {
    let pid: number | undefined;
    try {
      pid = Number(readFileSync(join(lock, 'pid'), 'utf8'));
    } catch {}
    if (pid) {
      try {
        process.kill(pid, 0);
        throw new Error('Another backend is already using this Home.');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      }
    } else
      throw new Error(
        `Backend lock is incomplete: ${lock}. Check for another backend before removing it.`,
      );
    rmSync(lock, { recursive: true });
    mkdirSync(lock);
  }
  writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  const { createRuntime } = await import('./server/runtime');
  const { createHttp } = await import('./server/http');
  let cleanup: (() => Promise<void>) | undefined;
  let createdRuntime: ReturnType<typeof createRuntime> | undefined;
  try {
    const runtime = (createdRuntime = createRuntime({ home, directory, config }));
    const { app, websocket } = createHttp(runtime, {
      devOrigin: values.dev ? 'http://127.0.0.1:5173' : undefined,
    });
    const web = config.read().web!;
    const server = Bun.serve({
      hostname: process.env.VIBE_CODER_LISTEN || web.hostname,
      port: web.port,
      fetch: app.fetch,
      websocket,
      idleTimeout: 0,
      maxRequestBodySize: 6 * 1024 * 1024,
    });
    let closing = false;
    cleanup = async () => {
      if (closing) return;
      closing = true;
      server.stop(true);
      await runtime.close();
      rmSync(lock, { recursive: true, force: true });
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.on(signal, () => {
        void cleanup!().finally(() => process.exit(0));
      });
    console.log(
      `vibe-coders: ${process.env.VIBE_CODER_ORIGIN || web.origin || `http://${web.hostname}:${web.port}`}\nHome: ${home}\nWebUI username: ${web.username}`,
    );
  } catch (e) {
    if (cleanup) await cleanup();
    else await createdRuntime?.close();
    rmSync(lock, { recursive: true, force: true });
    throw e;
  }
}
await main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Operation failed.');
  process.exitCode = 1;
});
