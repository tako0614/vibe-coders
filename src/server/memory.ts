import {
  MemoryHost,
  type AtomRef,
  type AtomRevision,
  type AtomView,
  type Authorizer,
  type AuthContext,
  type Principal,
  type MemoryClient,
} from 'atom-memory';
import { SqliteStorage } from 'atom-memory/sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicWrite } from './config';
import type { Store } from './store';
import type { MessageBody } from '../shared/contracts';
import type {
  MemoryDetail,
  MemoryItem,
  MemorySource,
  MemoryUsage,
  MemoryWrite,
} from '../shared/memory';

export class MemoryService {
  readonly storage: SqliteStorage;
  readonly host: MemoryHost;
  readonly binding;
  readonly client;
  readonly human;
  readonly input;
  organizing = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    path: string,
    readonly store?: Store,
    readonly redact = (text: string) => text,
  ) {
    this.storage = new SqliteStorage(path);
    const authorityPath = `${path}.authority.json`;
    if (!existsSync(authorityPath))
      atomicWrite(
        authorityPath,
        JSON.stringify({
          authorizationHandle: crypto.randomUUID(),
          generation: crypto.randomUUID(),
        }),
      );
    const stored = JSON.parse(readFileSync(authorityPath, 'utf8')) as {
      authorizationHandle: string;
      generation: string;
    };
    if (!stored.authorizationHandle || !stored.generation)
      throw new Error('Invalid Atom authority file.');
    const auth: AuthContext = { authorizationHandle: stored.authorizationHandle };
    const principal: Principal = {
      subject: 'vibe-coder',
      readPolicies: ['home'],
      writePolicies: ['home'],
      canIngestSource: true,
      generation: stored.generation,
    };
    const authority: Authorizer = {
      resolve(candidate) {
        if (candidate.authorizationHandle !== auth.authorizationHandle)
          throw new Error('Atom authorization denied.');
        return principal;
      },
    };
    this.binding = { auth, writePolicy: 'home', actor: { type: 'agent' as const } };
    this.host = new MemoryHost({ authority, storage: this.storage, retrieval: { depth: 2 } });
    this.client = this.host.connect(this.binding);
    this.human = this.host.connect({ ...this.binding, actor: { type: 'human' } });
    this.input = this.host.connect({ ...this.binding, actor: { type: 'input-adapter' } });
  }
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => {});
    return next;
  }
  private summary(r: AtomRevision): MemoryItem {
    const ref = this.host.reference(
      { kind: 'pinned', atomId: r.atomId, revisionId: r.revisionId },
      this.binding,
    );
    const text = this.redact(
      r.body.kind === 'inline'
        ? typeof r.body.value === 'string'
          ? r.body.value
          : JSON.stringify(r.body.value)
        : '[添付資料]',
    );
    const item: MemoryItem = {
      id: r.atomId,
      ref,
      revisionId: r.revisionId,
      title:
        text
          .split('\n')
          .find((s) => s.trim())
          ?.slice(0, 100) || '無題の記憶',
      preview: text.slice(0, 240),
      origin: r.provenance.kind,
      state: r.state,
      updatedAt: r.recordedAt,
      links: r.slots.length,
      sources: r.origins.length,
      capturedSource: this.storage.metaGet<MemorySource>(`vibe:source:${r.atomId}`),
    };
    if (!this.storage.metaGet(`vibe:ref:${ref}`))
      this.storage.metaSet(`vibe:ref:${ref}`, { id: r.atomId, revisionId: r.revisionId });
    return item;
  }
  // Materialize only catalog metadata from the public revision feed. Atom remains
  // authoritative for bodies, authorization, revisions and relationships.
  sync() {
    let position = this.storage.metaGet<{ sequence: number; revisionId: string }>(
      'vibe:catalog-position',
    ) || { sequence: 0, revisionId: '' };
    const at = this.storage.watermark();
    for (;;) {
      const changes = this.storage.changes(['home'], position, 100, at);
      if (!changes.length) break;
      this.storage.transaction(() => {
        for (const change of changes) {
          const item = this.summary(change.revision);
          this.storage.metaSet(`vibe:atom:${item.id}`, item);
        }
        const last = changes.at(-1)!;
        position = { sequence: last.sequence, revisionId: last.revision.revisionId };
        this.storage.metaSet('vibe:catalog-position', position);
      });
    }
  }
  identity(ref: string) {
    this.sync();
    const value = this.storage.metaGet<{ id: string; revisionId: string }>(`vibe:ref:${ref}`);
    if (!value) throw new Error('記憶の参照が見つかりません。再取得してください。');
    return value;
  }
  revision(id: string, revisionId?: string) {
    const r = this.storage.get(
      revisionId ? { kind: 'pinned', atomId: id, revisionId } : { kind: 'logical', atomId: id },
      this.storage.watermark(),
    );
    if (!r || r.policyId !== 'home' || this.storage.isPurged(id))
      throw new Error('記憶が見つかりません。');
    return r;
  }
  item(ref: string) {
    const value = this.identity(ref);
    return this.summary(this.revision(value.id, value.revisionId));
  }
  catalog() {
    this.sync();
    return this.storage
      .metaEntries<MemoryItem>('vibe:atom:')
      .map(([, item]) => ({
        ...item,
        capturedSource: this.storage.metaGet<MemorySource>(`vibe:source:${item.id}`),
      }))
      .filter((item) => !this.storage.isPurged(item.id));
  }
  async list(query = '', kind = 'memories', cursor?: string) {
    const catalog = this.catalog();
    const active = catalog.filter((item) => item.state === 'active');
    let items: MemoryItem[],
      next: string | undefined,
      partial = false;
    const matchesKind = (item: MemoryItem) =>
      kind === 'retired'
        ? item.state === 'retired'
        : item.state === 'active' &&
          (kind === 'sources' ? !!item.capturedSource : !item.capturedSource);
    if (query.trim() && kind !== 'retired') {
      const result = await this.human.search(query, { limit: 30, cursor, depth: 2 });
      items = result.items.map((item) => this.item(item.ref)).filter(matchesKind);
      next = result.cursor;
      partial = result.diagnostics.traversal === 'partial';
    } else {
      const all = catalog
        .filter(matchesKind)
        .filter(
          (item) =>
            !query.trim() ||
            JSON.stringify(this.revision(item.id).body)
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase()),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      const [at, id] = cursor ? Buffer.from(cursor, 'base64url').toString().split('\0') : [];
      if (cursor && (!at || !id || !Number.isFinite(Date.parse(at))))
        throw new Error('一覧を再取得してください。');
      const remaining = at
        ? all.filter((item) => item.updatedAt < at || (item.updatedAt === at && item.id > id!))
        : all;
      items = remaining.slice(0, 30);
      if (remaining.length > 30) {
        const last = items.at(-1)!;
        next = Buffer.from(`${last.updatedAt}\0${last.id}`).toString('base64url');
      }
    }
    return {
      items,
      cursor: next,
      total: active.filter((item) => !item.capturedSource).length,
      sourceCount: active.filter((item) => item.capturedSource).length,
      linkCount: active.reduce((sum, item) => sum + item.links, 0),
      partial,
    };
  }
  async detail(id: string, revisionId?: string, historyCursor?: string): Promise<MemoryDetail> {
    this.sync();
    const r = this.revision(id, revisionId),
      item = this.summary(r);
    const inspection = await this.human.inspect(item.ref as AtomRef, {
      version: 'observed',
      depth: 0,
    });
    const related = (ref: string) => {
      try {
        return { item: this.item(ref) };
      } catch {
        return { unavailable: true as const };
      }
    };
    const history: MemoryItem[] = [];
    let previous: AtomRevision | undefined = this.revision(id, historyCursor);
    for (let i = 0; previous && i < 20; i++) {
      history.push(this.summary(previous));
      previous = previous.previousRevisionId
        ? this.revision(id, previous.previousRevisionId)
        : undefined;
    }
    const incoming = this.storage
      .scan(
        { policies: ['home'], relation: { target: { kind: 'logical', atomId: id } }, limit: 30 },
        this.storage.watermark(),
      )
      .map((r) => this.summary(r));
    return {
      item,
      text: this.redact(inspection.atom.text),
      latestRevisionId: this.revision(id).revisionId,
      links: inspection.atom.links.map((link) => ({ role: link.role, ...related(link.ref) })),
      incoming,
      sources: inspection.atom.sources.map((source) => related(source.ref)),
      history,
      historyCursor: previous?.revisionId,
      usedIn: this.storage.metaGet<MemoryUsage[]>(`vibe:uses:${id}`) || [],
      stale: inspection.stale.includes(item.ref as AtomRef),
    };
  }
  async capture(conversationId: string, messageId: string): Promise<MemoryItem> {
    if (!this.store) throw new Error('Conversation storage unavailable.');
    const message = this.store.history(conversationId).find((message) => message.id === messageId);
    if (!message || message.body.role === 'system' || !message.body.content.trim())
      throw new Error('出典にできる発言がありません。');
    const text = this.redact(message.body.content);
    const truncated = Buffer.byteLength(text) > 6000;
    const excerpt = Buffer.from(text)
      .subarray(0, 6000)
      .toString('utf8')
      .replace(/\uFFFD$/, '');
    const role = message.body.role;
    const body = `${role === 'user' ? 'ユーザーの発言' : role === 'assistant' ? 'アシスタントの発言（未検証）' : 'ツールの観測結果'}\n${excerpt}`;
    const digest = createHash('sha256').update(body).digest('hex');
    const result = await this.input.write(body, {
      idempotencyKey: `vibe:message:${message.id}:${digest}`,
    });
    const identity = this.identity(result.ref);
    this.storage.metaSet(`vibe:source:${identity.id}`, {
      conversationId,
      messageId,
      title: this.store.conversation(conversationId).title,
      role,
      createdAt: message.createdAt,
      truncated,
    } satisfies MemorySource);
    this.storage.flush();
    return this.item(result.ref);
  }
  async write(
    input: MemoryWrite,
    options: {
      actor?: 'human' | 'agent';
      ref?: string;
      idempotencyKey?: string;
      client?: MemoryClient;
    } = {},
  ) {
    const client = options.client || (options.actor === 'human' ? this.human : this.client);
    const content = {
      text: this.redact(input.text),
      links: input.links.map((link) => ({
        role: link.role,
        target: { ref: link.ref as AtomRef, at: 'logical' as const },
      })),
    };
    const sources = input.sources.map((ref) => ({ ref: ref as AtomRef }));
    let result: AtomView;
    if (options.ref) {
      const identity = this.identity(options.ref);
      if (this.revision(identity.id).revisionId !== identity.revisionId)
        throw new Error('記憶が更新されています。最新の内容を開き直してください。');
      if (this.storage.metaGet(`vibe:source:${identity.id}`))
        throw new Error('会話の出典は変更できません。記憶として整理してください。');
      const changed = await client.edit((draft) =>
        draft.revise(options.ref as AtomRef, content, { sources }),
      );
      result = changed.changes[0]!;
    } else
      result = await client.write(content, { sources, idempotencyKey: options.idempotencyKey });
    this.sync();
    this.storage.flush();
    this.store?.notify();
    return result;
  }
  async retire(ref: string) {
    const id = this.identity(ref);
    if (this.revision(id.id).revisionId !== id.revisionId)
      throw new Error('記憶が更新されています。開き直してください。');
    await this.human.edit((draft) => draft.retire(ref as AtomRef));
    this.sync();
    this.storage.flush();
    this.store?.notify();
  }
  recall(context: string, tokens: number) {
    return this.client.read(
      { context: context || 'Current repository work' },
      { tokens, depth: 2 },
    );
  }
  delivered(history: MessageBody[]) {
    const memoryCalls = new Set(
      history.flatMap((m) =>
        (m.toolCalls || [])
          .filter((t) => ['memory_search', 'memory_inspect'].includes(t.name))
          .map((t) => t.id),
      ),
    );
    const refs: AtomRef[] = [];
    for (const message of history) {
      if (message.role !== 'tool' || !memoryCalls.has(message.toolCallId || '')) continue;
      try {
        const value = JSON.parse(message.content);
        for (const atom of [...(value.items || []), ...(value.atom ? [value.atom] : [])])
          if (atom.ref && atom.text) refs.push(atom.ref);
      } catch {
        /* Only structured memory output is acknowledged. */
      }
    }
    return refs;
  }
  acknowledge(refs: readonly AtomRef[], eventId: string, conversationId?: string) {
    if (!refs.length) return [];
    this.host.recordUse(refs, this.binding, { eventId });
    const items = [...new Set(refs)].map((ref) => this.item(ref));
    if (conversationId)
      for (const item of items) {
        const key = `vibe:uses:${item.id}`,
          previous = this.storage.metaGet<MemoryUsage[]>(key) || [];
        if (!previous.some((use) => use.messageId === eventId))
          this.storage.metaSet(
            key,
            [
              { conversationId, messageId: eventId, at: Date.now(), revisionId: item.revisionId },
              ...previous,
            ].slice(0, 50),
          );
      }
    this.storage.flush();
    return items;
  }
  close() {
    this.storage.close();
  }
}
