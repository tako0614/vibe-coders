import { afterEach, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { conversations, runs } from '../src/server/db/schema';
import { collectActivities, executionProgress, executionSurface } from '../src/web/activity-state';
import { calls, fixture } from './helpers';

const runtimes: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});
async function setup() {
  const r = await fixture();
  runtimes.push(r);
  return { r, snapshot: () => ({ ...r.store.snapshot(r.id), draft: '' }) };
}

test('Sequential tools distinguish the current operation from queued work, and stop spinning after a pause', async () => {
  const { r, snapshot } = await setup();
  const batch = calls(
    ['file_read', { path: 'src/App.tsx' }],
    ['file_write', { path: 'src/App.tsx', content: 'next' }],
  );
  r.store.message(r.id, batch);
  r.store.db
    .update(conversations)
    .set({ state: 'running' })
    .where(eq(conversations.id, r.id))
    .run();
  let view = snapshot(),
    activities = collectActivities(view);
  expect([...activities.values()].map((a) => a.state)).toEqual(['running', 'queued']);
  expect(executionProgress(view, true, activities)).toMatchObject({
    kind: 'running',
    title: 'ファイルを確認・編集しています',
  });
  r.agent.pause(r.id, true);
  view = snapshot();
  activities = collectActivities(view);
  expect([...activities.values()].map((a) => a.state)).toEqual(['interrupted', 'interrupted']);
  expect(executionProgress(view, true, activities)?.kind).toBe('paused');
  r.store.db
    .update(conversations)
    .set({ state: 'error', paused: false })
    .where(eq(conversations.id, r.id))
    .run();
  expect([...collectActivities(snapshot()).values()].some((a) => a.state === 'running')).toBe(
    false,
  );
});

test('Reading process output completes even while its process runs; human-owned terminals do not imply agent work', async () => {
  const { r, snapshot } = await setup();
  const batch = calls(['shell_exec', { command: 'bun test' }], ['run_read', { id: 'process' }]);
  r.store.message(r.id, batch);
  r.store.db
    .insert(runs)
    .values({
      id: 'process',
      conversationId: r.id,
      kind: 'shell',
      title: 'bun test',
      cwd: r.home,
      host: 'test',
      state: 'running',
      owner: 'agent',
      createdAt: Date.now(),
    })
    .run();
  for (const call of batch.toolCalls!)
    r.store.message(r.id, {
      role: 'tool',
      toolCallId: call.id,
      content: JSON.stringify({ id: 'process', state: 'running' }),
    });
  let view = snapshot(),
    activities = collectActivities(view);
  expect([...activities.values()].map((a) => a.state)).toEqual(['running', 'completed']);
  expect(executionProgress(view, true, activities)?.kind).toBe('background');
  r.agent.pause(r.id, true);
  view = snapshot();
  expect(executionProgress(view, true, collectActivities(view))).toMatchObject({
    kind: 'paused',
    detail: 'シェル1件は引き続き動いています',
  });
  r.store.db
    .update(conversations)
    .set({ state: 'idle', paused: false })
    .where(eq(conversations.id, r.id))
    .run();
  r.store.db.update(runs).set({ owner: 'human' }).where(eq(runs.id, 'process')).run();
  view = snapshot();
  expect(executionProgress(view, true, collectActivities(view))).toBeNull();
});

test('An asynchronous input request does not claim the active parent is waiting', async () => {
  const { r, snapshot } = await setup();
  r.human.create(r.id, {
    kind: 'input',
    title: '対象ブランチを選んでください',
    message: '',
    fields: [],
  });
  r.store.db
    .update(conversations)
    .set({ state: 'running' })
    .where(eq(conversations.id, r.id))
    .run();
  let view = snapshot();
  expect(executionProgress(view, true, collectActivities(view))?.kind).toBe('running');
  view.draft = '変更内容を確認しています。';
  expect(executionProgress(view, true, collectActivities(view))?.title).toBe(
    '回答を作成しています',
  );
  r.store.db
    .update(conversations)
    .set({ state: 'waiting' })
    .where(eq(conversations.id, r.id))
    .run();
  view = snapshot();
  expect(executionProgress(view, true, collectActivities(view))).toMatchObject({
    kind: 'waiting',
    title: '入力を待っています',
    detail: '対象ブランチを選んでください',
  });
});

test('Missing and interrupted outcomes never appear completed, and globally stopped work has no running indicator', async () => {
  const { r, snapshot } = await setup();
  const batch = calls(['file_read', {}], ['file_write', {}], ['file_list', {}]);
  r.store.message(r.id, batch);
  r.store.message(r.id, {
    role: 'tool',
    toolCallId: batch.toolCalls![0].id,
    content: '{"outcome":"interrupted"}',
  });
  r.store.message(r.id, {
    role: 'tool',
    toolCallId: batch.toolCalls![1].id,
    content: '{"error":"conflict"}',
  });
  let view = snapshot();
  expect([...collectActivities(view).values()].map((a) => a.state)).toEqual([
    'interrupted',
    'failed',
    'interrupted',
  ]);
  r.store.set('stopped', true);
  view = snapshot();
  expect(executionProgress(view, true, collectActivities(view))).toBeNull();
});

test('Working surfaces follow actual shell/desktop use in this turn, not installed tools or old conversations', async () => {
  const { r, snapshot } = await setup();
  r.store.message(r.id, calls(['desktop_screenshot', {}]));
  expect(executionSurface(snapshot())).toBe('desktop');
  r.store.message(r.id, { role: 'user', content: '次は説明だけ' });
  expect(executionSurface(snapshot())).toBeNull();
  r.store.message(r.id, calls(['mcp_browser_abcdef', {}]));
  expect(
    executionSurface(snapshot(), [
      {
        name: 'browser',
        transport: 'stdio',
        command: 'test',
        args: [],
        enabled: true,
        revision: 1,
        targetId: 'desktop',
      },
    ]),
  ).toBe('desktop');
  r.store.message(r.id, calls(['shell_exec', { mode: 'pty' }]));
  expect(executionSurface(snapshot())).toBe('terminal');
});

test('Resuming with a later tool batch does not restart an old operation without a result', async () => {
  const { r, snapshot } = await setup();
  r.store.message(r.id, calls(['shell_exec', { command: 'old' }]));
  r.store.message(r.id, { role: 'user', content: '再開してファイルを読んで' });
  r.store.message(r.id, calls(['file_read', { path: 'AGENT.md' }]));
  r.store.db
    .update(conversations)
    .set({ state: 'running' })
    .where(eq(conversations.id, r.id))
    .run();
  const activities = collectActivities(snapshot());
  expect([...activities.values()].map((a) => a.state)).toEqual(['interrupted', 'running']);
  expect(executionProgress(snapshot(), true, activities)?.title).toBe(
    'ファイルを確認・編集しています',
  );
});
