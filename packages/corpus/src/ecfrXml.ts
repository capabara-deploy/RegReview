/**
 * Shared parsing for the eCFR versioner API's GPO-style XML.
 *
 * DIV5=part, DIV6=subpart, DIV8=section. Pulled out of ingestCfr.ts so the
 * Subchapter H ingest (many parts, one date) can reuse the same walker
 * instead of re-implementing it.
 */

export interface EcfrNode {
  "@_TYPE"?: string;
  "@_N"?: string;
  HEAD?: unknown;
  P?: unknown;
  DIV6?: EcfrNode | EcfrNode[];
  DIV8?: EcfrNode | EcfrNode[];
  [key: string]: unknown;
}

export function asArray<T>(value: T | T[] | undefined): T[] {
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
export function textOf(value: unknown): string {
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
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function normalizeWhitespace(s: string): string {
  return decodeEntities(s).replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export interface SectionRow {
  section: string;
  subpart: string | null;
  heading: string;
  body: string;
  reserved: boolean;
}

/** Walk a DIV5 (part) node -> DIV6 (subpart) -> DIV8 (section) collecting sections. */
export function collectSections(part: EcfrNode): SectionRow[] {
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

/** Find the DIV5 for `partNumber`, wherever it sits in the returned envelope. */
export function findPartNode(node: unknown, partNumber: string): EcfrNode | undefined {
  if (!node || typeof node !== "object") return undefined;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "DIV5") {
      const candidates = asArray(value as EcfrNode | EcfrNode[]);
      const match = candidates.find((c) => c["@_N"] === partNumber) ?? candidates[0];
      if (match) return match;
    }
    const nested = findPartNode(value, partNumber);
    if (nested) return nested;
  }
  return undefined;
}

export const ECFR_XML_PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep text alongside child elements so inline markup doesn't drop content.
  textNodeName: "#text",
  trimValues: true,
  parseTagValue: false,
  isArray: (name: string) => name === "DIV6" || name === "DIV8" || name === "P",
} as const;
