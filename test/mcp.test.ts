import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { fixture, eventually, calls, answer } from './helpers';

test('C06/H12: real MCP discovery and elicitation run independently of the parent', async () => {
  let name = '',
    step = 0;
  const r = await fixture({
    async call() {
      if (step++ === 0) return calls([name, {}], ['file_read', { path: 'AGENT.md' }]);
      return answer;
    },
  });
  try {
    const config = {
      name: 'test',
      transport: 'stdio' as const,
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/mcp-server.ts', import.meta.url))],
      enabled: true,
      revision: 1,
    };
    r.config.update(r.config.read().revision, (c) => {
      c.mcp = [config];
    });
    await r.mcp.connect(config);
    name = r.mcp.definitions()[0].name;
    expect(r.mcp.status()[0].state).toBe('connected');
    expect(name).toStartWith('mcp_test_');
    r.agent.submit(r.id, 'Ask MCP and read the repository.', crypto.randomUUID());
    await eventually(() => r.store.snapshot(r.id).requests.length === 1 && step >= 2);
    expect(
      r.store
        .history(r.id)
        .some((m) => m.body.role === 'tool' && m.body.content.includes('sha256')),
    ).toBe(true);
    expect(r.store.snapshot(r.id).runs[0].state).toBe('running');
    const card = r.store.snapshot(r.id).requests[0];
    r.human.answer(card.id, {
      revision: card.revision,
      operationId: crypto.randomUUID(),
      values: { label: 'done' },
    });
    await eventually(() => r.store.snapshot(r.id).runs[0].state === 'completed');
    expect(r.runs.get(r.store.snapshot(r.id).runs[0].id).output).toContain('done');
  } finally {
    await r.dispose();
  }
}, 15000);

test('MCP numeric/boolean forms validate and return native values; URL elicitation remains asynchronous', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const config = {
      name: 'typed',
      transport: 'stdio' as const,
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/mcp-server.ts', import.meta.url))],
      enabled: true,
      revision: 1,
    };
    r.config.update(r.config.read().revision, (c) => {
      c.mcp = [config];
    });
    await r.mcp.connect(config);
    const tool = r.mcp.definitions().find((t) => t.description.startsWith('[typed/typed_input]'))!;
    const run = r.mcp.call(r.id, tool.name, {});
    await eventually(() => r.store.snapshot(r.id).requests.length === 1);
    const card = r.store.snapshot(r.id).requests[0];
    expect(() =>
      r.human.answer(card.id, {
        revision: 1,
        operationId: crypto.randomUUID(),
        values: { count: '11', ready: 'false' },
      }),
    ).toThrow();
    r.human.answer(card.id, {
      revision: 1,
      operationId: crypto.randomUUID(),
      values: { count: '3', ready: 'false' },
    });
    await eventually(() => r.runs.get(run.id).state === 'completed');
    const result = r.runs.get(run.id).result as { content: { text: string }[] };
    expect(JSON.parse(result.content[0].text).content).toEqual({ count: 3, ready: false });
    const urlTool = r.mcp.definitions().find((t) => t.description.startsWith('[typed/url_input]'))!;
    const urlRun = r.mcp.call(r.id, urlTool.name, {});
    await eventually(() => r.store.snapshot(r.id).requests.length === 2);
    const urlCard = r.store.snapshot(r.id).requests.find((r) => r.spec.url)!;
    expect(urlCard.spec.url).toBe('https://example.org/login');
    expect(r.runs.get(urlRun.id).state).toBe('running');
    r.human.answer(urlCard.id, { revision: 1, operationId: crypto.randomUUID(), values: {} });
    await eventually(() => r.runs.get(urlRun.id).state === 'completed');
    expect(
      JSON.parse((r.runs.get(urlRun.id).result as { content: { text: string }[] }).content[0].text),
    ).toEqual({ action: 'accept' });
  } finally {
    await r.dispose();
  }
}, 15000);
