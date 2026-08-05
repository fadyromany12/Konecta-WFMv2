import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCHEMA } from './schema.js';

const DB_PATH = process.env.PULSE_DB ?? resolve(process.cwd(), 'data/pulse.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
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
