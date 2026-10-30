import { readFile } from "node:fs/promises";
import { decodeText, detectFormat } from "./detect.js";
import { openWorkbook } from "./xlsxReader.js";

/**
 * What a document looks like, for a person to look at before reviewing it.
 *
 * Deliberately separate from extraction. Extraction produces the one canonical
 * text every offset indexes into; a preview is for recognising the document —
 * "is this the right FMEA, the current revision, the whole thing?" — and is
 * free to look like the original instead. Nothing here is sent to a model, and
 * nothing here may be used to anchor a finding.
 *
 * PDFs are not converted here: the client fetches the original bytes and draws
 * each page itself with pdf.js, so they sit in the same page view as every
 * other format instead of inside the browser's viewer chrome.
 */

export type DocumentPreview =
  | { kind: "pdf" }
  | { kind: "html"; html: string; messages: string[] }
  | { kind: "sheets"; sheets: PreviewSheet[] };

export interface PreviewSheet {
  name: string;
  hidden: boolean;
  /** Column letters in order, A..last used column. */
  columns: string[];
  rows: { rowNumber: number; cells: Record<string, string> }[];
  /** Rows not included because the sheet passed the preview limit. */
  truncatedRows: number;
}

/** A preview is for looking, not reading every row; extraction has its own, higher limit. */
const PREVIEW_ROWS_PER_SHEET = 1000;

function columnIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function columnLetter(index: number): string {
  let s = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export async function buildPreview(path: string, filename: string): Promise<DocumentPreview> {
  const bytes = new Uint8Array(await readFile(path));
  const detection = detectFormat(bytes, filename);
  if (!detection.ok) throw new Error(detection.message);

  switch (detection.format) {
    case "pdf":
      return { kind: "pdf" };

    case "docx": {
      // HTML conversion here (unlike extraction, which uses raw text): layout
      // is the point of a preview. Images come through as data URIs, so the
      // client can render it with no further requests to this server. The
      // client shows it in a sandboxed frame with scripts disabled.
      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
      return { kind: "html", html: result.value, messages: result.messages.map((m) => m.message) };
    }

    case "xlsx": {
      const workbook = openWorkbook(bytes, { dates: true });
      const sheets: PreviewSheet[] = [];
      for (const info of workbook.sheets) {
        const sheet = workbook.getSheet(info.name);
        if (!sheet) continue;
        const shown = sheet.rows.slice(0, PREVIEW_ROWS_PER_SHEET);

        // Uncalculated formulas show as their formula, as in extraction, so
        // the grid doesn't present a blank where Excel would show a value.
        const cells = (row: (typeof shown)[number]): Record<string, string> => {
          const out = Object.fromEntries(row.cells);
          for (const [ref, formula] of sheet.uncachedFormulaText) {
            const m = /^([A-Z]+)(\d+)$/.exec(ref);
            if (m && Number(m[2]) === row.rowNumber) out[m[1]!] = `=${formula}`;
          }
          return out;
        };

        const rows = shown.map((r) => ({ rowNumber: r.rowNumber, cells: cells(r) }));
        const width = Math.max(1, ...rows.flatMap((r) => Object.keys(r.cells).map(columnIndex)));
        sheets.push({
          name: info.name,
          hidden: info.state !== "visible",
          columns: Array.from({ length: width }, (_, i) => columnLetter(i + 1)),
          rows,
          truncatedRows: sheet.rows.length - shown.length,
        });
      }
      return { kind: "sheets", sheets };
    }

    // Text formats go through the same page rendering as Word, so every
    // document in the previewer reads as a document rather than as source.
    case "markdown": {
      const { marked } = await import("marked");
      const html = await marked.parse(decodeText(bytes, detection.encoding ?? "utf-8"), { gfm: true });
      return { kind: "html", html, messages: [] };
    }
    case "text": {
      const text = decodeText(bytes, detection.encoding ?? "utf-8");
      return { kind: "html", html: `<pre class="plain">${escapeHtml(text)}</pre>`, messages: [] };
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
