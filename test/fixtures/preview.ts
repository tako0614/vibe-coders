// Manual browser verification with isolated state and no external model calls.
import { fixture } from '../helpers';
import { activityPreview } from './activity-preview';
import { createHttp } from '../../src/server/http';
import { previewDesktop } from './desktop';
import { fileURLToPath } from 'node:url';
const runtime = await fixture({
  async call() {
    throw new Error('Browser fixture has no model connection.');
  },
});
if (process.env.VIBE_CODER_TEST_AUTH === '1') {
  const state = process.env.VIBE_CODER_TEST_AUTH_STATE || `${runtime.root}/auth-state.json`;
  await Bun.write(state, '{}');
  const program = [
    process.execPath,
    fileURLToPath(new URL('./codex-auth.ts', import.meta.url)),
    state,
    runtime.codex.credentialFile,
  ];
  runtime.codex.command.splice(0, runtime.codex.command.length, ...program);
}
const port = Number(process.env.VIBE_CODER_TEST_PORT || 3100);
const { app, websocket } = createHttp(runtime, {
  devOrigin: process.env.VIBE_CODER_TEST_ORIGIN || 'http://127.0.0.1:5173',
});
if (process.env.VIBE_CODER_TEST_ACTIVITY === '1') {
  app.post('/api/test/activity', async (c) =>
    c.json(activityPreview(runtime, String((await c.req.json()).scenario))),
  );
}
const closeDesktop =
  process.env.VIBE_CODER_TEST_DESKTOP === '1' ? await previewDesktop(runtime) : undefined;
const modelServer = process.env.VIBE_CODER_TEST_MODEL_PORT
  ? Bun.serve({
      hostname: '127.0.0.1',
      port: Number(process.env.VIBE_CODER_TEST_MODEL_PORT),
      fetch(request) {
        if (request.headers.get('authorization') !== 'Bearer picker-fixture-key')
          return new Response('', { status: 401 });
        return Response.json({
          data: [
            {
              id: 'fixture/alpha',
              name: 'Alpha picker model',
              reasoning: { supported_efforts: ['high', 'low'], default_effort: 'low' },
            },
            { id: 'fixture/beta', name: 'Beta picker model' },
          ],
        });
      },
    })
  : undefined;
const server = Bun.serve({
  hostname: process.env.VIBE_CODER_TEST_HOST || '127.0.0.1',
  port,
  fetch: app.fetch,
  websocket,
  idleTimeout: 0,
});
console.log(`Isolated preview API on ${port}; fixture account owner / test-only-password-123`);
console.log(`Fixture directory: ${runtime.root}`);
const cleanup = async () => {
  server.stop(true);
  modelServer?.stop(true);
  await runtime.dispose();
  await closeDesktop?.();
  process.exit(0);
};
process.on('SIGTERM', () => {
  void cleanup();
});
process.on('SIGINT', () => {
  void cleanup();
});
