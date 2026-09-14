import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export class Files {
  constructor(readonly home: string) {}
  path(path: string) {
    return resolve(this.home, path);
  }
  async list(path = '.') {
    return {
      path: this.path(path),
      entries: (await readdir(this.path(path), { withFileTypes: true }))
        .slice(0, 1000)
        .map((f) => ({
          name: f.name,
          kind: f.isDirectory() ? 'directory' : f.isSymbolicLink() ? 'symlink' : 'file',
        })),
    };
  }
  async read(path: string, startLine = 1, limit = 200) {
    const full = this.path(path);
    if ((await stat(full)).size > 2 * 1024 * 1024)
      throw new Error(
        'File exceeds the 2 MiB text-read limit. Use shell for bounded binary/large-file inspection.',
      );
    const text = await readFile(full, 'utf8'),
      lines = text.split('\n');
    return {
      path: full,
      sha256: digest(text),
      totalLines: lines.length,
      startLine,
      text: lines.slice(startLine - 1, startLine - 1 + limit).join('\n'),
      nextLine: startLine + limit <= lines.length ? startLine + limit : null,
    };
  }
  async write(input: unknown) {
    const { path, content, expectedSha256 } = z
      .object({
        path: z.string(),
        content: z.string().max(2 * 1024 * 1024),
        expectedSha256: z.string().nullable(),
      })
      .parse(input);
    const full = this.path(path);
    let before: string | null = null;
    try {
      before = await readFile(full, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (before === null ? expectedSha256 !== null : digest(before) !== expectedSha256)
      throw new Error(
        'File changed. Read it and use its current SHA256. null is only for a new file.',
      );
    await mkdir(dirname(full), { recursive: true });
    // Create is exclusive. Existing content is rechecked immediately before replacement.
    if (before === null) await writeFile(full, content, { flag: 'wx' });
    else {
      if (digest(await readFile(full, 'utf8')) !== expectedSha256)
        throw new Error('File changed during edit.');
      await writeFile(full, content);
    }
    return { path: full, sha256: digest(content), before, after: content };
  }
  async replace(path: string, oldText: string, newText: string) {
    if (!oldText) throw new Error('An exact nonempty match is required.');
    const current = await this.read(path, 1, Number.MAX_SAFE_INTEGER);
    if (current.text.split(oldText).length !== 2)
      throw new Error('Expected exactly one match; no changes applied.');
    return this.write({
      path,
      content: current.text.replace(oldText, newText),
      expectedSha256: current.sha256,
    });
  }
  async glob(pattern: string) {
    const matches: string[] = [];
    for await (const path of new Bun.Glob(pattern).scan({
      cwd: this.home,
      onlyFiles: true,
      dot: false,
    })) {
      matches.push(path);
      if (matches.length >= 1000) return { matches, truncated: true };
    }
    return { matches, truncated: false };
  }
}
