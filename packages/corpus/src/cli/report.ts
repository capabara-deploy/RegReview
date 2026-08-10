import { getCorpusDb, migrateCorpus } from "@regreview/core";

/**
 * Sanity-check what actually landed in the corpus.
 *
 * This is the verification step for corpus ingest, not a dashboard. The claim
 * being checked is specific: if CAPA (820.100) and complaint handling (820.198)
 * do not dominate the device citation counts, the parse is wrong — those are
 * well known to be the most-cited device requirements, so a result that
 * disagrees means we mis-read columns, not that FDA changed behavior.
 */

function bar(value: number, max: number, width = 28): string {
  if (max <= 0) return "";
  return "#".repeat(Math.max(1, Math.round((value / max) * width)));
}

function section(title: string): void {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

async function main(): Promise<void> {
  await migrateCorpus();
  const db = getCorpusDb();

  const { years, rows } = (await db
    .prepare(
      `SELECT COUNT(DISTINCT fiscal_year) AS years, COUNT(*) AS rows FROM fda_observations`,
    )
    .get<{ years: number; rows: number }>())!;

  if (rows === 0) {
    console.log("No observation data. Run `npm run ingest:observations` first.");
    return;
  }

  section(`FDA observation data: ${rows} rows across ${years} fiscal years`);
  const perYear = await db
    .prepare(
      `SELECT fiscal_year, COUNT(*) AS observations, SUM(frequency) AS citations
         FROM fda_observations GROUP BY fiscal_year ORDER BY fiscal_year DESC`,
    )
    .all<{ fiscal_year: number; observations: number; citations: number }>();
  for (const y of perYear) {
    console.log(
      `  FY${y.fiscal_year}  ${String(y.observations).padStart(4)} observations  ` +
        `${String(y.citations).padStart(5)} citations`,
    );
  }

  // The headline check. Aggregated across every ingested year so a single
  // anomalous year can't flip the ranking.
  section("Top 20 device citations, all ingested years");
  const top = await db
    .prepare(
      `SELECT citation,
              SUM(frequency) AS total,
              MIN(short_description) AS description
         FROM fda_observations
        GROUP BY citation
        ORDER BY total DESC
        LIMIT 20`,
    )
    .all<{ citation: string; total: number; description: string }>();

  const max = top[0]?.total ?? 0;
  for (const [i, row] of top.entries()) {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${row.citation.padEnd(22)} ` +
        `${String(row.total).padStart(5)}  ${bar(row.total, max)}`,
    );
    console.log(`      ${row.description.slice(0, 96)}`);
  }

  // Explicit pass/fail on the thing we actually care about, rather than leaving
  // it to the reader to eyeball.
  section("Verification");
  const capaTotal = (
    await db
      .prepare(
        `SELECT COALESCE(SUM(frequency), 0) AS total FROM fda_observations
          WHERE citation LIKE '%820.100%'`,
      )
      .get<{ total: number }>()
  )!.total;
  const complaintTotal = (
    await db
      .prepare(
        `SELECT COALESCE(SUM(frequency), 0) AS total FROM fda_observations
          WHERE citation LIKE '%820.198%'`,
      )
      .get<{ total: number }>()
  )!.total;
  const designTotal = (
    await db
      .prepare(
        `SELECT COALESCE(SUM(frequency), 0) AS total FROM fda_observations
          WHERE citation LIKE '%820.30%'`,
      )
      .get<{ total: number }>()
  )!.total;

  console.log(`  CAPA (820.100) total citations:        ${capaTotal}`);
  console.log(`  Complaints (820.198) total citations:  ${complaintTotal}`);
  console.log(`  Design controls (820.30) citations:    ${designTotal}`);

  const topThree = top.slice(0, 3).map((t) => t.citation).join(", ");
  const capaInTopThree = top.slice(0, 3).some((t) => t.citation.includes("820.100"));
  console.log(
    `\n  ${capaInTopThree ? "PASS" : "FAIL"}: CAPA (820.100) ` +
      `${capaInTopThree ? "is" : "is NOT"} among the top 3 device citations.` +
      `\n        Top 3: ${topThree}`,
  );
  if (!capaInTopThree) {
    console.log(
      "        This is the expected-result check from the build plan. A failure " +
        "\n        most likely means the column mapping is wrong, not that FDA changed.",
    );
    process.exitCode = 1;
  }

  // Corpus tables, for orientation once later phases populate them.
  section("Corpus tables");
  for (const table of ["rules", "cfr_sections", "fda_observations"]) {
    const { n } = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>())!;
    console.log(`  ${table.padEnd(18)} ${n}`);
  }
}

await main();
