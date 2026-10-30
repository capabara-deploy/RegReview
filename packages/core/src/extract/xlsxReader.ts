import { strFromU8, unzipSync } from "fflate";

/**
 * A minimal read-only .xlsx reader.
 *
 * Why hand-rolled instead of a library: the npm `xlsx` package is abandoned at
 * 0.18.5 with two unfixed high-severity advisories (prototype pollution,
 * ReDoS), and `exceljs` is unmaintained and drags in a stale `archiver` tree
 * with nine more. That reasoning is stronger now that this reads customer
 * uploads, not just FDA's published sheets: a parser fed untrusted files should
 * be one we can read end to end. One tiny, clean dependency (fflate) does the
 * unzip.
 *
 * Moved here from packages/corpus when customer spreadsheets (FMEAs,
 * traceability matrices) became reviewable records; corpus re-exports it.
 *
 * Deliberately not supported: writing, evaluating formulas, styles beyond
 * "is this number a date", legacy OLE2 .xls. Formulas are read as Excel last
 * saved their value — which is exactly what a reader of the file sees — and a
 * formula with no saved value is reported, never computed.
 *
 * PERFORMANCE, and why the API is lazy. Excel pads sheets out to its
 * 1,048,576-row limit with self-closing <row/> elements. FDA's FY2014 workbook
 * is 25 MB compressed but expands to about 60 MB *per worksheet* across nine
 * worksheets — roughly 540 MB of XML, of which we want one sheet. An eager
 * "parse the whole workbook" API therefore spends almost all of its time
 * decoding sheets the caller will never look at, which is slow enough to look
 * like a hang. So sheet contents are decoded on demand, one sheet at a time.
 */

/** A sheet as a list of rows, each a map of column letter -> cell text. */
export interface Sheet {
  name: string;
  /** 1-based worksheet row number -> { A: "...", B: "..." }. Sparse. */
  rows: { rowNumber: number; cells: Map<string, string> }[];
  /** Cells holding a formula (their text is Excel's last-saved result). */
  formulaCells: string[];
  /** Formula cells with no saved result: the value a reader sees is unknown. */
  uncachedFormulaCells: string[];
  /**
   * The formula text of those cells, where the cell states it (a shared
   * formula's followers don't). Kept so the cell can be shown as what it is —
   * "=D10*E10*F10" — rather than as a blank, which reads as "not assessed".
   */
  uncachedFormulaText: Map<string, string>;
  /** Merged ranges, e.g. "A1:G1". The value sits in the top-left cell only. */
  merged: string[];
  /** The sheet carries a drawing part (charts, images, shapes). */
  hasDrawing: boolean;
  /** Conditional formatting present: colour may carry meaning we don't read. */
  hasConditionalFormatting: boolean;
}

export interface SheetInfo {
  name: string;
  /** Excel's own visibility. veryHidden can only be unhidden from VBA. */
  state: "visible" | "hidden" | "veryHidden";
}

export interface Workbook {
  /** Sheet names in workbook order. */
  sheetNames: string[];
  sheets: SheetInfo[];
  /** Every part path in the package, for callers inspecting what else it holds. */
  parts: string[];
  /** Decode and parse one sheet. Returns undefined if the name is unknown. */
  getSheet(name: string): Sheet | undefined;
}

export interface OpenWorkbookOptions {
  /**
   * Render date-formatted numeric cells as ISO dates rather than Excel serials
   * ("2026-01-22", not "46044"). Off by default so the FDA ingest, which never
   * asked for it, reads exactly what it always has.
   */
  dates?: boolean;
}

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/**
 * Unescape XML entities. `&amp;` must be last: doing it first would turn
 * `&amp;lt;` into `<` instead of the literal `&lt;`.
 */
