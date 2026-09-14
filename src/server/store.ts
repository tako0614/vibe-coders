import { and, asc, desc, eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import type { DB } from './db';
import * as s from './db/schema';
import type { MessageBody } from '../shared/contracts';

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
  snapshot(id: string) {
    return {
      conversation: this.conversation(id),
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
              : null,
        })),
      schedules: this.db.select().from(s.schedules).where(eq(s.schedules.conversationId, id)).all(),
      stopped: this.stopped,
    };
  }
}
