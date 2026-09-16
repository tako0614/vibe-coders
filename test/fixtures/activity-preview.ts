// Isolated UI scenarios. No external model calls; workspace uses a real persistent PTY.
import { eq } from 'drizzle-orm';
import { conversations } from '../../src/server/db/schema';
import type { fixture } from '../helpers';
import { calls } from '../helpers';

export function activityPreview(runtime: Awaited<ReturnType<typeof fixture>>, scenario: string) {
  if (
    !['running', 'input', 'error', 'completed', 'streaming', 'thinking', 'workspace'].includes(
      scenario,
    )
  )
    throw new Error('Unknown activity fixture');
  const { id } = runtime.store.createConversation();
  runtime.store.db
    .update(conversations)
    .set({ title: `作業表示の確認 · ${scenario}` })
    .where(eq(conversations.id, id))
    .run();
  runtime.store.message(id, {
    role: 'user',
    content: '入力フォームの変更を確認して、テストを実行して。',
  });
  runtime.store.message(id, {
    role: 'assistant',
    content: '関連するファイルを確認してから、テストを実行します。',
  });
  const steps = calls(
    ['file_list', { path: 'src/web' }],
    ['file_read', { path: 'src/web/Chat.tsx' }],
    ['shell_exec', { command: 'bun test' }],
  ).toolCalls!;
  for (let i = 0; i < steps.length; i++) {
    runtime.store.message(id, { role: 'assistant', content: '', toolCalls: [steps[i]] });
    if (i < 2 || scenario === 'completed' || scenario === 'streaming' || scenario === 'thinking')
      runtime.store.message(id, {
        role: 'tool',
        toolCallId: steps[i].id,
        content: JSON.stringify({ ok: true, note: 'Preview fixture result' }),
      });
  }
  if (scenario === 'workspace') {
    const run = runtime.runs.start(id, { mode: 'pty', title: '作業用シェル' });
    runtime.runs.write(run.id, "printf 'WORKSPACE_SESSION_READY\\n'\n", 'agent', run.epoch);
    runtime.store.message(id, {
      role: 'tool',
      toolCallId: steps[2].id,
      content: JSON.stringify({ id: run.id, state: 'running' }),
    });
    runtime.store.message(id, calls(['run_read', { id: run.id }]));
  }
  let state: 'running' | 'waiting' | 'error' | 'idle' = 'running';
  if (scenario === 'input') {
    state = 'waiting';
    runtime.human.create(id, {
      kind: 'input',
      title: 'どのブランチに変更しますか？',
      message: '変更先を選ぶと作業を続けます。',
      fields: [
        {
          name: 'branch',
          label: '変更先',
          type: 'choice',
          required: true,
          options: [
            { label: '新しいブランチ', value: 'new' },
            { label: '現在のブランチ', value: 'current' },
          ],
        },
      ],
    });
  }
  if (scenario === 'error') {
    state = 'error';
    runtime.store.message(id, {
      role: 'tool',
      toolCallId: steps[2].id,
      content: '{"error":"Test failed with exit code 1"}',
    });
    runtime.store.message(id, {
      role: 'system',
      content: 'テストの実行に失敗しました (exit 1)。ログを確認して再試行してください。',
    });
  }
  if (scenario === 'completed') {
    state = 'idle';
    runtime.store.message(id, {
      role: 'assistant',
      content:
        '入力フォームを確認しました。\n\n- 送信後の下書きが残らないことを確認\n- 日本語入力の変換確定で送信されないことを確認\n- 関連するテストが通過\n\n変更内容は `src/web/Chat.tsx` から確認できます。',
    });
  }
  if (scenario === 'streaming')
    runtime.agent.drafts.set(id, '入力フォームを確認しています。\n\n送信後に入力内容が残る条件を');
  runtime.store.db.update(conversations).set({ state }).where(eq(conversations.id, id)).run();
  runtime.store.notify();
  return { id };
}
