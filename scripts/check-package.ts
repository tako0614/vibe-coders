import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../test/helpers';
const r = await fixture();
const directory = join(r.root, 'installed');
let child: Bun.Subprocess | undefined;
try {
  await cp('dist/package', directory, { recursive: true });
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  r.config.update(r.config.read().revision, (c) => {
    c.web!.port = port;
  });
  child = Bun.spawn([process.execPath, join(directory, 'dist/server/cli.js'), '--home', r.home], {
    cwd: r.home,
    env: {
      ...process.env,
      VIBE_CODER_CONFIG_DIR: r.config.directory,
      VIBE_CODER_DATA_DIR: join(r.root, 'package-data'),
      VIBE_CODER_LISTEN: '127.0.0.1',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const error = new Response(child.stderr as ReadableStream<Uint8Array>).text();
  let response: Response | undefined;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Packaged backend exited: ${await error}`);
    try {
      response = await fetch(`http://127.0.0.1:${port}/`, {
        headers: {
          Authorization: `Basic ${Buffer.from('owner:test-only-password-123').toString('base64')}`,
        },
      });
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
  assert.equal(response?.status, 200);
  assert.match(await response!.text(), /id="root"/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status, 401);
  console.log(
    'Packaged backend passed: isolated directory, no project node_modules, migrations, authentication and built UI.',
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await child.exited;
  }
  await r.dispose();
}
