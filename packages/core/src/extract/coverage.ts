import type { Coverage, CoverageGap } from "../types.js";

/**
 * Below this many non-whitespace characters a document is "unreadable": any
 * review of it would be empty, and an empty review reads as a clean one.
 */
const UNREADABLE_CHARS = 40;

export function buildCoverage(args: {
  format: string;
  declaredExtension: string | null;
  units: Coverage["units"];
  normalizedText: string;
  blocks: number;
  gaps: CoverageGap[];
}): Coverage {
  const characters = args.normalizedText.replace(/\s/g, "").length;
  const gaps = [...args.gaps];
  if (args.declaredExtension) {
    gaps.unshift({
      kind: "extension_mismatch",
      level: "note",
      where: null,
      detail: `Named ${args.declaredExtension} but the file is ${args.format.toUpperCase()}; it was read as ${args.format.toUpperCase()}.`,
    });
  }
  const status: Coverage["status"] =
    characters < UNREADABLE_CHARS
      ? "unreadable"
      : gaps.some((g) => g.level === "gap")
        ? "partial"
        : "complete";
  return {
    format: args.format,
    declaredExtension: args.declaredExtension,
    units: args.units,
    characters,
    blocks: args.blocks,
    status,
    gaps,
  };
}

/**
 * One sentence for the upload response, or nothing when the read was complete.
 * The full list lives on the record; this is the part that must not be missed
 * at the moment of upload.
 */
export function coverageWarning(filename: string, coverage: Coverage): string | undefined {
  if (coverage.status === "unreadable") {
    return (
      `"${filename}" yielded almost no text, so a review of it would produce no findings — ` +
      `which must not be read as a clean result.` +
      (coverage.format === "pdf" ? " It is very likely a scan; OCR it first." : "")
    );
  }
  const gaps = coverage.gaps.filter((g) => g.level === "gap");
  if (gaps.length === 0) return undefined;
  const parts = gaps.map((g) => (g.where ? `${g.where}: ${g.detail}` : g.detail));
  return `"${filename}" was only partly read: ${parts.join(" ")} Findings cannot cover what was not read.`;
}

/** [3,4,5,9] -> "3–5, 9". */
export function formatRanges(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!;
    let end = start;
    while (sorted[i + 1] === end + 1) end = sorted[++i]!;
    out.push(end === start ? `${start}` : `${start}–${end}`);
  }
  return out.join(", ");
}

/** A bounded list: "F12, F15, F19 and 40 more". */
export function listSome(items: string[], max = 10): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}
