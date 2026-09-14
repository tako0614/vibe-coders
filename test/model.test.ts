import { expect, test } from 'bun:test';
import { fixture } from './helpers';
import { ChatModel } from '../src/server/model';

test('the real Chat Completions adapter assembles streamed tool calls and sends actual image content', async () => {
  let payload: any,
    authorization: string | null = null;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      payload = await request.json();
      authorization = request.headers.get('Authorization');
      const chunks = [
        {
          choices: [
            {
              delta: {
                content: '読む',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_fixture',
                    type: 'function',
                    function: { name: 'file_read', arguments: '{"path":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                content: '。',
                tool_calls: [{ index: 0, function: { arguments: '"AGENT.md"}' } }],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ];
      return new Response(
        chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
  });
  const r = await fixture();
  try {
    r.config.update(r.config.read().revision, (c) => {
      c.provider = {
        revision: 1,
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        model: 'fixture',
        keyRequired: true,
        supportsImages: true,
      };
    });
    r.vault.put('provider:main', 1, 'model-test', 'model-test-key');
    const model = new ChatModel(r.config, r.vault),
      image = 'data:image/png;base64,iVBORw0KGgo=';
    let streamed = '';
    const response = await model.call({
      system: 'Instructions',
      messages: [
        {
          role: 'user',
          content: 'Read this',
          images: [{ type: 'image_url', image_url: { url: image } }],
        },
      ],
      tools: [
        {
          name: 'file_read',
          description: 'read',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      signal: new AbortController().signal,
      onText: (text) => {
        streamed += text;
      },
    });
    expect(response.content).toBe('読む。');
    expect(streamed).toBe('読む。');
    expect(response.toolCalls).toEqual([
      { id: 'call_fixture', name: 'file_read', arguments: '{"path":"AGENT.md"}' },
    ]);
    expect(payload.messages[1].content[1].image_url.url).toBe(image);
    expect(authorization as string | null).toBe('Bearer model-test-key');
    expect(JSON.stringify(r.store.snapshot(r.id))).not.toContain('model-test-key');
  } finally {
    server.stop(true);
    await r.dispose();
  }
});

test('provider failures are not automatically retried and truncated streams are rejected', async () => {
  let requests = 0,
    incomplete = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      requests++;
      return incomplete
        ? new Response(
            'data: {"choices":[{"delta":{"content":"unfinished"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          )
        : Response.json({ error: { message: 'Temporary failure' } }, { status: 503 });
    },
  });
  const r = await fixture();
  try {
    r.config.update(r.config.read().revision, (c) => {
      c.provider = {
        revision: 1,
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        model: 'fixture',
        keyRequired: false,
        supportsImages: true,
      };
    });
    const input = {
      system: 'Instructions',
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    };
    await expect(new ChatModel(r.config, r.vault).call(input)).rejects.toThrow();
    expect(requests).toBe(1);
    incomplete = true;
    await expect(new ChatModel(r.config, r.vault).call(input)).rejects.toThrow(
      'MODEL_RESPONSE_INCOMPLETE',
    );
    expect(requests).toBe(2);
  } finally {
    server.stop(true);
    await r.dispose();
  }
});
