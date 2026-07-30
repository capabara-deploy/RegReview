/**
 * Parsing and comparing CFR citations.
 *
 * This exists because the obvious implementation is wrong. FDA's observation
 * data cites paragraphs like "21 CFR 820.100(a)", while our authored rules
 * cross-walk to specific sub-paragraphs like "820.100(a)(1)". To let a rule
 * inherit the citation frequency of the paragraph that contains it, we need an
 * ancestor test — and naive string prefixing gets that wrong in both
 * directions: "820.10" is a string prefix of "820.100" but is a different
 * section entirely, and "820.100(a)" is not a string prefix of "820.100(a)(1)"
 * once you normalize punctuation inconsistently.
 *
 * So: parse into (section, paragraph path) and compare structurally.
 */

export interface ParsedCitation {
  /** e.g. "820.100". Part and section only. */
  section: string;
  /** e.g. ["a", "1"] for (a)(1). Ordered outermost-first. */
  paragraphs: string[];
  /** Canonical round-trippable form, e.g. "820.100(a)(1)". */
  canonical: string;
}

/**
 * Parse a citation in any of the forms these sources use:
 * "21 CFR 820.100(a)", "§ 820.100(a)(1)", "820.30", "21 CFR 803.17".
 * Returns undefined for anything that isn't a recognizable CFR citation.
 */
export function parseCitation(raw: string): ParsedCitation | undefined {
  const cleaned = raw
    .replace(/\s+/g, "")
    .replace(/^21CFR/i, "")
    .replace(/^§+/, "");

  // Part.section, then zero or more parenthesized paragraph components.
  const match = /^(\d+\.\d+)((?:\([0-9a-zA-Z]+\))*)/.exec(cleaned);
  if (!match) return undefined;

  const section = match[1]!;
  const paragraphs = [...(match[2] ?? "").matchAll(/\(([0-9a-zA-Z]+)\)/g)].map((m) =>
    m[1]!.toLowerCase(),
  );

  return {
    section,
    paragraphs,
    canonical: section + paragraphs.map((p) => `(${p})`).join(""),
  };
}

/**
 * Is `a` the same as, or an ancestor of, `b`?
 *
 * 820.100(a) is an ancestor of 820.100(a)(1). 820.100 is an ancestor of both.
 * 820.10 is an ancestor of neither — different section.
 */
export function isSameOrAncestor(a: ParsedCitation, b: ParsedCitation): boolean {
  if (a.section !== b.section) return false;
  if (a.paragraphs.length > b.paragraphs.length) return false;
  return a.paragraphs.every((p, i) => p === b.paragraphs[i]);
}

/**
 * Do two citations refer to overlapping scope in either direction?
 *
 * Used for frequency inheritance, where we want a match if the observed
 * citation contains our rule's paragraph *or* is contained by it:
 *
 *  - rule 820.100(a)(1), FDA cites 820.100(a)  -> inherit (our rule is a part
 *    of the paragraph FDA cited, so that citation count is relevant to it)
 *  - rule 820.100, FDA cites 820.100(a) and (b) -> inherit both (our rule
 *    covers the whole section)
 */
export function isRelated(a: ParsedCitation, b: ParsedCitation): boolean {
  return isSameOrAncestor(a, b) || isSameOrAncestor(b, a);
}
