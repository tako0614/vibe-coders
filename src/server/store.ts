import { and, asc, desc, eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import type { DB } from './db';
import * as s from './db/schema';
import type { MessageBody } from '../shared/contracts';
import { emptyWorkspace, workspaceSchema, type ShellWorkspace } from '../shared/shell';

export class Store {
  readonly changes = new EventEmitter();
  constructor(readonly db: DB) {
    this.changes.setMaxListeners(100);
  }
  notify() {
    this.changes.emit('change');
  }
  createConversation(title = '新しい会話') {
    const row = this.db
      .insert(s.conversations)
      .values({ id: crypto.randomUUID(), title, createdAt: Date.now() })
      .returning()
      .get();
    this.notify();
    return row;
  }
  conversation(id: string) {
    const row = this.db.select().from(s.conversations).where(eq(s.conversations.id, id)).get();
    if (!row) throw new Error('Conversation not found.');
    return row;
  }
  listConversations() {
    return this.db.select().from(s.conversations).orderBy(desc(s.conversations.createdAt)).all();
  }
  history(id: string) {
    return this.db
      .select()
      .from(s.messages)
      .where(eq(s.messages.conversationId, id))
      .orderBy(asc(s.messages.seq))
      .all();
  }
  message(id: string, body: MessageBody, messageId: string = crypto.randomUUID()) {
    this.db
      .insert(s.messages)
      .values({ id: messageId, conversationId: id, body, createdAt: Date.now() })
      .onConflictDoNothing()
      .run();
    this.notify();
  }
  event(
    id: string,
    type: string,
    payload: Record<string, unknown>,
    key: string = crypto.randomUUID(),
  ) {
    this.db
      .insert(s.events)
      .values({ conversationId: id, type, payload, key, createdAt: Date.now() })
      .onConflictDoNothing()
      .run();
  }
  inbox(id: string) {
    return this.db
      .select()
      .from(s.events)
      .where(and(eq(s.events.conversationId, id), eq(s.events.consumed, false)))
      .orderBy(asc(s.events.id))
      .all();
  }
  get<T>(key: string, fallback: T): T {
    return (this.db.select().from(s.state).where(eq(s.state.key, key)).get()?.value ??
      fallback) as T;
  }
  set(key: string, value: unknown) {
    this.db
      .insert(s.state)
      .values({ key, value })
      .onConflictDoUpdate({ target: s.state.key, set: { value } })
      .run();
    this.notify();
  }
  get stopped() {
    return this.get('stopped', false);
  }
  assertEnabled() {
    if (this.stopped) throw new Error('All execution is stopped. Enable it explicitly first.');
  }
  workspace(id: string): ShellWorkspace {
    this.conversation(id);
    const value = this.get(`terminal-workspace:${id}`, emptyWorkspace());
    const ids = new Set(
      this.db
        .select({ id: s.runs.id })
        .from(s.runs)
        .where(eq(s.runs.conversationId, id))
        .all()
        .map((r) => r.id),
    );
    return {
      ...value,
      placements: Object.fromEntries(
        Object.entries(value.placements).filter(([id]) => ids.has(id)),
      ),
      hidden: value.hidden.filter((id) => ids.has(id)),
    };
  }
  updateWorkspace(id: string, value: unknown) {
    const next = workspaceSchema.parse(value),
      current = this.workspace(id);
    if (next.revision !== current.revision)
      throw new Error('デッキが別の画面で更新されました。更新後にもう一度操作してください。');
    const ids = new Set(
      this.db
        .select({ id: s.runs.id })
        .from(s.runs)
        .where(eq(s.runs.conversationId, id))
        .all()
        .map((r) => r.id),
    );
    if ([...Object.keys(next.placements), ...next.hidden].some((id) => !ids.has(id)))
      throw new Error('Unknown workspace run.');
    this.set(`terminal-workspace:${id}`, { ...next, revision: current.revision + 1 });
    return this.workspace(id);
  }
  snapshot(id: string) {
    const context = this.get<{ through: number; count: number; updatedAt: number } | null>(
      `context:${id}`,
      null,
    );
    return {
      conversation: this.conversation(id),
      workspace: this.workspace(id),
      messages: this.history(id),
      requests: this.db
        .select()
        .from(s.requests)
        .where(eq(s.requests.conversationId, id))
        .orderBy(desc(s.requests.createdAt))
        .all(),
      runs: this.db
        .select()
        .from(s.runs)
        .where(eq(s.runs.conversationId, id))
        .orderBy(desc(s.runs.createdAt))
        .all()
        .map(({ output, result, ...run }) => ({
          ...run,
          result:
            run.kind === 'native' && result
              ? {
                  adapter: result.adapter,
                  threadId: result.threadId,
                  turnId: result.turnId,
                  sessionId: result.sessionId,
                  turnState: run.state === 'interrupted' ? 'unknown' : result.turnState,
                }
              : result?.install
                ? {
                    install: true,
                    name: result.name,
                    package: result.package,
                    version: result.version,
                    stage: result.stage,
                    error: result.error,
                  }
                : null,
        })),
      schedules: this.db.select().from(s.schedules).where(eq(s.schedules.conversationId, id)).all(),
      context: context
        ? { through: context.through, count: context.count, updatedAt: context.updatedAt }
        : null,
      stopped: this.stopped,
    };
  }
}
