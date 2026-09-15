import { ModelContextExceeded, isContextLimit } from './model';
import OpenAI from 'openai';
import type { ResponseInputItem, ResponseOutputItem } from 'openai/resources/responses/responses';
import type { MessageBody } from '../shared/contracts';
import type { Config } from './config';
import type { CodexAuth } from './codex-auth';
import { ModelLoginRequired, type ModelAdapter, type ModelInput } from './model';

// The subscription endpoint is fixed: an editable provider URL must never receive
// the user's Codex credential. No proxy listener or second agent loop is started.
const baseURL = 'https://chatgpt.com/backend-api/codex';
export function codexInput(messages: MessageBody[], model: string): ResponseInputItem[] {
  const result: ResponseInputItem[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.codex?.model === model) {
      result.push(...(message.codex.output as ResponseInputItem[]));
    } else if (message.role === 'tool') {
      result.push({
        type: 'function_call_output',
        call_id: message.toolCallId!,
        output: message.content,
      });
    } else if (message.role === 'assistant') {
      if (message.content) result.push({ role: 'assistant', content: message.content });
      for (const call of message.toolCalls || [])
        result.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
    } else {
      result.push({
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              message.role === 'system'
                ? `[Runtime observation]\n${message.content}`
                : message.content,
          },
          ...(message.images || []).map((image) => ({
            type: 'input_image' as const,
            image_url: image.image_url.url,
            detail: image.image_url.detail || ('auto' as const),
          })),
        ],
      });
    }
  }
  return result;
}
export class CodexModel implements ModelAdapter {
  constructor(
    readonly config: Config,
    readonly auth: CodexAuth,
    private readonly fetcher?: typeof fetch,
  ) {}
  private login(input: ModelInput, force = false): never {
    const status = this.auth.status();
    if (!status.requestId && status.message) throw new Error('CODEX_LOGIN_REQUIRED');
    if (input.conversationId)
      throw new ModelLoginRequired(
        this.auth.start(input.conversationId, 'device', force).requestId!,
      );
    throw new Error('CODEX_LOGIN_REQUIRED');
  }
  async call(input: ModelInput): Promise<MessageBody> {
    const provider = this.config.read().provider;
    if (provider?.kind !== 'codex') throw new Error('MODEL_NOT_CONFIGURED');
    input.signal.throwIfAborted();
    let credentials;
    try {
      credentials = await this.auth.subscriptionCredentials();
    } catch (error) {
      if (error instanceof Error && error.message === 'CODEX_LOGIN_REQUIRED')
        return this.login(input);
      throw error;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = new OpenAI({
        baseURL,
        apiKey: credentials.token,
        maxRetries: 0,
        timeout: 120000,
        defaultHeaders: { 'Chatgpt-Account-Id': credentials.accountId, originator: 'vibe_coders' },
        fetch: this.fetcher,
        fetchOptions: { redirect: 'error' },
      });
      let received = false;
      try {
        const stream = await client.responses.create(
          {
            model: provider.model,
            instructions: input.system,
            input: codexInput(input.messages, provider.model),
            tools: input.tools.map((tool) => ({
              type: 'function',
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              strict: false,
            })),
            tool_choice: 'auto',
            parallel_tool_calls: true,
            store: false,
            stream: true,
            include: ['reasoning.encrypted_content'],
            ...(input.conversationId ? { prompt_cache_key: input.conversationId } : {}),
          },
          { signal: input.signal },
        );
        let output: ResponseOutputItem[] | undefined;
        const completedItems = new Map<number, ResponseOutputItem>();
        for await (const event of stream) {
          received = true;
          if (event.type === 'response.output_text.delta') input.onText?.(event.delta);
          if (event.type === 'response.output_item.done')
            completedItems.set(event.output_index, event.item);
          if (event.type === 'response.completed') {
            if (isContextLimit(event.response.error?.code)) throw new ModelContextExceeded();
            if (event.response.status !== 'completed') throw new Error('MODEL_RESPONSE_INCOMPLETE');
            output = event.response.output?.length
              ? event.response.output
              : [...completedItems].sort(([a], [b]) => a - b).map(([, item]) => item);
          }
          if (event.type === 'response.failed' && isContextLimit(event.response.error?.code))
            throw new ModelContextExceeded();
          if (
            event.type === 'response.failed' ||
            event.type === 'response.incomplete' ||
            event.type === 'error'
          )
            throw new Error('MODEL_RESPONSE_INCOMPLETE');
        }
        input.signal.throwIfAborted();
        if (
          !output?.length ||
          output.some((item) => !['message', 'reasoning', 'function_call'].includes(item.type))
        )
          throw new Error('MODEL_RESPONSE_INCOMPLETE');
        const toolCalls = output
          .filter((item) => item.type === 'function_call')
          .map((item) => ({ id: item.call_id, name: item.name, arguments: item.arguments }));
        if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length)
          throw new Error('MODEL_RESPONSE_INCOMPLETE');
        for (const call of toolCalls) {
          if (!call.id || !input.tools.some((tool) => tool.name === call.name))
            throw new Error('MODEL_RESPONSE_INCOMPLETE');
          JSON.parse(call.arguments);
        }
        const content = output
          .filter((item) => item.type === 'message')
          .flatMap((item) => item.content)
          .map((part) =>
            part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : '',
          )
          .join('');
        // Retain only encrypted reasoning and the actual assistant/function items.
        const continuation = output.map((item) =>
          item.type === 'reasoning'
            ? {
                type: 'reasoning',
                id: item.id,
                summary: [],
                ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}),
              }
            : item,
        );
        return {
          role: 'assistant',
          content,
          toolCalls,
          codex: { model: provider.model, output: continuation },
        };
      } catch (error) {
        input.signal.throwIfAborted();
        if (
          error instanceof OpenAI.APIError &&
          error.status === 401 &&
          !received &&
          attempt === 0
        ) {
          try {
            credentials = await this.auth.subscriptionCredentials(true);
          } catch {
            return this.login(input, true);
          }
          continue;
        }
        if (error instanceof ModelContextExceeded) throw error;
        if (error instanceof OpenAI.APIError && isContextLimit(error.code))
          throw new ModelContextExceeded();
        // Never persist upstream bodies, headers or account details in errors.
        if (error instanceof OpenAI.APIError && error.status === 401)
          return this.login(input, true);
        if (error instanceof OpenAI.APIError && error.status === 429)
          throw new Error('CODEX_USAGE_LIMIT');
        if (error instanceof Error && error.message === 'MODEL_RESPONSE_INCOMPLETE') throw error;
        throw new Error('CODEX_MODEL_FAILED');
      }
    }
    throw new Error('CODEX_MODEL_FAILED');
  }
}
