import { XMLParser } from "fast-xml-parser";
import { CORPUS_VERSION, getDb, migrate } from "@regreview/core";
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

/** eCFR returns GPO-style XML: DIV5=part, DIV6=subpart, DIV8=section. */
interface EcfrNode {
  "@_TYPE"?: string;
  "@_N"?: string;
  HEAD?: unknown;
  P?: unknown;
  DIV6?: EcfrNode | EcfrNode[];
  DIV8?: EcfrNode | EcfrNode[];
  [key: string]: unknown;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Flatten a parsed node's text content.
 *
 * eCFR paragraphs contain inline markup (<I>, <E>, citations), so the parser is
 * configured to preserve text nodes and we join them here rather than trying to
 * model every inline element.
 */
function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (typeof value === "object") {
    // "#text" holds the node's own text; other keys are child elements.
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !k.startsWith("@_"))
      .map(([, v]) => textOf(v))
      .join(" ");
  }
  return "";
}

/**
 * Decode XML character references.
 *
 * eCFR uses numeric references liberally — a part heading arrives as
 * "PART 820&#x2014;QUALITY MANAGEMENT SYSTEM REGULATION". fast-xml-parser
 * resolves named entities but leaves these, and storing the raw reference means
 * a reviewer eventually sees `&#x2014;` in the middle of a citation.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeWhitespace(s: string): string {
  return decodeEntities(s).replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

interface SectionRow {
  section: string;
  subpart: string | null;
  heading: string;
  body: string;
  reserved: boolean;
}

/** Walk DIV5 -> DIV6 -> DIV8 collecting sections. */
function collectSections(part: EcfrNode): SectionRow[] {
  const out: SectionRow[] = [];

  const pushSection = (node: EcfrNode, subpart: string | null): void => {
    const heading = normalizeWhitespace(textOf(node.HEAD));
    const body = normalizeWhitespace(textOf(node.P));
    // eCFR marks removed sections by putting "[Reserved]" in the heading.
    const reserved = /\[reserved\]/i.test(heading) || (body === "" && /\[reserved\]/i.test(heading));
    out.push({
      section: node["@_N"] ?? heading.split(/\s+/)[0] ?? "?",
      subpart,
      heading,
      body,
      reserved,
    });
  };

  // Sections can sit directly under the part as well as under a subpart.
  for (const s of asArray(part.DIV8)) pushSection(s, null);

  for (const subpartNode of asArray(part.DIV6)) {
    const subpartLabel = normalizeWhitespace(textOf(subpartNode.HEAD)) || null;
    for (const s of asArray(subpartNode.DIV8)) pushSection(s, subpartLabel);
    // A wholly reserved subpart has a heading but no sections; record it so we
    // can show that a range went away rather than silently having no row.
    if (asArray(subpartNode.DIV8).length === 0 && subpartLabel) {
      out.push({
        section: subpartNode["@_N"] ?? subpartLabel,
        subpart: subpartLabel,
        heading: subpartLabel,
        body: "",
        reserved: /\[reserved\]/i.test(subpartLabel),
      });
    }
  }

  return out;
}

async function ingestDate(label: string, date: string, force: boolean): Promise<SectionRow[]> {
  const buf = await fetchCached(CFR_PART_820.urlFor(date), {
    cacheKey: `ecfr-part820-${date}.xml`,
    accept: XML_ACCEPT,
    ...(force ? { force: true } : {}),
  });

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Keep text alongside child elements so inline markup doesn't drop content.
    textNodeName: "#text",
    trimValues: true,
    parseTagValue: false,
    isArray: (name) => name === "DIV6" || name === "DIV8" || name === "P",
  });

  const doc = parser.parse(buf.toString("utf8")) as Record<string, unknown>;

  // Find the DIV5 for the part, wherever it sits in the returned envelope.
  const findPart = (node: unknown): EcfrNode | undefined => {
    if (!node || typeof node !== "object") return undefined;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "DIV5") {
        const candidates = asArray(value as EcfrNode | EcfrNode[]);
        const match = candidates.find((c) => c["@_N"] === "820") ?? candidates[0];
        if (match) return match;
      }
      const nested = findPart(value);
      if (nested) return nested;
    }
    return undefined;
  };

  const part = findPart(doc);
  if (!part) throw new Error(`${label}: could not locate DIV5 for Part 820 in the eCFR response`);

  const partTitle = normalizeWhitespace(textOf(part.HEAD));
  const sections = collectSections(part);

  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO cfr_sections
       (cfr_section_id, as_of_date, part, subpart, section, heading, body, reserved)
     VALUES (?, ?, '820', ?, ?, ?, ?, ?)
     ON CONFLICT(as_of_date, section) DO UPDATE SET
       subpart  = excluded.subpart,
       heading  = excluded.heading,
       body     = excluded.body,
       reserved = excluded.reserved`,
  );

  db.transaction(() => {
    for (const s of sections) {
      insert.run(
        `${date}|${s.section}`,
        date,
        s.subpart,
        s.section,
        s.heading,
        s.body,
        s.reserved ? 1 : 0,
      );
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
  migrate();

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
