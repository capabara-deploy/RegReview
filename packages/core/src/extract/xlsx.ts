import type { Block, CellSpan, CoverageGap } from "../types.js";
import { listSome } from "./coverage.js";
import { openWorkbook, type Sheet } from "./xlsxReader.js";

/**
 * Reading a spreadsheet as a reviewable record.
 *
 * FMEAs, hazard analyses and traceability matrices are spreadsheets, and they
 * are the documents a design-history review most needs to read. The engine
 * reads text, so the workbook is rendered to ONE canonical string — like every
 * other format — with one block per row, laid out so both a model and a person
 * can read a row without the grid:
 *
 *   Sheet "FMEA"
 *
 *   Columns (row 4) | A: ID | B: Failure Mode | F: S | G: RPN
 *
 *   Row 5 | ID: FM-201 | Failure Mode: Spurious occlusion alarm | S: 4 | RPN: 24
 *
 * Header labels are repeated on every row on purpose. A row that says "4" means
 * nothing; "S: 4" next to its failure mode is a severity rating the fact
 * extractor can compare against the CAPA that rates the same failure "3". It
 * costs tokens, and it is the difference between reviewing an FMEA and
 * reviewing a list of numbers.
 *
 * Every cell's value keeps its offsets (`Block.cells`), so a finding's quote
 * resolves to the cell an investigator would be pointed at — "FMEA!F5" — rather
 * than to the whole row. The values are rendered verbatim apart from line
 * endings, so a quote copied from the rendering is a quote from the cell.
 */

/**
 * Rows rendered per workbook. A review sends the whole rendering to the model,
 * so this bounds cost on a 50,000-row export; anything beyond it is recorded as
 * an explicit coverage gap with the exact rows not read, never dropped quietly.
 */
export const XLSX_ROW_LIMIT = 5000;

/** How far down a sheet to look for its header row. */
const HEADER_SEARCH_ROWS = 15;

export interface XlsxExtraction {
  normalizedText: string;
  blocks: Block[];
  gaps: CoverageGap[];
  sheetsTotal: number;
  sheetsRead: number;
}

