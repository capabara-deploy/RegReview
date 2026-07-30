import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

export type Db = Database.Database;

let cached: Db | undefined;

/**
 * Open (and memoize) the local SQLite database.
 *
 * Local-first is a security decision, not a convenience one: the documents this
 * tool reads are among the most confidential a device company owns, and the
 * Fresenius interviewee was explicit that hosting would need to be on their
 * infrastructure rather than ours.
 *
 * better-sqlite3 rather than the built-in `node:sqlite` because the latter is
 * still flagged experimental ("might change at any time"), which is a poor
 * foundation for a tool that will eventually need to survive a customer's
 * computer system validation process.
 */
export function getDb(path = config.dbPath): Db {
  if (cached) return cached;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  cached = db;
  return db;
}

export function closeDb(): void {
  cached?.close();
  cached = undefined;
}
