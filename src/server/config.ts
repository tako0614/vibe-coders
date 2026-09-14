import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  chmodSync,
  realpathSync,
  linkSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  providerSchema,
  mcpSchema,
  desktopSchema,
  searchSchema,
  retentionSchema,
} from '../shared/contracts';

const hostSchema = z.object({
  version: z.literal(1),
  revision: z.number().int(),
  web: z
    .object({
      username: z.string(),
      passwordHash: z.string(),
      hostname: z.string().default('127.0.0.1'),
      port: z.number().default(3100),
      origin: z.url().optional(),
    })
    .optional(),
  provider: providerSchema.extend({ revision: z.number().int() }).optional(),
  mcp: z.array(mcpSchema.extend({ revision: z.number().int() })).default([]),
  desktop: desktopSchema.extend({ revision: z.number().int() }).optional(),
  search: searchSchema.extend({ revision: z.number().int() }).optional(),
  retention: retentionSchema.optional(),
});
export type HostConfig = z.infer<typeof hostSchema>;
export type McpConfig = HostConfig['mcp'][number];
// src/server in development and dist/server in the distributed bundle share this depth.
export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const repoSchema = z
  .object({
    version: z.literal(1),
    agent: z.object({ model: z.literal('main').default('main') }).default({ model: 'main' }),
    memory: z
      .object({
        engine: z.literal('atom-memory').default('atom-memory'),
        context_tokens: z.number().int().positive().default(6000),
      })
      .default({ engine: 'atom-memory', context_tokens: 6000 }),
    mcp: z.object({ use: z.array(z.string()).default([]) }).optional(),
    routines: z
      .array(
        z.object({
          id: z.string().min(1),
          every: z.string().regex(/^\d+(s|m|h|d)$/),
          action: z.enum(['prompt', 'shell']),
          text: z.string().min(1),
        }),
      )
      .default([]),
  })
  .strict();

export function atomicWrite(path: string, value: string | Uint8Array) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, value, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}
function withFileLock<T>(path: string, operation: () => T): T {
  const marker = `${path}.${randomBytes(12).toString('hex')}.owner`;
  // Publish an already complete owner record atomically; a killed writer cannot
  // leave the empty lock file produced by open-then-write protocols.
  writeFileSync(marker, String(process.pid), { flag: 'wx', mode: 0o600 });
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
      try {
        linkSync(marker, path);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const guard = `${path}.recovery`;
        try {
          mkdirSync(guard);
        } catch {
          throw new Error('Configuration lock recovery is in progress. Retry.');
        }
        try {
          if (!existsSync(path)) continue;
          const owner = Number(readFileSync(path, 'utf8'));
          if (!Number.isSafeInteger(owner) || owner <= 0)
            throw new Error('Legacy lock has no valid owner. Inspect it before manual recovery.');
          let dead = false;
          try {
            process.kill(owner, 0);
          } catch (check) {
            dead = (check as NodeJS.ErrnoException).code === 'ESRCH';
          }
          if (!dead)
            throw new Error(`Configuration is locked by process ${owner}. Retry after reloading.`);
          unlinkSync(path);
        } finally {
          rmdirSync(guard);
        }
      }
    }
    if (!acquired) throw new Error('Configuration lock could not be acquired. Retry.');
    return operation();
  } finally {
    if (acquired && existsSync(path) && statSync(path).ino === statSync(marker).ino)
      unlinkSync(path);
    unlinkSync(marker);
  }
}
export class Config {
  readonly directory: string;
  readonly path: string;
  constructor(
    directory = process.env.VIBE_CODER_CONFIG_DIR ||
      join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'vibe-coder'),
  ) {
    this.directory = resolve(directory);
    this.path = join(this.directory, 'config.json');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  read(): HostConfig {
    return existsSync(this.path)
      ? hostSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      : { version: 1, revision: 0, mcp: [] };
  }
  update(expected: number, fn: (config: HostConfig) => void) {
    return this.lock(() => {
      const config = this.read();
      if (config.revision !== expected)
        throw new Error('Configuration changed. Reload before saving.');
      fn(config);
      config.revision++;
      atomicWrite(this.path, JSON.stringify(hostSchema.parse(config), null, 2));
      return config;
    });
  }
  lock<T>(operation: () => T) {
    return withFileLock(`${this.path}.lock`, operation);
  }
  targetVersion(id: string) {
    const c = this.read();
    if (id === 'provider:main') return c.provider?.revision;
    if (id === 'desktop') return c.desktop?.revision;
    if (id === 'search') return c.search?.revision;
    if (id.startsWith('mcp:')) return c.mcp.find((m) => m.name === id.slice(4))?.revision;
    return undefined;
  }
  public() {
    const c = this.read();
    return {
      revision: c.revision,
      provider: c.provider,
      mcp: c.mcp,
      desktop: c.desktop,
      search: c.search,
      retention: c.retention,
      username: c.web?.username,
    };
  }
}

