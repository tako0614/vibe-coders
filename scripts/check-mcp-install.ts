// Uses a test-owned Chrome endpoint. Downloads a real npm MCP into isolated state.
import assert from 'node:assert/strict';
import { fixture, eventually } from '../test/helpers';
const browser = process.env.VIBE_CODER_CDP;
if (!browser || !/^http:\/\/127\.0\.0\.1:\d+$/.test(browser))
  throw new Error('Set VIBE_CODER_CDP to a test-owned Chrome endpoint.');
const r = await fixture();
try {
  r.agent.pause(r.id, true);
  const input = {
    conversationId: r.id,
    operationId: crypto.randomUUID(),
    name: 'chrome',
    package: 'chrome-devtools-mcp',
    version: '1.9.0',
    args: [`--browser-url=${browser}`, '--no-usage-statistics', '--no-performance-crux'],
  };
  const install = r.mcpInstaller.start(input);
  await eventually(() => r.runs.get(install.id).state !== 'running', 180000);
  assert.equal(
    r.runs.get(install.id).state,
    'completed',
    JSON.stringify(r.runs.get(install.id).result),
  );
  assert.equal(r.mcp.status()[0].state, 'connected');
  const tools = r.mcp.definitions();
  const tool = tools.find((t) => t.description.startsWith('[chrome/list_pages]'));
  assert.ok(tool);
  const invoke = r.mcp.call(r.id, tool.name, {});
  await eventually(() => r.runs.get(invoke.id).state !== 'running', 30000);
  assert.equal(
    r.runs.get(invoke.id).state,
    'completed',
    JSON.stringify(r.runs.get(invoke.id).result),
  );
  assert.notEqual(r.runs.get(invoke.id).result?.isError, true);
  assert.match(JSON.stringify(r.runs.get(invoke.id).result), /about:blank/);
  console.log(
    JSON.stringify({
      passed: true,
      package: input.package,
      version: r.runs.get(install.id).result?.version,
      tools: tools.length,
      invocation: 'list_pages',
      state: r.runs.get(invoke.id).state,
    }),
  );
} finally {
  await r.dispose();
}
