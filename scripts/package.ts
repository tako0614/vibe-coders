import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const directory = resolve('dist/package');
const manifest = await Bun.file('package.json').json();
await rm(directory, { recursive: true, force: true });
await mkdir(join(directory, 'dist/server'), { recursive: true });
const build = await Bun.build({
  entrypoints: ['src/cli.ts'],
  outdir: join(directory, 'dist/server'),
  target: 'bun',
  external: ['node-pty'],
  packages: 'bundle',
  minify: false,
  sourcemap: 'external',
});
if (!build.success) throw new AggregateError(build.logs, 'Backend bundle failed.');
await cp('dist/web', join(directory, 'dist/web'), { recursive: true });
await cp('drizzle', join(directory, 'drizzle'), { recursive: true });
await cp('docs/package-readme.md', join(directory, 'README.md'));
await writeFile(
  join(directory, 'package.json'),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      repository: manifest.repository,
      homepage: manifest.homepage,
      bugs: manifest.bugs,
      description: 'Repository-based resident agent with shared terminals, memory and desktop.',
      type: 'module',
      bin: { [manifest.name]: './dist/server/cli.js' },
      engines: { bun: '>=1.3.14' },
      optionalDependencies: { 'node-pty': '1.1.0' },
      files: ['dist', 'drizzle', 'README.md', 'THIRD_PARTY_LICENSES.txt'],
    },
    null,
    2,
  ),
);
const notices: string[] = [];
for await (const path of new Bun.Glob(
  '**/{LICENSE,LICENSE.md,LICENSE.txt,license,license.md,license.txt,OFL.txt}',
).scan({ cwd: 'node_modules', onlyFiles: true })) {
  if (path.includes('/node_modules/')) continue;
  const file = Bun.file(join('node_modules', path));
  if (file.size <= 100000) notices.push(`\n--- ${path} ---\n${await file.text()}`);
}
await writeFile(join(directory, 'THIRD_PARTY_LICENSES.txt'), notices.join('\n'));
console.log(`Distribution prepared in ${directory}.`);
