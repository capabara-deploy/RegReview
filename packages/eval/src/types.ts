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

/**
 * The rules a fixture is labeled against.
 *
 * This exists because "exhaustive" is otherwise not a well-defined claim. A CAPA
 * review loads 62 rules on this corpus and 36 of them come from whichever sample
 * SOP happens to be seeded in the environment — so the set of findings a
 * document *should* produce moves with the database, and no hand-labeled file
 * can enumerate it. Precision computed against a moving denominator is a number
 * that looks real and is wrong, which is worse than no number at all.
 *
 * A scope pins it down: this fixture claims to enumerate every defect *against
 * these requirements*, and the harness reviews it against exactly those. Both
 * fields are allowlists and they union; omit the scope entirely to review
 * against every rule for the record type, which is the right default for a
 * recall-only fixture.
 */
export const RuleScope = z
  .object({
    /** Rule sources to include, e.g. ["iso_clause", "logic"]. */
    sources: z.array(z.string().min(1)).min(1).optional(),
    /** Explicit rule ids to include. The tightest and most defensible form. */
    ruleIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine((v) => v.sources !== undefined || v.ruleIds !== undefined, {
    message: "ruleScope must name at least one of `sources` or `ruleIds`",
  });
export type RuleScope = z.infer<typeof RuleScope>;

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
   *
   * Requires `ruleScope` — see there for why an unscoped exhaustive claim is
   * not checkable.
   */
  exhaustive: z.boolean(),
  ruleScope: RuleScope.optional(),
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

/**
 * Parse a fixture's metadata, enforcing the one cross-field invariant:
 * an exhaustive fixture must declare the rules it is exhaustive against.
 *
 * Enforced at load rather than by convention because the failure is silent —
 * an unscoped `exhaustive: true` produces a precision number computed against
 * whatever rules the environment happened to load, which reads as real.
 */
export const FixtureMetaChecked = FixtureMeta.superRefine((m, ctx) => {
  if (m.exhaustive && !m.ruleScope) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ruleScope"],
      message:
        "a fixture marked exhaustive must declare `ruleScope`. Without one, " +
        "precision is computed against every rule the environment happens to " +
        "load — including seeded sample SOPs — so the number moves with the " +
        "database rather than with the engine.",
    });
  }
});

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
