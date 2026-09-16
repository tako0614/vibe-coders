import { expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, eventually, calls, answer } from './helpers';
import { createHttp } from '../src/server/http';
import type { ModelInput } from '../src/server/model';
const serverFile = fileURLToPath(new URL('./fixtures/mcp-server.ts', import.meta.url));
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

test('parent setup request inspects the host, installs a local MCP executable, discovers and invokes it in the same conversation', async () => {
  let phase = 0,
    command = '',
    installCommand = '',
    discovered = '',
    invoked = false;
  const r = await fixture({
    async call(input: ModelInput) {
      expect(input.system).toContain('[Environment and MCP setup]');
      const result = (name: string) => {
        const call = input.messages
          .flatMap((m) => m.toolCalls || [])
          .filter((t) => t.name === name)
          .at(-1);
        const msg = input.messages.find((m) => m.role === 'tool' && m.toolCallId === call?.id);
        return msg ? JSON.parse(msg.content) : undefined;
      };
      if (phase === 0) {
        phase++;
        return calls(['environment_inspect', { programs: [command] }], ['connections_list', {}]);
      }
      if (phase === 1) {
        expect(result('environment_inspect').programs[command]).toBeNull();
        phase++;
        return calls(['shell_exec', { command: installCommand }]);
      }
      if (phase === 2) {
        phase++;
        return calls([
          'agent_wait',
          {
            reason: 'Installing the local fixture tool',
            wakeOn: [{ type: 'run.completed', runId: result('shell_exec').id }],
          },
        ]);
      }
      if (phase === 3) {
        phase++;
        return calls(
          ['run_read', { id: result('shell_exec').id }],
          ['environment_inspect', { programs: [command] }],
        );
      }
      if (phase === 4) {
        expect(result('run_read').state).toBe('completed');
        expect(result('environment_inspect').programs[command]).toBe(command);
        phase++;
        return calls(['mcp_add', { name: 'local_tools', transport: 'stdio', command }]);
      }
      if (phase === 5) {
        phase++;
        return calls([
          'agent_wait',
          {
            reason: 'Discovering installed MCP',
            wakeOn: [{ type: 'run.completed', runId: result('mcp_add').id }],
          },
        ]);
      }
      if (phase === 6) {
        discovered =
          input.tools.find((t) => t.description.startsWith('[local_tools/request_input]'))?.name ||
          '';
        expect(discovered).toStartWith('mcp_local_tools_');
        phase++;
        return calls([discovered, {}], ['file_read', { path: 'AGENT.md' }]);
      }
      if (phase === 7) {
        phase++;
        return calls([
          'agent_wait',
          {
            reason: 'MCP operation awaits input',
            wakeOn: [{ type: 'run.completed', runId: result(discovered).id }],
          },
        ]);
      }
      invoked = true;
      return answer;
    },
  });
  try {
    command = join(r.home, 'installed-mcp');
    // Installation fixture is staged outside Home. The parent must install the
    // command before registration; the MCP server/protocol and shell are real.
    const source = join(r.root, 'mcp-source');
    await Bun.write(source, `#!/bin/sh\nexec ${q(process.execPath)} ${q(serverFile)}\n`);
    installCommand = `cp ${q(source)} ${q(command)} && chmod 700 ${q(command)}`;
    const { app } = createHttp(r);
    const body = JSON.stringify({
      text: 'Install the local tools and verify an invocation.',
      operationId: crypto.randomUUID(),
    });
    const headers = {
      Authorization: `Basic ${Buffer.from('owner:test-only-password-123').toString('base64')}`,
      'X-Vibe-Coder': '1',
      'Content-Type': 'application/json',
    };
    expect(
      (await app.request(`/api/conversations/${r.id}/messages`, { method: 'POST', headers, body }))
        .status,
    ).toBe(202);
    await eventually(() => r.store.snapshot(r.id).requests.length === 1, 10000);
    const card = r.store.snapshot(r.id).requests[0];
    await eventually(() =>
      r.store
        .history(r.id)
        .some((m) => m.body.role === 'tool' && m.body.content.includes('sha256')),
    );
    expect(
      r.store
        .history(r.id)
        .some((m) => m.body.role === 'tool' && m.body.content.includes('sha256')),
    ).toBe(true);
    r.human.answer(card.id, {
      revision: card.revision,
      operationId: crypto.randomUUID(),
      values: { label: 'installed and invoked' },
    });
    await eventually(() => invoked);
    expect(r.store.snapshot(r.id).runs.every((run) => run.state === 'completed')).toBe(true);
    expect(
      r.store
        .snapshot(r.id)
        .runs.some((run) => r.runs.get(run.id).output.includes('installed and invoked')),
    ).toBe(true);
    expect(r.mcp.status()[0]).toMatchObject({ state: 'connected', tools: 4 });
  } finally {
    await r.dispose();
  }
}, 15000);

test('MCP changes retire old tools, reject stale connections, and report missing commands', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const input = {
      name: 'tools',
      transport: 'stdio',
      command: process.execPath,
      args: [serverFile],
      enabled: true,
    };
    const first = r.mcp.configure(r.config.read().revision, input);
    await r.mcp.connect(first.mcp[0]);
    const oldTool = r.mcp.definitions()[0].name;
    const next = r.mcp.configure(first.revision, { ...input, command: '/missing-mcp-fixture' });
    expect(r.mcp.definitions()).toEqual([]);
    expect(() => r.mcp.call(r.id, oldTool, {})).toThrow();
    expect(() => r.mcp.configure(first.revision, input)).toThrow();
    await expect(r.mcp.connect(first.mcp[0])).rejects.toThrow('changed');
    const failed = r.mcp.connectRun(r.id, 'tools');
    await eventually(() => r.runs.get(failed.id).state === 'failed');
    expect(r.mcp.status()[0]).toMatchObject({ state: 'error' });
    expect(r.mcp.status()[0].error).toContain('not installed');
    r.mcp.configure(next.revision, input);
    const connected = r.mcp.connectRun(r.id, 'tools');
    await eventually(() => r.runs.get(connected.id).state === 'completed');
    await r.mcp.remove(r.config.read().revision, 'tools');
    expect(r.mcp.definitions()).toEqual([]);
    expect(r.mcp.status()).toEqual([]);
  } finally {
    await r.dispose();
  }
}, 15000);

test('desktop handoff cancels MCP initialization before tools can appear', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const delayed = join(r.root, 'delayed-mcp');
    await Bun.write(delayed, `#!/bin/sh\nsleep 1\nexec ${q(process.execPath)} ${q(serverFile)}\n`);
    chmodSync(delayed, 0o700);
    r.mcp.configure(r.config.read().revision, {
      name: 'desktop_tools',
      transport: 'stdio',
      command: delayed,
      targetId: 'desktop:default',
    });
    const run = r.mcp.connectRun(r.id, 'desktop_tools');
    await eventually(() => r.mcp.status()[0].state === 'connecting');
    r.desktop.get().handoff('human');
    await eventually(() => r.runs.get(run.id).state === 'failed');
    expect(r.mcp.definitions()).toEqual([]);
    expect(r.mcp.status()[0].state).toBe('disconnected');
  } finally {
    await r.dispose();
  }
}, 15000);
