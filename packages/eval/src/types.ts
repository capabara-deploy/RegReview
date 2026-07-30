import { z } from "zod";
import { CheckCategory, RecordType, Severity } from "@regreview/core";

/**
 * The evaluation fixture format.
 *
 * A fixture is a hand-authored quality record plus an exhaustive list of the
 * findings a competent reviewer would expect on it. Hand-authored deliberately:
 * there is no public corpus of real DHF or CAPA records (real ones are
 * confidential), and the one rich set of templates that does exist —
 * OpenRegulatory's — is CC BY-NC-SA and cannot ship inside a commercial
 * product. See NOTICE.md.
 */

export const ExpectedFinding = z.object({
  /**
   * The rule this defect violates. Must exist in the corpus — the loader checks,
   * because a label naming a rule that was renamed silently becomes an
   * unsatisfiable expectation and drags recall down for no reason.
   */
  ruleId: z.string(),
  /**
   * A verbatim substring of the fixture identifying where the defect is. Used
   * to locate the expected span; the loader fails if it is not found, which
   * catches labels that drift out of sync when fixture prose is edited.
   */
  anchor: z.string().min(1),
  /** Why this is a defect. Documentation for whoever debugs a miss later. */
  why: z.string().min(1),
  category: CheckCategory.optional(),
  /** Expected tier, when the fixture is specifically testing the severity model. */
  severity: Severity.optional(),
  /**
   * Mark a label as hard when the defect requires reasoning a keyword baseline
   * could not plausibly reach. Lets the harness report an easy/hard breakdown,
   * so a headline recall number can't be carried by the trivial cases.
   */
  difficulty: z.enum(["easy", "hard"]).default("easy"),
});
export type ExpectedFinding = z.infer<typeof ExpectedFinding>;

export const FixtureMeta = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  recordType: RecordType,
  /**
   * True when every defect in the document is labeled.
   *
   * This flag governs whether unmatched predictions count as false positives.
   * On a non-exhaustive fixture they cannot: an unlabeled finding might be a
   * real defect we simply did not annotate, and punishing the engine for
   * finding it would train the corpus toward missing things. Only exhaustively
   * labeled fixtures contribute to precision.
   */
  exhaustive: z.boolean(),
  /**
   * Deliberate traps: text that pattern-matches to a problem but is actually
   * correct. Named here so a false positive on one can be reported distinctly —
   * these are the failures most likely to cost credibility with a reviewer.
   */
  distractors: z.array(z.object({ anchor: z.string(), why: z.string() })).default([]),
  expected: z.array(ExpectedFinding),
  /**
   * Other fixture ids that must be loaded alongside this one, for
   * cross-document consistency cases. A severity-rating mismatch is only
   * detectable if both documents are in scope.
   */
  related: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type FixtureMeta = z.infer<typeof FixtureMeta>;

/** A loaded fixture: metadata, the document text, and resolved label offsets. */
export interface Fixture {
  meta: FixtureMeta;
  /** Path to the document on disk. */
  documentPath: string;
  raw: string;
  /** Expected findings with their anchors resolved to offsets. */
  labels: ResolvedLabel[];
  /** Distractors with resolved offsets. */
  distractors: { anchor: string; why: string; charStart: number; charEnd: number }[];
}

export interface ResolvedLabel extends ExpectedFinding {
  charStart: number;
  charEnd: number;
}
