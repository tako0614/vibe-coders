import { and, eq, lte, gt, asc, desc, isNull } from 'drizzle-orm';
import { scheduleSchema } from '../shared/contracts';
import { schedules, events } from './db/schema';
import { Store } from './store';
import { RunService } from './runs';

export class Scheduler {
  constructor(
    readonly store: Store,
    readonly runs: RunService,
  ) {}
  create(
    conversationId: string,
    input: unknown,
    id: string = crypto.randomUUID(),
    source: 'local' | 'repo' = 'local',
  ) {
    this.store.assertEnabled();
    this.store.conversation(conversationId);
    const spec = scheduleSchema.parse(input);
    const row = this.store.db
      .insert(schedules)
      .values({
        id,
        conversationId,
        ...spec,
        eventCursor: this.latestEvent(),
        source,
        createdAt: Date.now(),
      })
      .returning()
      .get();
    this.store.notify();
    return row;
  }
  update(id: string, input: unknown) {
    const current = this.get(id);
    if (current.source === 'repo') throw new Error('Edit shared routines in atom.toml.');
    const spec = scheduleSchema.parse(input);
    this.store.db
      .update(schedules)
      .set({
        ...spec,
        trigger: spec.trigger ?? null,
        eventCursor:
          JSON.stringify(current.trigger) !== JSON.stringify(spec.trigger ?? null)
            ? this.latestEvent()
            : current.eventCursor,
      })
      .where(eq(schedules.id, id))
      .run();
    this.store.notify();
    return this.get(id);
  }
  private latestEvent() {
    return (
      this.store.db.select({ id: events.id }).from(events).orderBy(desc(events.id)).limit(1).get()
        ?.id || 0
    );
  }
  get(id: string) {
    const row = this.store.db.select().from(schedules).where(eq(schedules.id, id)).get();
    if (!row) throw new Error('Schedule not found.');
    return row;
  }
  remove(id: string) {
    if (this.get(id).source === 'repo') throw new Error('Remove shared routines from atom.toml.');
    this.store.db.delete(schedules).where(eq(schedules.id, id)).run();
    this.store.notify();
  }
  fire(id: string, now = Date.now(), manual = false) {
    this.store.assertEnabled();
    const row = this.get(id);
    if (!manual && (!row.enabled || row.nextAt > now)) return;
    const key = manual ? `manual:${id}:${crypto.randomUUID()}` : `schedule:${id}:${row.nextAt}`;
    this.store.db.transaction(() => {
      if (!manual)
        this.store.db
          .update(schedules)
          .set({
            enabled: row.intervalMs !== null,
            nextAt: row.intervalMs ? now + row.intervalMs : row.nextAt,
            lastAt: now,
            lastOutcome: 'dispatched',
          })
          .where(eq(schedules.id, id))
          .run();
      else
        this.store.db
          .update(schedules)
          .set({ lastAt: now, lastOutcome: 'dispatched' })
          .where(eq(schedules.id, id))
          .run();
      this.store.event(
        row.conversationId,
        'schedule.fired',
        {
          scheduleId: id,
          title: row.title,
          action: row.action,
          prompt: row.prompt,
          timeZone: row.timeZone,
          missedPolicy: 'coalesce',
        },
        key,
      );
    });
    if (row.action === 'shell') this.runs.shell(row.conversationId, row.prompt);
    this.store.notify();
  }
  tick(now = Date.now()) {
    if (this.store.stopped) return;
    for (const row of this.store.db
      .select()
      .from(schedules)
      .where(
        and(eq(schedules.enabled, true), isNull(schedules.trigger), lte(schedules.nextAt, now)),
      )
      .all())
      this.fire(row.id, now);
    for (const row of this.store.db
      .select()
      .from(schedules)
      .where(eq(schedules.enabled, true))
      .all()) {
      if (!row.trigger) continue;
      const batch = this.store.db
        .select()
        .from(events)
        .where(and(eq(events.conversationId, row.conversationId), gt(events.id, row.eventCursor)))
        .orderBy(asc(events.id))
        .limit(100)
        .all();
      for (const event of batch) {
        const t = row.trigger;
        const matches =
          event.type === t.event &&
          (!t.runId || event.payload.runId === t.runId) &&
          (!t.requestId || event.payload.requestId === t.requestId);
        this.store.db.transaction(() => {
          this.store.db
            .update(schedules)
            .set({
              eventCursor: event.id,
              ...(matches ? { enabled: t.repeat, lastAt: now, lastOutcome: 'dispatched' } : {}),
            })
            .where(eq(schedules.id, row.id))
            .run();
          if (matches)
            this.store.event(
              row.conversationId,
              'schedule.fired',
              {
                scheduleId: row.id,
                title: row.title,
                prompt: row.prompt,
                action: row.action,
                triggerEventId: event.id,
                trigger: event.type,
              },
              `schedule:${row.id}:event:${event.id}`,
            );
        });
        if (matches) {
          if (row.action === 'shell') this.runs.shell(row.conversationId, row.prompt);
          this.store.notify();
          if (!t.repeat) break;
        }
      }
    }
  }
}
