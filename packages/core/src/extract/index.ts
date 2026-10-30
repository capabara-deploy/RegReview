import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Block, Coverage, CoverageGap, RecordDoc, RecordType } from "../types.js";
import { buildCoverage, coverageWarning, formatRanges } from "./coverage.js";
import { decodeText, detectFormat, type SupportedFormat } from "./detect.js";
import { inspectDocx } from "./docx.js";
import { extractPdf } from "./pdf.js";
import { blockify, normalizeText, recordFromText, sha256Hex } from "./text.js";
import { extractXlsx } from "./xlsx.js";

/**
 * Reading a customer document, whatever format it arrives in.
 *
 * Real quality records are .docx, .pdf and .xlsx. Supporting only text and
 * Markdown meant nothing a customer could actually send could be reviewed.
 *
 * The invariant every format must preserve: produce ONE canonical
 * `normalizedText`, and blocks whose offsets index into exactly that string.
 * Everything downstream — the quote anchoring guard, the highlight the reviewer
 * clicks, the fact spans the consistency diff points at — depends on there being
 * a single coordinate system. A format that produced a slightly different
 * rendering than the one it computed offsets against would put highlights on the
 * wrong words, and it would do so quietly.
 *
 * The second invariant: every extraction says what it did NOT read (`coverage`,
 * stored on the record). See `Coverage` in types.ts for why.
 */

export type { SupportedFormat } from "./detect.js";

export interface ExtractionResult {
  record: RecordDoc;
  blocks: Block[];
  format: SupportedFormat;
  /** Page count, for paginated formats. */
  pageCount?: number;
  coverage: Coverage;
  /** One-sentence summary of the coverage gaps, when there are any. */
  warning?: string;
}

/** Thrown for a file whose bytes are not a format we read. `message` is user-facing. */
export class UnsupportedFormatError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

function recordId(path: string): string {
  return `rec-${basename(path).replace(/\W+/g, "-")}`;
}

/**
 * Extract a reviewable record from a file.
 *
 * The format comes from the bytes (see detect.ts); `filename` is the name the
 * file arrived with, which may differ from the stored path and is only a hint.
 * Unknown formats are rejected with a message saying what the file is, rather
 * than guessed at.
 */
