// Manual browser verification with isolated state and no external model calls.
import { fixture } from '../helpers';
import { createHttp } from '../../src/server/http';
import { previewDesktop } from './desktop';
import { fileURLToPath } from 'node:url';
const runtime = await fixture({
  async call() {
    throw new Error('Browser fixture has no model connection.');
  },
});
if (process.env.VIBE_CODER_TEST_NATIVE === '1') {
  const program = [process.execPath, fileURLToPath(new URL('./native-cli.ts', import.meta.url))];
  Object.assign(runtime.native.executables, { codex: program, claude: program });
  runtime.codex.command.splice(0, runtime.codex.command.length, ...program);
}
if (process.env.VIBE_CODER_TEST_AUTH === '1') {
  const state = process.env.VIBE_CODER_TEST_AUTH_STATE || `${runtime.root}/auth-state.json`;
  await Bun.write(state, '{}');
  const program = [
    process.execPath,
    fileURLToPath(new URL('./codex-auth.ts', import.meta.url)),
    state,
  ];
  runtime.codex.command.splice(0, runtime.codex.command.length, ...program);
  runtime.native.executables.codex = runtime.codex.command;
}
const port = Number(process.env.VIBE_CODER_TEST_PORT || 3100);
const { app, websocket } = createHttp(runtime, {
  devOrigin: process.env.VIBE_CODER_TEST_ORIGIN || 'http://127.0.0.1:5173',
});
const closeDesktop =
  process.env.VIBE_CODER_TEST_DESKTOP === '1' ? await previewDesktop(runtime) : undefined;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: app.fetch,
  websocket,
  idleTimeout: 0,
});
console.log(`Isolated preview API on ${port}; fixture account owner / test-only-password-123`);
console.log(`Fixture directory: ${runtime.root}`);
const cleanup = async () => {
  server.stop(true);
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
