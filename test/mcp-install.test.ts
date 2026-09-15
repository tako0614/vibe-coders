import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fixture, eventually } from './helpers';
import { McpInstaller, mcpInstallSchema } from '../src/server/mcp-install';
import { mcpFields } from '../src/server/mcp-form';
import { McpOAuth } from '../src/server/mcp-auth';

test('MCP named selections, array constraints and defaults cross the real stdio protocol', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const config = r.mcp.configure(r.config.read().revision, {
      name: 'forms',
      transport: 'stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/mcp-server.ts', import.meta.url))],
    }).mcp[0];
    await r.mcp.connect(config);
    const tool = r.mcp
      .definitions()
      .find((t) => t.description.startsWith('[forms/selection_input]'))!;
    const run = r.mcp.call(r.id, tool.name, {});
    await eventually(() => r.store.snapshot(r.id).requests.length === 1);
    const card = r.store.snapshot(r.id).requests[0];
    expect(card.spec.fields[0].options?.[0]).toEqual({ value: 'basic', label: 'Basic plan' });
    expect(card.spec.fields[1].default).toEqual(['files']);
    const answer = (features: string) =>
      r.human.answer(card.id, {
        revision: 1,
        operationId: crypto.randomUUID(),
        values: { plan: 'pro', features, slug: 'demo' },
      });
    expect(() => answer('[]')).toThrow();
    expect(() => answer('["files","files"]')).toThrow();
    expect(() => answer('["invalid"]')).toThrow();
    answer('["files","browser"]');
    await eventually(() => r.runs.get(run.id).state === 'completed');
    expect(JSON.parse((r.runs.get(run.id).result as any).content[0].text).content).toEqual({
      plan: 'pro',
      features: ['files', 'browser'],
      slug: 'demo',
    });
    const fields = mcpFields({ properties: { code: { type: 'string', pattern: '^[a-z]+$' } } });
    const pattern = r.human.create(r.id, { kind: 'input', title: 'Pattern', fields });
    expect(() =>
      r.human.answer(pattern.id, {
        revision: 1,
        operationId: crypto.randomUUID(),
        values: { code: '123' },
      }),
    ).toThrow();
    expect(() => mcpFields({ properties: { password: { type: 'string' } } })).toThrow();
    expect(() => mcpFields({ properties: { nested: { type: 'object' } } })).toThrow();
  } finally {
    await r.dispose();
  }
});

test('npm setup pins a version, installs once, discovers tools and does not overwrite an existing connection', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const npm = join(r.root, 'npm.ts');
    await Bun.write(
      npm,
      `import { mkdir, writeFile } from 'node:fs/promises'; import { join } from 'node:path';
      const args = process.argv.slice(2);
      if (args[0] === 'view') console.log(JSON.stringify({ version: '1.2.3', bin: { 'fixture-server': 'cli.js' } }));
      else { if (args.at(-1) !== 'fixture-server@1.2.3') throw new Error('not pinned');
        const root = join(args[args.indexOf('--prefix')+1], 'node_modules', 'fixture-server'); await mkdir(root, { recursive: true });
        await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
        await writeFile(join(root, 'cli.js'), ${JSON.stringify(`#!${process.execPath}\nimport ${JSON.stringify(fileURLToPath(new URL('./fixtures/mcp-server.ts', import.meta.url)))};`)}, { mode: 0o755 });
      }`,
    );
    const installer = new McpInstaller(r.mcp, [process.execPath, npm]);
    const input = {
      conversationId: r.id,
      operationId: crypto.randomUUID(),
      name: 'installed',
      package: 'fixture-server',
    };
    const run = installer.start(input);
    expect(installer.start(input).id).toBe(run.id);
    await eventually(() => r.runs.get(run.id).state !== 'running', 10000);
    expect(r.runs.get(run.id).state).toBe('completed');
    expect(r.runs.get(run.id).result?.version).toBe('1.2.3');
    expect(r.mcp.status()[0].state).toBe('connected');
    expect(r.mcp.status()[0].tools).toBeGreaterThan(0);
    expect(() => installer.start({ ...input, operationId: crypto.randomUUID() })).toThrow();
    expect(
      mcpInstallSchema.safeParse({ ...input, package: 'https://example.org/code.tgz' }).success,
    ).toBe(false);
    expect(mcpInstallSchema.safeParse({ ...input, package: 'foo;touch /tmp/unsafe' }).success).toBe(
      false,
    );
    await r.mcp.remove(r.config.read().revision, 'installed');
    await Bun.write(npm, 'throw new Error("npm unavailable")');
    const fail = installer.start({ ...input, operationId: crypto.randomUUID(), name: 'retry' });
    await eventually(() => r.runs.get(fail.id).state !== 'running');
    expect(r.runs.get(fail.id).state).toBe('failed');
    expect(r.runs.get(fail.id).result?.stage).toBe('resolving');
    expect(r.config.read().mcp).toHaveLength(0);
  } finally {
    await r.dispose();
  }
});

test('registered OAuth client uses a revision-bound vault secret, never public config', async () => {
  const r = await fixture();
  try {
    const config = r.mcp.configure(r.config.read().revision, {
      name: 'registered',
      transport: 'http',
      url: 'https://example.org/mcp',
      oauth: true,
      oauthClientId: 'client-id',
      oauthClientSecret: true,
      oauthScope: 'read write',
    }).mcp[0];
    const auth = new McpOAuth(r.config, r.vault, r.store, r.human, config, r.id);
    expect(() => auth.clientInformation()).toThrow();
    const card = r.human.create(r.id, {
      kind: 'secret',
      title: 'Client secret',
      targetId: 'oauth-client:registered',
      fields: [{ name: 'key', label: 'Secret', type: 'secret' }],
    });
    r.human.answer(
      card.id,
      { revision: 1, operationId: crypto.randomUUID(), values: { key: 'fixture-client-secret' } },
      true,
    );
    expect(auth.clientInformation()).toEqual({
      client_id: 'client-id',
      client_secret: 'fixture-client-secret',
    });
    expect(auth.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post');
    expect(JSON.stringify(r.config.public())).not.toContain('fixture-client-secret');
    const { revision, ...connection } = config;
    const changed = r.mcp.configure(r.config.read().revision, connection).mcp[0];
    const updated = new McpOAuth(r.config, r.vault, r.store, r.human, changed, r.id);
    expect(() => updated.clientInformation()).toThrow();
    expect(() => auth.clientInformation()).toThrow();
  } finally {
    await r.dispose();
  }
});
