import { expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { fixture, eventually } from './helpers';
import { missingDesktopPackages } from '../src/server/desktop-host';

test('desktop dependencies only require a virtual display stack when needed', () => {
  expect(missingDesktopPackages(false, () => null)).toEqual(['x11-utils', 'x11vnc']);
  expect(missingDesktopPackages(true, () => null)).toContain('openbox');
  expect(missingDesktopPackages(true, () => '/usr/bin/available')).toEqual([]);
});

test.skipIf(missingDesktopPackages(true).length > 0)(
  'automatic host desktop: private display, authenticated capture, preview isolation, launch and cleanup',
  async () => {
    const r = await fixture();
    let display = '',
      pids: number[] = [];
    try {
      expect(r.desktop.status().configured).toBe(false);
      const host = r.desktop.host!;
      const first = host.prepare(true, false),
        second = host.prepare(true, false);
      expect(first).toBe(second);
      await first;
      display = r.desktop.target()!.display.slice(1);
      expect(r.config.read().desktop).toBeUndefined();
      expect(r.desktop.status().source).toBe('virtual');
      expect(r.desktop.status().configured).toBe(true);
      const observation = await r.desktop.screenshot();
      expect(observation.width).toBe(1280);
      const preview = await r.desktop.preview();
      expect(Buffer.from(preview.image, 'base64').subarray(0, 8).toString('hex')).toBe(
        '89504e470d0a1a0a',
      );
      // Watching from the UI must not consume the agent's last observation.
      await r.desktop.input({ observationId: observation.id, action: 'click', x: 200, y: 200 });
      r.desktop.handoff('human');
      await expect(r.desktop.screenshot()).rejects.toThrow('User owns');
      await expect(r.desktop.launch('terminal')).rejects.toThrow('User owns');
      expect((await r.desktop.launch('terminal', undefined, 'human'))?.launched).toBe('terminal');
      expect((await r.desktop.preview()).image.length).toBeGreaterThan(100);
      // The auto display does not accept clients without its private Xauthority cookie.
      const unauthenticated = Bun.spawn(['xdpyinfo', '-display', `:${display}`], {
        env: { PATH: process.env.PATH, XAUTHORITY: '/dev/null' },
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 3000,
      });
      expect(await unauthenticated.exited).not.toBe(0);
      pids = JSON.parse(readFileSync(`${host.directory}/processes.json`, 'utf8')).map(
        (p: { pid: number }) => p.pid,
      );
      expect(pids.length).toBeGreaterThanOrEqual(3);
      expect(r.desktop.credential()).toHaveLength(8);
      expect(JSON.stringify(r.desktop.status())).not.toContain(r.desktop.credential()!);
    } finally {
      await r.dispose();
    }
    await eventually(() => !existsSync(`/tmp/.X11-unix/X${display}`));
    for (const pid of pids) expect(existsSync(`/proc/${pid}`)).toBe(false);
  },
  30000,
);

test.skipIf(missingDesktopPackages(true).length > 0)(
  'restart reaps only recorded owned processes, and an accessible host display is reused',
  async () => {
    const r = await fixture();
    const module = new URL('../src/server/desktop-host.ts', import.meta.url).pathname;
    const script = `${r.root}/crash.ts`;
    await Bun.write(
      script,
      `import { DesktopHost } from ${JSON.stringify(module)}; const host = new DesktopHost(${JSON.stringify(r.home)}, ${JSON.stringify(r.directory)}, () => {}); await host.prepare(true, false); await Bun.write(${JSON.stringify(`${r.root}/ready`)}, 'ready'); setInterval(() => {}, 1000);`,
    );
    const parent = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'pipe' });
    let observer: import('../src/server/desktop-host').DesktopHost | undefined;
    try {
      await eventually(() => existsSync(`${r.root}/ready`), 12000);
      const old = JSON.parse(
        readFileSync(`${r.desktop.host!.directory}/processes.json`, 'utf8'),
      ) as { pid: number }[];
      parent.kill('SIGKILL');
      await parent.exited;
      expect(old.some((p) => existsSync(`/proc/${p.pid}`))).toBe(true);
      await r.desktop.host!.prepare(true, false);
      // Killed orphans may briefly remain zombies until the container's init reaps them.
      for (const { pid } of old) {
        let state = '';
        try {
          state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0];
        } catch {}
        expect(['', 'Z']).toContain(state);
      }
      const { DesktopHost } = await import('../src/server/desktop-host');
      observer = new DesktopHost(r.home, `${r.root}/viewer`, () => {});
      const previous = { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY };
      try {
        process.env.DISPLAY = r.desktop.target()!.display;
        process.env.XAUTHORITY = `${r.desktop.host!.directory}/Xauthority`;
        await observer.prepare(false, false);
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      expect(observer.source).toBe('host');
      expect(observer.target!.display).toBe(r.desktop.target()!.display);
      await observer.close();
      expect((await r.desktop.screenshot()).width).toBe(1280);
    } finally {
      if (parent.exitCode === null) parent.kill();
      await parent.exited;
      await observer?.close();
      await r.dispose();
    }
  },
  30000,
);
