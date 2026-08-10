import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../config.js";
import { PgDb } from "../db/pgDb.js";

/**
 * One-time archive of the pre-migration data/regreview.db into the "old"
 * Neon database, before the running app switches onto the split
 * corpus/customer/sops databases (see db/index.ts). Not read by the app —
 * just a frozen snapshot, in its original unsplit schema, for reference.
 *
 *   npx tsx src/cli/archiveSqlite.ts
 */

const TABLES = [
  "schema_meta",
  "sop_documents",
  "rules",
  "fda_observations",
  "cfr_sections",
  "records",
  "blocks",
  "facts",
  "runs",
  "findings",
  "finding_events",
] as const;

function schemaPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "db", "archiveSchema.sql"), // tsx from src
    join(here, "..", "..", "src", "db", "archiveSchema.sql"), // running from dist
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`could not locate archiveSchema.sql; looked in:\n  ${candidates.join("\n  ")}`);
  }
  return found;
}

async function main(): Promise<void> {
  const connectionString = process.env["NEON_OLD_DATABASE_URL"];
  if (!connectionString) {
    throw new Error("NEON_OLD_DATABASE_URL is not set. Add it to .env first.");
  }

  const sqlitePath = join(REPO_ROOT, "data", "regreview.db");
  if (!existsSync(sqlitePath)) {
    throw new Error(`no SQLite file at ${sqlitePath} — nothing to archive.`);
  }

  const sqlite = new Database(sqlitePath, { readonly: true });
  const archive = new PgDb(connectionString);

  console.log(`Archiving ${sqlitePath} -> old (Neon).\n`);

  await archive.exec(readFileSync(schemaPath(), "utf8"));

  // Batched, not one round-trip per row: a sequential per-row insert over a
  // real network link to Neon is dominated by round-trip latency, not by the
  // database's own work, and this table set runs into the thousands of rows.
  const BATCH_SIZE = 200;

  for (const table of TABLES) {
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    if (rows.length === 0) {
      console.log(`  ${table.padEnd(16)} 0 rows`);
      continue;
    }

    const columns = Object.keys(rows[0]!);
    const rowPlaceholders = `(${columns.map(() => "?").join(", ")})`;

    await archive.transaction(async () => {
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const insertSql = `INSERT INTO ${table} (${columns.join(", ")})
           VALUES ${batch.map(() => rowPlaceholders).join(", ")}
           ON CONFLICT DO NOTHING`;
        const params = batch.flatMap((row) => columns.map((c) => row[c]));
        await archive.prepare(insertSql).run(...params);
      }
    })();

    const { count } = (await archive
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get<{ count: number }>())!;
    const match = count === rows.length ? "OK" : `MISMATCH (source ${rows.length})`;
    console.log(`  ${table.padEnd(16)} ${String(count).padStart(6)} rows  ${match}`);
  }

  console.log("\nDone. The local data/regreview.db file is left untouched.");
}

await main();
