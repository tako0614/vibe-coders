import { integer, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import type { HumanSpec, MessageBody, WaitCondition } from '../../shared/contracts';

export const conversations = sqliteTable('conversations', {
  id: text().primaryKey(),
  title: text().notNull(),
  createdAt: integer().notNull(),
  paused: integer({ mode: 'boolean' }).notNull().default(false),
  state: text({ enum: ['idle', 'running', 'waiting', 'paused', 'error'] })
    .notNull()
    .default('idle'),
  wait: text({ mode: 'json' }).$type<{ reason: string; wakeOn: WaitCondition[] }>(),
});
export const messages = sqliteTable(
  'messages',
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    id: text().notNull().unique(),
    conversationId: text()
      .notNull()
      .references(() => conversations.id),
    body: text({ mode: 'json' }).$type<MessageBody>().notNull(),
    createdAt: integer().notNull(),
  },
  (t) => [index('messages_conversation').on(t.conversationId, t.seq)],
);
export const events = sqliteTable(
  'events',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    conversationId: text()
      .notNull()
      .references(() => conversations.id),
    type: text().notNull(),
    key: text().notNull().unique(),
    payload: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    consumed: integer({ mode: 'boolean' }).notNull().default(false),
    createdAt: integer().notNull(),
  },
  (t) => [index('events_inbox').on(t.conversationId, t.consumed, t.id)],
);
export const requests = sqliteTable(
  'human_requests',
  {
    id: text().primaryKey(),
    conversationId: text()
      .notNull()
      .references(() => conversations.id),
    spec: text({ mode: 'json' }).$type<HumanSpec>().notNull(),
    dedupeKey: text(),
    targetVersion: integer(),
    state: text({ enum: ['pending', 'processing', 'resolved', 'cancelled', 'expired'] })
      .notNull()
      .default('pending'),
    revision: integer().notNull().default(1),
    operationId: text(),
    result: text({ mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (t) => [uniqueIndex('request_dedupe').on(t.conversationId, t.dedupeKey)],
);
export const runs = sqliteTable('runs', {
  id: text().primaryKey(),
  conversationId: text()
    .notNull()
    .references(() => conversations.id),
  kind: text({ enum: ['shell', 'terminal', 'mcp', 'native'] }).notNull(),
  title: text().notNull(),
  cwd: text().notNull(),
  host: text().notNull(),
  state: text({ enum: ['running', 'stopping', 'completed', 'failed', 'interrupted'] }).notNull(),
  exitCode: integer(),
  output: text().notNull().default(''),
  outputOffset: integer().notNull().default(0),
  result: text({ mode: 'json' }).$type<Record<string, unknown>>(),
  owner: text({ enum: ['agent', 'human'] })
    .notNull()
    .default('agent'),
  epoch: integer().notNull().default(0),
  createdAt: integer().notNull(),
  endedAt: integer(),
});
export const schedules = sqliteTable('schedules', {
  id: text().primaryKey(),
  conversationId: text()
    .notNull()
    .references(() => conversations.id),
  title: text().notNull(),
  prompt: text().notNull(),
  action: text({ enum: ['prompt', 'shell'] })
    .notNull()
    .default('prompt'),
  nextAt: integer().notNull(),
  intervalMs: integer(),
  enabled: integer({ mode: 'boolean' }).notNull(),
  timeZone: text().notNull(),
  source: text({ enum: ['local', 'repo'] })
    .notNull()
    .default('local'),
  lastAt: integer(),
  lastOutcome: text(),
  trigger: text({ mode: 'json' }).$type<{
    event: 'run.completed' | 'human.resolved' | 'user.message';
    runId?: string;
    requestId?: string;
    repeat: boolean;
  }>(),
  eventCursor: integer().notNull().default(0),
  createdAt: integer().notNull(),
});
export const state = sqliteTable('state', {
  key: text().primaryKey(),
  value: text({ mode: 'json' }).$type<unknown>().notNull(),
});
export type Conversation = typeof conversations.$inferSelect;
export type HumanRequest = typeof requests.$inferSelect;
export type Run = typeof runs.$inferSelect;
