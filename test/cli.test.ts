import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config, stateDirectory } from '../src/server/config';

test('CLI setup/init/start works with private state, preserves files, and rejects a second backend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-coder-cli-')),
    home = join(root, 'repo');
  const env = {
    ...process.env,
    VIBE_CODER_CONFIG_DIR: join(root, 'config'),
    VIBE_CODER_DATA_DIR: join(root, 'data'),
  };
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = async (args: string[], stdin?: string) => {
    const proc = Bun.spawn([process.execPath, cli, ...args], {
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc.stdin.write(stdin || '');
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const setup = await run(
      ['setup', '--username', 'cli-owner', '--password-stdin'],
      'cli-private-password-123\n',
    );
    expect(setup.code).toBe(0);
    expect(setup.stdout + setup.stderr).not.toContain('cli-private-password-123');
    expect((await run(['init', '--home', home])).code).toBe(0);
    writeFileSync(join(home, 'AGENT.md'), 'Keep this exact instruction.');
    await run(['init', '--home', home]);
    expect(readFileSync(join(home, 'AGENT.md'), 'utf8')).toBe('Keep this exact instruction.');
    const doctor = await run(['doctor', '--home', home]);
    expect(JSON.parse(doctor.stdout).repoReady).toBe(true);
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = probe.port!;
    probe.stop(true);
    const config = new Config(env.VIBE_CODER_CONFIG_DIR);
    config.update(config.read().revision, (c) => {
      c.web!.port = port;
    });
    daemon = Bun.spawn([process.execPath, cli, '--home', home], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let ready = false;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/status`)).status === 401) {
          ready = true;
          break;
        }
      } catch {}
      await Bun.sleep(30);
    }
    expect(ready).toBe(true);
    const status = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: {
        Authorization: `Basic ${Buffer.from('cli-owner:cli-private-password-123').toString('base64')}`,
      },
    });
    expect(((await status.json()) as { home: string }).home).toBe(home);
    const duplicate = await run(['--home', home]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain('already using this Home');
    daemon.kill('SIGTERM');
    expect(await daemon.exited).toBe(0);
    daemon = undefined;
    expect(existsSync(join(home, 'state.sqlite'))).toBe(false);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  } finally {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
