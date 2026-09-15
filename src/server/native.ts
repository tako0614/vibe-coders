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
export const nativeInputSchema = z
  .object({
    prompt: z.string().min(1).max(32000),
    operationId: z.string().uuid(),
    expectedTurnId: z.string().min(1),
  })
  .strict();
type NativeInput = z.infer<typeof nativeSchema>;

export class NativeService {
  private inputs = new Map<
    string,
    { turnId: string; send: (prompt: string, operationId: string) => Promise<void> }
  >();
  private sending = new Set<string>();
  async input(id: string, value: unknown) {
    this.store.assertEnabled();
    const { prompt, operationId, expectedTurnId } = nativeInputSchema.parse(value);
    const key = `native-input:${id}:${operationId}`;
    const previous = this.store.get<{ state: string; prompt: string } | null>(key, null);
    if (previous) {
      if (previous.prompt !== this.runs.vault.redact(prompt))
        throw new Error('Input ID was already used.');
      return previous;
    }
    const active = this.inputs.get(id);
    if (!active || active.turnId !== expectedTurnId || this.runs.get(id).state !== 'running')
      throw new Error('実行状態が変わりました。画面を更新してから追加指示を送ってください。');
    if (this.sending.has(id)) throw new Error('前の追加指示を送信中です。');
    this.sending.add(id);
    const record = { state: 'sending', prompt: this.runs.vault.redact(prompt) };
    this.store.set(key, record);
    try {
      await active.send(prompt, operationId);
      this.store.set(key, { ...record, state: 'accepted' });
      return { state: 'accepted', prompt: record.prompt };
    } catch (error) {
      this.store.set(key, { ...record, state: 'unknown' });
      throw new Error(
        '追加指示の到達を確認できません。自動再送はしていません。実行の出力を確認してください。',
      );
    } finally {
      this.sending.delete(id);
    }
  }

  beforeWork?: () => Promise<void>;
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
    const run = this.runs.managed(
      conversationId,
      `${input.adapter}: ${input.prompt.slice(0, 70)}`,
      async (signal, emit, update) => {
        await this.beforeWork?.();
        if (input.adapter === 'codex' && this.auth) {
          update({ adapter: 'codex', turnState: 'checking_auth' });
          await this.auth.ensure(conversationId, signal);
        }
        return input.adapter === 'codex'
          ? this.codex(conversationId, input, signal, emit, update, run.id)
          : this.claude(input, signal, emit, update, run.id);
      },
      'native',
      input.cwd,
    );
    return run;
  }
  private async codex(
    conversationId: string,
    input: NativeInput,
    signal: AbortSignal,
    emit: (s: string) => void,
    update: (metadata: Record<string, unknown>) => void,
    runId: string,
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
        clientInfo: { name: 'vibe_coders', version: '0.1.8' },
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
      this.inputs.set(runId, {
        turnId,
        send: async (prompt) => {
          const accepted = await process.request('turn/steer', {
            threadId,
            expectedTurnId: turnId,
            input: [{ type: 'text', text: prompt }],
          });
          if (accepted.turnId !== turnId) throw new Error('Turn changed.');
          emit(`\n[追加指示を送信] ${prompt}\n`);
        },
      });
      update({ adapter: 'codex', threadId, turnId, turnState: 'inProgress', inputMode: 'steer' });
      return await completed;
    } finally {
      this.inputs.delete(runId);
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
    runId: string,
  ) {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--replay-user-messages',
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
    let sessionId = input.resumeId || '',
      turnId: string = crypto.randomUUID(),
      redirecting = false;
    let finish!: (result: Record<string, unknown>) => void;
    const completed = new Promise<Record<string, unknown>>((resolve) => {
      finish = resolve;
    });
    const controls = new Map<
      string,
      { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
    >();
    const acknowledgments = new Map<
      string,
      { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
    >();
    const waiting = (map: typeof controls, id: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          map.delete(id);
          reject(new Error('Claude input acknowledgment timed out.'));
        }, 20000);
        map.set(id, { resolve, reject, timer });
      });
    const user = (prompt: string, uuid: string) =>
      process.send({
        type: 'user',
        uuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: 'user', content: prompt },
      });
    const publish = () =>
      update({
        adapter: 'claude',
        sessionId,
        turnId,
        turnState: 'inProgress',
        inputMode: 'interrupt',
      });
    const register = () =>
      this.inputs.set(runId, {
        turnId,
        send: async (prompt, operationId) => {
          redirecting = true;
          const requestId = crypto.randomUUID(),
            ack = waiting(controls, requestId);
          process.send({
            type: 'control_request',
            request_id: requestId,
            request: { subtype: 'interrupt' },
          });
          await ack.catch((error) => {
            redirecting = false;
            stop();
            throw error;
          });
          signal.throwIfAborted();
          const received = waiting(acknowledgments, operationId);
          user(prompt, operationId);
          await received.catch((error) => {
            redirecting = false;
            stop();
            throw error;
          });
          turnId = operationId;
          register();
          publish();
          emit(`\n[追加指示を送信] ${prompt}\n`);
        },
      });
    process.events.on('ended', () => {
      for (const map of [controls, acknowledgments]) {
        for (const pending of map.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Claude session ended.'));
        }
        map.clear();
      }
      finish({
        adapter: 'claude',
        sessionId,
        isError: true,
        turnState: 'unknown',
        error: 'Connection ended before a completed turn.',
      });
    });
    process.events.on('message', (message) => {
      if (message.type === 'control_response') {
        const response = message.response,
          pending = controls.get(response?.request_id);
        if (pending) {
          controls.delete(response.request_id);
          clearTimeout(pending.timer);
          response.subtype === 'success'
            ? pending.resolve()
            : pending.reject(new Error('Claude rejected interruption.'));
        }
      }
      if (message.type === 'user' && acknowledgments.has(message.uuid)) {
        const pending = acknowledgments.get(message.uuid)!;
        acknowledgments.delete(message.uuid);
        clearTimeout(pending.timer);
        redirecting = false;
        pending.resolve();
      }
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        register();
        publish();
      }
      if (message.type === 'stream_event' && message.event?.delta?.text)
        emit(message.event.delta.text);
      if (message.type === 'result' && !redirecting)
        finish({
          adapter: 'claude',
          sessionId: message.session_id || sessionId,
          turnId,
          turnState: message.is_error || message.subtype !== 'success' ? 'failed' : 'completed',
          isError: !!message.is_error || message.subtype !== 'success',
          text: message.result,
          usage: message.usage,
          costUsd: message.total_cost_usd,
        });
    });
    try {
      signal.throwIfAborted();
      const initializationId = crypto.randomUUID(),
        initialized = waiting(controls, initializationId);
      process.send({
        type: 'control_request',
        request_id: initializationId,
        request: { subtype: 'initialize', hooks: {} },
      });
      await initialized;
      user(input.prompt, turnId);
      return await completed;
    } finally {
      this.inputs.delete(runId);
      clearTimeout(deadline);
      signal.removeEventListener('abort', stop);
      for (const map of [controls, acknowledgments])
        for (const pending of map.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Claude session ended.'));
        }
      await process.close();
    }
  }
}
