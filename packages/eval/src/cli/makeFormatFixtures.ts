/**
 * Generate .docx and .pdf fixtures from a Markdown source.
 *
 * Dev tooling, not product. Real customer records arrive as Word and PDF, so the
 * parsers have to be tested against genuine files of those formats — a
 * hand-written unit test over a fake token stream would not have caught the
 * geometry problems that actually matter (line grouping, paragraph gaps,
 * offsets shifting after a mis-split).
 *
 * Generating them from the *same* Markdown the text parser already handles is
 * the point: it gives a known-correct expected text, so the PDF and Word
 * extractions can be compared against a baseline rather than eyeballed.
 *
 *   npx tsx src/cli/makeFormatFixtures.ts <source.md>
 */
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";

const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Build a minimal but valid .docx.
 *
 * A .docx is a zip of OOXML parts. Only three are strictly required for a
 * text-bearing document, which is all mammoth needs to read.
 */
function buildDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map(
      (p) =>
        `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p.replace(/\n/g, " "))}</w:t></w:r></w:p>`,
    )
    .join("");

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body}</w:body></w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" ` +
    `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ` +
    `Target="word/document.xml"/></Relationships>`;

  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rels),
    "word/document.xml": strToU8(documentXml),
  });
}

/**
 * Render paragraphs to a paginated PDF with a real text layer.
 *
 * Deliberately wraps text and breaks pages, because that is what exercises the
 * extractor's line-grouping and paragraph-gap reconstruction. A single-line-per
 * -paragraph PDF would pass trivially and prove nothing.
 */
async function buildPdf(paragraphs: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const fontSize = 11;
  const lineHeight = 15;
  const paragraphGap = 10;
  const margin = 56;
  const pageWidth = 595; // A4 points
  const pageHeight = 842;
  const maxWidth = pageWidth - margin * 2;

  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const newPage = (): void => {
    page = pdf.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  };

  for (const paragraph of paragraphs) {
    const words = paragraph.replace(/\n/g, " ").split(/\s+/).filter(Boolean);
    let line = "";

    const flushLine = (): void => {
      if (line === "") return;
      if (y < margin + lineHeight) newPage();
      page.drawText(line, { x: margin, y, size: fontSize, font });
      y -= lineHeight;
      line = "";
    };

    for (const word of words) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth) {
        flushLine();
        line = word;
      } else {
        line = candidate;
      }
    }
    flushLine();
    // The gap that tells the extractor one paragraph ended and another began.
    y -= paragraphGap;
  }

  return pdf.save();
}

async function main(): Promise<void> {
  const source = process.argv[2];
  if (!source) {
    console.error("usage: makeFormatFixtures <source.md>");
    process.exit(2);
  }

  const raw = await readFile(source, "utf8");

  // Strip Markdown syntax so the generated documents read like real records
  // rather than like Markdown pasted into Word.
  const paragraphs = raw
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) =>
      p
        .replace(/^#{1,6}\s*/gm, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/^\s*[-*]\s+/gm, "")
        .replace(/^-{3,}$/gm, "")
        .trim(),
    )
    .filter((p) => p !== "");

  const dir = dirname(source);
  const stem = basename(source).replace(/\.[^.]+$/, "");

  const docxPath = join(dir, `${stem}.docx`);
  writeFileSync(docxPath, buildDocx(paragraphs));
  console.log(`wrote ${docxPath}  (${paragraphs.length} paragraphs)`);

  const pdfPath = join(dir, `${stem}.pdf`);
  writeFileSync(pdfPath, await buildPdf(paragraphs));
  console.log(`wrote ${pdfPath}`);

  console.log(
    `\nExpected text baseline is the Markdown source with syntax stripped.\n` +
      `Compare extractions against it with:\n` +
      `  npx tsx src/cli/checkFormats.ts ${stem}`,
  );
}

await main();
