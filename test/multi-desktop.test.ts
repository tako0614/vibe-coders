import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fixture, eventually } from './helpers';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/server/runtime';
import { missingDesktopPackages } from '../src/server/desktop-host';
import { createHttp } from '../src/server/http';

test.skipIf(missingDesktopPackages(true).length > 0)(
  'desktops have independent displays, shells, observations and control; deleting one preserves the other',
  async () => {
    const r = await fixture();
    try {
      const a = r.desktop.get();
      const created = r.desktop.create('Second screen');
      const b = r.desktop.get(created.id);
      await Promise.all([a.host!.prepare(true, false), b.host!.prepare(true, false)]);
      expect(a.target()!.display).not.toBe(b.target()!.display);
      expect(a.host!.directory).not.toBe(b.host!.directory);
      expect(a.credential()).not.toBe(b.credential());
      const observationA = await a.screenshot(),
        observationB = await b.screenshot();
      await expect(
        b.input({ observationId: observationA.id, action: 'click', x: 10, y: 10 }),
      ).rejects.toThrow();
      const shell = r.runs.start(r.id, {
        mode: 'pipe',
        command: 'echo "$DISPLAY"; echo "$XAUTHORITY"; cat',
        desktopId: b.definition.id,
      });
      await eventually(() => r.runs.read(shell.id).text.includes(b.target()!.display));
      expect(r.runs.read(shell.id).text).toContain(b.host!.directory);
      await expect(r.desktop.remove(b.definition.id)).rejects.toThrow('シェル');
      const serverFile = fileURLToPath(new URL('./fixtures/mcp-desktop.ts', import.meta.url));
      for (const [name, desktop] of [
        ['first', a],
        ['second', b],
      ] as const) {
        const c = r.mcp.configure(r.config.read().revision, {
          name,
          transport: 'stdio',
          command: process.execPath,
          args: [serverFile],
          targetId: `desktop:${desktop.definition.id}`,
          enabled: true,
        });
        await r.mcp.connect(c.mcp.find((m) => m.name === name)!);
      }
      expect(r.mcp.definitions()).toHaveLength(2);
      a.handoff('human');
      await eventually(() => r.mcp.definitions().length === 1);
      const tool = r.mcp.definitions()[0];
      expect(tool.name).toContain('second');
      const mcpRun = r.mcp.call(r.id, tool.name, {});
      await eventually(() => r.runs.get(mcpRun.id).state === 'completed');
      expect(JSON.stringify(r.runs.get(mcpRun.id).result)).toContain(b.target()!.display);
      expect(JSON.stringify(r.runs.get(mcpRun.id).result)).toContain(b.host!.directory);

      await expect(a.screenshot()).rejects.toThrow('User owns');
      await b.input({ observationId: observationB.id, action: 'click', x: 10, y: 10 });
      r.runs.write(shell.id, 'second-is-independent\n', 'agent', shell.epoch);
      b.handoff('human');
      expect(() => r.runs.read(shell.id, 0, 16000, true)).toThrow('suspended');
      b.handoff('agent');
      expect(() => r.runs.write(shell.id, 'stale\n', 'agent', shell.epoch)).toThrow('ownership');
      expect(r.runs.read(shell.id, 0, 16000, true).text).toBe('');
      r.runs.stop(shell.id);
      await eventually(() => !['running', 'stopping'].includes(r.runs.get(shell.id).state));
      const displayB = b.target()!.display.slice(1);
      await expect(r.desktop.remove(b.definition.id, 'agent')).rejects.toThrow('MCP');
      await r.mcp.remove(r.config.read().revision, 'second');
      await r.desktop.remove(b.definition.id, 'agent');
      await eventually(() => !existsSync(`/tmp/.X11-unix/X${displayB}`));
      expect((await a.preview()).image.length).toBeGreaterThan(100);
      expect(a.status().owner).toBe('human');
    } finally {
      await r.dispose();
    }
  },
  30000,
);

