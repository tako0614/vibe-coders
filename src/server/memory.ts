import {
  MemoryHost,
  type AtomRef,
  type Authorizer,
  type AuthContext,
  type Principal,
} from 'atom-memory';
import { SqliteStorage } from 'atom-memory/sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWrite } from './config';

export class MemoryService {
  readonly storage: SqliteStorage;
  readonly host: MemoryHost;
  readonly binding;
  readonly client;
  readonly human;
  constructor(path: string) {
    this.storage = new SqliteStorage(path);
    // References bind to an authorization handle. Persist the host capability and
    // policy generation so references in durable history survive backend restarts.
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
    // Stable storage identity across the public rename to Vibe Coders.
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
    this.host = new MemoryHost({ authority, storage: this.storage });
    this.client = this.host.connect(this.binding);
    this.human = this.host.connect({ ...this.binding, actor: { type: 'human' } });
  }
  recall(context: string, tokens: number) {
    return this.client.read({ context: context || 'Current repository work' }, { tokens });
  }
  acknowledge(refs: readonly AtomRef[], eventId: string) {
    this.host.recordUse(refs, this.binding, { eventId });
    this.storage.flush();
  }
  close() {
    this.storage.close();
  }
}