export async function extractRecord(args: {
  path: string;
  recordType?: RecordType;
  filename?: string;
}): Promise<ExtractionResult> {
  const bytes = new Uint8Array(await readFile(args.path));
  const filename = basename(args.filename ?? args.path);
  const detection = detectFormat(bytes, filename);
  if (!detection.ok) throw new UnsupportedFormatError(detection.kind, detection.message);

  const { format } = detection;
  const id = recordId(args.path);
  const recordType = args.recordType ?? "unknown";

  const finish = (args2: {
    normalizedText: string;
    blocks: Block[];
    units: Coverage["units"];
    gaps: CoverageGap[];
    pageCount?: number;
    /** Prose formats re-derive metadata from the text; see buildRecord. */
    record?: RecordDoc;
  }): ExtractionResult => {
    const coverage = buildCoverage({
      format,
      declaredExtension: detection.mismatchedExtension,
      units: args2.units,
      normalizedText: args2.normalizedText,
      blocks: args2.blocks.length,
      gaps: args2.gaps,
    });
    const record =
      args2.record ??
      buildRecord({ recordId: id, filename, storedPath: args.path, normalizedText: args2.normalizedText, recordType });
    record.coverage = coverage;
    const warning = coverageWarning(filename, coverage);
    return {
      record,
      blocks: args2.blocks,
      format,
      coverage,
      ...(args2.pageCount !== undefined ? { pageCount: args2.pageCount } : {}),
      ...(warning ? { warning } : {}),
    };
  };

  if (format === "pdf") {
    // Imported here, not at module scope: pdfjs's Node build is heavy and has
    // import side effects, and most documents are not PDFs.
    const pdfjsLib = (await import(
      "pdfjs-dist/legacy/build/pdf.mjs"
    )) as unknown as Parameters<typeof extractPdf>[1];

    // Point pdfjs at its bundled standard-font data. Glyph widths are what the
    // extractor uses to decide whether two text runs are adjacent or need a
    // space between them, so the metrics are worth supplying.
    //
    // Note: pdfjs may still warn that it cannot load a specific font such as
    // LiberationSans — pdfjs-dist bundles Foxit substitutes rather than the full
    // set. That warning is benign: it falls back to built-in metrics, and the
    // format check verifies that every block's offsets still match its text
    // exactly. Do not chase it.
    const standardFontDataUrl = new URL(
      "../../../../node_modules/pdfjs-dist/standard_fonts/",
      import.meta.url,
    ).href;

    // pdfjs takes ownership of (detaches) the buffer it is given, so it gets a copy.
    const extracted = await extractPdf(bytes.slice(), pdfjsLib, { standardFontDataUrl });

    const blocks: Block[] = extracted.blocks.map((b, i) => ({
      ...b,
      blockId: `${id}:b${i}`,
      recordId: id,
    }));

    const gaps: CoverageGap[] = [];
    // A fully scanned PDF is reported by the "unreadable" status; this is for
    // the partial case, which is the one that otherwise hides.
    if (extracted.emptyPages.length > 0 && extracted.emptyPages.length < extracted.pageCount) {
      gaps.push({
        kind: "image_only_pages",
        level: "gap",
        where: `page${extracted.emptyPages.length === 1 ? "" : "s"} ${formatRanges(extracted.emptyPages)}`,
        detail:
          `${extracted.emptyPages.length} page(s) have no text layer — scanned or image-only — and were not read. ` +
          "OCR is not available yet.",
      });
    }

    return finish({
      normalizedText: extracted.normalizedText,
      blocks,
      units: {
        kind: "page",
        total: extracted.pageCount,
        read: extracted.pageCount - extracted.emptyPages.length,
      },
      gaps,
      pageCount: extracted.pageCount,
    });
  }

  if (format === "docx") {
    // mammoth's raw-text extraction rather than its HTML conversion: HTML would
    // have to be stripped back to text to compute offsets, and every
    // transformation between the string offsets are computed against and the
    // string the reviewer sees is a chance for highlights to drift.
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const inspection = inspectDocx(bytes);
    // Header/footer text goes first: it is where a Word record usually states
    // its own document number and revision, which mammoth never sees.
    const head = inspection.headerFooterText.join("\n");
    const normalizedText = normalizeText(head ? `${head}\n\n${value}` : value);
    return finish({
      normalizedText,
      blocks: blockify(id, normalizedText),
      units: { kind: "document", total: 1, read: 1 },
      gaps: inspection.gaps,
    });
  }

  if (format === "xlsx") {
    const extracted = extractXlsx(bytes, id);
    return finish({
      normalizedText: extracted.normalizedText,
      blocks: extracted.blocks,
      units: { kind: "sheet", total: extracted.sheetsTotal, read: extracted.sheetsRead },
      gaps: extracted.gaps,
    });
  }

  // Text and Markdown.
  const encoding = detection.encoding ?? "utf-8";
  const raw = decodeText(bytes, encoding);
  const built = recordFromText({ recordId: id, filename, storedPath: args.path, raw, recordType });
  const gaps: CoverageGap[] =
    encoding === "windows-1252"
      ? [
          {
            kind: "legacy_encoding",
            level: "note",
            where: null,
            detail: "Not UTF-8; decoded as Windows-1252. Check that accented characters and symbols read correctly.",
          },
        ]
      : [];
  return finish({
    normalizedText: built.record.normalizedText,
    blocks: built.blocks,
    units: { kind: "document", total: 1, read: 1 },
    gaps,
    record: built.record,
  });
}

/**
 * Build the record row. Kept in one place so document-identifier and revision
 * extraction behave identically across formats — a .docx CAPA and a Markdown one
 * must yield the same `docId`.
 */
function buildRecord(args: {
  recordId: string;
  filename: string;
  storedPath: string;
  normalizedText: string;
  recordType: RecordType;
}): RecordDoc {
  // Reuse the text path's metadata extraction by running it over the already
  // normalized string; normalizing twice is a no-op.
  const viaText = recordFromText({
    recordId: args.recordId,
    filename: args.filename,
    storedPath: args.storedPath,
    raw: args.normalizedText,
    recordType: args.recordType,
  });

  return {
    ...viaText.record,
    normalizedText: args.normalizedText,
    sha256: sha256Hex(args.normalizedText),
  };
}

export { buildCoverage, coverageWarning } from "./coverage.js";
export { detectFormat, type Detection } from "./detect.js";
export { extractPdf } from "./pdf.js";
export { buildPreview, type DocumentPreview, type PreviewSheet } from "./preview.js";
export { findHeader, openWorkbook, type Sheet, type SheetInfo, type Workbook } from "./xlsxReader.js";
export * from "./text.js";
