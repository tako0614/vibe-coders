import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { humanSpecSchema, type HumanSpec } from '../shared/contracts';
import { requests } from './db/schema';
import { Store } from './store';
import { Config, Vault } from './config';
import { RE2JS } from 're2js';

export class HumanService {
  verifyCredential?: (
    target: string,
    revision: number,
    conversationId: string,
  ) => Promise<{ status: string; message: string }>;
  private verifying = new Set<string>();
  private closing = false;
  shutdown() {
    this.closing = true;
  }
  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly vault: Vault,
  ) {}
  get(id: string) {
    const row = this.store.db.select().from(requests).where(eq(requests.id, id)).get();
    if (!row) throw new Error('Request not found.');
    return row;
  }
  create(conversationId: string, input: unknown) {
    this.store.conversation(conversationId);
    const spec = humanSpecSchema.parse(input);
    if (spec.dedupeKey) {
      const existing = this.store.db
        .select()
        .from(requests)
        .where(
          and(eq(requests.conversationId, conversationId), eq(requests.dedupeKey, spec.dedupeKey)),
        )
        .get();
      if (existing) return existing;
    }
    const targetVersion = spec.targetId ? this.config.targetVersion(spec.targetId) : undefined;
    if (spec.kind === 'secret' && targetVersion === undefined)
      throw new Error('Register the target connection before requesting its credential.');
    if (spec.kind === 'secret' && spec.targetId?.startsWith('mcp:')) {
      const connection = this.config.read().mcp.find((c) => c.name === spec.targetId!.slice(4));
      if (connection?.transport === 'stdio' && !connection.credentialEnv)
        throw new Error(
          'Set this stdio connection’s credentialEnv before requesting its credential.',
        );
    }
    const now = Date.now();
    const row = this.store.db
      .insert(requests)
      .values({
        id: crypto.randomUUID(),
        conversationId,
        spec,
        dedupeKey: spec.dedupeKey,
        targetVersion,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    this.store.notify();
    return row;
  }
  answer(id: string, input: unknown, secretRoute = false) {
    return this.config.lock(() => this.answerLocked(id, input, secretRoute));
  }
  submitSecret(id: string, input: unknown) {
    const request = this.answer(id, input, true);
    void this.verify(id).catch(() => {});
    return request;
  }
  completeExternal(id: string, result: Record<string, unknown>) {
    const r = this.get(id);
    if (r.state !== 'pending' || r.spec.kind !== 'action') return;
    this.resolve(id, crypto.randomUUID(), result);
  }
  async verify(id: string) {
    if (this.closing) return;
    const r = this.get(id);
    if (
      !this.verifyCredential ||
      this.verifying.has(id) ||
      r.spec.kind !== 'secret' ||
      r.state !== 'resolved' ||
      r.targetVersion === null
    )
      return;
    this.verifying.add(id);
    try {
      const check = await this.verifyCredential(
        r.spec.targetId!,
        r.targetVersion,
        r.conversationId,
      );
      if (this.closing) return;
      this.config.lock(() => {
        const current = this.get(id);
        if (
          current.revision !== r.revision ||
          current.operationId !== r.operationId ||
          this.config.targetVersion(r.spec.targetId!) !== r.targetVersion
        )
          return;
        const invalid = check.status === 'invalid';
        this.store.db.transaction(() => {
          this.store.db
            .update(requests)
            .set({
              state: invalid ? 'pending' : 'resolved',
              revision: invalid ? r.revision + 1 : r.revision,
              operationId: invalid ? null : r.operationId,
              result: { ...r.result, verification: check.status, message: check.message },
              updatedAt: Date.now(),
            })
            .where(eq(requests.id, id))
            .run();
          this.store.event(r.conversationId, 'human.verification', {
            requestId: id,
            targetId: r.spec.targetId,
            verification: check.status,
            message: check.message,
            revision: invalid ? r.revision + 1 : r.revision,
          });
        });
        this.store.notify();
      });
    } finally {
      this.verifying.delete(id);
    }
  }
  private answerLocked(id: string, input: unknown, secretRoute: boolean) {
    const { revision, operationId, values } = z
      .object({
        revision: z.number().int(),
        operationId: z.string().uuid(),
        values: z.record(z.string(), z.string().max(32000)),
      })
      .strict()
      .parse(input);
    const request = this.get(id);
    if (request.spec.externalCompletion)
      throw new Error(
        'This request completes automatically after the external service confirms authentication.',
      );
    if (request.operationId === operationId && request.state === 'resolved') return request;
    if (request.state !== 'pending' || request.revision !== revision)
      throw new Error('This request changed or is already closed.');
    if (request.spec.expiresAt && request.spec.expiresAt <= Date.now()) {
      this.close(id, 'expired');
      throw new Error('This request expired.');
    }
    if ((request.spec.kind === 'secret') !== secretRoute)
      throw new Error('Use the matching input route.');
    if (
      request.targetVersion !== null &&
      this.config.targetVersion(request.spec.targetId!) !== request.targetVersion
    )
      throw new Error('Target configuration changed. Create a request for its current version.');
    this.validateValues(request.spec, values);
    // Synchronous write plus durable operation ID: no await window between version
    // validation and saving. Recovery can identify a saved credential after a crash.
    if (secretRoute) {
      this.store.db
        .update(requests)
        .set({ state: 'processing', operationId, updatedAt: Date.now() })
        .where(eq(requests.id, id))
        .run();
      try {
        this.vault.put(
          request.spec.targetId!,
          request.targetVersion!,
          operationId,
          values[request.spec.fields[0].name],
        );
      } catch {
        this.store.db
          .update(requests)
          .set({ state: 'pending', operationId: null })
          .where(eq(requests.id, id))
          .run();
        throw new Error('Credential could not be saved.');
      }
    }
    const result = secretRoute
      ? {
          targetId: request.spec.targetId,
          credentialRef: request.spec.targetId,
          status: 'saved',
          verification: 'unverified',
        }
      : request.spec.kind === 'action'
        ? { status: 'reported_complete', verification: 'unverified' }
        : { answers: values };
    this.resolve(id, operationId, result);
    return this.get(id);
  }
  private validateValues(spec: HumanSpec, values: Record<string, string>) {
    if (Object.keys(values).some((key) => !spec.fields.some((f) => f.name === key)))
      throw new Error('Unknown form field.');
    for (const field of spec.fields) {
      const value = values[field.name] ?? '';
      if (field.required && !value.trim()) throw new Error(`${field.label} is required.`);
      if (value && field.type === 'choice' && !field.options?.some((o) => o.value === value))
        throw new Error('Invalid choice.');
      if (!value) continue;
      if (field.type === 'multiChoice') {
        let selected: unknown;
        try {
          selected = JSON.parse(value);
        } catch {
          throw new Error('Invalid choices.');
        }
        if (
          !Array.isArray(selected) ||
          selected.some(
            (v) => typeof v !== 'string' || !field.options?.some((o) => o.value === v),
          ) ||
          new Set(selected).size !== selected.length ||
          selected.length < (field.minItems ?? 0) ||
          selected.length > (field.maxItems ?? 20)
        )
          throw new Error('選択数または選択肢が正しくありません。');
      }
      if (field.pattern && !RE2JS.compile(field.pattern).test(value))
        throw new Error(`${field.label}の形式が正しくありません。`);
      if (field.type === 'boolean' && !['true', 'false'].includes(value))
        throw new Error('Invalid boolean.');
      if (field.type === 'number' || field.type === 'integer') {
        const n = Number(value);
        if (
          !value.trim() ||
          !Number.isFinite(n) ||
          (field.type === 'integer' && !Number.isSafeInteger(n)) ||
          (field.minimum !== undefined && n < field.minimum) ||
          (field.maximum !== undefined && n > field.maximum)
        )
          throw new Error('Number is outside the allowed range.');
      }
      if (
        (field.minLength !== undefined && value.length < field.minLength) ||
        (field.maxLength !== undefined && value.length > field.maxLength)
      )
        throw new Error('Invalid text length.');
      if (field.format === 'email' && !z.email().safeParse(value).success)
        throw new Error('Invalid email.');
      if (field.format === 'uri' && !z.url().safeParse(value).success)
        throw new Error('Invalid URL.');
      if (field.format === 'date' && !z.iso.date().safeParse(value).success)
        throw new Error('Invalid date.');
      if (
        field.format === 'date-time' &&
        !z.iso.datetime({ offset: true }).safeParse(value).success
      )
        throw new Error('Invalid date-time.');
    }
  }
  private resolve(id: string, operationId: string, result: Record<string, unknown>) {
    const r = this.get(id);
    this.store.db.transaction(() => {
      this.store.db
        .update(requests)
        .set({ state: 'resolved', result, operationId, updatedAt: Date.now() })
        .where(eq(requests.id, id))
        .run();
      this.store.event(
        r.conversationId,
        'human.resolved',
        { requestId: id, outcome: 'resolved', ...result },
        `human:${id}:${r.revision}`,
      );
    });
    this.store.notify();
  }
  close(id: string, state: 'cancelled' | 'expired' = 'cancelled') {
    const r = this.get(id);
    if (r.state !== 'pending') return r;
    this.store.db.transaction(() => {
      this.store.db
        .update(requests)
        .set({ state, updatedAt: Date.now() })
        .where(eq(requests.id, id))
        .run();
      this.store.event(
        r.conversationId,
        'human.resolved',
        { requestId: id, outcome: state },
        `human:${id}:${r.revision}`,
      );
    });
    this.store.notify();
    return this.get(id);
  }
  recover() {
    for (const r of this.store.db
      .select()
      .from(requests)
      .where(inArray(requests.state, ['processing', 'pending']))
      .all()) {
      if (r.state === 'processing') {
        if (
          r.spec.targetId &&
          r.operationId &&
          r.targetVersion !== null &&
          this.config.targetVersion(r.spec.targetId) === r.targetVersion &&
          this.vault.saved(r.spec.targetId, r.targetVersion, r.operationId)
        ) {
          this.resolve(r.id, r.operationId, {
            targetId: r.spec.targetId,
            credentialRef: r.spec.targetId,
            status: 'saved',
            verification: 'unverified',
          });
        } else
          this.store.db
            .update(requests)
            .set({ state: 'pending', operationId: null, revision: r.revision + 1 })
            .where(eq(requests.id, r.id))
            .run();
      } else if (r.spec.expiresAt && r.spec.expiresAt <= Date.now()) this.close(r.id, 'expired');
    }
  }
}
