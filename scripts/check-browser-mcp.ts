import assert from 'node:assert/strict';
import { fixture, eventually } from '../test/helpers';
const endpoint = process.env.VIBE_CODER_CDP;
if (!endpoint) throw new Error('Set VIBE_CODER_CDP to the Chrome instance being tested.');
const r = await fixture();
try {
  r.agent.pause(r.id, true);
  r.mcp.configure(r.config.read().revision, {
    name: 'browser',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@1.9.0', '--browser-url', endpoint],
    targetId: 'desktop',
    enabled: true,
  });
  const config = r.config.read().mcp.find((m) => m.name === 'browser')!;
  await r.mcp.connect(config, r.id);
  const tool = r.mcp.definitions().find((t) => t.description.startsWith('[browser/list_pages]'));
  assert.ok(tool, 'Installed Chrome MCP must expose list_pages.');
  const run = r.mcp.call(r.id, tool.name, {});
  await eventually(() => !['running', 'stopping'].includes(r.runs.get(run.id).state), 30000);
  assert.equal(r.runs.get(run.id).state, 'completed', JSON.stringify(r.runs.get(run.id).result));
  const before = r.mcp.definitions().length;
  r.desktop.handoff('human');
  assert.equal(r.mcp.definitions().length, 0);
  assert.throws(() => r.mcp.call(r.id, tool.name, {}));
  r.desktop.handoff('agent');
  await r.mcp.connect(config, r.id);
  assert.ok(r.mcp.definitions().length > 0);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'real Chrome MCP install',
        'tool discovery',
        'live tabs',
        'handoff disconnect',
        'reconnect',
      ],
      tools: before,
    }),
  );
} finally {
  await r.dispose();
}
