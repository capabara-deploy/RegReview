import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

/**
 * Postgres returns `bigint`/`COUNT(*)` columns (OID 20) as strings by
 * default, to avoid silent precision loss outside JS's safe integer range.
 * better-sqlite3 (what this code was written against) always returned plain
 * numbers, and every COUNT(*)-reading call site in this codebase expects
 * one — none of these counts get anywhere near 2^53, so parsing as a number
 * here is the right global default rather than patching every call site.
 */
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));

/**
 * A thin better-sqlite3-shaped wrapper around a Postgres pool.
 *
 * The rest of the codebase was written against better-sqlite3's synchronous
 * `db.prepare(sql).run/get/all()` and `db.transaction(fn)()`. Rather than
 * hand-translating every call site to raw `pg` calls, this preserves that
 * exact shape — just async — so converting a call site is "add async/await",
 * not "rewrite the query". `?` positional placeholders are translated to
 * Postgres's `$1..$n` automatically; every SQL string in this codebase is a
 * static literal with no literal `?` characters in it, so a straight
 * sequential replace is safe.
 */

function toPositional(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

export interface RunResult {
  changes: number;
}

class PreparedStatement {
  constructor(
    private readonly db: PgDb,
    private readonly sql: string,
  ) {}

  async run(...params: unknown[]): Promise<RunResult> {
    const res = await this.db.rawQuery(toPositional(this.sql), params);
    return { changes: res.rowCount ?? 0 };
  }

  async get<T = unknown>(...params: unknown[]): Promise<T | undefined> {
    const res = await this.db.rawQuery(toPositional(this.sql), params);
    return res.rows[0] as T | undefined;
  }

  async all<T = unknown>(...params: unknown[]): Promise<T[]> {
    const res = await this.db.rawQuery(toPositional(this.sql), params);
    return res.rows as T[];
  }
}

export class PgDb {
  private readonly pool: pg.Pool;
  // Per-instance, deliberately: this app opens multiple PgDb instances (one
  // per database — corpus/customer/sops). A module-level AsyncLocalStorage
  // would leak one database's checked-out transaction client into a query
  // against a different database if a transaction callback on one PgDb calls
  // into another PgDb while it's running (ingestSop's cross-database
  // "is this rule still referenced by a finding" check does exactly that).
  private readonly txStorage = new AsyncLocalStorage<pg.PoolClient>();

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this, sql);
  }

  /** Run a full (possibly multi-statement) SQL string, e.g. schema DDL. */
  async exec(sqlText: string): Promise<void> {
    await (this.txStorage.getStore() ?? this.pool).query(sqlText);
  }

  /** For call sites that need a raw query rather than the prepare() shape. */
  rawQuery(sqlText: string, params?: unknown[]) {
    return (this.txStorage.getStore() ?? this.pool).query(sqlText, params);
  }

  /**
   * Mirrors better-sqlite3's `db.transaction(fn)`: returns a function that,
   * when called, runs `fn` inside BEGIN/COMMIT/ROLLBACK on one checked-out
   * client. `fn` (and anything it calls into, via prepare()) must be async —
   * AsyncLocalStorage threads the transaction's client through so nested
   * prepare().run/get/all() calls transparently use it instead of the pool.
   */
  transaction<Args extends unknown[], T>(
    fn: (...args: Args) => Promise<T>,
  ): (...args: Args) => Promise<T> {
    return async (...args: Args) => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await this.txStorage.run(client, () => fn(...args));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    };
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
