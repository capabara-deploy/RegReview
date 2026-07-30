import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORPUS_VERSION } from "../config.js";
import { getDb } from "./index.js";

// ESM has no __dirname; derive it from import.meta.url.
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate schema.sql.
 *
 * It sits next to this file in `src`, but `tsc` does not copy non-TS assets to
 * `dist` — so when this module runs as `dist/db/migrate.js` the sibling lookup
 * misses. Checking both keeps `tsx src/...` and built output working without a
 * build-time copy step to forget about.
 */
function schemaPath(): string {
  const candidates = [
    join(here, "schema.sql"), // tsx from src, or dist if an asset copy exists
    join(here, "..", "..", "src", "db", "schema.sql"), // running from dist
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`could not locate schema.sql; looked in:\n  ${candidates.join("\n  ")}`);
  }
  return found;
}

export function migrate(): void {
  const db = getDb();
  const sql = readFileSync(schemaPath(), "utf8");
  db.exec(sql);
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run("schema_version", "1");
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run("corpus_version", CORPUS_VERSION);
}

// Run directly: `npm run migrate`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  migrate();
  const db = getDb();
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as { name: string }[];
  console.log(`migrated: ${tables.length} tables`);
  for (const t of tables) console.log(`  ${t.name}`);
}
