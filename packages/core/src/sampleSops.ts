import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSopsDb, type Db } from "./db/index.js";
import { ingestSop } from "./sop.js";
import type { RecordType } from "./types.js";

/**
 * Sample procedures seeded into the sops database on first migrate.
 *
 * Why this exists. Until a procedure is loaded the conformance pass finds no
 * rules with `source = 'sop'` and **skips itself silently** — half the review is
 * missing and the output still looks complete. "0 findings" from a pass that
 * never ran is indistinguishable from a clean document, and a new user has no
 * way to know which one they are looking at. Seeding something means the pass
 * always has rules, so its absence can never be the invisible failure.
 *
 * Why a sample is nonetheless a hazard, and how it is contained. The conformance
 * pass exists because a company's own procedures are treated as the rule of law
 * in an inspection — a finding's force comes entirely from the customer having
 * written the clause it cites. A shipped procedure has none of that force, and a
 * conformance finding that cannot be told apart from a real one is worse than no
 * finding at all. So:
 *
 *   - every sample is cited as `SAMPLE-...`, never as a plausible document
 *     number, so the label is visible on the finding itself and not only in a
 *     list view the reviewer may never open;
 *   - `isSampleSop()` lets any surface badge or filter them;
 *   - seeding happens once, tracked in the sops database's `schema_meta`, so
 *     deleting a sample is permanent and the next migrate will not resurrect it;
 *   - a sops database that already holds any procedure is never seeded, so a
 *     real deployment never grows samples underneath the customer's own.
 *
 * Set `REGREVIEW_SKIP_SAMPLE_SOPS=1` to opt out entirely.
 *
 * Note that the server migrates its own schema on every boot, so this runs on
 * every boot in production. After the first it is a single `schema_meta` read.
 * Two instances booting at once can both seed; that is harmless, because the
 * sample IDs are fixed and every write is an upsert.
 */

/** `sop_documents.sop_document_id` prefix reserved for shipped samples. */
export const SAMPLE_SOP_ID_PREFIX = "sop-sample-";

/** True if this procedure is one RegReview shipped, not one the customer loaded. */
export function isSampleSop(sopDocumentId: string): boolean {
  return sopDocumentId.startsWith(SAMPLE_SOP_ID_PREFIX);
}

/** Marker recording that seeding already ran, so it never runs twice. */
const SEEDED_KEY = "sample_sops_seeded";

interface SampleSop {
  sopDocumentId: string;
  file: string;
  /** How findings cite it. Deliberately not a plausible customer document number. */
  citationLabel: string;
  appliesTo: RecordType[];
}

const SAMPLES: SampleSop[] = [
  {
    sopDocumentId: `${SAMPLE_SOP_ID_PREFIX}capa`,
    file: "sample-capa-procedure.md",
    citationLabel: "SAMPLE-CAPA-001",
    appliesTo: ["capa"],
  },
  {
    sopDocumentId: `${SAMPLE_SOP_ID_PREFIX}risk`,
    file: "sample-risk-management-procedure.md",
    citationLabel: "SAMPLE-RISK-001",
    appliesTo: ["risk_analysis"],
  },
];

/**
 * Locate the bundled sample procedures.
 *
 * They live in `packages/core/samples/`, a sibling of `src/` and of `dist/`, so
 * the same relative path resolves whether this module runs from source under tsx
 * or from built output. That is deliberate: the `*Schema.sql` files sit *inside*
 * `src/`, `tsc` does not copy non-TS assets to `dist`, and `migrate.ts` needs a
 * two-path lookup to cope. Keeping these outside `src/` avoids inheriting that.
 *
 * The Dockerfile must copy this directory into the image explicitly — it copies
 * `dist` only, and these are not build output.
 */
function samplesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "samples");
}

export interface SeedResult {
  seeded: { citationLabel: string; rulesWritten: number }[];
  /** Why nothing was seeded, when nothing was. */
  skipped?: "already-seeded" | "sops-exist" | "opted-out" | "files-missing";
}

/**
 * Load the sample procedures if the sops database has never had any.
 *
 * Idempotent and safe to call on every migrate.
 */
export async function seedSampleSops(db: Db = getSopsDb()): Promise<SeedResult> {
  if (process.env["REGREVIEW_SKIP_SAMPLE_SOPS"] === "1") {
    return { seeded: [], skipped: "opted-out" };
  }

  const marker = await db
    .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
    .get<{ value: string }>(SEEDED_KEY);
  if (marker) return { seeded: [], skipped: "already-seeded" };

  // Never seed into a database that already holds procedures: an existing
  // install is one where the customer has loaded their own, and adding ours
  // underneath would mix rules they are bound by with rules they are not.
  const existing = await db.prepare(`SELECT 1 FROM sop_documents LIMIT 1`).get();
  if (existing) {
    // Still mark it, so this check is answered once rather than on every boot.
    await markSeeded(db);
    return { seeded: [], skipped: "sops-exist" };
  }

  const dir = samplesDir();
  const present = SAMPLES.filter((s) => existsSync(join(dir, s.file)));
  if (present.length === 0) {
    // Loud, because the failure it guards against is silent: a deployed image
    // that dropped the samples directory would otherwise look identical to a
    // correctly-seeded one right up until the conformance pass reported
    // nothing on every review.
    console.error(
      `sample procedures not found in ${dir} — the conformance pass will be ` +
        `ruleless until a procedure is uploaded. If this is a container, the ` +
        `image is missing packages/core/samples.`,
    );
    return { seeded: [], skipped: "files-missing" };
  }

  const seeded: SeedResult["seeded"] = [];
  for (const sample of present) {
    const path = join(dir, sample.file);
    const result = await ingestSop(
      {
        filename: sample.file,
        storedPath: path,
        raw: readFileSync(path, "utf8"),
        appliesTo: sample.appliesTo,
        sopDocumentId: sample.sopDocumentId,
        citationLabel: sample.citationLabel,
      },
      db,
    );
    seeded.push({ citationLabel: sample.citationLabel, rulesWritten: result.rulesWritten });
  }

  await markSeeded(db);
  return { seeded };
}

async function markSeeded(db: Db): Promise<void> {
  await db
    .prepare(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(SEEDED_KEY, new Date().toISOString());
}
