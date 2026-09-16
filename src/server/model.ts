import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { MessageBody } from '../shared/contracts';
import { Config, Vault } from './config';

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
export type ModelInput = {
  conversationId?: string;
  system: string;
  messages: MessageBody[];
  tools: ToolDefinition[];
  signal: AbortSignal;
  onText?: (text: string) => void;
};
export interface ModelAdapter {
  isConfigured?(): boolean;
  call(input: ModelInput): Promise<MessageBody>;
}
export class ModelContextExceeded extends Error {
  constructor() {
    super(
      '会話がモデルの入力上限を超えました。入力やツールの読取範囲を小さくして再試行してください。元の履歴は保持されています。',
    );
  }
}
export const isContextLimit = (code: unknown) =>
  ['context_length_exceeded', 'context_window_exceeded'].includes(String(code));
export class ModelLoginRequired extends Error {
  constructor(readonly requestId: string) {
    super('CODEX_LOGIN_REQUIRED');
  }
}
export class ChatModel implements ModelAdapter {
  constructor(
    readonly config: Config,
    readonly vault: Vault,
  ) {}
  async call(input: ModelInput): Promise<MessageBody> {
    const p = this.config.read().provider;
    if (!p?.model) throw new Error('MODEL_NOT_CONFIGURED');
    if (p.kind === 'codex') throw new Error('Use the Codex subscription model adapter.');
    const key = this.vault.get('provider:main', p.revision);
    if (p.keyRequired && !key) throw new Error('MODEL_KEY_MISSING');
    if (!p.supportsImages && input.messages.some((m) => m.images?.length))
      throw new Error('MODEL_IMAGES_UNSUPPORTED');
    const client = new OpenAI({
      apiKey: key || 'local',
      baseURL: p.baseUrl,
      maxRetries: 0,
      timeout: 120000,
    });
    const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: input.system }];
    for (const m of input.messages) {
      if (m.role === 'tool')
        messages.push({ role: 'tool', tool_call_id: m.toolCallId!, content: m.content });
      else if (m.role === 'assistant')
        messages.push({
          role: 'assistant',
          content: m.content || null,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((t) => ({
                  id: t.id,
                  type: 'function' as const,
                  function: { name: t.name, arguments: t.arguments },
                })),
              }
            : {}),
        });
      else if (m.role === 'user')
        messages.push({
          role: 'user',
          content: m.images?.length ? [{ type: 'text', text: m.content }, ...m.images] : m.content,
        });
      else messages.push({ role: 'user', content: `[Runtime observation]\n${m.content}` });
    }
    const tools: ChatCompletionTool[] = input.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const stream = await client.chat.completions
      .create({ model: p.model, messages, tools, stream: true }, { signal: input.signal })
      .catch((error) => {
        if (error instanceof OpenAI.APIError && isContextLimit(error.code))
          throw new ModelContextExceeded();
        throw error;
      });
    let content = '';
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let finished = false;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) {
        if (!['stop', 'tool_calls'].includes(choice.finish_reason))
          throw new Error('MODEL_RESPONSE_INCOMPLETE');
        finished = true;
      }
      const d = choice.delta;
      if (d.content) {
        content += d.content;
        input.onText?.(d.content);
      }
      for (const call of d.tool_calls || []) {
        const current = calls.get(call.index) || { id: '', name: '', arguments: '' };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        calls.set(call.index, current);
      }
    }
    if (!finished || [...calls.values()].some((t) => !t.id || !t.name))
      throw new Error('MODEL_RESPONSE_INCOMPLETE');
    return {
      role: 'assistant',
      content,
      toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, t]) => t),
    };
  }
}
