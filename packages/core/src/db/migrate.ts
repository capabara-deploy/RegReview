import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORPUS_VERSION } from "../config.js";
import { seedSampleSops } from "../sampleSops.js";
import { getCorpusDb, getCustomerDb, getSopsDb } from "./index.js";
import type { PgDb } from "./pgDb.js";

// ESM has no __dirname; derive it from import.meta.url.
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate a schema file next to this module.
 *
 * It sits next to this file in `src`, but `tsc` does not copy non-TS assets
 * to `dist` — so when this module runs as `dist/db/migrate.js` the sibling
 * lookup misses. Checking both keeps `tsx src/...` and built output working
 * without a build-time copy step to forget about.
 */
function schemaPath(filename: string): string {
  const candidates = [
    join(here, filename), // tsx from src, or dist if an asset copy exists
    join(here, "..", "..", "src", "db", filename), // running from dist
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`could not locate ${filename}; looked in:\n  ${candidates.join("\n  ")}`);
  }
  return found;
}

async function runSchema(db: PgDb, filename: string): Promise<void> {
  const sql = readFileSync(schemaPath(filename), "utf8");
  await db.exec(sql);
  await db
    .prepare(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run("schema_version", "1");
  await db
    .prepare(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run("corpus_version", CORPUS_VERSION);
}

export async function migrateCorpus(): Promise<void> {
  await runSchema(getCorpusDb(), "corpusSchema.sql");
}

export async function migrateCustomer(): Promise<void> {
  await runSchema(getCustomerDb(), "customerSchema.sql");
}

export async function migrateSops(): Promise<void> {
  const db = getSopsDb();
  await runSchema(db, "sopsSchema.sql");
  // Seed the sample procedures if this database has never held one, so the
  // conformance pass is never silently ruleless. A no-op on every subsequent
  // call, including the server's migrate-on-boot. See sampleSops.ts for why a
  // shipped procedure is both necessary and carefully labeled.
  await seedSampleSops(db);
}

async function listTables(db: PgDb): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    )
    .all<{ table_name: string }>();
  return rows.map((r) => r.table_name);
}

// Run directly: `npm run migrate`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  for (const [label, migrateFn, getDb] of [
    ["corpus", migrateCorpus, getCorpusDb],
    ["customer", migrateCustomer, getCustomerDb],
    ["sops", migrateSops, getSopsDb],
  ] as const) {
    await migrateFn();
    const tables = await listTables(getDb());
    console.log(`migrated ${label}: ${tables.length} tables`);
    for (const t of tables) console.log(`  ${t}`);
  }
}