test('desktop tickets cannot cross targets; rename preserves ownership/credentials; stale or duplicate updates fail', async () => {
  const r = await fixture();
  try {
    const a = r.desktop.create('A', 'external', { name: 'A', mode: 'vnc', vncPort: 5997 });
    const b = r.desktop.create('B', 'external', { name: 'B', mode: 'vnc', vncPort: 5998 });
    r.vault.put(`desktop:${a.id}`, 1, crypto.randomUUID(), 'vnc-test');
    r.desktop.get(a.id).handoff('human');
    r.desktop.get(b.id).handoff('human');
    const { app } = createHttp(r);
    const headers = {
      Authorization: `Basic ${Buffer.from('owner:test-only-password-123').toString('base64')}`,
      'X-Vibe-Coder': '1',
      Origin: 'http://127.0.0.1:3100',
    };
    const { ticket } = (await (
      await app.request(`/api/desktops/${a.id}/ticket`, { method: 'POST', headers })
    ).json()) as { ticket: string };
    const response = await app.request(`/api/desktops/${b.id}/socket?ticket=${ticket}`, {
      headers,
    });
    expect(response.status).toBe(403);
    const epoch = r.desktop.get(a.id).status().epoch;
    const original = r.config.read().desktops.find((d) => d.id === a.id)!;
    const { revision: _, ...value } = original;
    await r.desktop.update(r.config.read().revision, { ...value, name: 'Renamed' });
    expect(r.desktop.get(a.id).credential()).toBe('vnc-test');
    expect(r.desktop.get(a.id).status()).toMatchObject({ name: 'Renamed', epoch, owner: 'human' });
    await expect(
      r.desktop.update(r.config.read().revision, {
        ...value,
        connection: { ...value.connection, vncPort: 5998 },
      }),
    ).rejects.toThrow('登録済み');
    await expect(r.desktop.remove(a.id, 'agent')).rejects.toThrow('User owns');
    await expect(r.desktop.update(0, value)).rejects.toThrow('changed');
  } finally {
    await r.dispose();
  }
});

test('legacy singleton migration retains VNC credential, human control, MCP target and messages across restart', async () => {
  const r = await fixture();
  let reopened: ReturnType<typeof createRuntime> | undefined;
  try {
    r.store.message(r.id, { role: 'user', content: 'kept history' });
    r.store.set('desktopRegistryVersion', 0);
    r.store.set('desktopOwner', 'human');
    r.store.set('desktopEpoch', 27);
    r.vault.put('desktop', 4, crypto.randomUUID(), 'preserved-vnc');
    await r.close();
    const { desktops: _, ...config } = r.config.read();
    writeFileSync(
      r.config.path,
      JSON.stringify({
        ...config,
        desktop: {
          name: 'Legacy screen',
          display: ':12',
          mode: 'vnc',
          vncHost: '127.0.0.1',
          vncPort: 5999,
          revision: 4,
        },
        mcp: [
          {
            name: 'screen',
            transport: 'stdio',
            command: 'missing',
            enabled: false,
            targetId: 'desktop',
            revision: 1,
          },
        ],
      }),
    );
    reopened = createRuntime({
      home: r.home,
      directory: r.directory,
      config: r.config,
      timers: false,
      model: {
        async call() {
          return { role: 'assistant', content: '' };
        },
      },
    });
    expect(reopened.desktop.get().status()).toMatchObject({
      id: 'default',
      name: 'Legacy screen',
      owner: 'human',
      epoch: 27,
    });
    expect(reopened.desktop.get().credential()).toBe('preserved-vnc');
    expect(reopened.config.read().mcp[0].targetId).toBe('desktop:default');
    expect(JSON.parse(readFileSync(r.config.path, 'utf8')).desktop).toBeUndefined();
    expect(reopened.store.history(r.id).some((m) => m.body.content === 'kept history')).toBe(true);
  } finally {
    await (reopened || r).close();
    rmSync(r.root, { recursive: true, force: true });
  }
});
