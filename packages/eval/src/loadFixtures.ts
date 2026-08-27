import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { extractRecord, type Block, type RecordDoc } from "@regreview/core";
import { FixtureMetaChecked, type Fixture, type ResolvedLabel } from "./types.js";

/**
 * Load evaluation fixtures.
 *
 * A fixture is a document file plus a `<id>.labels.json` sidecar validated
 * against `FixtureMeta`. The loader's contract is that a fixture either loads
 * clean or fails loudly:
 *
 *  - every label `anchor` must be found verbatim in the SAME normalized text the
 *    engine offsets into (produced by `extractRecord`, not the raw file), so a
 *    label whose anchor drifted out of sync with edited fixture prose is a hard
 *    error, not a silently unsatisfiable expectation that drags recall down;
 *  - every label `ruleId` must exist in the corpus (checked when the caller
 *    supplies the known-rule set), because a label naming a renamed rule can
 *    never be matched and would understate the engine for no reason.
 *
 * Both checks exist because the alternative — a fixture that loads with broken
 * labels — produces a precision/recall number that looks real and is wrong, and
 * a wrong accuracy number is worse than none with this audience.
 */

export interface LoadedFixture extends Fixture {
  /** The extracted record, ready to hand to a review engine. */
  record: RecordDoc;
  blocks: Block[];
  /** Related documents (for cross-document consistency), extracted. */
  relatedDocs: { record: RecordDoc; blocks: Block[] }[];
}

/** Resolve an anchor string to a [start, end) span in the normalized text. */
function resolveAnchor(
  normalizedText: string,
  anchor: string,
  context: string,
): { charStart: number; charEnd: number } {
  const charStart = normalizedText.indexOf(anchor);
  if (charStart === -1) {
    throw new Error(
      `${context}: anchor not found verbatim in the document.\n` +
        `  anchor: ${JSON.stringify(anchor.slice(0, 80))}${anchor.length > 80 ? "…" : ""}\n` +
        `  The anchor must be an exact substring of the extracted (normalized) text. ` +
        `Fixture prose was probably edited without updating the label.`,
    );
  }
  // A second occurrence means the anchor is ambiguous; the first is used, but
  // warn so the fixture author can tighten it if the wrong span gets matched.
  if (normalizedText.indexOf(anchor, charStart + 1) !== -1) {
    console.warn(
      `${context}: anchor appears more than once; using the first occurrence. ` +
        `Consider a longer, unique anchor: ${JSON.stringify(anchor.slice(0, 60))}`,
    );
  }
  return { charStart, charEnd: charStart + anchor.length };
}

/** Path to the label sidecar for a document file. */
export function labelsPathFor(documentPath: string): string {
  const dir = dirname(documentPath);
  const base = basename(documentPath).replace(/\.(md|txt|pdf|docx)$/i, "");
  return join(dir, `${base}.labels.json`);
}

/**
 * Load one fixture and everything it needs to be reviewed and scored.
 *
 * `knownRuleIds`, when supplied, enables the rule-existence check. Omit it for a
 * pure load (e.g. a unit test with no corpus).
 *
 * `resolveRelated` maps a related fixture id to its document path, so the
 * cross-document fixtures load their companions. A missing companion is a hard
 * error for the same reason a missing anchor is: a consistency label that can
 * never fire silently costs recall.
 */
export async function loadFixture(
  documentPath: string,
  opts: {
    knownRuleIds?: Set<string>;
    resolveRelated?: (fixtureId: string) => string | undefined;
  } = {},
): Promise<LoadedFixture> {
  const labelsPath = labelsPathFor(documentPath);
  if (!existsSync(labelsPath)) {
    throw new Error(
      `no label file for ${basename(documentPath)} (expected ${basename(labelsPath)}). ` +
        `Every eval fixture needs a labels sidecar.`,
    );
  }

  const rawLabels: unknown = JSON.parse(await readFile(labelsPath, "utf8"));
  const parsed = FixtureMetaChecked.safeParse(rawLabels);
  if (!parsed.success) {
    throw new Error(
      `invalid label file ${basename(labelsPath)}:\n  ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\n  ")}`,
    );
  }
  const meta = parsed.data;

  // Extract the document exactly as the engine will, so label offsets index into
  // the same canonical string as every finding offset.
  const extraction = await extractRecord({ path: documentPath, recordType: meta.recordType });
  const normalizedText = extraction.record.normalizedText;
  const raw = await readFile(documentPath, "utf8");

  // Optional rule-existence check.
  if (opts.knownRuleIds) {
    const missing = [...new Set(meta.expected.map((e) => e.ruleId))].filter(
      (id) => !opts.knownRuleIds!.has(id),
    );
    if (missing.length > 0) {
      throw new Error(
        `${basename(labelsPath)} references ${missing.length} rule id(s) not in the corpus: ` +
          `${missing.join(", ")}. A label can only be matched against a rule that exists.`,
      );
    }
  }

  const labels: ResolvedLabel[] = meta.expected.map((e, i) => ({
    ...e,
    ...resolveAnchor(normalizedText, e.anchor, `${meta.id} expected[${i}]`),
  }));

  const distractors = meta.distractors.map((d, i) => ({
    ...d,
    ...resolveAnchor(normalizedText, d.anchor, `${meta.id} distractor[${i}]`),
  }));

  // Load related documents for cross-document consistency.
  const relatedDocs: LoadedFixture["relatedDocs"] = [];
  for (const relId of meta.related) {
    const relPath = opts.resolveRelated?.(relId);
    if (!relPath) {
      throw new Error(
        `${meta.id} declares related fixture "${relId}" but no path could be resolved for it. ` +
          `A cross-document label that never fires silently costs recall.`,
      );
    }
    const relExtraction = await extractRecord({ path: relPath });
    relatedDocs.push({ record: relExtraction.record, blocks: relExtraction.blocks });
  }

  return {
    meta,
    documentPath,
    raw,
    labels,
    distractors,
    record: extraction.record,
    blocks: extraction.blocks,
    relatedDocs,
  };
}

/**
 * Discover every fixture (every document with a labels sidecar) in a directory.
 *
 * A labels sidecar is keyed by base name, and a fixture may exist in several
 * formats (`capa-001.md`, `.docx`, `.pdf` — the format-conversion siblings the
 * checkFormats tooling produces). Only ONE is scored, and it must be the format
 * the anchors were authored against: markdown/text preserve the `**bold**` and
 * spacing the label anchors quote verbatim, whereas .docx/.pdf extraction strips
 * them, so a markdown anchor would never resolve there. Prefer .md, then .txt.
 */
export function fixtureDocumentsIn(dir: string): string[] {
  const preference = [".md", ".txt", ".docx", ".pdf"];
  const byBase = new Map<string, string>();
  for (const f of readdirSync(dir)) {
    if (!/\.(md|txt|pdf|docx)$/i.test(f)) continue;
    const base = f.replace(/\.(md|txt|pdf|docx)$/i, "");
    if (!existsSync(labelsPathFor(join(dir, f)))) continue;
    const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
    const current = byBase.get(base);
    if (!current) {
      byBase.set(base, f);
      continue;
    }
    const curExt = current.slice(current.lastIndexOf(".")).toLowerCase();
    if (preference.indexOf(ext) < preference.indexOf(curExt)) byBase.set(base, f);
  }
  return [...byBase.values()].map((f) => join(dir, f)).sort();
}
