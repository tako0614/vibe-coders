import { resolve } from 'node:path';
import { z } from 'zod';
import { RunService } from './runs';
import { JsonProcess } from './json-process';
import type { CodexAuth } from './codex-auth';
import { HumanService } from './human';
import { Store } from './store';

export const nativeSchema = z
  .object({
    adapter: z.enum(['codex', 'claude']),
    prompt: z.string().min(1).max(32000),
    cwd: z.string().optional(),
    resumeId: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
  })
  .strict();
type NativeInput = z.infer<typeof nativeSchema>;

export class NativeService {
  constructor(
    readonly store: Store,
    readonly runs: RunService,
    readonly human: HumanService,
    readonly executables: { codex: string[]; claude: string[] } = {
      codex: ['codex'],
      claude: ['claude'],
    },
    readonly auth?: CodexAuth,
  ) {}
  start(conversationId: string, value: unknown) {
    const input = nativeSchema.parse(value);
    return this.runs.managed(
      conversationId,
      `${input.adapter}: ${input.prompt.slice(0, 70)}`,
      async (signal, emit, update) => {
        if (input.adapter === 'codex' && this.auth) {
          update({ adapter: 'codex', turnState: 'checking_auth' });
          await this.auth.ensure(conversationId, signal);
        }
        return input.adapter === 'codex'
          ? this.codex(conversationId, input, signal, emit, update)
          : this.claude(input, signal, emit, update);
      },
      'native',
      input.cwd,
    );
  }
  private async codex(
    conversationId: string,
    input: NativeInput,
    signal: AbortSignal,
    emit: (s: string) => void,
    update: (metadata: Record<string, unknown>) => void,
  ) {
    const cwd = resolve(this.runs.home, input.cwd || '.');
    const process = new JsonProcess([...this.executables.codex, 'app-server'], cwd, emit);
    const stop = () => {
      void process.close();
    };
    signal.addEventListener('abort', stop, { once: true });
    const deadline = setTimeout(stop, 30 * 60000);
    let threadId = '',
      turnId = '',
      finalText = '';
    const cards = new Set<string>();
    let finish!: (r: Record<string, unknown>) => void;
    const completed = new Promise<Record<string, unknown>>((resolve) => {
      finish = resolve;
    });
    const ended = () =>
      finish({
        isError: true,
        turnState: 'unknown',
        threadId,
        turnId,
        error: 'Connection ended before a completed turn.',
      });
    process.events.on('ended', ended);
    process.events.on('message', (message) => {
      if (message.id !== undefined && message.method) {
        if (
          message.method === 'item/tool/requestUserInput' ||
          message.method === 'tool/requestUserInput'
        ) {
          const questions = message.params.questions as {
            id: string;
            question: string;
            options?: { label: string; description?: string }[];
          }[];
          try {
            const card = this.human.create(conversationId, {
              kind: 'input',
              title: 'Codexからの入力依頼',
              fields: questions.map((q, i) => ({
                name: `q${i}`,
                label: q.question,
                type: q.options?.length ? 'choice' : 'text',
                options: q.options?.map((o) => ({ label: o.label, value: o.label })),
              })),
            });
            cards.add(card.id);
            const check = () => {
              const current = this.human.get(card.id);
              if (current.state === 'pending') return;
              this.store.changes.off('change', check);
              cards.delete(card.id);
              const values = (current.result?.answers as Record<string, string>) || {};
              process.send({
                id: message.id,
                result: {
                  answers: Object.fromEntries(
                    questions.map((q, i) => [
                      q.id,
                      { answers: current.state === 'resolved' ? [values[`q${i}`]] : [] },
                    ]),
                  ),
                },
              });
            };
            this.store.changes.on('change', check);
            check();
          } catch {
            process.send({
              id: message.id,
              error: { code: -32602, message: 'Input form is unsupported.' },
            });
          }
        } else
          process.send({
            id: message.id,
            error: {
              code: -32601,
              message: 'Unsupported server request; operation was not approved.',
            },
          });
        return;
      }
      if (message.params?.threadId && threadId && message.params.threadId !== threadId) return;
      if (message.method === 'item/agentMessage/delta') {
        const delta = String(message.params.delta || '');
        finalText = (finalText + delta).slice(-64000);
        emit(delta);
      }
      if (message.method === 'turn/completed') {
        const turn = message.params.turn;
        finish({
          adapter: 'codex',
          threadId: message.params.threadId || threadId,
          turnId: turn.id,
          turnState: turn.status,
          isError: turn.status !== 'completed',
          text: finalText.slice(-64000),
          error: turn.error,
        });
      }
    });
    try {
      signal.throwIfAborted();
      await process.request('initialize', {
        clientInfo: { name: 'vibe_coders', version: '0.1.7' },
      });
      process.send({ method: 'initialized', params: {} });
      const thread = await process.request(input.resumeId ? 'thread/resume' : 'thread/start', {
        ...(input.resumeId ? { threadId: input.resumeId } : {}),
        cwd,
        model: input.model,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      });
      threadId = thread.thread.id;
      update({ adapter: 'codex', threadId, turnState: 'idle' });
      emit(`\n[Codex thread ${threadId}]\n`);
      const turn = await process.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.prompt }],
      });
      turnId = turn.turn.id;
      update({ adapter: 'codex', threadId, turnId, turnState: 'inProgress' });
      return await completed;
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', stop);
      for (const id of cards) this.human.close(id);
      await process.close();
      process.events.removeAllListeners();
    }
  }
  private async claude(
    input: NativeInput,
    signal: AbortSignal,
    emit: (s: string) => void,
    update: (metadata: Record<string, unknown>) => void,
  ) {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Bash,Read,Write,Edit,Glob,Grep',
    ];
    if (input.resumeId) args.push('--resume', input.resumeId);
    if (input.model) args.push('--model', input.model);
    const process = new JsonProcess(
      [...this.executables.claude, ...args],
      resolve(this.runs.home, input.cwd || '.'),
      emit,
    );
    const stop = () => {
      void process.close();
    };
    signal.addEventListener('abort', stop, { once: true });
    const deadline = setTimeout(stop, 30 * 60000);
    let result: Record<string, unknown> | undefined;
    process.events.on('message', (message) => {
      if (message.type === 'system' && message.subtype === 'init')
        update({ adapter: 'claude', sessionId: message.session_id, turnState: 'inProgress' });
      if (message.type === 'stream_event' && message.event?.delta?.text)
        emit(message.event.delta.text);
      if (message.type === 'result')
        result = {
          adapter: 'claude',
          sessionId: message.session_id,
          turnState: message.is_error || message.subtype !== 'success' ? 'failed' : 'completed',
          isError: !!message.is_error || message.subtype !== 'success',
          text: message.result,
          usage: message.usage,
          costUsd: message.total_cost_usd,
        };
    });
    try {
      signal.throwIfAborted();
      process.child.stdin.end(input.prompt);
      const code = await process.exited;
      return result && code === 0
        ? result
        : { ...result, isError: true, exitCode: code, turnState: result?.turnState || 'unknown' };
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', stop);
      await process.close();
    }
  }
}
