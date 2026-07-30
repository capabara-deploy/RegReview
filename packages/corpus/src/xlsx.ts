import { strFromU8, unzipSync } from "fflate";

/**
 * A minimal read-only .xlsx reader.
 *
 * Why hand-rolled instead of a library: the npm `xlsx` package is abandoned at
 * 0.18.5 with two unfixed high-severity advisories (prototype pollution,
 * ReDoS), and `exceljs` is unmaintained and drags in a stale `archiver` tree
 * with nine more. We only ever *read* simple tabular sheets published by FDA,
 * which is a small enough job to own outright — and it keeps the dependency
 * count at one tiny, clean library (fflate) for the unzip.
 *
 * Deliberately not supported: writing, formulas, styles, dates-as-serials,
 * merged cells, legacy OLE2 .xls. If you need any of those, reconsider rather
 * than growing this file.
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
}

export interface Workbook {
  /** Sheet names in workbook order. */
  sheetNames: string[];
  /** Decode and parse one sheet. Returns undefined if the name is unknown. */
  getSheet(name: string): Sheet | undefined;
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

/**
 * Parse xl/sharedStrings.xml into an index-addressable array.
 *
 * A single <si> can contain several <t> runs when the cell has mixed
 * formatting; they concatenate into one logical string. Missing that is the
 * classic way to silently truncate rich-text cells.
 */
function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((si) =>
    unescapeXml(
      [...(si[1] ?? "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1] ?? "").join(""),
    ),
  );
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
function parseSheet(name: string, xml: string, shared: string[]): Sheet {
  const rows: Sheet["rows"] = [];

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
      let value: string;

      if (type === "inlineStr") {
        value = unescapeXml(
          [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1] ?? "").join(""),
        );
      } else {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (raw === undefined) continue;
        if (type === "s") {
          // Shared-string index. Out of range means a malformed file; surface
          // it as empty rather than crashing the whole ingest.
          value = shared[Number(raw)] ?? "";
        } else {
          value = unescapeXml(raw);
        }
      }

      const trimmed = value.trim();
      if (trimmed !== "") cells.set(columnOf(ref), trimmed);
    }

    // Drop rows with no content so callers don't have to filter padding.
    if (cells.size > 0) rows.push({ rowNumber, cells });
  }

  return { name, rows };
}

/**
 * Open an .xlsx workbook. Sheet contents are decoded lazily by `getSheet`.
 *
 * Throws if the buffer is a legacy OLE2 .xls — callers get a clear message
 * rather than fflate's opaque "invalid zip data".
 */
export function openWorkbook(buf: Uint8Array): Workbook {
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
  // XML-escaped in this attribute (e.g. "Parts 1240 &amp; 1250").
  const nameToRid = new Map<string, string>();
  for (const m of workbook.matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]+)"/g)) {
    nameToRid.set(unescapeXml(m[1] ?? ""), m[2] ?? "");
  }

  // Relationship id -> worksheet path. This indirection is load-bearing:
  // "sheet4.xml" is NOT reliably the 4th sheet in the workbook's own order.
  const rels = text("xl/_rels/workbook.xml.rels") ?? "";
  const ridToTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g)) {
    const target = (m[2] ?? "").replace(/^\/xl\//, "").replace(/^\.?\//, "");
    ridToTarget.set(m[1] ?? "", target);
  }

  // Shared strings are small (half a megabyte even in the big workbooks) and
  // needed by every sheet, so this one is eager.
  let shared: string[] | undefined;
  const cache = new Map<string, Sheet>();

  return {
    sheetNames: [...nameToRid.keys()],
    getSheet(name: string): Sheet | undefined {
      const cached = cache.get(name);
      if (cached) return cached;

      const rid = nameToRid.get(name);
      if (!rid) return undefined;
      const target = ridToTarget.get(rid);
      if (!target) return undefined;

      const entry = files[`xl/${target}`];
      if (!entry) return undefined;

      shared ??= parseSharedStrings(text("xl/sharedStrings.xml"));
      const sheet = parseSheet(name, strFromU8(entry), shared);
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
