import { expect, test } from 'bun:test';
import { fixture, eventually } from './helpers';
import { createHttp } from '../src/server/http';

const headers = {
  Authorization: `Basic ${Buffer.from('owner:test-only-password-123').toString('base64')}`,
  'X-Vibe-Coder': '1',
  'Content-Type': 'application/json',
};

test('standalone account input does not start an unrelated parent conversation', async () => {
  let calls = 0;
  const r = await fixture({
    async call() {
      calls++;
      return { role: 'assistant', content: 'Unexpected' };
    },
  });
  try {
    const card = r.human.create(r.id, { kind: 'action', title: 'Sign in', targetId: 'codex' });
    r.human.close(card.id);
    await Bun.sleep(200);
    expect(calls).toBe(0);
    expect(r.store.history(r.id)).toHaveLength(0);
    expect(r.store.conversation(r.id).state).toBe('idle');
  } finally {
    await r.dispose();
  }
});

test('a queued user request starts once its parent model becomes configured', async () => {
  let ready = false,
    calls = 0;
  const r = await fixture({
    isConfigured: () => ready,
    async call() {
      calls++;
      return { role: 'assistant', content: 'Connected' };
    },
  });
  try {
    r.agent.submit(r.id, 'Keep this request while I connect.', crypto.randomUUID());
    await Bun.sleep(200);
    expect(calls).toBe(0);
    expect(r.store.conversation(r.id).state).toBe('idle');
    ready = true;
    r.store.notify();
    await eventually(() => r.store.history(r.id).some((m) => m.body.content === 'Connected'));
    expect(calls).toBe(1);
    expect(
      r.store.history(r.id).filter((m) => m.body.content === 'Keep this request while I connect.'),
    ).toHaveLength(1);
  } finally {
    await r.dispose();
  }
});

test('retry reuses the failed request without adding a duplicate user message', async () => {
  let calls = 0;
  const r = await fixture({
    async call() {
      if (++calls === 1) throw new Error('Temporary outage');
      return { role: 'assistant', content: 'Recovered' };
    },
  });
  try {
    r.agent.submit(r.id, 'Retry my original request.', crypto.randomUUID());
    await eventually(() => r.store.conversation(r.id).state === 'error');
    const { app } = createHttp(r);
    const response = await app.request(`/api/conversations/${r.id}/retry`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(response.status).toBe(202);
    await eventually(() => r.store.history(r.id).some((m) => m.body.content === 'Recovered'));
    expect(calls).toBe(2);
    expect(
      r.store.history(r.id).filter((m) => m.body.content === 'Retry my original request.'),
    ).toHaveLength(1);
  } finally {
    await r.dispose();
  }
});

test('a terminal opened by the user is immediately writable and Ctrl-C returns to its shell', async () => {
  if (process.platform === 'win32') return;
  const r = await fixture();
  try {
    const { app } = createHttp(r);
    const response = await app.request('/api/runs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId: r.id, spec: { mode: 'pty' } }),
    });
    const run = (await response.json()) as { id: string; epoch: number; owner: string };
    expect(run.owner).toBe('human');
    r.runs.write(run.id, 'printf "__PTY_READY__\\n"\n', 'human', run.epoch);
    await eventually(() => /(?:\r|\n)__PTY_READY__\r?\n/.test(r.runs.read(run.id).text), 2000);
    r.runs.write(run.id, 'sleep 30\n', 'human', run.epoch);
    await Bun.sleep(150);
    r.runs.write(run.id, '\u0003', 'human', run.epoch);
    await Bun.sleep(100);
    r.runs.write(run.id, 'printf "__CTRL_C_RETURNED__\\n"\n', 'human', run.epoch);
    await eventually(
      () => /(?:\r|\n)__CTRL_C_RETURNED__\r?\n/.test(r.runs.read(run.id).text),
      2000,
    );
    expect(r.runs.read(run.id).text).not.toContain('no job control');
    expect(r.runs.get(run.id).state).toBe('running');
  } finally {
    await r.dispose();
  }
}, 10000);

test('manual run completion does not silently retry a failed parent request', async () => {
  let calls = 0;
  const r = await fixture({
    async call() {
      calls++;
      throw new Error('Provider unavailable');
    },
  });
  try {
    r.agent.submit(r.id, 'Keep the failed task for an explicit retry.', crypto.randomUUID());
    await eventually(() => r.store.conversation(r.id).state === 'error');
    r.store.event(r.id, 'run.completed', { runId: 'manual-run', exitCode: 0 });
    r.store.notify();
    await Bun.sleep(200);
    expect(calls).toBe(1);
    expect(r.store.conversation(r.id).state).toBe('error');
  } finally {
    await r.dispose();
  }
});

