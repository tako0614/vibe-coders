import { createHash } from 'node:crypto';
import {
  readFile,
  readdir,
  lstat,
  mkdir,
  unlink,
  rename,
  writeFile,
  realpath,
} from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative, dirname, join, isAbsolute } from 'node:path';
import { atomicWrite } from './config';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
type Entry = { hash: string; mode: number };
type Baseline = {
  id: string;
  createdAt: number;
  entries: Record<string, Entry>;
  skipped: string[];
};
const excluded = new Set([
  '.git',
  'node_modules',
  '.next',
  '.cache',
  'dist',
  'build',
  'coverage',
  '.venv',
  'vendor',
]);
export class WorkspaceChanges {
  readonly directory: string;
  readonly ready: Promise<void>;
  private baseline!: Baseline;
  private queue = Promise.resolve();
  constructor(
    readonly home: string,
    directory: string,
  ) {
    this.directory = join(directory, 'changes');
    this.ready = this.initialize();
  }
  private async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true, mode: 0o700 });
    const manifest = join(this.directory, 'baseline.json');
    if (existsSync(manifest)) this.baseline = JSON.parse(readFileSync(manifest, 'utf8'));
    else {
      const current = await this.scan(true);
      this.baseline = { id: crypto.randomUUID(), createdAt: Date.now(), ...current };
      atomicWrite(manifest, JSON.stringify(this.baseline));
    }
  }
  private async scan(save = false) {
    const entries: Record<string, Entry> = {},
      skipped: string[] = [];
    let bytes = 0,
      count = 0;
    // Respect .gitignore without executing hooks or changing the index.
    let candidates: string[] | undefined;
    if (Bun.which('git')) {
      const p = Bun.spawn(
        ['git', '-C', this.home, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { stdout: 'pipe', stderr: 'ignore' },
      );
      const output = await new Response(p.stdout).text();
      if ((await p.exited) === 0) candidates = [...new Set(output.split('\0').filter(Boolean))];
    }
    if (!candidates) {
      candidates = [];
      const walk = async (path: string) => {
        for (const item of await readdir(join(this.home, path), { withFileTypes: true })) {
          if (excluded.has(item.name)) continue;
          const name = path ? `${path}/${item.name}` : item.name;
          if (item.isDirectory()) await walk(name);
          else if (item.isFile()) candidates!.push(name);
          else skipped.push(name);
          if (candidates!.length >= 10000) {
            skipped.push(`${path || '.'}: scan limit`);
            return;
          }
        }
      };
      await walk('');
    }
    for (const path of candidates.sort()) {
      if (path.split('/').some((p) => excluded.has(p))) continue;
      try {
        const full = await this.path(path),
          stat = await lstat(full);
        if (
          !stat.isFile() ||
          stat.size > 2 * 1024 * 1024 ||
          bytes + stat.size > 32 * 1024 * 1024 ||
          count >= 5000
        ) {
          skipped.push(path);
          continue;
        }
        const buffer = await readFile(full);
        let text: string;
        try {
          if (buffer.includes(0)) throw new Error();
          text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        } catch {
          skipped.push(path);
          continue;
        }
        bytes += buffer.length;
        count++;
        const digest = hash(text);
        entries[path] = { hash: digest, mode: stat.mode & 0o777 };
        if (save && !existsSync(join(this.directory, 'objects', digest)))
          atomicWrite(join(this.directory, 'objects', digest), text);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') skipped.push(path);
      }
    }
    return { entries, skipped };
  }
  private async path(path: string) {
    const full = resolve(this.home, path),
      rel = relative(this.home, full);
    if (
      !rel ||
      isAbsolute(rel) ||
      rel === '..' ||
      rel.startsWith('../') ||
      rel.split(/[\\/]/).includes('.git')
    )
      throw new Error('作業フォルダ内の通常ファイルを指定してください。');
    // Check every existing ancestor; never traverse a symlink for an edit/restore.
    let current = this.home;
    for (const part of rel.split(/[\\/]/)) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error('シンボリックリンクは編集・復元できません。');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    const root = await realpath(this.home);
    if (root !== this.home) throw new Error('Workspace path changed.');
    return full;
  }
  async list() {
    await this.ready;
    const current = await this.scan();
    const skipped = new Set([...this.baseline.skipped, ...current.skipped]);
    const changes = [
      ...new Set([...Object.keys(this.baseline.entries), ...Object.keys(current.entries)]),
    ]
      .filter(
        (path) =>
          !skipped.has(path) && this.baseline.entries[path]?.hash !== current.entries[path]?.hash,
      )
      .map((path) => ({
        path,
        kind: !this.baseline.entries[path]
          ? 'added'
          : !current.entries[path]
            ? 'deleted'
            : 'modified',
        sha256: current.entries[path]?.hash || null,
      }));
    return {
      baseline: { id: this.baseline.id, createdAt: this.baseline.createdAt },
      changes,
      skipped: [...skipped],
    };
  }
  async detail(path: string) {
    await this.ready;
    const full = await this.path(path);
    const saved = this.baseline.entries[relative(this.home, full)];
    const before = saved
      ? await readFile(join(this.directory, 'objects', saved.hash), 'utf8')
      : null;
    let after: string | null = null;
    try {
      if ((await lstat(full)).size > 2 * 1024 * 1024)
        throw new Error('File exceeds the 2 MiB editor limit.');
      const data = await readFile(full);
      if (data.includes(0)) throw new Error('Binary files cannot be edited here.');
      after = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return {
      path: relative(this.home, full),
      before,
      after,
      sha256: after === null ? null : hash(after),
      baselineId: this.baseline.id,
      restorable: (await this.list()).changes.some((c) => c.path === relative(this.home, full)),
    };
  }
  private serial<T>(work: () => Promise<T>) {
    const result = this.queue.then(work);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  edit(path: string, content: string | null, expectedSha256: string | null) {
    return this.serial(async () => {
      await this.ready;
      const full = await this.path(path),
        current = await this.detail(path);
      if (current.sha256 !== expectedSha256)
        throw new Error('ファイルが変更されています。再読み込みしてから操作してください。');
      if (content !== null && Buffer.byteLength(content) > 2 * 1024 * 1024)
        throw new Error('File exceeds the 2 MiB editor limit.');
      if (content === null) {
        if (current.after !== null) await unlink(full);
      } else {
        await mkdir(dirname(full), { recursive: true });
        const mode = current.after === null ? 0o644 : (await lstat(full)).mode & 0o777;
        const temp = join(dirname(full), `.vibe-edit-${crypto.randomUUID()}`);
        try {
          await writeFile(temp, content, { flag: 'wx', mode });
          const check = await this.detail(path);
          if (check.sha256 !== expectedSha256)
            throw new Error('ファイルが変更されています。再読み込みしてください。');
          await this.path(path);
          if (current.after === null) {
            // Exclusive create avoids replacing a concurrently created file.
            await writeFile(full, content, { flag: 'wx', mode });
          } else await rename(temp, full);
        } finally {
          await unlink(temp).catch(() => {});
        }
      }
      return this.detail(path);
    });
  }
  async restore(path: string, expectedSha256: string | null, baselineId: string) {
    await this.ready;
    const current = await this.detail(path);
    if (!current.restorable || baselineId !== this.baseline.id)
      throw new Error('復元元が変更されたか、このファイルは保存対象外です。');
    return this.edit(path, current.before, expectedSha256);
  }
}
