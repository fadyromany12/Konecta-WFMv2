import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SCHEMA } from './schema.js';

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

/**
 * Database location.
 *
 * `PULSE_DB=:memory:` gives an ephemeral database that lives for the life of
 * the process. That is what the hosted testing deployment uses: a serverless
 * instance seeds itself on cold start, so every deployment is reproducible and
 * nothing needs a writable disk. A file path is used everywhere else.
 */
const configured =
  process.env.PULSE_DB ??
  // A serverless filesystem is read-only apart from /tmp, and /tmp does not
  // survive or get shared between instances. Defaulting to memory there means
  // the deployment needs no configuration and no external database.
  (process.env.VERCEL ? ':memory:' : resolve(process.cwd(), 'data/pulse.db'));

export const IS_MEMORY = configured === ':memory:';

if (!IS_MEMORY) mkdirSync(dirname(configured), { recursive: true });

export const db = openDatabase(configured);

// WAL is a file-mode concern; an in-memory database neither needs nor accepts it.
if (!IS_MEMORY) db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA);

export function audit(
  actorId: number | null,
  entity: string,
  entityId: string | number,
  action: string,
  detail?: unknown,
): void {
  db.prepare(
    'INSERT INTO audit_log (actor_id, entity, entity_id, action, detail) VALUES (?, ?, ?, ?, ?)',
  ).run(actorId, entity, String(entityId), action, detail === undefined ? null : JSON.stringify(detail));
}

export function transact<T>(fn: () => T): T {
  const run = db.transaction(fn);
  return run();
}
