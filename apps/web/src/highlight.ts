import type { Finding, Severity } from "./api";

/**
 * Splitting document text into renderable segments.
 *
 * The naive approach — wrap each finding's span in a <mark> — breaks as soon as
 * two findings overlap, which they routinely do: a compliance finding about a
 * whole paragraph and a plausibility finding about one sentence inside it are
 * both legitimate and both anchored. Nested or sibling <mark> elements produced
 * by independent wrapping either drop text or duplicate it.
 *
 * So instead: collect every finding boundary, cut the text at those boundaries,
 * and give each resulting segment the full list of findings covering it. Every
 * character of the document appears in exactly one segment, in order, which
 * makes it impossible to lose or duplicate text no matter how findings overlap.
 */

export interface Segment {
  text: string;
  charStart: number;
  /** Findings covering this segment, outermost first. Empty for plain text. */
  findings: Finding[];
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** The finding that should determine a segment's appearance: most severe wins. */
export function dominant(findings: Finding[]): Finding | undefined {
  return [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  )[0];
}

export function segment(text: string, findings: Finding[]): Segment[] {
  if (findings.length === 0) {
    return [{ text, charStart: 0, findings: [] }];
  }

  // Every start and end is a cut point, plus the document ends.
  const cuts = new Set<number>([0, text.length]);
  for (const f of findings) {
    // Clamp defensively: an offset outside the text would silently produce
    // empty or reversed segments.
    cuts.add(Math.max(0, Math.min(f.charStart, text.length)));
    cuts.add(Math.max(0, Math.min(f.charEnd, text.length)));
  }

  const bounds = [...cuts].sort((a, b) => a - b);
  const segments: Segment[] = [];

  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!;
    const end = bounds[i + 1]!;
    if (end <= start) continue;

    const covering = findings
      .filter((f) => f.charStart <= start && f.charEnd >= end)
      // Widest span first, so a nested finding renders inside its container.
      .sort((a, b) => b.charEnd - b.charStart - (a.charEnd - a.charStart));

    segments.push({ text: text.slice(start, end), charStart: start, findings: covering });
  }

  return segments;
}
