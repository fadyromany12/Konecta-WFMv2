/**
 * The storage interface.
 *
 * Two things forced this to exist. A serverless deployment has no writable disk,
 * so the SQLite build there runs in memory and loses everything on a cold start;
 * and once more than one instance is running, each would have had its own copy
 * of the truth. Postgres fixes both.
 *
 * The interface is async even for SQLite, where every operation is really
 * synchronous. That is deliberate: one shape of calling code, so a bug can never
 * be "works on SQLite, deadlocks on Postgres". The cost is an `await` in front
 * of queries that do not need one, which is a small price for the two builds
 * being the same program.
 *
 * The SQL dialect is kept portable by hand rather than by an ORM: queries are
 * written once, in the subset both databases agree on, and the few genuine
 * differences (identity columns, placeholder syntax, the timestamp default) are
 * translated here at the boundary.
 */

export type Row = Record<string, any>;

export interface RunResult {
  /** Rows affected. Used where the code needs to know something existed. */
  changes: number;
}

export interface Database {
  readonly dialect: 'sqlite' | 'postgres';
  /** Every matching row. */
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** The first matching row, or undefined. */
  get<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** A statement with no result rows. */
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  /**
   * An INSERT that yields its new id. Separate from `run` because the two
   * databases obtain it in completely different ways — a driver property in
   * SQLite, a `RETURNING` clause in Postgres — and hiding that behind one
   * method is the whole point.
   */
  insert(sql: string, params?: unknown[]): Promise<number>;
  /** Multiple statements, for DDL. */
  exec(sql: string): Promise<void>;
  /**
   * Run `fn` inside a transaction, rolling back if it throws.
   *
   * Nested calls join the transaction already in progress rather than opening a
   * second one, because several services call each other and both may want a
   * transaction. Whichever call opened it is the one that commits.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Rewrite `?` placeholders to Postgres `$1, $2, …`.
 *
 * Queries are written with `?` throughout because that is what the SQLite build
 * has always used and what the string-building helpers (`placeholders(n)`)
 * produce. Question marks inside string literals must be left alone, so this
 * tracks quoting rather than doing a blind replace — `WHERE note = '?'` is rare
 * but a silent corruption if it is ever written.
 */
export function toPositional(sql: string): string {
  let out = '';
  let index = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;

    if (char === '?' && !inSingle && !inDouble) {
      out += `$${++index}`;
    } else {
      out += char;
    }
  }
  return out;
}