// Separate from conversation/Atom databases. Encryption prevents accidental plaintext
// persistence; the same OS user can access both this key and the encrypted store.
export class Vault {
  private key: Buffer;
  private path: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = join(directory, 'vault.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    chmodSync(keyPath, 0o600);
    this.key = readFileSync(keyPath);
    this.path = join(directory, 'vault.enc');
  }
  private read(): Record<string, { value: string; version: number; operationId: string }> {
    if (!existsSync(this.path)) return {};
    const data = readFileSync(this.path),
      decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(),
    );
  }
  put(target: string, version: number, operationId: string, value: string) {
    withFileLock(`${this.path}.lock`, () => {
      const records = this.read();
      records[target] = { value, version, operationId };
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', this.key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(records)), cipher.final()]);
      atomicWrite(this.path, Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
    });
  }
  get(target: string, version: number) {
    const r = this.read()[target];
    return r?.version === version ? r.value : undefined;
  }
  saved(target: string, version: number, operationId: string) {
    const r = this.read()[target];
    return r?.version === version && r.operationId === operationId;
  }
  longestSecret() {
    return Math.max(1, ...this.secretValues().map((value) => JSON.stringify(value).length - 2));
  }
  private secretValues() {
    const values: string[] = [];
    const add = (value: unknown, key = '') => {
      if (
        typeof value === 'string' &&
        /^(access_token|refresh_token|id_token|client_secret|verifier)$/.test(key)
      )
        values.push(value);
      else if (value && typeof value === 'object')
        Object.entries(value).forEach(([k, v]) => add(v, k));
    };
    for (const r of Object.values(this.read())) {
      try {
        const parsed = JSON.parse(r.value);
        if (parsed && typeof parsed === 'object') add(parsed);
        else values.push(r.value);
      } catch {
        values.push(r.value);
      }
    }
    return values.filter(Boolean).sort((a, b) => b.length - a.length);
  }
  redact(value: string) {
    for (const secret of this.secretValues()) {
      const encoded = JSON.stringify(secret).slice(1, -1);
      value = value.replaceAll(encoded, '[REDACTED]').replaceAll(secret, '[REDACTED]');
    }
    return value;
  }
}

export function loadHome(path: string) {
  const home = realpathSync(resolve(path));
  if (!existsSync(join(home, 'atom.toml')) || !existsSync(join(home, 'AGENT.md')))
    throw new Error('Run `vibe-coders init` in this repository first.');
  return {
    home,
    repo: repoSchema.parse(Bun.TOML.parse(readFileSync(join(home, 'atom.toml'), 'utf8'))),
  };
}
export function stateDirectory(home: string) {
  const root =
    process.env.VIBE_CODER_DATA_DIR ||
    join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'vibe-coder');
  const path = join(root, createHash('sha256').update(home).digest('hex').slice(0, 24));
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
export function initHome(home: string) {
  mkdirSync(home, { recursive: true });
  const files = {
    'atom.toml':
      'version = 1\n\n[agent]\nmodel = "main"\n\n[memory]\nengine = "atom-memory"\ncontext_tokens = 6000\n',
    'AGENT.md':
      'このリポジトリで作業するエージェントです。\nユーザーの目的、現在の観測、利用可能な道具から次の行動を判断してください。\n',
  };
  for (const [name, body] of Object.entries(files))
    if (!existsSync(join(home, name))) writeFileSync(join(home, name), body, { flag: 'wx' });
}
