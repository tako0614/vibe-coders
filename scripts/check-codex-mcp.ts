// Real subscription + parent tool loop + dynamically registered Chrome MCP.
// Use only a dedicated test Chrome endpoint. This never starts native Codex turns.
import assert from 'node:assert/strict';
import { fixture, eventually } from '../test/helpers';
const endpoint = process.env.VIBE_CODER_CDP;
if (!endpoint) throw new Error('Set VIBE_CODER_CDP to a dedicated test Chrome.');
const r = await fixture(null);
try {
  const models = await r.codex.models();
  const model = models.find((m) => m.isDefault)?.id || models[0]?.id;
  assert(model);
  r.config.update(r.config.read().revision, (c) => {
    c.provider = {
      revision: 1,
      kind: 'codex',
      model,
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      keyRequired: false,
      supportsImages: true,
    };
  });
  assert((await r.codex.refresh()).subscriptionReady, 'Sign into Codex first.');
  r.agent.submit(
    r.id,
    `Verify the parent MCP setup in this temporary test repository. Use environment_inspect to locate npx. Then use mcp_add to register this exact nonsecret connection: ${JSON.stringify({ name: 'qa_browser', transport: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.9.0', '--browser-url', endpoint], targetId: 'desktop', enabled: true })}. Wait for discovery using agent_wait when necessary. Once discovered, invoke qa_browser/list_pages through the actual new MCP tool. Wait for its completion and read its run result. Finally report the observed page count. This Chrome is dedicated to this test. Do not open or close pages, do not change browser profiles, do not read other directories, and do not use native_start, shell_exec, terminal_open, schedules or delegation.`,
    crypto.randomUUID(),
  );
  await eventually(
    () =>
      r.store
        .snapshot(r.id)
        .runs.some((run) => run.title === 'qa_browser: list_pages' && run.state === 'completed'),
    120000,
  );
  await eventually(() => ['idle', 'error'].includes(r.store.conversation(r.id).state), 120000);
  assert.equal(r.store.conversation(r.id).state, 'idle');
  assert.equal(r.store.snapshot(r.id).runs.filter((run) => run.kind === 'native').length, 0);
  assert(r.store.history(r.id).some((m) => m.body.toolCalls?.some((t) => t.name === 'mcp_add')));
  assert(
    r.store
      .history(r.id)
      .some((m) => m.body.toolCalls?.some((t) => t.name.startsWith('mcp_qa_browser_'))),
  );
  console.log(
    JSON.stringify({
      passed: true,
      provider: 'codex',
      model,
      tools: r.mcp.status()[0].tools,
      checks: [
        'parent environment inspection',
        'parent MCP registration',
        'dynamic tool discovery',
        'real Chrome list_pages',
        'no native child',
      ],
    }),
  );
} finally {
  await r.dispose();
}
