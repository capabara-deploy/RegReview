/**
 * Generate fmea-vp400-infusion.xlsx — the Northlake design FMEA as a real
 * workbook, the shape a customer actually sends it in.
 *
 * Dev tooling, not product. Built by hand (fflate + OOXML) rather than with a
 * spreadsheet library for the same reason the reader is hand-rolled, and so the
 * file deliberately carries the features that make real FMEAs hard to read:
 *
 *   - title and "Document No." / "Rev" rows above the header, one of them merged
 *   - a date cell stored as an Excel serial with a date format
 *   - RPN as formulas, with saved values — and one row whose formula has NO
 *     saved value (what tools that write but don't calculate produce)
 *   - conditional formatting on RPN (colour carrying meaning)
 *   - a hidden "Retired" sheet holding a superseded severity rating
 *
 * Content follows fmea-vp400-infusion.md and docs/roadmap/demo-corpus-facts.md;
 * the hidden sheet's S=3 for FM-201 is the pre-2025-08 rating the Markdown's
 * §2.1 says was reviewed and not reduced.
 *
 *   node --import tsx packages/eval/src/cli/makeXlsxFixture.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";

const FIXTURES = new URL("../../fixtures/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Cell =
  | string
  | number
  | { date: number }
  | { formula: string; value?: number };

interface SheetSpec {
  name: string;
  hidden?: boolean;
  rows: [number, Cell[]][];
  merged?: string[];
  conditional?: string;
}

const shared: string[] = [];
function sharedIndex(s: string): number {
  const i = shared.indexOf(s);
  if (i !== -1) return i;
  shared.push(s);
  return shared.length - 1;
}

function colLetter(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetXml(spec: SheetSpec): string {
  const rows = spec.rows
    .map(([r, cells]) => {
      const cs = cells
        .map((cell, i) => {
          const ref = `${colLetter(i)}${r}`;
          if (cell === "") return "";
          if (typeof cell === "string") return `<c r="${ref}" t="s"><v>${sharedIndex(cell)}</v></c>`;
          if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
          if ("date" in cell) return `<c r="${ref}" s="1"><v>${cell.date}</v></c>`;
          return `<c r="${ref}"><f>${esc(cell.formula)}</f>${cell.value === undefined ? "" : `<v>${cell.value}</v>`}</c>`;
        })
        .join("");
      return `<row r="${r}">${cs}</row>`;
    })
    .join("");
  const merged = spec.merged?.length
    ? `<mergeCells count="${spec.merged.length}">${spec.merged.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`
    : "";
  const conditional = spec.conditional
    ? `<conditionalFormatting sqref="${spec.conditional}"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>15</formula></cfRule></conditionalFormatting>`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rows}</sheetData>${merged}${conditional}</worksheet>`
  );
}

const rpn = (r: number, value?: number): Cell => ({ formula: `D${r}*E${r}*F${r}`, ...(value === undefined ? {} : { value }) });

const sheets: SheetSpec[] = [
  {
    name: "FMEA",
    merged: ["A1:G1"],
    conditional: "G7:G10",
    rows: [
      [1, ["Design FMEA — VP-400 Volumetric Infusion Pump"]],
      [2, ["Document No.:", "FMEA-VP400"]],
      [3, ["Rev:", "11"]],
      [4, ["Date:", { date: 46044 }]], // 2026-01-22
      [6, ["ID", "Failure Mode", "Effect", "S", "O", "D", "RPN"]],
      [7, ["FM-201", "Spurious occlusion alarm causing infusion interruption", "Therapy interrupted; possible haemodynamic instability where infusion is vasoactive", 4, 3, 2, rpn(7, 24)]],
      [8, ["FM-202", "Failure to detect true occlusion", "Under-infusion undetected", 5, 2, 3, rpn(8, 30)]],
      [9, ["FM-203", "Cassette seating not detected", "Free-flow risk", 5, 2, 2, rpn(9, 20)]],
      [10, ["FM-204", "Air-in-line sensor drift", "Air embolism risk if alarm suppressed", 5, 1, 3, rpn(10)]],
    ],
  },
  {
    name: "Notes",
    rows: [
      [1, ["Note"]],
      [2, ["Severity for FM-201 was set at 4 (Serious) on the basis that an interruption to a vasoactive infusion can produce a clinically significant haemodynamic response before staff intervene. The rating was reviewed following the 2025-08 hazard analysis update and was not reduced."]],
      [3, ["Any failure mode with a risk index above 15 requires risk control measures and may not be accepted on the basis of annunciation alone."]],
      [4, ["FM-201 at index 24 exceeds the threshold and carries an open risk control action\n(RC-118, cassette channel geometry revision)."]],
    ],
  },
  {
    name: "Retired",
    hidden: true,
    rows: [
      [1, ["ID", "Failure Mode", "S", "Retired"]],
      [2, ["FM-201", "Spurious occlusion alarm", 3, "Superseded by rev 9 (2025-08)"]],
    ],
  },
];

const sheetParts = sheets.map((s) => sheetXml(s));

const workbook =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets>${sheets
    .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ` state="hidden"` : ""} r:id="rId${i + 1}"/>`)
    .join("")}</sheets></workbook>`;

const workbookRels =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join("") +
  `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
  `<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `</Relationships>`;

// cellXfs[1] is the date style (built-in numFmt 14, m/d/yyyy).
const styles =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border/></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>` +
  `<dxfs count="1"><dxf><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs>` +
  `</styleSheet>`;

// Shared strings are collected while building sheets, so this comes last.
const sharedStrings =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
  shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("") +
  `</sst>`;

const contentTypes =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("") +
  `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
  `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
  `</Types>`;

const rootRels =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const zip = zipSync({
  "[Content_Types].xml": strToU8(contentTypes),
  "_rels/.rels": strToU8(rootRels),
  "xl/workbook.xml": strToU8(workbook),
  "xl/_rels/workbook.xml.rels": strToU8(workbookRels),
  "xl/styles.xml": strToU8(styles),
  "xl/sharedStrings.xml": strToU8(sharedStrings),
  ...Object.fromEntries(sheetParts.map((xml, i) => [`xl/worksheets/sheet${i + 1}.xml`, strToU8(xml)])),
});

const out = join(FIXTURES, "fmea-vp400-infusion.xlsx");
writeFileSync(out, zip);
console.log(`wrote ${out} (${zip.length} bytes)`);
