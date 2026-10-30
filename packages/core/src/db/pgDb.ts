import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import pg from "pg";

/**
 * Postgres returns `bigint`/`COUNT(*)` columns (OID 20) as strings by
 * default, to avoid silent precision loss outside JS's safe integer range.
 * better-sqlite3 (what this code was written against) always returned plain
 * numbers, and every COUNT(*)-reading call site in this codebase expects
 * one — none of these counts get anywhere near 2^53, so parsing as a number
 * here is the right global default rather than patching every call site.
 * (PGlite already returns int8 as a number, so the local backend needs no
 * equivalent.)
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

interface QueryResult {
  rows: unknown[];
  rowCount: number;
}

/**
 * What a statement actually runs against: the pool (or embedded database),
 * or the client/transaction a surrounding `transaction()` checked out.
 */
interface Runner {
  query(sqlText: string, params?: unknown[]): Promise<QueryResult>;
  exec(sqlText: string): Promise<void>;
}

function pgRunner(q: pg.Pool | pg.PoolClient): Runner {
  return {
    async query(sqlText, params) {
      const res = await q.query(sqlText, params);
      return { rows: res.rows, rowCount: res.rowCount ?? 0 };
    },
    async exec(sqlText) {
      await q.query(sqlText);
    },
  };
}

function pgliteRunner(q: PGlite | Transaction): Runner {
  return {
    async query(sqlText, params) {
      const res = await q.query(sqlText, params);
      return { rows: res.rows, rowCount: res.affectedRows ?? 0 };
    },
    async exec(sqlText) {
      await q.exec(sqlText);
    },
  };
}

class PreparedStatement {
  constructor(
    private readonly db: PgDb,
    private readonly sql: string,
  ) {}

  async run(...params: unknown[]): Promise<RunResult> {
    const res = await this.db.rawQuery(toPositional(this.sql), params);
    return { changes: res.rowCount };
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

/**
 * Stop PGlite's internal Postgres timers from keeping the process alive.
 *
 * The embedded Postgres arms a periodic ~10s timer (its own housekeeping, via
 * Emscripten's setitimer shim, which calls the global setTimeout) that
 * re-arms itself indefinitely. Against Neon a CLI exits once its pool goes
 * idle; against PGlite every CLI that ends without process.exit() would hang
 * forever instead. Unref'ing only the timers that shim creates fixes that
 * without touching anyone else's: the server is kept alive by its listener,
 * and the housekeeping is not needed for durability (commits are written
 * through to disk synchronously). Installed once, and only in local mode.
 */
let pgliteTimersUnrefd = false;
function unrefPgliteTimers(): void {
  if (pgliteTimersUnrefd) return;
  pgliteTimersUnrefd = true;
  const original = globalThis.setTimeout;
  const patched = ((...args: Parameters<typeof setTimeout>) => {
    const timer = original(...args);
    if (new Error().stack?.includes("__setitimer_js")) timer.unref();
    return timer;
  }) as typeof setTimeout;
  globalThis.setTimeout = Object.assign(patched, original);
}

/**
 * Where a PgDb's data lives: a real Postgres server (Neon), or an embedded
 * Postgres (PGlite — the Postgres engine itself, compiled to WASM) persisting
 * to a directory on local disk. The embedded one is for local development and
 * testing with no online database; it is the same SQL dialect, so the schemas
 * and every query run unchanged against either.
 */
export type PgTarget = { kind: "url"; connectionString: string } | { kind: "local"; dataDir: string };

export class PgDb {
  private readonly pool: pg.Pool | undefined;
  private readonly lite: PGlite | undefined;
  private readonly base: Runner;
  // Per-instance, deliberately: this app opens multiple PgDb instances (one
  // per database — corpus/customer/sops). A module-level AsyncLocalStorage
  // would leak one database's checked-out transaction client into a query
  // against a different database if a transaction callback on one PgDb calls
  // into another PgDb while it's running (ingestSop's cross-database
  // "is this rule still referenced by a finding" check does exactly that).
  private readonly txStorage = new AsyncLocalStorage<Runner>();

  constructor(target: string | PgTarget) {
    const t: PgTarget = typeof target === "string" ? { kind: "url", connectionString: target } : target;
    if (t.kind === "local") {
      mkdirSync(t.dataDir, { recursive: true });
      unrefPgliteTimers();
      this.lite = new PGlite(t.dataDir);
      this.base = pgliteRunner(this.lite);
    } else {
      this.pool = new pg.Pool({ connectionString: t.connectionString });
      this.base = pgRunner(this.pool);
    }
  }

  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this, sql);
  }

  /** Run a full (possibly multi-statement) SQL string, e.g. schema DDL. */
  async exec(sqlText: string): Promise<void> {
    await (this.txStorage.getStore() ?? this.base).exec(sqlText);
  }

  /** For call sites that need a raw query rather than the prepare() shape. */
  rawQuery(sqlText: string, params?: unknown[]): Promise<QueryResult> {
    return (this.txStorage.getStore() ?? this.base).query(sqlText, params);
  }

  /**
   * Mirrors better-sqlite3's `db.transaction(fn)`: returns a function that,
   * when called, runs `fn` inside BEGIN/COMMIT/ROLLBACK on one checked-out
   * client. `fn` (and anything it calls into, via prepare()) must be async —
   * AsyncLocalStorage threads the transaction's client through so nested
   * prepare().run/get/all() calls transparently use it instead of the pool.
   *
   * That threading matters even more for PGlite: it is a single connection
   * that queues every statement behind an open transaction, so a nested
   * statement that escaped to the base instance would wait forever on the
   * transaction it belongs to.
   */
  transaction<Args extends unknown[], T>(
    fn: (...args: Args) => Promise<T>,
  ): (...args: Args) => Promise<T> {
    return async (...args: Args) => {
      if (this.lite) {
        return this.lite.transaction((tx) => this.txStorage.run(pgliteRunner(tx), () => fn(...args)));
      }
      const client = await this.pool!.connect();
      try {
        await client.query("BEGIN");
        const result = await this.txStorage.run(pgRunner(client), () => fn(...args));
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
    if (this.lite) await this.lite.close();
    else await this.pool!.end();
  }
}
