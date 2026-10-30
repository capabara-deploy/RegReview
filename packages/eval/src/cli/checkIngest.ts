/**
 * Verify content-based format detection, coverage reporting, and spreadsheet
 * cell anchoring.
 *
 * The companion to checkFormats.ts (which checks that each format's text and
 * offsets are right). This one checks the two things that make an upload
 * honest: that a file is read as what its bytes say it is, whatever it is
 * named, and that whatever could not be read is reported rather than silently
 * missing. Synthetic inputs are built in a temp directory, so this needs no
 * fixtures beyond fmea-vp400-infusion.xlsx (makeXlsxFixture.ts).
 *
 *   npm run check:ingest
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRecord, locateQuote, UnsupportedFormatError, type ExtractionResult } from "@regreview/core";
import { strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";

const FIXTURES = new URL("../../fixtures/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const dir = mkdtempSync(join(tmpdir(), "regreview-ingest-"));

let failures = 0;
const check = (ok: boolean, label: string, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function extract(name: string, bytes: Uint8Array | string): Promise<ExtractionResult | UnsupportedFormatError> {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  try {
    return await extractRecord({ path, recordType: "capa" });
  } catch (err) {
    if (err instanceof UnsupportedFormatError) return err;
    throw err;
  }
}

const gapKinds = (r: ExtractionResult): string[] => r.coverage.gaps.map((g) => g.kind);

async function pdf(pages: (string | null)[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([612, 792]);
    if (text) page.drawText(text, { x: 72, y: 700, size: 11, font });
    else page.drawRectangle({ x: 72, y: 300, width: 400, height: 300 }); // stands in for a scanned image
  }
  return doc.save();
}

function docx(parts: Record<string, string>): Uint8Array {
  const w = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    ...Object.fromEntries(
      Object.entries(parts).map(([name, body]) => [
        name,
        strToU8(body.replace("$W", w)),
      ]),
    ),
  });
}

const BODY =
  "Corrective and preventive action record. The investigation found that the alarm threshold " +
  "was set below the specified limit on units built after the firmware update, and the cause was confirmed by test.";

console.log("\n--- detection: the bytes decide, not the name ---");
{
  const realPdf = await pdf([BODY]);
  const r = await extract("misnamed.docx", realPdf);
  check(!(r instanceof Error) && r.format === "pdf", "a PDF named .docx is read as PDF");
  check(!(r instanceof Error) && r.coverage.declaredExtension === ".docx", "…and the mismatch is recorded");

  const noExt = await extract("export", realPdf);
  check(!(noExt instanceof Error) && noExt.format === "pdf", "a PDF with no extension is read as PDF");

  const xlsxBytes = new Uint8Array((await import("node:fs")).readFileSync(join(FIXTURES, "fmea-vp400-infusion.xlsx")));
  const asXls = await extract("fmea.xls", xlsxBytes);
  check(!(asXls instanceof Error) && asXls.format === "xlsx", "an .xlsx named .xls is read as XLSX");

  const cases: [string, Uint8Array | string, string][] = [
    ["scan.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), "image"],
    ["old.doc", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]), "ole2"],
    ["notes.rtf", "{\\rtf1\\ansi Hello}", "rtf"],
    ["page.txt", "<!DOCTYPE html><html><body>CAPA</body></html>", "html"],
    ["bundle.zip", zipSync({ "a.txt": strToU8("hello") }), "zip"],
    ["deck.pdf", zipSync({ "ppt/presentation.xml": strToU8("<p/>") }), "pptx"],
    ["blob.txt", new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x41]), "binary"],
  ];
  for (const [name, bytes, kind] of cases) {
    const res = await extract(name, bytes);
    check(res instanceof UnsupportedFormatError && res.kind === kind, `${name} is refused as ${kind}`, res instanceof Error ? res.kind : "accepted");
  }

  const cp1252 = await extract("legacy.txt", Buffer.from(BODY.replace("CAPA", "CAPA") + " Temperature 37\xb0C.", "latin1"));
  check(
    !(cp1252 instanceof Error) && cp1252.record.normalizedText.includes("37°C") && gapKinds(cp1252).includes("legacy_encoding"),
    "Windows-1252 text decodes correctly and says so",
  );
  const utf16 = await extract("utf16.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(BODY, "utf16le")]));
  check(!(utf16 instanceof Error) && utf16.record.normalizedText.startsWith("Corrective"), "UTF-16 text with a BOM decodes");
}

console.log("\n--- coverage: PDF ---");
{
  const partial = await extract("partial.pdf", await pdf([BODY, BODY, null, null]));
  if (partial instanceof Error) throw partial;
  const gap = partial.coverage.gaps.find((g) => g.kind === "image_only_pages");
  check(partial.coverage.status === "partial", "typed PDF with two scanned pages is 'partial'", partial.coverage.status);
  check(gap?.where === "pages 3–4", "the unread pages are named", gap?.where ?? "none");
  check(partial.coverage.units.read === 2 && partial.coverage.units.total === 4, "units read 2 of 4");

  const scanned = await extract("scanned.pdf", await pdf([null, null]));
  if (scanned instanceof Error) throw scanned;
  check(scanned.coverage.status === "unreadable" && !!scanned.warning, "an all-image PDF is 'unreadable', with a warning");

  const clean = await extract("clean.pdf", await pdf([BODY]));
  if (clean instanceof Error) throw clean;
  check(clean.coverage.status === "complete" && !clean.warning, "a fully typed PDF is 'complete' with no warning");
}

console.log("\n--- coverage: DOCX ---");
{
  const p = (t: string): string => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const bytes = docx({
    "word/document.xml":
      `<?xml version="1.0"?><w:document $W><w:body>${p(BODY)}` +
      `<w:p><w:ins w:id="1" w:author="QA"><w:r><w:t>Added by tracked change.</w:t></w:r></w:ins></w:p>` +
      `<w:p><w:del w:id="2" w:author="QA"><w:r><w:delText>Deleted by tracked change.</w:delText></w:r></w:del></w:p>` +
      `</w:body></w:document>`,
    "word/header1.xml": `<?xml version="1.0"?><w:hdr $W>${p("Document No.: CAPA-2026-0199")}${p("Rev: C")}</w:hdr>`,
    "word/media/image1.png": "not really a png",
    "word/comments.xml": `<?xml version="1.0"?><w:comments $W><w:comment w:id="0"><w:p/></w:comment></w:comments>`,
  });
  const r = await extract("capa.docx", bytes);
  if (r instanceof Error) throw r;
  check(r.record.docId === "CAPA-2026-0199" && r.record.revision === "C", "doc id and revision come from the page header", `${r.record.docId} / ${r.record.revision}`);
  for (const kind of ["images", "comments", "tracked_changes", "headers_footers"]) {
    check(gapKinds(r).includes(kind), `reports ${kind}`);
  }
  check(r.record.normalizedText.includes("Added by tracked change."), "tracked insertions are read");
  check(!r.record.normalizedText.includes("Deleted by tracked change."), "tracked deletions are not (read as accepted)");
  check(r.coverage.status === "partial", "a docx with images and pending changes is 'partial'");
}

console.log("\n--- XLSX: rendering, anchors, coverage ---");
{
  const path = join(dir, "fmea.xlsx");
  copyFileSync(join(FIXTURES, "fmea-vp400-infusion.xlsx"), path);
  const r = await extractRecord({ path, recordType: "risk_analysis" });
  const text = r.record.normalizedText;

  check(r.record.docId === "FMEA-VP400" && r.record.revision === "11", "doc id and revision from the title rows", `${r.record.docId} / ${r.record.revision}`);
  check(text.includes("Date:  2026-01-22"), "a date-formatted serial renders as an ISO date");
  check(text.includes("Row 7 | ID: FM-201 | Failure Mode: Spurious occlusion alarm"), "data rows carry their header labels");
  check(text.includes("RPN: =D10*E10*F10 (formula; no saved value)"), "an uncalculated formula is shown as its formula, not dropped");

  let mismatched = 0;
  for (const b of r.blocks) {
    if (text.slice(b.charStart, b.charEnd) !== b.text) mismatched++;
    for (const c of b.cells ?? []) {
      if (c.charStart < b.charStart || c.charEnd > b.charEnd) mismatched++;
    }
  }
  check(mismatched === 0, `all ${r.blocks.length} block and cell offsets are consistent`, `${mismatched} bad`);

  // What review does with a quote: locate it, then resolve it to a cell.
  const quote = "S: 4";
  const at = locateQuote(text, quote);
  const block = at ? r.blocks.find((b) => at.charStart >= b.charStart && at.charStart < b.charEnd) : undefined;
  const cell = block?.cells?.find((c) => at && at.charEnd > c.charStart && at.charStart < c.charEnd);
  check(cell?.ref === "FMEA!D7", `quote "${quote}" resolves to FMEA!D7`, cell?.ref ?? "unresolved");
  check(block?.anchor === "FMEA!A7:G7", "its row anchor is FMEA!A7:G7", block?.anchor ?? "none");

  const multiline = r.blocks.find((b) => b.anchor === "Notes!A4");
  check(!!multiline && multiline.text.includes("\n(RC-118"), "a multi-line cell keeps its line break");

  for (const kind of ["uncalculated_formulas", "formula_values", "conditional_formatting", "merged_cells", "hidden_sheet"]) {
    check(gapKinds(r).includes(kind), `reports ${kind}`);
  }
  check(
    r.coverage.gaps.find((g) => g.kind === "uncalculated_formulas")?.where === "FMEA!G10",
    "the uncalculated cell is named",
  );
  check(text.includes('Sheet "Retired" (hidden in the workbook)'), "the hidden sheet is read and labelled hidden");
  check(r.coverage.status === "partial" && r.coverage.units.read === 3, "status partial, 3 of 3 sheets read");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}: ingest`);
if (failures > 0) process.exitCode = 1;
