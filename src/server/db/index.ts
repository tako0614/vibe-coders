import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { join } from 'node:path';
import { packageRoot } from '../config';
import * as schema from './schema';

export function openDatabase(path: string) {
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec(
    'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;',
  );
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: join(packageRoot, 'drizzle') });
  return { db, sqlite };
}
export type DB = ReturnType<typeof openDatabase>['db'];
