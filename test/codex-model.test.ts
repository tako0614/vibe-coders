import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, eventually } from './helpers';
import { createHttp } from '../src/server/http';

const token = `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.private-subscription-token`;
const message = (text: string) => ({
  type: 'message',
  id: 'msg_fixture',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
});
const sse = (output: unknown[], terminal = true) =>
  new Response(
    [
      ...output.map((item, output_index) => ({
        type: 'response.output_item.done',
        output_index,
        item,
      })),
      ...(terminal
        ? [{ type: 'response.completed', response: { status: 'completed', output: [] } }]
        : []),
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
async function subscriptionFixture(
  fetcher: (request: Request) => Response | Promise<Response>,
  signedIn = true,
) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-coders-subscription-'));
  const credentialFile = join(root, 'auth.json'),
    state = join(root, 'state.json');
  await Bun.write(state, JSON.stringify({ signedIn }));
  const save = () =>
    Bun.write(
      credentialFile,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: token, account_id: 'private-account-id' },
      }),
    );
  if (signedIn) await save();
  const r = await fixture(null, {
    credentialFile,
    command: [
      process.execPath,
      fileURLToPath(new URL('./fixtures/codex-auth.ts', import.meta.url)),
      state,
    ],
    fetch: (async (url, init) => fetcher(new Request(url, init))) as typeof fetch,
  });
  r.config.update(r.config.read().revision, (c) => {
    c.provider = {
      revision: 1,
      kind: 'codex',
      model: 'subscription-model',
      baseUrl: 'https://must-not-receive-credentials.invalid',
      keyRequired: true,
      supportsImages: true,
    };
  });
  return {
    ...r,
    state,
    save,
    async cleanup() {
      await r.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('parent Codex subscription uses the fixed endpoint and retains done items, tool IDs, image input and encrypted continuation', async () => {
  const payloads: any[] = [];
  let step = 0;
  const r = await subscriptionFixture(async (request) => {
    expect(request.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(request.headers.get('Authorization')).toBe(`Bearer ${token}`);
    expect(request.headers.get('Chatgpt-Account-Id')).toBe('private-account-id');
    expect(request.redirect).toBe('error');
    const body = (await request.json()) as any;
    payloads.push(body);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(body.store).toBe(false);
    if (step++ === 0)
      return sse([
        {
          type: 'reasoning',
          id: 'rs_fixture',
          encrypted_content: 'encrypted-provider-context',
          summary: [],
        },
        {
          type: 'function_call',
          id: 'fc_fixture',
          call_id: 'call_fixture',
          name: 'file_write',
          arguments: JSON.stringify({
            path: 'subscription-proof.txt',
            content: 'SUB_OK\n',
            expectedSha256: null,
          }),
          status: 'completed',
        },
      ]);
    return sse([message('The parent used the subscription.')]);
  });
  try {
    r.agent.submit(r.id, 'Write the proof file.', crypto.randomUUID(), [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]);
    await eventually(() =>
      r.store.history(r.id).some((m) => m.body.content === 'The parent used the subscription.'),
    );
    expect(await Bun.file(join(r.home, 'subscription-proof.txt')).text()).toBe('SUB_OK\n');
    expect(
      payloads[0].input.some((m: any) => m.content?.some?.((p: any) => p.type === 'input_image')),
    ).toBe(true);
    expect(payloads[1].input).toContainEqual({
      type: 'reasoning',
      id: 'rs_fixture',
      summary: [],
      encrypted_content: 'encrypted-provider-context',
    });
    expect(
      payloads[1].input.some(
        (m: any) => m.type === 'function_call_output' && m.call_id === 'call_fixture',
      ),
    ).toBe(true);
    expect(r.store.snapshot(r.id).runs).toHaveLength(0);
    const serialized = JSON.stringify(r.store.snapshot(r.id));
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('private-account-id');
    const status = await createHttp(r).app.request('/api/status', {
      headers: {
        Authorization: `Basic ${Buffer.from('owner:test-only-password-123').toString('base64')}`,
      },
    });
    expect(((await status.json()) as any).providerReady).toBe(true);
  } finally {
    await r.cleanup();
  }
}, 15000);

test('parent waits for subscription login without a native child and resumes its original message', async () => {
  let calls = 0;
  const r = await subscriptionFixture(() => {
    calls++;
    return sse([message('Logged in as the parent.')]);
  }, false);
  try {
    r.agent.submit(r.id, 'Continue this exact parent request.', crypto.randomUUID());
    await eventually(
      () => r.store.conversation(r.id).state === 'waiting' && r.codex.status().state === 'waiting',
    );
    expect(calls).toBe(0);
    expect(r.store.snapshot(r.id).runs).toHaveLength(0);
    await r.save();
    await Bun.write(r.state, JSON.stringify({ signedIn: true, finish: true }));
    await eventually(() =>
      r.store.history(r.id).some((m) => m.body.content === 'Logged in as the parent.'),
    );
    expect(calls).toBe(1);
    expect(
      r.store
        .history(r.id)
        .filter(
          (m) => m.body.role === 'user' && m.body.content === 'Continue this exact parent request.',
        ),
    ).toHaveLength(1);
  } finally {
    await r.cleanup();
  }
}, 15000);

test('subscription stream truncation cannot execute tools and quota failures never fall back to API billing', async () => {
  let requests = 0;
  const r = await subscriptionFixture(() => {
    requests++;
    return sse(
      [
        {
          type: 'function_call',
          id: 'fc',
          call_id: 'call',
          name: 'file_write',
          arguments: JSON.stringify({
            path: 'must-not-exist',
            content: 'bad',
            expectedSha256: null,
          }),
        },
      ],
      false,
    );
  });
  try {
    r.agent.submit(r.id, 'Attempt truncated stream.', crypto.randomUUID());
    await eventually(() => r.store.conversation(r.id).state === 'error');
    expect(await Bun.file(join(r.home, 'must-not-exist')).exists()).toBe(false);
    expect(requests).toBe(1);
  } finally {
    await r.cleanup();
  }
  let attempts = 0;
  const quota = await subscriptionFixture(() => {
    attempts++;
    return new Response(
      JSON.stringify({
        error: { message: `private server error ${token}`, type: 'rate_limit_error' },
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    );
  });
  try {
    quota.agent.submit(quota.id, 'Check quota.', crypto.randomUUID());
    await eventually(() => quota.store.conversation(quota.id).state === 'error');
    expect(attempts).toBe(1);
    expect(JSON.stringify(quota.store.snapshot(quota.id))).not.toContain(token);
    expect(
      quota.store.history(quota.id).some((m) => m.body.content.includes('Codexの利用枠')),
    ).toBe(true);
  } finally {
    await quota.cleanup();
  }
}, 15000);

test('canceling parent login does not create another card; unauthorized requests refresh once then require a real new login', async () => {
  const r = await subscriptionFixture(() => sse([message('must not run')]), false);
  try {
    r.agent.submit(r.id, 'Wait for my login.', crypto.randomUUID());
    await eventually(() => r.codex.status().state === 'waiting');
    await r.codex.cancel();
    await eventually(() => r.store.conversation(r.id).state === 'error');
    expect(r.store.snapshot(r.id).requests).toHaveLength(1);
    expect(r.store.snapshot(r.id).requests[0].state).toBe('cancelled');
  } finally {
    await r.cleanup();
  }
  let calls = 0;
  const rejected = await subscriptionFixture(() => {
    calls++;
    return new Response(
      JSON.stringify({ error: { message: token, type: 'authentication_error' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  });
  try {
    rejected.agent.submit(
      rejected.id,
      'Reauthenticate instead of switching to API keys.',
      crypto.randomUUID(),
    );
    await eventually(() => rejected.codex.status().state === 'waiting');
    expect(calls).toBe(2);
    expect(rejected.store.snapshot(rejected.id).requests).toHaveLength(1);
    expect(JSON.stringify(rejected.store.snapshot(rejected.id))).not.toContain(token);
  } finally {
    await rejected.cleanup();
  }
}, 15000);

test('all-stop aborts an active subscription stream without committing partial output', async () => {
  let aborted = false,
    started = false;
  const r = await subscriptionFixture(
    (request) =>
      new Response(
        new ReadableStream({
          start(controller) {
            started = true;
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n`,
              ),
            );
            request.signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                controller.error(new Error('Aborted fixture stream'));
              },
              { once: true },
            );
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );
  try {
    r.agent.submit(r.id, 'Stop before the response completes.', crypto.randomUUID());
    await eventually(() => started);
    r.agent.stopAll();
    await eventually(() => aborted && r.store.conversation(r.id).state !== 'running');
    expect(r.store.history(r.id).some((m) => m.body.role === 'assistant')).toBe(false);
  } finally {
    await r.cleanup();
  }
}, 15000);
