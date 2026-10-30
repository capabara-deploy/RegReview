import { config, getLocalAccountsDb, type Db } from "@regreview/core";

/**
 * The REGREVIEW_LOCAL=1 stand-in for the MongoDB side: reviewer accounts,
 * sessions and the hourly quota, in an embedded Postgres on local disk.
 *
 * It exists so the whole app — sign-in screen, session cookie, quota — runs
 * on a laptop with no online database, rather than local dev taking a
 * separate auth-disabled path the deployed app never takes (the web UI has no
 * such path: with no /api/me it can only show a sign-in screen that 404s).
 * auth.ts and quota.ts keep their Mongo code and branch on LOCAL_ACCOUNTS.
 *
 * Mongo's TTL indexes have no Postgres equivalent, so expiry is enforced in
 * the reads (`expires_at > now()`) and stale rows are swept on boot.
 */

export const LOCAL_ACCOUNTS = config.local;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  username      TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_counters (
  key         TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  hour_bucket TEXT NOT NULL,
  count       INTEGER NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);
`;

export function accountsDb(): Db {
  return getLocalAccountsDb();
}

export async function migrateLocalAccounts(): Promise<void> {
  const db = accountsDb();
  await db.exec(SCHEMA);
  await db.prepare(`DELETE FROM sessions WHERE expires_at <= now()`).run();
  await db.prepare(`DELETE FROM usage_counters WHERE expires_at <= now()`).run();
}