function unescapeXml(s: string): string {
  return s
    .replace(/&(?:lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** "BC12" -> "BC". Column letters are the stable cell identity; positions are not. */
function columnOf(ref: string): string {
  return /^([A-Z]+)/.exec(ref)?.[1] ?? "";
}

/** Text of every <t> run inside a fragment, concatenated. Skips phonetic <rPh> runs. */
function runsText(fragment: string): string {
  const withoutPhonetic = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  return [...withoutPhonetic.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1] ?? "").join("");
}

/**
 * Parse xl/sharedStrings.xml into an index-addressable array.
 *
 * A single <si> can contain several <t> runs when the cell has mixed
 * formatting; they concatenate into one logical string. Missing that is the
 * classic way to silently truncate rich-text cells.
 */
function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((si) => unescapeXml(runsText(si[1] ?? "")));
}

/** Built-in number formats that are dates or times (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/**
 * Which cell-style indexes (`s="n"` on a cell) format their number as a date.
 *
 * A date in a spreadsheet is a number with a date format, nothing more, so
 * without this a CAPA closure date reads as "46044". Custom formats count as
 * dates when their code has a date/time token outside quoted literals and
 * [colour] sections — "0.00" is not a date, "yyyy-mm-dd" is.
 */
function parseDateStyles(xml: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!xml) return out;

  const customDate = new Set<number>();
  for (const m of xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    const code = unescapeXml(m[2] ?? "")
      .replace(/"[^"]*"/g, "")
      .replace(/\[[^\]]*\]/g, "");
    if (/[dmyhs]/i.test(code)) customDate.add(Number(m[1]));
  }

  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  let index = 0;
  for (const xf of cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const id = Number(/\bnumFmtId="(\d+)"/.exec(xf[1] ?? "")?.[1] ?? 0);
    if (BUILTIN_DATE_FORMATS.has(id) || customDate.has(id)) out.add(index);
    index++;
  }
  return out;
}

/**
 * Excel serial -> ISO date (or date-time when there is a time part).
 *
 * The 1900 system counts from 1899-12-30, which absorbs Lotus 1-2-3's phantom
 * 1900-02-29 for every date after it; earlier dates don't occur in quality
 * records. The 1904 system (old Mac workbooks) is offset by 1462 days.
 */
function serialToIso(serial: number, date1904: boolean): string {
  const days = serial + (date1904 ? 1462 : 0);
  const ms = Math.round(days * 86_400_000) + Date.UTC(1899, 11, 30);
  const iso = new Date(ms).toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
}

interface ParseContext {
  shared: string[];
  dateStyles: Set<number>;
  date1904: boolean;
  dates: boolean;
}

/**
 * Read one worksheet's cells.
 *
 * Two things here are load-bearing:
 *
 * Cells are keyed by column letter rather than by position, because the XML is
 * sparse: an empty cell is simply absent, so the third <c> element in a row is
 * not necessarily column C. Indexing positionally silently shifts columns on
 * any row with a gap.
 *
 * Rows are matched with an alternation that handles self-closing `<row r="9"/>`
 * separately from the paired form. Without that branch, the lazy `[\s\S]*?`
 * after `<row ...>` treats a self-closing row as an opening tag and scans
 * forward to the *next* `</row>`, swallowing a real row's cells into a padding
 * row. With a million padding rows per sheet, that is not a theoretical risk.
 */
function parseSheet(name: string, xml: string, ctx: ParseContext): Sheet {
  const rows: Sheet["rows"] = [];
  const formulaCells: string[] = [];
  const uncachedFormulaCells: string[] = [];
  const uncachedFormulaText = new Map<string, string>();

  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const body = rowMatch[2];
    // Self-closing row: structurally present, no cells. Skip without scanning.
    if (body === undefined) continue;

    const rowNumber = Number(/\br="(\d+)"/.exec(rowMatch[1] ?? "")?.[1] ?? 0);
    const cells = new Map<string, string>();

    // Two cell shapes: self-closing (<c r="A1"/>, always empty) and paired.
    for (const cell of body.matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1] ?? cell[2] ?? "";
      const inner = cell[3] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;

      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const hasFormula = /<f\b/.test(inner);
      let value: string;

      if (type === "inlineStr") {
        value = unescapeXml(runsText(inner));
      } else {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (raw === undefined) {
          // A formula with no saved result — written by a tool that does not
          // calculate, or saved with calculation off. Its value is unknown,
          // and saying so is the caller's job; inventing one is not ours.
          if (hasFormula) {
            formulaCells.push(ref);
            uncachedFormulaCells.push(ref);
            const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
            if (formula) uncachedFormulaText.set(ref, unescapeXml(formula));
          }
          continue;
        }
        if (type === "s") {
          // Shared-string index. Out of range means a malformed file; surface
          // it as empty rather than crashing the whole ingest.
          value = ctx.shared[Number(raw)] ?? "";
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : "FALSE";
        } else {
          value = unescapeXml(raw);
          const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1);
          if (ctx.dates && type === undefined && ctx.dateStyles.has(style) && raw !== "") {
            const serial = Number(raw);
            if (Number.isFinite(serial)) value = serialToIso(serial, ctx.date1904);
          }
        }
      }
      if (hasFormula) formulaCells.push(ref);

      const trimmed = value.trim();
      if (trimmed !== "") cells.set(columnOf(ref), trimmed);
    }

    // Drop rows with no content so callers don't have to filter padding.
    if (cells.size > 0) rows.push({ rowNumber, cells });
  }

  return {
    name,
    rows,
    formulaCells,
    uncachedFormulaCells,
    uncachedFormulaText,
    merged: [...xml.matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"/g)].map((m) => m[1] ?? ""),
    hasDrawing: /<drawing\b/.test(xml),
    hasConditionalFormatting: /<conditionalFormatting\b/.test(xml),
  };
}

