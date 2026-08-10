import { createHash } from "node:crypto";
import { getCorpusDb, migrateCorpus } from "@regreview/core";
import { fetchCached } from "../fetch.js";
import {
  DEVICES_SHEET,
  LEGACY_XLS_YEARS,
  OBSERVATION_COLUMNS as COL,
  OBSERVATION_FILES,
} from "../sources.js";
import { findHeader, openWorkbook } from "../xlsx.js";

/**
 * Ingest FDA's Inspectional Observation ("Turbo EIR") data for devices.
 *
 * Run this first of the corpus CLIs. It produces the empirical inspection-risk
 * signal that the severity model depends on, and FDA's own canonical deficiency
 * phrasings, which the eval fixtures use as labels. Everything downstream is
 * more speculative without it.
 */

const XLSX_ACCEPT =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet," +
  "application/vnd.ms-excel,*/*";

/**
 * Normalize a citation to a comparable key.
 *
 * FDA writes "21 CFR 820.100(a)" but the same paragraph shows up elsewhere as
 * "820.100(a)". Strip the title prefix and whitespace so the two join, and keep
 * paragraph lettering — it is the whole point, since 820.100(a) (no procedures)
 * and 820.100(b) (no documentation) are different observations with different
 * frequencies.
 */
export function normalizeCitation(raw: string): string {
  return raw
    .replace(/\s+/g, "")
    .replace(/^21CFR/i, "")
    .replace(/^§+/, "")
    .toLowerCase();
}

function observationId(fiscalYear: number, citation: string, shortDescription: string): string {
  return createHash("sha256")
    .update(`${fiscalYear}|${normalizeCitation(citation)}|${shortDescription}`)
    .digest("hex")
    .slice(0, 24);
}

interface IngestStats {
  fiscalYear: number;
  rows: number;
  totalCitations: number;
}

async function ingestYear(fiscalYear: number, url: string, force: boolean): Promise<IngestStats> {
  const buf = await fetchCached(url, {
    cacheKey: `fda-observations-FY${fiscalYear}.xlsx`,
    accept: XLSX_ACCEPT,
    ...(force ? { force: true } : {}),
  });

  // Only the Devices sheet is decoded. This matters: FDA's FY2014 workbook
  // expands to ~60 MB per worksheet across nine worksheets, so eagerly parsing
  // the whole book costs about half a gigabyte of XML to reach one sheet.
  const workbook = openWorkbook(buf);
  const sheet = workbook.getSheet(DEVICES_SHEET);
  if (!sheet) {
    throw new Error(
      `FY${fiscalYear}: no "${DEVICES_SHEET}" sheet. Found: ${workbook.sheetNames.join(", ")}`,
    );
  }

  const header = findHeader(sheet, [COL.citation, COL.shortDescription, COL.frequency]);
  if (!header) {
    throw new Error(
      `FY${fiscalYear}: could not find a header row containing ` +
        `"${COL.citation}", "${COL.shortDescription}", "${COL.frequency}". ` +
        `FDA may have relabelled the columns — inspect the file before changing the parser.`,
    );
  }

  const colCitation = header.columns.get(COL.citation)!;
  const colShort = header.columns.get(COL.shortDescription)!;
  const colLong = header.columns.get(COL.longDescription);
  const colFreq = header.columns.get(COL.frequency)!;
  const colArea = header.columns.get(COL.programArea);

  const db = getCorpusDb();

  let rows = 0;
  let totalCitations = 0;

  const run = db.transaction(async () => {
    for (const row of sheet.rows) {
      if (row.rowNumber <= header.rowNumber) continue;

      const citation = row.cells.get(colCitation);
      const shortDescription = row.cells.get(colShort);
      const frequencyRaw = row.cells.get(colFreq);
      // A row without all three isn't a citation row — it's padding, a subtotal,
      // or a footnote. Skip quietly.
      if (!citation || !shortDescription || !frequencyRaw) continue;

      const frequency = Number(frequencyRaw.replace(/,/g, ""));
      if (!Number.isFinite(frequency)) continue;

      await db
        .prepare(
          `INSERT INTO fda_observations
             (observation_id, fiscal_year, program_area, citation,
              short_description, long_description, frequency)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(observation_id) DO UPDATE SET
             frequency        = excluded.frequency,
             long_description = excluded.long_description`,
        )
        .run(
          observationId(fiscalYear, citation, shortDescription),
          fiscalYear,
          (colArea ? row.cells.get(colArea) : undefined) ?? DEVICES_SHEET,
          citation,
          shortDescription,
          (colLong ? row.cells.get(colLong) : undefined) ?? null,
          frequency,
        );
      rows++;
      totalCitations += frequency;
    }
  });
  await run();

  return { fiscalYear, rows, totalCitations };
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  await migrateCorpus();

  console.log(
    `Ingesting FDA Inspectional Observation data (Devices) for ` +
      `${OBSERVATION_FILES.length} fiscal years.`,
  );
  console.log(
    `Skipping FY${Math.min(...LEGACY_XLS_YEARS)}-FY${Math.max(...LEGACY_XLS_YEARS)}: ` +
      `legacy OLE2 .xls, not supported.\n`,
  );

  const stats: IngestStats[] = [];
  const failures: { fiscalYear: number; error: string }[] = [];

  for (const { fiscalYear, url } of OBSERVATION_FILES) {
    try {
      const s = await ingestYear(fiscalYear, url, force);
      stats.push(s);
      console.log(
        `  FY${s.fiscalYear}: ${String(s.rows).padStart(4)} distinct observations, ` +
          `${String(s.totalCitations).padStart(5)} total citations`,
      );
    } catch (err) {
      // One bad year should not abort the whole ingest — report and continue,
      // then fail loudly at the end so it can't pass unnoticed.
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ fiscalYear, error: message });
      console.error(`  FY${fiscalYear}: FAILED — ${message}`);
    }
  }

  const db = getCorpusDb();
  const { count } = (await db
    .prepare(`SELECT COUNT(*) AS count FROM fda_observations`)
    .get<{ count: number }>())!;
  console.log(`\n${count} observation rows in the database.`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} fiscal year(s) failed:`);
    for (const f of failures) console.error(`  FY${f.fiscalYear}: ${f.error}`);
    process.exitCode = 1;
  }
}

await main();
