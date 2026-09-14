import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { fixture, eventually } from './helpers';

test.skipIf(!['Xvfb', 'x11vnc', 'xsetroot', 'xev', 'xdotool'].every((x) => Bun.which(x)))(
  'real X11 and authenticated VNC: capture, click, keyboard, drag and ownership handoff',
  async () => {
    const r = await fixture();
    const number = Array.from({ length: 100 }, (_, i) => 90 + i).find(
      (n) => !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`),
    )!;
    const display = `:${number}`;
    const x = Bun.spawn(['Xvfb', display, '-screen', '0', '640x480x24', '-nolisten', 'tcp'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const processes: { kill: () => void; exitCode: number | null; exited: Promise<number> }[] = [x];
    try {
      await eventually(() => existsSync(`/tmp/.X11-unix/X${number}`), 5000);
      const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }),
        port = reserve.port!;
      await reserve.stop(true);
      const passwordFile = `${r.root}/vnc-password`;
      const password = Bun.spawn(['x11vnc', '-storepasswd', 'test-vnc', passwordFile], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      expect(await password.exited).toBe(0);
      const vnc = Bun.spawn(
        [
          'x11vnc',
          '-display',
          display,
          '-localhost',
          '-rfbport',
          String(port),
          '-rfbauth',
          passwordFile,
          '-forever',
          '-shared',
          '-noxdamage',
          '-quiet',
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      processes.push(vnc);
      const env = { ...process.env, DISPLAY: display };
      const color = Bun.spawn(['xsetroot', '-solid', '#a13c5d'], {
        env,
        stdout: 'ignore',
        stderr: 'ignore',
      });
      await color.exited;
      const xev = Bun.spawn(['xev', '-geometry', '300x200+20+20'], {
        env,
        stdout: 'pipe',
        stderr: 'ignore',
      });
      processes.push(xev);
      let observed = '';
      const readEvents = (async () => {
        for await (const bytes of xev.stdout) observed += Buffer.from(bytes).toString();
      })();
      await Bun.sleep(500);
      r.config.update(r.config.read().revision, (c) => {
        c.desktop = {
          revision: 1,
          name: 'Test X11',
          display,
          mode: 'vnc',
          vncHost: '127.0.0.1',
          vncPort: port,
        };
      });
      r.vault.put('desktop', 1, crypto.randomUUID(), 'test-vnc');
      expect((await r.desktop.verifyCredential(1)).status).toBe('verified');
      const screen = await r.desktop.screenshot();
      expect(screen.width).toBe(640);
      expect(screen.height).toBe(480);
      expect(Buffer.from(screen.image.data, 'base64').subarray(0, 8).toString('hex')).toBe(
        '89504e470d0a1a0a',
      );
      await r.desktop.input({ observationId: screen.id, action: 'click', x: 100, y: 100 });
      await expect(
        r.desktop.input({ observationId: screen.id, action: 'type', text: 'wrong' }),
      ).rejects.toThrow();
      const focus = Bun.spawn(['xdotool', 'search', '--name', 'Event Tester', 'windowfocus'], {
        env,
        stdout: 'ignore',
        stderr: 'ignore',
      });
      await focus.exited;
      const textScreen = await r.desktop.screenshot();
      await r.desktop.input({ observationId: textScreen.id, action: 'type', text: 'A日' });
      await eventually(
        () => observed.includes('KeyPress') && observed.includes('ButtonPress'),
        4000,
      );
      expect(observed).toContain('0x41');
      expect(observed).toMatch(/0x10065e5|U65E5/);
      const drag = await r.desktop.screenshot();
      await r.desktop.input({
        observationId: drag.id,
        action: 'drag',
        x: 100,
        y: 100,
        toX: 150,
        toY: 130,
      });
      const old = await r.desktop.screenshot();
      r.desktop.handoff('human');
      await expect(r.desktop.screenshot()).rejects.toThrow('owns');
      r.desktop.handoff('agent');
      await expect(
        r.desktop.input({ observationId: old.id, action: 'click', x: 1, y: 1 }),
      ).rejects.toThrow();
      r.config.update(r.config.read().revision, (c) => {
        c.desktop!.mode = 'x11';
      });
      expect((await r.desktop.screenshot()).width).toBe(640);
      xev.kill();
      await xev.exited;
      await readEvents;
    } finally {
      for (const p of processes) if (p.exitCode === null) p.kill();
      await Promise.all(processes.map((p) => p.exited));
      await r.dispose();
    }
  },
  20000,
);
