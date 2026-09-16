import { expect, test } from 'bun:test';
import { fixture } from './helpers';
import { ChatModel } from '../src/server/model';
import { providerModels } from '../src/server/provider-models';
import { updateProvider } from '../src/server/settings';

test('OpenRouter effort is sent in reasoning, ordinary APIs use reasoning_effort, and default omits both', async () => {
  const r = await fixture();
  const payloads: any[] = [];
  try {
    const model = new ChatModel(r.config, r.vault, (async (url, init) => {
      const request = new Request(url, init);
      payloads.push(await request.json());
      expect(request.headers.get('authorization')).toBe('Bearer retained-key');
      return new Response(
        'data: ' +
          JSON.stringify({
            choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
          }) +
          '\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }) as typeof fetch);
    for (const baseUrl of ['https://openrouter.ai/api/v1', 'https://api.example/v1']) {
      const provider = {
        kind: 'openai' as const,
        baseUrl,
        model: 'test-model',
        supportsImages: true,
        keyRequired: true,
      };
      updateProvider(r, {
        revision: r.config.read().revision,
        provider,
        credential: 'retained-key',
      });
      updateProvider(r, {
        revision: r.config.read().revision,
        provider: { ...provider, reasoningEffort: 'high' },
      });
      expect(r.config.read().provider?.reasoningEffort).toBe('high');
      await model.call({
        system: 'Test',
        messages: [{ role: 'user', content: 'Test' }],
        tools: [],
        signal: new AbortController().signal,
      });
      updateProvider(r, { revision: r.config.read().revision, provider });
      await model.call({
        system: 'Test',
        messages: [{ role: 'user', content: 'Test' }],
        tools: [],
        signal: new AbortController().signal,
      });
    }
    expect(payloads[0].reasoning).toEqual({ effort: 'high' });
    expect(payloads[0].reasoning_effort).toBeUndefined();
    expect(payloads[2].reasoning_effort).toBe('high');
    expect(payloads[2].reasoning).toBeUndefined();
    for (const i of [1, 3]) {
      expect(payloads[i].reasoning).toBeUndefined();
      expect(payloads[i].reasoning_effort).toBeUndefined();
    }
  } finally {
    await r.dispose();
  }
});

test('model discovery uses supported efforts, mandatory reasoning and null gateway levels without inventing support', async () => {
  const r = await fixture();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      Response.json({
        data: [
          {
            id: 'bounded',
            reasoning: {
              supported_efforts: ['none', 'low', 'high', 'bad'],
              default_effort: 'low',
              mandatory: true,
            },
          },
          { id: 'gateway', reasoning: { supported_efforts: null, default_effort: 'medium' } },
          { id: 'plain' },
        ],
      }),
  });
  try {
    const models = await providerModels(r.config, r.vault, {
      baseUrl: `http://127.0.0.1:${server.port}`,
    });
    expect(models.find((m) => m.id === 'bounded')).toMatchObject({
      reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'low',
    });
    expect(models.find((m) => m.id === 'gateway')?.reasoningEfforts).toContain('xhigh');
    expect(models.find((m) => m.id === 'plain')?.reasoningEfforts).toBeUndefined();
  } finally {
    server.stop(true);
    await r.dispose();
  }
});