/** Column order: A < B < … < Z < AA. Plain string order would put AA before B. */
function compareColumns(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * A cell's text as rendered. Line endings normalized, trailing spaces per line
 * stripped, and blank lines collapsed — a blank line inside a cell would read as
 * a block boundary to anything that splits the text on paragraphs.
 */
function cellText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const NUMERIC = /^[-+]?[\d.,]+%?$|^\d{4}-\d{2}-\d{2}/;

/**
 * The header row, if the sheet has one: the first row near the top whose cells
 * are all short non-numeric labels and that spans at least half the sheet's
 * width. Title rows above it ("Design FMEA — VP-400", "Document No.: …") are a
 * single cell or a label/value pair and fail the width test, which is what
 * keeps them rendered as themselves rather than mistaken for column names.
 */
function findHeaderRow(sheet: Sheet): Sheet["rows"][number] | undefined {
  const width = Math.max(0, ...sheet.rows.slice(0, 50).map((r) => r.cells.size));
  return sheet.rows.slice(0, HEADER_SEARCH_ROWS).find(
    (row) =>
      row.cells.size >= Math.max(2, Math.ceil(width * 0.5)) &&
      [...row.cells.values()].every((v) => v.length <= 60 && !NUMERIC.test(v.trim())),
  );
}

export function extractXlsx(bytes: Uint8Array, recordId: string): XlsxExtraction {
  const workbook = openWorkbook(bytes, { dates: true });

  const parts: string[] = [];
  const blocks: Block[] = [];
  const gaps: CoverageGap[] = [];
  let cursor = 0;
  let rowsRendered = 0;
  let sheetsRead = 0;

  const emit = (
    text: string,
    heading: string | null,
    anchor: string | null,
    cells: { ref: string; start: number; end: number }[] = [],
  ): void => {
    if (parts.length > 0) {
      parts.push("\n\n");
      cursor += 2;
    }
    const charStart = cursor;
    parts.push(text);
    cursor += text.length;
    const spans: CellSpan[] = cells.map((c) => ({
      ref: c.ref,
      charStart: charStart + c.start,
      charEnd: charStart + c.end,
    }));
    blocks.push({
      blockId: `${recordId}:b${blocks.length}`,
      recordId,
      ordinal: blocks.length,
      text,
      charStart,
      charEnd: cursor,
      page: null,
      bbox: null,
      heading,
      anchor,
      cells: spans.length > 0 ? spans : null,
    });
  };

  /**
   * One row as "Row N | label: value | …". `labels` null means the row is
   * above the header (a title or "Document No.: X" line): its values are joined
   * with plain spaces so "Rev:" and "11" in adjacent cells still read as
   * "Rev: 11" to the same id/revision extraction every other format gets.
   */
  const renderRow = (
    sheetName: string,
    prefix: string,
    rowNumber: number,
    cells: Map<string, string>,
    labels: Map<string, string> | null,
  ): { text: string; cells: { ref: string; start: number; end: number }[] } => {
    let text = prefix;
    const spans: { ref: string; start: number; end: number }[] = [];
    const columns = [...cells.keys()].sort(compareColumns);
    columns.forEach((col) => {
      const value = cellText(cells.get(col) ?? "");
      if (value === "") return;
      if (labels) {
        text += `${spans.length === 0 ? "" : " | "}${labels.get(col) ?? col}: `;
      } else if (spans.length > 0) {
        text += "  ";
      }
      spans.push({ ref: `${sheetName}!${col}${rowNumber}`, start: text.length, end: text.length + value.length });
      text += value;
    });
    return { text, cells: spans };
  };

  for (const info of workbook.sheets) {
    const sheet = workbook.getSheet(info.name);
    const hidden = info.state !== "visible";
    const heading = `Sheet "${info.name}"`;

    if (rowsRendered >= XLSX_ROW_LIMIT) {
      gaps.push({
        kind: "row_limit",
        level: "gap",
        where: `sheet "${info.name}"`,
        detail: `Not read: the workbook passed the ${XLSX_ROW_LIMIT}-row review limit before this sheet.`,
      });
      continue;
    }
    if (!sheet) {
      gaps.push({
        kind: "unreadable_sheet",
        level: "gap",
        where: `sheet "${info.name}"`,
        detail: "This sheet could not be read (it is a chart sheet, or its part is missing).",
      });
      continue;
    }
    sheetsRead++;

    emit(heading + (hidden ? " (hidden in the workbook)" : ""), heading, info.name);
    if (hidden) {
      gaps.push({
        kind: "hidden_sheet",
        level: "note",
        where: `sheet "${info.name}"`,
        detail:
          "Hidden in the workbook. It was read, and its rows are marked as coming from a hidden sheet — " +
          "hidden rows are often retired content, so weigh findings on them accordingly.",
      });
    }
    if (sheet.rows.length === 0) {
      gaps.push({ kind: "empty_sheet", level: "note", where: `sheet "${info.name}"`, detail: "This sheet is empty." });
      continue;
    }

    // Formula cells with no saved value are shown as their formula rather than
    // silently absent. A blank RPN reads as "not assessed" — a finding about the
    // document that isn't true, since Excel would show the computed value on
    // opening. The formula lets a reader see what it computes; we still don't
    // evaluate it, so the value never claims more than the file holds.
    const uncached = new Map<number, string[]>();
    for (const ref of sheet.uncachedFormulaCells) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      if (!m) continue;
      const list = uncached.get(Number(m[2])) ?? [];
      list.push(m[1]!);
      uncached.set(Number(m[2]), list);
    }

    const header = findHeaderRow(sheet);
    const labels = header
      ? new Map([...header.cells].map(([col, v]) => [col, cellText(v).replace(/\s*\n\s*/g, " ")]))
      : null;

    for (const [index, row] of sheet.rows.entries()) {
      if (rowsRendered >= XLSX_ROW_LIMIT) {
        const remaining = sheet.rows.slice(index);
        gaps.push({
          kind: "row_limit",
          level: "gap",
          where: `${info.name}!rows ${remaining[0]!.rowNumber}–${remaining[remaining.length - 1]!.rowNumber}`,
          detail: `Not read: ${remaining.length} rows past the ${XLSX_ROW_LIMIT}-row review limit.`,
        });
        break;
      }
      const cells = new Map(row.cells);
      for (const col of uncached.get(row.rowNumber) ?? []) {
        const formula = sheet.uncachedFormulaText.get(`${col}${row.rowNumber}`);
        cells.set(col, formula ? `=${formula} (formula; no saved value)` : "(formula; no saved value)");
      }

      const isHeader = row === header;
      const beforeHeader = header !== undefined && row.rowNumber < header.rowNumber;
      const rendered = isHeader
        ? renderRow(info.name, `Columns (row ${row.rowNumber}) | `, row.rowNumber, cells, new Map([...cells.keys()].map((c) => [c, c])))
        : renderRow(info.name, `Row ${row.rowNumber} | `, row.rowNumber, cells, beforeHeader ? null : labels);

      const cols = [...cells.keys()].sort(compareColumns);
      const anchor = `${info.name}!${cols[0]}${row.rowNumber}${cols.length > 1 ? `:${cols[cols.length - 1]}${row.rowNumber}` : ""}`;
      emit(rendered.text, heading + (hidden ? " (hidden)" : ""), anchor, rendered.cells);
      rowsRendered++;
    }

    if (sheet.uncachedFormulaCells.length > 0) {
      gaps.push({
        kind: "uncalculated_formulas",
        level: "gap",
        where: `${info.name}!${listSome(sheet.uncachedFormulaCells)}`,
        detail:
          `${sheet.uncachedFormulaCells.length} formula cell(s) have no saved value, so what they show in Excel is unknown. ` +
          "Open and re-save the workbook in Excel to store their values.",
      });
    }
    const cached = sheet.formulaCells.length - sheet.uncachedFormulaCells.length;
    if (cached > 0) {
      gaps.push({
        kind: "formula_values",
        level: "note",
        where: `sheet "${info.name}"`,
        detail: `${cached} cell(s) are formulas; their values are as Excel last saved them, not recalculated.`,
      });
    }
    if (sheet.hasDrawing) {
      gaps.push({
        kind: "drawings",
        level: "gap",
        where: `sheet "${info.name}"`,
        detail: "Has charts, images or shapes; their content was not read.",
      });
    }
    if (sheet.hasConditionalFormatting) {
      gaps.push({
        kind: "conditional_formatting",
        level: "note",
        where: `sheet "${info.name}"`,
        detail:
          "Uses conditional formatting. Cell colour is not read — if colour marks acceptability " +
          "(a red RPN, say), that meaning is not part of the review.",
      });
    }
    if (sheet.merged.length > 0) {
      gaps.push({
        kind: "merged_cells",
        level: "note",
        where: `sheet "${info.name}"`,
        detail: `${sheet.merged.length} merged range(s); each value is read once, at its top-left cell.`,
      });
    }
  }

  // Workbook-level parts we don't read. Each is a place content can live that
  // the review never saw.
  const count = (re: RegExp): number => workbook.parts.filter((p) => re.test(p)).length;
  const comments = count(/^xl\/(comments\d*|threadedComments\/[^/]+)\.xml$/);
  if (comments > 0) {
    gaps.push({ kind: "comments", level: "gap", where: null, detail: "Cell comments and notes were not read." });
  }
  if (count(/^xl\/embeddings\//) > 0) {
    gaps.push({
      kind: "embedded_objects",
      level: "gap",
      where: null,
      detail: "Embedded objects (documents or files inside the workbook) were not read.",
    });
  }
  if (count(/^xl\/externalLinks\//) > 0) {
    gaps.push({
      kind: "external_links",
      level: "note",
      where: null,
      detail: "Some values link to other workbooks; they are as last saved, and the linked files were not read.",
    });
  }
  if (count(/^xl\/vbaProject\.bin$/) > 0) {
    gaps.push({ kind: "macros", level: "note", where: null, detail: "The workbook contains macros; they were not run." });
  }

  return {
    normalizedText: parts.join(""),
    blocks,
    gaps,
    sheetsTotal: workbook.sheets.length,
    sheetsRead,
  };
}
