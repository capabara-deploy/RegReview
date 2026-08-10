import { XMLParser } from "fast-xml-parser";
import { CORPUS_VERSION, getCorpusDb, migrateCorpus } from "@regreview/core";
import {
  ECFR_XML_PARSER_OPTIONS,
  collectSections,
  findPartNode,
  normalizeWhitespace,
  textOf,
  type SectionRow,
} from "../ecfrXml.js";
import { fetchCached } from "../fetch.js";
import { CFR_PART_820 } from "../sources.js";

/**
 * Ingest 21 CFR Part 820 from the eCFR versioner API at two dates.
 *
 * Two dates, not one, and this is the point of the whole CLI:
 *
 *  - The QMSR took effect 2026-02-02. After it, Part 820 is titled "Quality
 *    Management System Regulation" and most of it is [Reserved] — §820.30
 *    (design controls) and §820.100 (CAPA) no longer exist as regulation text,
 *    because their substance now enters US law by incorporation by reference to
 *    ISO 13485 via §820.7.
 *  - The legacy (pre-QMSR) text still matters enormously. Historical records
 *    were written against it, every historical 483 citation refers to it, and
 *    it is still how quality staff talk. It is also public domain, whereas its
 *    replacement is not — so for design controls and CAPA this text is the best
 *    quotable statement of the requirement we are legally allowed to hold.
 *
 * Storing both lets a finding cite the clause that governs today while
 * explaining it in the terms the customer actually uses.
 */

const XML_ACCEPT = "application/xml,text/xml,*/*";

async function ingestDate(label: string, date: string, force: boolean): Promise<SectionRow[]> {
  const buf = await fetchCached(CFR_PART_820.urlFor(date), {
    cacheKey: `ecfr-part820-${date}.xml`,
    accept: XML_ACCEPT,
    ...(force ? { force: true } : {}),
  });

  const parser = new XMLParser(ECFR_XML_PARSER_OPTIONS);
  const doc = parser.parse(buf.toString("utf8")) as Record<string, unknown>;

  const part = findPartNode(doc, "820");
  if (!part) throw new Error(`${label}: could not locate DIV5 for Part 820 in the eCFR response`);

  const partTitle = normalizeWhitespace(textOf(part.HEAD));
  const sections = collectSections(part);

  const db = getCorpusDb();

  await db.transaction(async () => {
    for (const s of sections) {
      await db
        .prepare(
          `INSERT INTO cfr_sections
             (cfr_section_id, as_of_date, part, subpart, section, heading, body, reserved)
           VALUES (?, ?, '820', ?, ?, ?, ?, ?)
           ON CONFLICT(as_of_date, section) DO UPDATE SET
             subpart  = excluded.subpart,
             heading  = excluded.heading,
             body     = excluded.body,
             reserved = excluded.reserved`,
        )
        .run(`${date}|${s.section}`, date, s.subpart, s.section, s.heading, s.body, s.reserved);
    }
  })();

  const live = sections.filter((s) => !s.reserved && s.body !== "").length;
  console.log(
    `  ${label} (${date}): part titled "${partTitle}"\n` +
      `    ${sections.length} sections, ${live} with substantive text, ` +
      `${sections.length - live} reserved or empty`,
  );

  return sections;
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  await migrateCorpus();

  console.log(`Ingesting 21 CFR Part 820 (corpus ${CORPUS_VERSION}).\n`);

  const legacy = await ingestDate("legacy QSR", CFR_PART_820.legacyDate, force);
  const current = await ingestDate("current QMSR", CFR_PART_820.currentDate, force);

  // The headline consequence, stated explicitly rather than left to inference.
  console.log("\nWhat QMSR removed from the CFR:");
  const currentLive = new Set(
    current.filter((s) => !s.reserved && s.body !== "").map((s) => s.section),
  );
  const gone = legacy.filter(
    (s) => !s.reserved && s.body !== "" && !currentLive.has(s.section),
  );

  // Console output is kept ASCII-only: Windows terminals default to a legacy
  // code page and render UTF-8 section signs and em dashes as mojibake.
  for (const section of ["820.30", "820.100", "820.198"]) {
    const wasLive = legacy.some((s) => s.section === section && !s.reserved && s.body !== "");
    const isLive = currentLive.has(section);
    console.log(
      `  Sec. ${section.padEnd(8)} legacy: ${wasLive ? "present" : "absent "}  ` +
        `current: ${isLive ? "present" : "RESERVED/absent"}`,
    );
  }
  console.log(
    `\n  ${gone.length} section(s) with substantive text pre-QMSR are no longer live.\n` +
      `  Their requirements now enter US law by incorporation by reference to\n` +
      `  ISO 13485:2016 via Sec. 820.7 -- see NOTICE.md for why that means we\n` +
      `  author our own prose for those expectations instead of ingesting the standard.`,
  );
}

await main();