/**
 * Open an .xlsx workbook. Sheet contents are decoded lazily by `getSheet`.
 *
 * Throws if the buffer is a legacy OLE2 .xls — callers get a clear message
 * rather than fflate's opaque "invalid zip data".
 */
export function openWorkbook(buf: Uint8Array, options: OpenWorkbookOptions = {}): Workbook {
  const magic = Buffer.from(buf.subarray(0, 4)).toString("hex");
  if (magic === "d0cf11e0") {
    throw new Error(
      "legacy OLE2 .xls format is not supported (only .xlsx). " +
        "FDA published .xls through FY2013 and .xlsx from FY2014 on.",
    );
  }
  if (magic !== "504b0304") {
    throw new Error(`not an .xlsx file (magic bytes ${magic}, expected 504b0304)`);
  }

  const files = unzipSync(buf);
  const text = (path: string): string | undefined => {
    const entry = files[path];
    return entry ? strFromU8(entry) : undefined;
  };

  const workbook = text("xl/workbook.xml");
  if (!workbook) throw new Error("malformed .xlsx: missing xl/workbook.xml");

  // Sheet name -> relationship id, in workbook order. Note the sheet *name* is
  // XML-escaped in this attribute (e.g. "Parts 1240 &amp; 1250"). Attribute
  // order varies between writers, so each attribute is read separately.
  const nameToRid = new Map<string, string>();
  const sheets: SheetInfo[] = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? "";
    const name = unescapeXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? "");
    const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const state = /\bstate="([^"]+)"/.exec(attrs)?.[1];
    nameToRid.set(name, rid);
    sheets.push({ name, state: state === "hidden" || state === "veryHidden" ? state : "visible" });
  }

  // Relationship id -> worksheet path. This indirection is load-bearing:
  // "sheet4.xml" is NOT reliably the 4th sheet in the workbook's own order.
  const rels = text("xl/_rels/workbook.xml.rels") ?? "";
  const ridToTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? "";
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
    if (id && target) ridToTarget.set(id, target.replace(/^\/xl\//, "").replace(/^\.?\//, ""));
  }

  const date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(workbook);

  // Shared strings are small (half a megabyte even in the big workbooks) and
  // needed by every sheet, so this one is eager once any sheet is read.
  let ctx: ParseContext | undefined;
  const cache = new Map<string, Sheet>();

  return {
    sheetNames: [...nameToRid.keys()],
    sheets,
    parts: Object.keys(files),
    getSheet(name: string): Sheet | undefined {
      const cached = cache.get(name);
      if (cached) return cached;

      const rid = nameToRid.get(name);
      if (!rid) return undefined;
      const target = ridToTarget.get(rid);
      if (!target) return undefined;

      const entry = files[`xl/${target}`];
      if (!entry) return undefined;

      ctx ??= {
        shared: parseSharedStrings(text("xl/sharedStrings.xml")),
        dateStyles: options.dates ? parseDateStyles(text("xl/styles.xml")) : new Set(),
        date1904,
        dates: options.dates ?? false,
      };
      const sheet = parseSheet(name, strFromU8(entry), ctx);
      cache.set(name, sheet);
      return sheet;
    },
  };
}

/**
 * Locate a header row and build a case-insensitive column-name -> letter map.
 *
 * FDA's header labels drift between years ("Cite ID" in FY2025 vs "Cite Id" in
 * FY2019), and the header is not always row 1, so it is found by looking for a
 * row that contains all the required labels rather than assumed.
 */
export function findHeader(
  sheet: Sheet,
  required: string[],
): { rowNumber: number; columns: Map<string, string> } | undefined {
  const want = required.map((r) => r.toLowerCase());

  for (const row of sheet.rows.slice(0, 20)) {
    const columns = new Map<string, string>();
    for (const [col, text] of row.cells) {
      columns.set(text.toLowerCase().replace(/\s+/g, " "), col);
    }
    if (want.every((w) => columns.has(w))) {
      return { rowNumber: row.rowNumber, columns };
    }
  }
  return undefined;
}
