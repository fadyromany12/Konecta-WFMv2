import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { toPositional, type Database as Db, type RunResult } from './driver.js';

/**
 * The Postgres driver.
 *
 * Two things need care here and nothing else is interesting.
 *
 * First, transactions. A Postgres transaction lives on one connection, but the
 * services call a module-level `db` from inside the transaction callback and
 * have no idea a transaction is running. `AsyncLocalStorage` carries the
 * checked-out client down the call stack, so every query raised inside
 * `transaction()` lands on the right connection without a single service
 * needing to pass one around.
 *
 * Second, types. `node-postgres` returns NUMERIC and BIGINT as strings, because
 * they can exceed what a JavaScript number holds safely. That is the correct
 * default and completely wrong for this schema, where those columns are hours
 * and row counts. They are parsed back to numbers below — otherwise
 * `balance_hours - 8` silently becomes the string "16-8" behaviour class of
 * bug, and a count compared with `>= slots` compares a string to a number.
 */

const { Pool, types } = pg;

// 1700 = NUMERIC, 20 = INT8. Both are safely within Number range for this data.
types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));
types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

type Client = pg.PoolClient;

export function createPostgresDatabase(connectionString: string): Db {
  const pool = new Pool({
    connectionString,
    // Hosted Postgres almost always terminates TLS with a certificate this
    // process has no root for. The connection is still encrypted; it is the
    // certificate chain that is not verified. Set PULSE_DB_SSL=verify when the
    // deployment has a CA available and this should be strict.
    ssl: sslSetting(connectionString),
    // A serverless instance handles one request at a time and may be frozen at
    // any moment, so a wide pool is wasted file descriptors on the database.
    max: Number(process.env.PULSE_DB_POOL ?? (process.env.VERCEL ? 1 : 10)),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    // An idle client erroring is not fatal — the pool replaces it — but it is
    // worth seeing, because a burst of these means the database is unhappy.
    console.error('Postgres idle client error:', err.message);
  });

  const transactionClient = new AsyncLocalStorage<Client>();

  async function query(sql: string, params: unknown[]): Promise<pg.QueryResult> {
    const text = toPositional(sql);
    const active = transactionClient.getStore();
    if (active) return active.query(text, params as any[]);
    return pool.query(text, params as any[]);
  }

  return {
    dialect: 'postgres',

    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await query(sql, params)).rows as T[];
    },

    async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
      return (await query(sql, params)).rows[0] as T | undefined;
    },

    async run(sql: string, params: unknown[] = []): Promise<RunResult> {
      return { changes: (await query(sql, params)).rowCount ?? 0 };
    },

    async insert(sql: string, params: unknown[] = []): Promise<number> {
      // Postgres has no "last inserted id" on the connection, and asking for one
      // afterwards would be a race. RETURNING is the only correct way.
      const withReturning = /returning/i.test(sql) ? sql : `${sql.trimEnd().replace(/;$/, '')} RETURNING id`;
      const result = await query(withReturning, params);
      return Number(result.rows[0]?.id);
    },

    async exec(sql: string): Promise<void> {
      const active = transactionClient.getStore();
      if (active) await active.query(sql);
      else await pool.query(sql);
    },

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      // Already inside one: join it. Opening a second would either deadlock on
      // a different connection or commit the outer transaction early.
      if (transactionClient.getStore()) return fn();

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await transactionClient.run(client, fn);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* The connection is already gone; the transaction died with it. */
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

function sslSetting(connectionString: string): { rejectUnauthorized: boolean } | boolean {
  const mode = process.env.PULSE_DB_SSL;
  if (mode === 'off') return false;
  if (mode === 'verify') return true;
  // A local server has no TLS at all and rejects the attempt.
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(connectionString) && !/sslmode=require/.test(connectionString)) {
    return false;
  }
  return { rejectUnauthorized: false };
}
