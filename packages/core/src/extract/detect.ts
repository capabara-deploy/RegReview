import { extname } from "node:path";
import { unzipSync } from "fflate";

/**
 * Deciding what a file IS from its bytes, not its name.
 *
 * Extensions lie constantly in the documents this product sees: eQMS exports
 * named ".pdf" that are Word files, ".xls" that are really .xlsx, attachments
 * saved with no extension at all. Trusting the name either rejects a readable
 * file or — worse — reads a binary as UTF-8 text, which produces mojibake that
 * looks enough like a document to be reviewed as one, and reviews clean.
 *
 * So the bytes decide, and the extension is used only where the bytes cannot
 * tell (Markdown and plain text are both just text). Every rejection names
 * what the file actually is and what to do, because "unsupported file type"
 * sends a quality engineer nowhere.
 */

export type SupportedFormat = "text" | "markdown" | "docx" | "pdf" | "xlsx";

export type Detection =
  | {
      ok: true;
      format: SupportedFormat;
      /** For text: how the bytes decode. Always UTF-8 for other formats. */
      encoding?: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";
      /** The file's own extension, when it names a different format than the bytes. */
      mismatchedExtension: string | null;
    }
  | { ok: false; kind: string; message: string };

const EXTENSION_FORMAT: Record<string, SupportedFormat> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".xlsm": "xlsx",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
};

const SUPPORTED_LIST = "PDF, Word (.docx), Excel (.xlsx), Markdown and plain text";

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((b, i) => bytes[offset + i] === b);
}

function asciiPrefix(bytes: Uint8Array, length: number): string {
  return Buffer.from(bytes.subarray(0, length)).toString("latin1");
}

function unsupported(kind: string, what: string, advice: string): Detection {
  return { ok: false, kind, message: `This file is ${what}, which can't be reviewed yet. ${advice}` };
}

/** Part names inside a zip, without inflating any of them. */
function zipEntryNames(bytes: Uint8Array): string[] | undefined {
  const names: string[] = [];
  try {
    unzipSync(bytes, {
      filter: (file) => {
        names.push(file.name);
        return false;
      },
    });
  } catch {
    return undefined;
  }
  return names;
}

/** An OOXML package (or plain zip): which Office application wrote it. */
function detectZip(bytes: Uint8Array): Detection | SupportedFormat {
  const names = zipEntryNames(bytes);
  if (!names) return unsupported("corrupt_zip", "a damaged or incomplete archive", "Re-export it and upload again.");
  const has = (prefix: string): boolean => names.some((n) => n.startsWith(prefix));

  if (has("word/document") || has("word/")) return "docx";
  if (has("xl/workbook")) return "xlsx";
  if (has("ppt/")) {
    return unsupported(
      "pptx",
      "a PowerPoint presentation",
      "Export it to PDF (File → Save As → PDF) and upload that.",
    );
  }
  if (names.includes("mimetype") && has("content.xml")) {
    return unsupported(
      "opendocument",
      "an OpenDocument file (LibreOffice/OpenOffice)",
      "Save it as .docx, .xlsx or PDF and upload that.",
    );
  }
  return unsupported(
    "zip",
    "a zip archive",
    `Unzip it and upload the documents inside individually (${SUPPORTED_LIST}).`,
  );
}

/**
 * Text that is not UTF-8. Old exports from Windows tools are routinely
 * Windows-1252, and refusing them would refuse real records; decoding them as
 * UTF-8 would corrupt every curly quote and degree sign. A NUL byte, though,
 * means binary — no legitimate 8-bit text contains one.
 */
function detectText(bytes: Uint8Array): Detection | "utf-8" | "windows-1252" {
  const sample = bytes.subarray(0, 64 * 1024);
  if (sample.includes(0)) {
    return unsupported(
      "binary",
      "a binary file of a type we don't recognise",
      `Supported formats are ${SUPPORTED_LIST}.`,
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf-8";
  } catch {
    return "windows-1252";
  }
}

export function detectFormat(bytes: Uint8Array, filename: string): Detection {
  const ext = extname(filename).toLowerCase();
  const claimed = EXTENSION_FORMAT[ext];
  const done = (format: SupportedFormat, encoding?: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252"): Detection => ({
    ok: true,
    format,
    ...(encoding ? { encoding } : {}),
    // Markdown vs text is the extension's call, so it can't "mismatch" there.
    mismatchedExtension:
      ext !== "" && claimed !== format && !(format === "text" && claimed === "markdown") ? ext : null,
  });

  if (bytes.length === 0) return { ok: false, kind: "empty", message: "This file is empty." };

  // %PDF- may be preceded by junk (some generators emit a BOM or whitespace);
  // the spec tolerates it within the first 1024 bytes.
  if (asciiPrefix(bytes, 1024).includes("%PDF-")) return done("pdf");

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const zip = detectZip(bytes);
    return typeof zip === "string" ? done(zip) : zip;
  }

  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    // OLE2 compound file: legacy .doc/.xls/.ppt, or an Outlook .msg. The
    // extension is the only cheap way to tell which, and naming the right
    // conversion is the useful part of the message.
    const what =
      ext === ".xls"
        ? "a legacy Excel workbook (.xls)"
        : ext === ".ppt"
          ? "a legacy PowerPoint file (.ppt)"
          : ext === ".msg"
            ? "an Outlook message (.msg)"
            : "a legacy Office file (.doc/.xls/.ppt)";
    const advice =
      ext === ".msg"
        ? "Save the message as PDF, and upload its attachments individually."
        : "Open it in Office and save it in the current format (.docx/.xlsx), or as PDF.";
    return unsupported("ole2", what, advice);
  }

  if (asciiPrefix(bytes, 5) === "{\\rtf") {
    return unsupported("rtf", "a Rich Text (.rtf) document", "Save it as .docx or PDF and upload that.");
  }

  const image: [number[], string][] = [
    [[0x89, 0x50, 0x4e, 0x47], "a PNG image"],
    [[0xff, 0xd8, 0xff], "a JPEG image"],
    [[0x47, 0x49, 0x46, 0x38], "a GIF image"],
    [[0x49, 0x49, 0x2a, 0x00], "a TIFF image"],
    [[0x4d, 0x4d, 0x00, 0x2a], "a TIFF image"],
  ];
  for (const [signature, what] of image) {
    if (startsWith(bytes, signature)) {
      return unsupported(
        "image",
        what,
        "Text in images needs OCR, which isn't available yet. If this is a scan of a typed document, upload the original instead.",
      );
    }
  }

  // UTF-16 text announces itself with a byte-order mark.
  if (startsWith(bytes, [0xff, 0xfe])) return done(claimed === "markdown" ? "markdown" : "text", "utf-16le");
  if (startsWith(bytes, [0xfe, 0xff])) return done(claimed === "markdown" ? "markdown" : "text", "utf-16be");

  const text = detectText(bytes);
  if (typeof text !== "string") return text;

  const head = asciiPrefix(bytes, 512).trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
    return unsupported(
      "html",
      "a web page (HTML)",
      "Print or save it as PDF and upload that.",
    );
  }

  return done(claimed === "markdown" ? "markdown" : "text", text);
}

/** Decode a text file's bytes per its detected encoding, dropping any BOM. */
export function decodeText(bytes: Uint8Array, encoding: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252"): string {
  // TextDecoder strips a leading BOM for the utf-8/utf-16 labels by default.
  return new TextDecoder(encoding).decode(bytes);
}
