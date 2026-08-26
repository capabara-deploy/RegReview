/**
 * Verify .docx and .pdf extraction against a known-correct baseline.
 *
 * The property that matters is not "did we get some text out" — it is that every
 * finding's offsets land on the right characters. So this checks the things that
 * actually break that:
 *
 *   1. Content: is the substantive text present, in order?
 *   2. Offsets: does every block's [charStart, charEnd) slice of normalizedText
 *      equal that block's own text? If a paragraph is mis-split or a space is
 *      inserted where the offsets were computed without one, this fails.
 *   3. Anchoring: can a quote taken from the middle of the document be located
 *      again? That is exactly what the hallucination guard does at review time.
 *   4. Geometry (PDF only): does every block carry a page and a sane bbox?
 *
 *   npx tsx src/cli/checkFormats.ts <stem>
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { extractRecord } from "@regreview/core";
import { locateQuote } from "@regreview/core";

const FIXTURES = new URL("../../fixtures/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

interface CheckResult {
  format: string;
  ok: boolean;
  notes: string[];
}

async function check(path: string): Promise<CheckResult> {
  const notes: string[] = [];
  let ok = true;
  const fail = (m: string): void => {
    notes.push(`FAIL ${m}`);
    ok = false;
  };
  const pass = (m: string): void => {
    notes.push(`ok   ${m}`);
  };

  const extracted = await extractRecord({ path, recordType: "capa" });
  const { record, blocks } = extracted;

  if (extracted.warning) notes.push(`warn ${extracted.warning}`);

  // 1. Content present.
  const text = record.normalizedText;
  if (text.replace(/\s/g, "").length < 400) {
    fail(`only ${text.length} chars extracted — content is missing`);
  } else {
    pass(`${text.length} chars, ${blocks.length} blocks`);
  }

  // Substantive phrases that must survive any format round-trip, listed in the
  // order they appear in the source. The order is asserted below, so getting it
  // wrong here fails on the Markdown baseline too — which is how the first
  // version of this check caught its own mistake rather than blaming the parsers.
  const required = [
    "CAPA-2026-0142", // header
    "35,000 units are installed", // §1 Problem Statement
    "operator error in seating", // §3 Investigation
    "Severity was rated", // §4 Risk Assessment
    "considered effective", // §6 Effectiveness Verification
  ];
  const missing = required.filter((phrase) => !text.includes(phrase));
  if (missing.length > 0) fail(`missing phrases: ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
  else pass(`all ${required.length} required phrases present`);

  // Order matters: a reordered document would produce findings that reference
  // text out of sequence.
  const positions = required.filter((p) => text.includes(p)).map((p) => text.indexOf(p));
  const ordered = positions.every((p, i) => i === 0 || p > positions[i - 1]!);
  if (!ordered) fail("phrases are out of document order");
  else pass("document order preserved");

  // 2. Offsets agree with block text — the invariant everything depends on.
  let offsetMismatches = 0;
  for (const b of blocks) {
    if (text.slice(b.charStart, b.charEnd) !== b.text) offsetMismatches++;
  }
  if (offsetMismatches > 0) {
    fail(
      `${offsetMismatches} of ${blocks.length} blocks have offsets that do not match their ` +
        `own text — highlights would land on the wrong characters`,
    );
  } else {
    pass(`all ${blocks.length} block offsets match their text exactly`);
  }

  // 3. Anchoring works mid-document, the way it will at review time.
  const middle = blocks[Math.floor(blocks.length / 2)];
  if (middle) {
    const quote = middle.text.split("\n")[0]!.slice(0, 60);
    const located = locateQuote(text, quote);
    if (!located) fail(`could not re-locate a quote taken from block ${middle.ordinal}`);
    else if (text.slice(located.charStart, located.charEnd) !== quote.trim()) {
      fail("located quote does not match the text at those offsets");
    } else pass("mid-document quote anchors correctly");
  }

  // 4. Geometry, for paginated formats.
  if (extracted.format === "pdf") {
    const noPage = blocks.filter((b) => b.page === null).length;
    const badBox = blocks.filter(
      (b) => !b.bbox || b.bbox[2] <= b.bbox[0] || b.bbox[3] <= b.bbox[1],
    ).length;
    if (noPage > 0) fail(`${noPage} block(s) have no page number`);
    else pass(`all blocks carry a page number (${extracted.pageCount} page(s))`);
    if (badBox > 0) fail(`${badBox} block(s) have a degenerate bounding box`);
    else pass("all bounding boxes are non-degenerate");
  }

  return { format: extracted.format, ok, notes };
}

async function main(): Promise<void> {
  const stem = process.argv[2] ?? "capa-001-infusion-pump-alarm";
  const candidates = [`${stem}.md`, `${stem}.docx`, `${stem}.pdf`];

  let allOk = true;
  for (const name of candidates) {
    const path = join(FIXTURES, name);
    if (!existsSync(path)) {
      console.log(`\n--- ${name}: not present, skipped ---`);
      continue;
    }
    console.log(`\n--- ${name} ---`);
    try {
      const result = await check(path);
      for (const note of result.notes) console.log(`  ${note}`);
      if (!result.ok) allOk = false;
    } catch (err) {
      console.log(`  FAIL threw: ${err instanceof Error ? err.message : String(err)}`);
      allOk = false;
    }
  }

  console.log(`\n${allOk ? "PASS" : "FAIL"}: format extraction`);
  if (!allOk) process.exitCode = 1;
}

await main();