test('queued API-provider work waits for its key, then resumes after secret input', async () => {
  let calls = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      calls++;
      return new Response(
        'data: {"choices":[{"delta":{"content":"Key connected"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
  });
  const r = await fixture(null);
  try {
    r.agent.submit(r.id, 'Hold this until the API key is saved.', crypto.randomUUID());
    r.config.update(r.config.read().revision, (c) => {
      c.provider = {
        revision: 1,
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        model: 'fixture',
        keyRequired: true,
        supportsImages: false,
      };
    });
    r.store.notify();
    await Bun.sleep(200);
    expect(r.store.conversation(r.id).state).toBe('idle');
    expect(calls).toBe(0);
    const request = r.human.create(r.id, {
      kind: 'secret',
      title: 'API key',
      targetId: 'provider:main',
      fields: [{ name: 'key', label: 'Key', type: 'secret', required: true }],
    });
    await r.human.submitSecret(request.id, {
      revision: request.revision,
      operationId: crypto.randomUUID(),
      values: { key: 'fixture-api-key' },
    });
    await eventually(() => r.store.history(r.id).some((m) => m.body.content === 'Key connected'));
    expect(calls).toBe(1);
    expect(
      r.store.history(r.id).filter((m) => m.body.role === 'user' && !m.id.startsWith('event-')),
    ).toHaveLength(1);
  } finally {
    provider.stop(true);
    await r.dispose();
  }
});

test('first send creates one chat atomically; empty input and retries do not add empty chats', async () => {
  const r = await fixture({
    isConfigured: () => false,
    async call() {
      throw Error('Not configured');
    },
  });
  try {
    const { app } = createHttp(r);
    const status = async () =>
      (await (await app.request('/api/status', { headers })).json()) as any;
    const before = r.store.listConversations().length;
    const initial = await status();
    expect(initial.conversations.some((c: any) => c.id === initial.workspaceId)).toBe(false);
    expect(r.store.history(initial.workspaceId)).toHaveLength(0);
    createHttp(r);
    expect(r.store.listConversations()).toHaveLength(before);
    const post = (body: unknown) =>
      app.request('/api/conversations', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    expect((await post({})).status).toBe(400);
    expect((await post({ text: '  ', operationId: crypto.randomUUID() })).status).toBe(400);
    expect(r.store.listConversations()).toHaveLength(before);
    const body = { text: 'Start at the first message.', operationId: crypto.randomUUID() };
    const response = await post(body);
    expect(response.status).toBe(201);
    const conversation = (await response.json()) as { id: string; title: string };
    expect(conversation.title).toBe(body.text);
    expect(r.store.history(conversation.id)).toHaveLength(1);
    expect(r.store.listConversations()).toHaveLength(before + 1);
    // Simulate the client retrying after the acknowledgement was lost.
    expect(((await (await post(body)).json()) as { id: string }).id).toBe(conversation.id);
    expect(r.store.history(conversation.id)).toHaveLength(1);
    expect((await post({ ...body, text: 'Different content' })).status).toBe(400);
    expect(r.store.listConversations()).toHaveLength(before + 1);
    expect((await status()).conversations).toHaveLength(initial.conversations.length + 1);
    const image = await post({
      text: '',
      operationId: crypto.randomUUID(),
      images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }],
    });
    expect(image.status).toBe(201);
    expect(((await image.json()) as { title: string }).title).toBe('画像について');
  } finally {
    await r.dispose();
  }
});

test('first send inherits standalone workspace state without attaching to an older chat', async () => {
  const r = await fixture({
    isConfigured: () => false,
    async call() {
      throw Error('Not configured');
    },
  });
  try {
    const { app } = createHttp(r);
    const status = async () =>
      (await (await app.request('/api/status', { headers })).json()) as any;
    const before = await status();
    const workspace = r.store.workspace(before.workspaceId);
    r.store.updateWorkspace(before.workspaceId, {
      ...workspace,
      decks: [{ id: 'main', name: 'My draft shell deck' }],
    });
    const body = {
      text: 'Continue my workspace.',
      operationId: crypto.randomUUID(),
      workspaceId: before.workspaceId,
    };
    const send = () =>
      app.request('/api/conversations', { method: 'POST', headers, body: JSON.stringify(body) });
    const first = (await (await send()).json()) as { id: string; title: string };
    expect(first.id).toBe(before.workspaceId);
    expect(first.id).not.toBe(r.id);
    expect(first.title).toBe(body.text);
    expect(r.store.workspace(first.id).decks[0].name).toBe('My draft shell deck');
    const after = await status();
    expect(after.workspaceId).not.toBe(first.id);
    expect(after.conversations.some((c: any) => c.id === first.id)).toBe(true);
    expect(((await (await send()).json()) as { id: string }).id).toBe(first.id);
    expect(r.store.history(first.id)).toHaveLength(1);
    expect(r.store.history(after.workspaceId)).toHaveLength(0);
    expect(r.store.history(r.id)).toHaveLength(0);
  } finally {
    await r.dispose();
  }
});
