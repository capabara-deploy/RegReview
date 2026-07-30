import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Block, RecordDoc, RecordType } from "../types.js";
import { extractPdf } from "./pdf.js";
import { blockify, normalizeText, recordFromText, sha256Hex } from "./text.js";

/**
 * Reading a customer document, whatever format it arrives in.
 *
 * Real quality records are .docx and .pdf. Supporting only text and Markdown
 * meant nothing a customer could actually send could be reviewed.
 *
 * The invariant every format must preserve: produce ONE canonical
 * `normalizedText`, and blocks whose offsets index into exactly that string.
 * Everything downstream — the quote anchoring guard, the highlight the reviewer
 * clicks, the fact spans the consistency diff points at — depends on there being
 * a single coordinate system. A format that produced a slightly different
 * rendering than the one it computed offsets against would put highlights on the
 * wrong words, and it would do so quietly.
 */

export type SupportedFormat = "text" | "markdown" | "docx" | "pdf";

export interface ExtractionResult {
  record: RecordDoc;
  blocks: Block[];
  format: SupportedFormat;
  /** Page count, for paginated formats. */
  pageCount?: number;
  /** Set when a document appears to have no extractable text layer. */
  warning?: string;
}

export function detectFormat(path: string): SupportedFormat | undefined {
  switch (extname(path).toLowerCase()) {
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".txt":
    case "":
      return "text";
    default:
      return undefined;
  }
}

function recordId(path: string): string {
  return `rec-${basename(path).replace(/\W+/g, "-")}`;
}

/**
 * Extract a reviewable record from a file.
 *
 * Rejects unknown extensions rather than guessing. A .doc (legacy binary Word)
 * or .xls silently read as UTF-8 produces mojibake that looks like a document
 * and would be reviewed as one.
 */
export async function extractRecord(args: {
  path: string;
  recordType?: RecordType;
}): Promise<ExtractionResult> {
  const format = detectFormat(args.path);
  if (!format) {
    throw new Error(
      `unsupported file type: ${extname(args.path) || "(no extension)"}. ` +
        `Supported: .pdf, .docx, .md, .txt. ` +
        `Legacy .doc and .xls are not supported — convert them first.`,
    );
  }

  const filename = basename(args.path);
  const id = recordId(args.path);

  if (format === "pdf") {
    const data = new Uint8Array(await readFile(args.path));
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

    const extracted = await extractPdf(data, pdfjsLib, { standardFontDataUrl });

    const blocks: Block[] = extracted.blocks.map((b, i) => ({
      ...b,
      blockId: `${id}:b${i}`,
      recordId: id,
    }));

    return {
      record: buildRecord({
        recordId: id,
        filename,
        storedPath: args.path,
        normalizedText: extracted.normalizedText,
        recordType: args.recordType ?? "unknown",
      }),
      blocks,
      format,
      pageCount: extracted.pageCount,
      ...(extracted.likelyScanned
        ? {
            warning:
              `"${filename}" has ${extracted.pageCount} page(s) but almost no extractable ` +
              `text — it is very likely a scan. Reviewing it will produce no findings, ` +
              `which must not be read as a clean result. OCR it first.`,
          }
        : {}),
    };
  }

  if (format === "docx") {
    // mammoth's raw-text extraction rather than its HTML conversion: HTML would
    // have to be stripped back to text to compute offsets, and every
    // transformation between the string offsets are computed against and the
    // string the reviewer sees is a chance for highlights to drift.
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ path: args.path });
    const normalizedText = normalizeText(value);
    return {
      record: buildRecord({
        recordId: id,
        filename,
        storedPath: args.path,
        normalizedText,
        recordType: args.recordType ?? "unknown",
      }),
      blocks: blockify(id, normalizedText),
      format,
      ...(normalizedText.replace(/\s/g, "").length < 40
        ? {
            warning:
              `"${filename}" yielded almost no text. If the content is images or ` +
              `embedded objects, it cannot be reviewed as written.`,
          }
        : {}),
    };
  }

  // Text and Markdown.
  const raw = await readFile(args.path, "utf8");
  const built = recordFromText({
    recordId: id,
    filename,
    storedPath: args.path,
    raw,
    ...(args.recordType ? { recordType: args.recordType } : {}),
  });
  return { record: built.record, blocks: built.blocks, format };
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

export { extractPdf } from "./pdf.js";
export * from "./text.js";
