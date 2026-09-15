import { and, eq, lt, inArray, max, like, or } from 'drizzle-orm';
import { conversations, messages, runs, requests, events, schedules, state } from './db/schema';
import { Store } from './store';
import { Config } from './config';
import { retentionSchema } from '../shared/contracts';

export function prune(store: Store, config: Config, now = Date.now()) {
  const policy = retentionSchema.parse(config.read().retention || {}),
    day = 86400000;
  const counts = { conversations: 0, runs: 0, images: 0 };
  store.db.transaction(() => {
    for (const c of store.listConversations()) {
      // Keep every active conversation and any outstanding human/execution obligation.
      const active =
        ['running', 'waiting'].includes(c.state) ||
        store.db
          .select()
          .from(runs)
          .where(and(eq(runs.conversationId, c.id), inArray(runs.state, ['running', 'stopping'])))
          .get() ||
        store.db
          .select()
          .from(requests)
          .where(
            and(
              eq(requests.conversationId, c.id),
              inArray(requests.state, ['pending', 'processing']),
            ),
          )
          .get() ||
        store.db
          .select()
          .from(schedules)
          .where(and(eq(schedules.conversationId, c.id), eq(schedules.enabled, true)))
          .get() ||
        store.inbox(c.id).length;
      if (active) continue;
      const last =
        store.db
          .select({ at: max(messages.createdAt) })
          .from(messages)
          .where(eq(messages.conversationId, c.id))
          .get()?.at || c.createdAt;
      if (
        policy.conversationDays &&
        last < now - policy.conversationDays * day &&
        store.listConversations().length > 1
      ) {
        for (const table of [events, messages, requests, runs, schedules])
          store.db.delete(table).where(eq(table.conversationId, c.id)).run();
        store.db.delete(conversations).where(eq(conversations.id, c.id)).run();
        counts.conversations++;
        continue;
      }
      if (policy.runDays)
        counts.runs += store.db
          .delete(runs)
          .where(and(eq(runs.conversationId, c.id), lt(runs.endedAt, now - policy.runDays * day)))
          .returning()
          .all().length;
      if (policy.imageDays)
        for (const row of store.db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, c.id),
              lt(messages.createdAt, now - policy.imageDays * day),
            ),
          )
          .all()) {
          if (!row.body.images?.length) continue;
          const { images, ...body } = row.body;
          store.db
            .update(messages)
            .set({
              body: { ...body, content: `${body.content}\n[Images removed by retention policy.]` },
            })
            .where(eq(messages.id, row.id))
            .run();
          counts.images += images.length;
        }
    }
    for (const row of store.db
      .select()
      .from(state)
      .where(
        or(
          like(state.key, 'context:%'),
          like(state.key, 'native-input:%'),
          like(state.key, 'mcp-install:%'),
        ),
      )
      .all()) {
      const exists = row.key.startsWith('context:')
        ? store.db
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.id, row.key.slice(8)))
            .get()
        : store.db
            .select({ id: runs.id })
            .from(runs)
            .where(
              eq(
                runs.id,
                row.key.startsWith('native-input:')
                  ? row.key.split(':')[1]
                  : (row.value as { runId: string }).runId,
              ),
            )
            .get();
      if (!exists) store.db.delete(state).where(eq(state.key, row.key)).run();
    }
    store.db
      .insert(state)
      .values({ key: 'lastPrune', value: { at: now, counts } })
      .onConflictDoUpdate({ target: state.key, set: { value: { at: now, counts } } })
      .run();
  });
  store.notify();
  return counts;
}
