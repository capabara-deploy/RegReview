import { getCorpusDb, migrateCorpus, type Db } from "@regreview/core";
import { XMLParser } from "fast-xml-parser";
import {
  ECFR_XML_PARSER_OPTIONS,
  collectSections,
  findPartNode,
  normalizeWhitespace,
  textOf,
} from "../ecfrXml.js";
import { fetchCached } from "../fetch.js";
import { CFR_PART_820, CFR_SUBCHAPTER_H_PARTS, ecfrPartUrl } from "../sources.js";

/**
 * Ingest every part of 21 CFR Subchapter H (Medical Devices) into Neon
 * Postgres, as of one current date.
 *
 * This is reference text, not the rule corpus: nothing in the review pipeline
 * reads this table (see loadRulesFor in packages/core/src/store.ts, which only
 * ever queries the hand-authored `rules` table). It exists so a reviewer or a
 * future rule author can look up what a citation actually says. That is also
 * why one date is enough here, unlike ingestCfr.ts's deliberate two-date
 * Part 820 fetch: the QMSR pre/post split matters because §820.30 and §820.100
 * disappeared from the CFR text, and we need the legacy wording for old
 * findings. The other ~34 parts have no equivalent transition, so only the
 * current text is worth storing.
 */

const XML_ACCEPT = "application/xml,text/xml,*/*";

/** Same date as CFR_PART_820.currentDate, for one consistent as-of date across the table. */
const AS_OF_DATE = CFR_PART_820.currentDate;

async function ingestPart(db: Db, part: number, force: boolean): Promise<void> {
  const buf = await fetchCached(ecfrPartUrl(AS_OF_DATE, part), {
    cacheKey: `ecfr-part${part}-${AS_OF_DATE}.xml`,
    accept: XML_ACCEPT,
    ...(force ? { force: true } : {}),
  });

  const parser = new XMLParser(ECFR_XML_PARSER_OPTIONS);
  const doc = parser.parse(buf.toString("utf8")) as Record<string, unknown>;

  const partNode = findPartNode(doc, String(part));
  if (!partNode) {
    console.log(`  Part ${part}: could not locate DIV5 in the eCFR response, skipping`);
    return;
  }

  const partTitle = normalizeWhitespace(textOf(partNode.HEAD));
  const sections = collectSections(partNode);

  await db.transaction(async () => {
    for (const s of sections) {
      await db
        .prepare(
          `INSERT INTO cfr_sections
             (cfr_section_id, as_of_date, part, subpart, section, heading, body, reserved)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (as_of_date, section) DO UPDATE SET
             subpart  = excluded.subpart,
             heading  = excluded.heading,
             body     = excluded.body,
             reserved = excluded.reserved`,
        )
        .run(
          `${AS_OF_DATE}|${s.section}`,
          AS_OF_DATE,
          String(part),
          s.subpart,
          s.section,
          s.heading,
          s.body,
          s.reserved,
        );
    }
  })();

  const live = sections.filter((s) => !s.reserved && s.body !== "").length;
  console.log(
    `  Part ${part} (${partTitle || "untitled"}): ` +
      `${sections.length} sections, ${live} with substantive text`,
  );
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  await migrateCorpus();
  const db = getCorpusDb();

  console.log(
    `Ingesting 21 CFR Subchapter H (${CFR_SUBCHAPTER_H_PARTS.length} parts) ` +
      `as of ${AS_OF_DATE} into Neon.\n`,
  );

  for (const part of CFR_SUBCHAPTER_H_PARTS) {
    await ingestPart(db, part, force);
  }

  const row = await db
    .prepare(`SELECT count(*) AS count FROM cfr_sections WHERE as_of_date = ?`)
    .get<{ count: number }>(AS_OF_DATE);
  console.log(`\nDone. ${row?.count ?? "?"} total sections stored for ${AS_OF_DATE}.`);
}

await main();
