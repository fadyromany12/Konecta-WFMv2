import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database as Db, RunResult } from './driver.js';

/**
 * The SQLite driver.
 *
 * Kept as the default because it needs nothing standing up: clone, seed, run.
 * Every call here is really synchronous and simply returns a resolved promise,
 * so the calling code is identical to the Postgres build.
 */

/**
 * better-sqlite3 normally finds its compiled addon through `bindings`, which
 * searches at runtime relative to the calling module. A bundler moves the
 * calling module, so that search can fail in a serverless bundle even when the
 * binary was shipped. We try the normal path first and only fall back to
 * naming the binary outright, which keeps local development untouched.
 */
function openDatabase(file: string): Database.Database {
  try {
    return new Database(file);
  } catch (err) {
    const binding = findNativeBinding();
    if (!binding) throw err;
    console.log(`better-sqlite3: using explicitly located native binding at ${binding}`);
    return new Database(file, { nativeBinding: binding });
  }
}

function findNativeBinding(): string | null {
  const relative = join('node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  const candidates = [
    join(process.cwd(), relative),
    join('/var/task', relative), // the serverless bundle root
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function createSqliteDatabase(file: string): Db & { isMemory: boolean } {
  const isMemory = file === ':memory:';
  if (!isMemory) mkdirSync(dirname(file), { recursive: true });

  const db = openDatabase(file);
  // WAL is a file-mode concern; an in-memory database neither needs nor accepts it.
  if (!isMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Depth rather than a boolean, so a service that opens a transaction inside
  // another service's transaction does not commit the outer one early.
  let depth = 0;

  return {
    dialect: 'sqlite',
    isMemory,

    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as any[])) as T[];
    },

    async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
      return db.prepare(sql).get(...(params as any[])) as T | undefined;
    },

    async run(sql: string, params: unknown[] = []): Promise<RunResult> {
      const info = db.prepare(sql).run(...(params as any[]));
      return { changes: info.changes };
    },

    async insert(sql: string, params: unknown[] = []): Promise<number> {
      const info = db.prepare(sql).run(...(params as any[]));
      return Number(info.lastInsertRowid);
    },

    async exec(sql: string): Promise<void> {
      db.exec(sql);
    },

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (depth > 0) return fn();
      // better-sqlite3's own `transaction()` wrapper cannot be used: it refuses
      // to return a promise, because it cannot keep the transaction coherent
      // across an await. Here the awaits inside resolve immediately — nothing
      // else can interleave on a synchronous driver — so driving BEGIN/COMMIT
      // by hand is both safe and the only option.
      depth++;
      db.prepare('BEGIN').run();
      try {
        const result = await fn();
        db.prepare('COMMIT').run();
        return result;
      } catch (err) {
        try {
          db.prepare('ROLLBACK').run();
        } catch {
          /* Already rolled back by SQLite. */
        }
        throw err;
      } finally {
        depth--;
      }
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}
