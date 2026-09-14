import { existsSync } from 'node:fs';
import { eventually } from '../helpers';
import type { Runtime } from '../../src/server/runtime';

export async function previewDesktop(runtime: Runtime) {
  const n = Array.from({ length: 100 }, (_, i) => 90 + i).find(
    (i) => !existsSync(`/tmp/.X11-unix/X${i}`) && !existsSync(`/tmp/.X${i}-lock`),
  )!;
  const display = `:${n}`;
  const processes: { kill: () => void; exitCode: number | null; exited: Promise<number> }[] = [];
  const cleanup = async () => {
    for (const p of processes) if (p.exitCode === null) p.kill();
    await Promise.all(processes.map((p) => p.exited));
  };
  try {
    processes.push(
      Bun.spawn(['Xvfb', display, '-screen', '0', '800x600x24', '-nolisten', 'tcp', '-noreset'], {
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    );
    await eventually(() => existsSync(`/tmp/.X11-unix/X${n}`), 5000);
    const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }),
      port = reserve.port!;
    await reserve.stop(true);
    const password = `${runtime.directory}/test-vnc-password`;
    await Bun.spawn(['x11vnc', '-storepasswd', 'test-vnc', password], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited;
    processes.push(
      Bun.spawn(
        [
          'x11vnc',
          '-display',
          display,
          '-localhost',
          '-rfbport',
          String(port),
          '-rfbauth',
          password,
          '-forever',
          '-shared',
          '-quiet',
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      ),
    );
    await Bun.spawn(['xsetroot', '-solid', '#28534b'], {
      env: { ...process.env, DISPLAY: display },
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited;
    processes.push(
      Bun.spawn(['xmessage', '-geometry', '400x180+100+100', 'vibe-coder live GUI test'], {
        env: { ...process.env, DISPLAY: display },
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    );
    runtime.config.update(runtime.config.read().revision, (c) => {
      c.desktop = {
        name: 'Live test desktop',
        display,
        mode: 'vnc',
        vncHost: '127.0.0.1',
        vncPort: port,
        revision: 1,
      };
    });
    runtime.vault.put('desktop', 1, crypto.randomUUID(), 'test-vnc');
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
