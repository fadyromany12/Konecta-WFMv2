import { schemaFor } from './schema.js';
import { createSqliteDatabase } from './sqlite.js';
import { createPostgresDatabase } from './postgres.js';
import type { Database } from './driver.js';
import { resolve } from 'node:path';

export type { Database, Row } from './driver.js';

/**
 * Which database, decided by environment alone.
 *
 * `PULSE_DATABASE_URL` (or `DATABASE_URL`, `POSTGRES_URL`, which is what the
 * hosted Postgres providers set for you) selects Postgres. Everything else
 * falls back to SQLite, so a clone still runs with nothing installed.
 *
 * The precedence matters: a deployment that has been given a Postgres URL must
 * never quietly fall back to an ephemeral local database if the connection
 * fails. It should fail loudly instead, which is what happens — the first query
 * throws rather than succeeding against the wrong store.
 */
/**
 * A variable that exists but is blank counts as unset.
 *
 * Hosting dashboards create empty variables readily — you add the key, save,
 * and fill the value in later. Treating `POSTGRES_URL=""` as "use Postgres"
 * sends the process at libpq's defaults on localhost:5432 and it dies with a
 * connection refused that names a database nobody configured.
 */
const configured = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const postgresUrl =
  configured(process.env.PULSE_DATABASE_URL) ??
  configured(process.env.DATABASE_URL) ??
  configured(process.env.POSTGRES_URL) ??
  configured(process.env.POSTGRES_URL_NON_POOLING);

const sqliteFile =
  configured(process.env.PULSE_DB) ??
  // A serverless filesystem is read-only apart from /tmp, and /tmp does not
  // survive or get shared between instances. Defaulting to memory there means
  // the deployment needs no configuration — at the cost of losing everything on
  // a cold start, which is exactly what a Postgres URL is for.
  (process.env.VERCEL ? ':memory:' : resolve(process.cwd(), 'data/pulse.db'));

export const USING_POSTGRES = postgresUrl !== null;
export const IS_MEMORY = !USING_POSTGRES && sqliteFile === ':memory:';

// Running on ephemeral memory is a legitimate choice for a demo and a silent
// disaster for anything else: every cold start reseeds, so a record written a
// minute ago may simply not exist. It looks healthy from the outside — the
// deployment answers 200 and the data is plausible — which is exactly why it
// needs saying out loud rather than being left to whoever reads /api/health.
if (IS_MEMORY && process.env.VERCEL) {
  console.warn(
    'WARNING: no Postgres URL is set, so this deployment is running on an in-memory database. ' +
      'Every cold start wipes it and instances do not share data. ' +
      'Set POSTGRES_URL and redeploy — Vercel captures environment variables when a deployment is built, ' +
      'so adding the variable alone will not change a deployment that is already live.',
  );
}

export const db: Database = USING_POSTGRES
  ? createPostgresDatabase(postgresUrl!)
  : createSqliteDatabase(sqliteFile);

/** Human description of where the data is, for the health endpoint and logs. */
export function storageDescription(): string {
  if (USING_POSTGRES) return 'postgres (durable, shared between instances)';
  return IS_MEMORY ? 'in-memory (ephemeral — resets on restart)' : `sqlite file (${sqliteFile})`;
}

let ready: Promise<void> | null = null;

/**
 * Create the tables if they are missing.
 *
 * Called once, lazily, and memoised on the promise rather than a boolean so
 * that concurrent cold-start requests wait for the same migration instead of
 * racing to run it twice.
 */
export function ensureSchema(): Promise<void> {
  ready ??= db.exec(schemaFor(db.dialect)).then(migrate);
  return ready;
}

/**
 * Additive migrations for databases that already exist.
 *
 * `CREATE TABLE IF NOT EXISTS` creates a missing table and does nothing at all
 * to one that is already there — so a column added to the schema never reaches
 * a database that predates it. New tables are handled by the schema itself;
 * new *columns* need this.
 *
 * Deliberately only additive. A destructive migration run automatically on
 * startup against a database holding payroll records is not something this
 * should be able to do by accident.
 */
async function migrate(): Promise<void> {
  await addColumn('timecards', 'correction_reason', 'TEXT');
  // Existing rows were being worked to, so they are published by definition.
  await addColumn('schedules', 'status', "TEXT NOT NULL DEFAULT 'PUBLISHED'");
  await addColumn('schedules', 'published_at', 'TEXT');
  // How a worked public holiday was settled. Null means nobody has chosen yet,
  // which is a state the payroll screen has to be able to show.
  await addColumn('timecards', 'holiday_election', 'TEXT');
}

async function addColumn(table: string, column: string, type: string): Promise<void> {
  try {
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    console.log(`Migrated: added ${table}.${column}`);
  } catch (err) {
    // Both engines refuse a duplicate column, with different wording. That is
    // the expected outcome on every start after the first, so it is not an
    // error — anything else is, and should surface.
    const message = err instanceof Error ? err.message.toLowerCase() : String(err);
    const alreadyThere =
      message.includes('duplicate column') || message.includes('already exists');
    if (!alreadyThere) throw err;
  }
}

export async function audit(
  actorId: number | null,
  entity: string,
  entityId: string | number,
  action: string,
  detail?: unknown,
): Promise<void> {
  await db.run(
    'INSERT INTO audit_log (actor_id, entity, entity_id, action, detail) VALUES (?, ?, ?, ?, ?)',
    [actorId, entity, String(entityId), action, detail === undefined ? null : JSON.stringify(detail)],
  );
}

export function transact<T>(fn: () => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

/** Build `?, ?, ?` for an IN clause of n values. */
export function placeholders(n: number): string {
  return n === 0 ? 'NULL' : new Array(n).fill('?').join(',');
}
