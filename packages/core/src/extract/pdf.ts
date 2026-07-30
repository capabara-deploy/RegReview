import type { Block } from "../types.js";

/**
 * PDF text extraction with per-block coordinates.
 *
 * Two outputs, and both are required. The text, assembled into the single
 * canonical string every offset in the system indexes into. And, per block, the
 * page and bounding box — because a reviewer looking at a PDF expects a highlight
 * drawn on the page, not a highlighted line of extracted plain text.
 *
 * pdfjs gives text as a flat list of positioned items with no notion of lines or
 * paragraphs, so the geometry has to be reconstructed: group items into lines by
 * vertical position, then lines into paragraphs by the size of the vertical gap.
 * Getting this wrong does not merely look bad — it shifts every character offset
 * after the mistake, and every finding anchored past that point lands on the
 * wrong text.
 *
 * Scanned PDFs contain no text layer at all and will yield nothing. That is
 * detected and reported rather than silently returning an empty document, since
 * "no findings" on a scanned record would be a dangerous lie. OCR is out of
 * scope for now.
 */

/** One positioned text run, as pdfjs reports it. */
interface TextItem {
  str: string;
  /** [a, b, c, d, e, f] — e and f are x and y in PDF user space. */
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

export interface PdfExtraction {
  normalizedText: string;
  blocks: Omit<Block, "blockId" | "recordId">[];
  pageCount: number;
  /** True when the PDF has pages but essentially no extractable text. */
  likelyScanned: boolean;
}

/**
 * Vertical tolerance, as a fraction of line height, for treating two items as
 * being on the same line. Text runs on one visual line rarely share an exact
 * baseline once superscripts and font changes are involved.
 */
const SAME_LINE_TOLERANCE = 0.5;

/**
 * A vertical gap larger than this multiple of the typical line height starts a
 * new paragraph. Tuned to split on blank lines without splitting ordinary
 * leading.
 */
const PARAGRAPH_GAP_FACTOR = 1.6;

interface Line {
  text: string;
  y: number;
  height: number;
  minX: number;
  maxX: number;
}

function groupIntoLines(items: TextItem[]): Line[] {
  const lines: Line[] = [];

  for (const item of items) {
    if (item.str === "") continue;
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const height = item.height || Math.abs(item.transform[3] ?? 10) || 10;

    const existing = lines.find(
      (l) => Math.abs(l.y - y) <= Math.max(l.height, height) * SAME_LINE_TOLERANCE,
    );

    if (existing) {
      // Insert a space when the runs are not already adjacent. pdfjs splits on
      // font and kerning changes, so mid-word splits are common and must not
      // gain a space.
      const needsSpace =
        !existing.text.endsWith(" ") && !item.str.startsWith(" ") && x > existing.maxX + 1;
      existing.text += (needsSpace ? " " : "") + item.str;
      existing.minX = Math.min(existing.minX, x);
      existing.maxX = Math.max(existing.maxX, x + item.width);
      existing.height = Math.max(existing.height, height);
    } else {
      lines.push({
        text: item.str,
        y,
        height,
        minX: x,
        maxX: x + item.width,
      });
    }
  }

  // PDF user space has y increasing upward, so reading order is descending y.
  return lines.sort((a, b) => b.y - a.y);
}

/** Median line height, used as the scale for paragraph-gap detection. */
function typicalHeight(lines: Line[]): number {
  if (lines.length === 0) return 10;
  const heights = lines.map((l) => l.height).sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)] ?? 10;
}

/**
 * Extract text and geometry from a PDF buffer.
 *
 * `pdfjsLib` is injected rather than imported at module scope: pdfjs-dist's
 * Node entry point is an ESM legacy build whose import has side effects, and
 * keeping it out of the module graph means the rest of the extraction code — and
 * anything that merely imports these types — does not pay for it.
 */
export async function extractPdf(
  data: Uint8Array,
  pdfjsLib: {
    getDocument(src: {
      data: Uint8Array;
      isEvalSupported: boolean;
      standardFontDataUrl?: string;
    }): {
      promise: Promise<{
        numPages: number;
        getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
      }>;
    };
  },
  options: { standardFontDataUrl?: string } = {},
): Promise<PdfExtraction> {
  const doc = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    ...(options.standardFontDataUrl
      ? { standardFontDataUrl: options.standardFontDataUrl }
      : {}),
  }).promise;

  const parts: string[] = [];
  const blocks: Omit<Block, "blockId" | "recordId">[] = [];
  let cursor = 0;
  let ordinal = 0;
  let heading: string | null = null;

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items.filter(
      (i): i is TextItem =>
        typeof i === "object" && i !== null && "str" in i && "transform" in i,
    );

    const lines = groupIntoLines(items);
    if (lines.length === 0) continue;

    const gapThreshold = typicalHeight(lines) * PARAGRAPH_GAP_FACTOR;

    // Accumulate lines into paragraphs.
    let paragraph: Line[] = [];

    const flush = (): void => {
      if (paragraph.length === 0) return;
      const text = paragraph
        .map((l) => l.text.trim())
        .filter((t) => t !== "")
        .join("\n")
        .trim();
      if (text === "") {
        paragraph = [];
        return;
      }

      const charStart = cursor;
      parts.push(text);
      cursor += text.length;
      const charEnd = cursor;
      // Paragraph separator, matching the blank-line convention the plain-text
      // blocker uses so both produce the same shape of canonical string.
      parts.push("\n\n");
      cursor += 2;

      // A short single line in a paragraph of its own reads as a heading; it
      // scopes the blocks that follow, which is what the reviewer sees as
      // section context.
      if (paragraph.length === 1 && text.length < 80 && !/[.;:]$/.test(text)) {
        heading = text;
      }

      blocks.push({
        ordinal: ordinal++,
        text,
        charStart,
        charEnd,
        page: pageNumber,
        // Union of the paragraph's line boxes, in PDF user space. y is the
        // bottom edge, since PDF y increases upward.
        bbox: [
          Math.min(...paragraph.map((l) => l.minX)),
          Math.min(...paragraph.map((l) => l.y)),
          Math.max(...paragraph.map((l) => l.maxX)),
          Math.max(...paragraph.map((l) => l.y + l.height)),
        ],
        heading,
      });
      paragraph = [];
    };

    for (const [i, line] of lines.entries()) {
      const previous = lines[i - 1];
      if (previous) {
        const gap = previous.y - line.y;
        if (gap > gapThreshold) flush();
      }
      paragraph.push(line);
    }
    flush();
  }

  const normalizedText = parts.join("").trimEnd();

  // A PDF with pages but almost no text is a scan. Saying so is important: a
  // review that reports "no findings" on a document it could not read is worse
  // than an error, because it looks like a clean bill of health.
  const likelyScanned = doc.numPages > 0 && normalizedText.replace(/\s/g, "").length < 40;

  return {
    normalizedText,
    blocks,
    pageCount: doc.numPages,
    likelyScanned,
  };
}
