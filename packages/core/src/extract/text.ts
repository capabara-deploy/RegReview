import { createHash } from "node:crypto";
import type { Block, RecordDoc, RecordType } from "../types.js";

/**
 * Turn plain text (or Markdown) into a record plus offset-anchored blocks.
 *
 * The single most important property here: `charStart`/`charEnd` are offsets
 * into ONE canonical string, `record.normalizedText`. Everything downstream —
 * the model's quotes, the anchoring guard, the highlight the reviewer sees —
 * uses that same coordinate system. The moment there are two renderings of a
 * document, highlights land in the wrong place, so normalization happens once,
 * here, and the result is stored.
 *
 * Normalization is deliberately conservative: line endings and trailing
 * whitespace only. It is tempting to collapse runs of spaces or strip Markdown
 * syntax, but every character removed shifts every subsequent offset, and a
 * quote the model copied from the text it was shown would stop matching.
 */

export interface BlockingOptions {
  /** Treat lines matching this as headings that scope the blocks beneath them. */
  headingPattern?: RegExp;
}

const DEFAULT_HEADING = /^(#{1,6}\s+.+|\d+(?:\.\d+)*\.?\s+\S.*|[A-Z][A-Z0-9 ,/&'-]{6,}:?)$/;

/** Normalize line endings and strip trailing spaces. Nothing else — see above. */
export function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Split normalized text into paragraph-level blocks.
 *
 * Blocks are paragraph-sized rather than sentence- or page-sized because that
 * is the unit a reviewer reads and the unit a finding is about. Headings are
 * carried as context on each block so a finding can say which section it came
 * from without the model having to guess.
 */
export function blockify(
  recordId: string,
  normalizedText: string,
  options: BlockingOptions = {},
): Block[] {
  const headingPattern = options.headingPattern ?? DEFAULT_HEADING;
  const blocks: Block[] = [];

  let currentHeading: string | null = null;
  let ordinal = 0;
  let cursor = 0;

  // Split on blank lines, but track offsets by walking the original string so
  // the offsets stay true regardless of how the split behaved.
  const chunks = normalizedText.split(/\n{2,}/);

  for (const chunk of chunks) {
    const start = normalizedText.indexOf(chunk, cursor);
    if (start === -1) continue; // Defensive: should not happen.
    const end = start + chunk.length;
    cursor = end;

    const trimmed = chunk.trim();
    if (trimmed === "") continue;

    // A chunk that is a single heading line scopes what follows and is not
    // itself worth flagging, but it still gets a block so offsets are complete.
    const lines = trimmed.split("\n");
    if (lines.length === 1 && headingPattern.test(trimmed)) {
      currentHeading = trimmed.replace(/^#+\s*/, "");
    }

    // Offsets exclude the leading/trailing whitespace inside the chunk so a
    // highlight hugs the visible text.
    const leading = chunk.length - chunk.trimStart().length;
    const trailing = chunk.length - chunk.trimEnd().length;

    blocks.push({
      blockId: `${recordId}:b${ordinal}`,
      recordId,
      ordinal,
      text: trimmed,
      charStart: start + leading,
      charEnd: end - trailing,
      page: null,
      bbox: null,
      heading: currentHeading,
    });
    ordinal++;
  }

  return blocks;
}

/**
 * Build a RecordDoc + blocks from raw text. Used by the eval harness and by the
 * plain-text/Markdown ingest path.
 */
export function recordFromText(args: {
  recordId: string;
  filename: string;
  storedPath: string;
  raw: string;
  recordType?: RecordType;
}): { record: RecordDoc; blocks: Block[] } {
  const normalizedText = normalizeText(args.raw);
  const blocks = blockify(args.recordId, normalizedText);

  // Pull the company's own identifier and revision out of the text rather than
  // assigning one: an investigator asks for "CAPA-2026-0142", not our row id.
  const docId = /\b((?:CAPA|NCR|CR|DCO|COMP)[- ]?\d{2,4}[- ]?\d{1,5})\b/i.exec(
    normalizedText,
  )?.[1];
  // The trailing \b after the Rev/Revision token is load-bearing: without it,
  // "Reviewed by" matches as Rev + "iewed" and the record silently acquires a
  // revision of "iewed". Markdown emphasis is skipped so "**Rev:** 2" works.
  const revision = /\bRev(?:ision)?\b[*_\s]*\.?[*_\s]*[:#]?[*_\s]*([A-Z0-9][A-Z0-9.\-]{0,7})\b/i.exec(
    normalizedText,
  )?.[1];

  return {
    record: {
      recordId: args.recordId,
      filename: args.filename,
      storedPath: args.storedPath,
      sha256: sha256Hex(normalizedText),
      recordType: args.recordType ?? "unknown",
      docId: docId ?? null,
      revision: revision ?? null,
      normalizedText,
      createdAt: new Date().toISOString(),
    },
    blocks,
  };
}

/**
 * Locate a verbatim quote in the record text and return its offsets.
 *
 * This is the hallucination guard. A finding whose quote cannot be found is
 * discarded rather than shown, because a highlight that does not correspond to
 * real text is worse than no highlight: it tells a quality reviewer the tool
 * invents evidence, and that judgment is not recoverable.
 *
 * Whitespace is normalized for comparison only — models reliably reflow line
 * breaks when copying a quote, and rejecting a correct quote over a newline
 * would throw away good findings. Offsets returned always refer to the original
 * text.
 */
export function locateQuote(
  normalizedText: string,
  quote: string,
  searchFrom = 0,
): { charStart: number; charEnd: number } | undefined {
  const trimmed = quote.trim();
  if (trimmed === "") return undefined;

  // Fast path: exact match.
  const exact = normalizedText.indexOf(trimmed, searchFrom);
  if (exact !== -1) return { charStart: exact, charEnd: exact + trimmed.length };

  // Whitespace-tolerant match. Build a regex from the quote where any run of
  // whitespace matches any run of whitespace, escaping everything else.
  const pattern = trimmed
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  if (pattern === "") return undefined;

  const re = new RegExp(pattern, "g");
  re.lastIndex = searchFrom;
  const match = re.exec(normalizedText);
  if (!match) return undefined;

  return { charStart: match.index, charEnd: match.index + match[0].length };
}

/** Which block contains an offset range. */
export function blockContaining(blocks: Block[], charStart: number): Block | undefined {
  return blocks.find((b) => charStart >= b.charStart && charStart <= b.charEnd);
}
