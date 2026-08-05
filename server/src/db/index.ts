import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCHEMA } from './schema.js';

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

export const db = new Database(configured);

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
