import { z } from "zod";

/**
 * The five things a reviewer wants checked. The first four are the "four C's"
 * from the product summary; Plausibility covers the "common logic and
 * scientific research" case — a document that is compliant, conformant,
 * consistent, and complete can still draw a conclusion its data does not
 * support.
 */
export const CheckCategory = z.enum([
  /** Against FDA requirements: Part 820 / QMSR, incorporated standards, guidance. */
  "compliance",
  /** Against the company's own SOPs — binding during an inspection. */
  "conformance",
  /** Against the company's other documents: risk ratings, IDs, dates, terminology. */
  "consistency",
  /** Loop closure: was every concern raised actually addressed and closed out. */
  "completeness",
  /** Internal logic and scientific/statistical soundness of the argument made. */
  "plausibility",
]);
export type CheckCategory = z.infer<typeof CheckCategory>;

/**
 * Tiered risk. Derived by `deriveSeverity`, never chosen freehand by the model —
 * see severity.ts for the inputs and why each one is there.
 */
export const Severity = z.enum(["high", "medium", "low"]);
export type Severity = z.infer<typeof Severity>;

/** Where a requirement came from. Determines how it may be displayed and shipped. */
export const RuleSource = z.enum([
  /** Verbatim US regulation text. Public domain — safe to store and display. */
  "cfr",
  /**
   * A copyrighted standard (ISO 13485, ISO 14971) referenced by clause ID only.
   * `expectation` is our own authored prose. Never the standard's text.
   */
  "iso_clause",
  /** FDA guidance documents. Public domain. */
  "guidance",
  /** The customer's own uploaded procedure. Their content, never redistributed. */
  "sop",
  /** A general logic/soundness check not traceable to a single citation. */
  "logic",
]);
export type RuleSource = z.infer<typeof RuleSource>;

/** Document classes the engine knows how to review. CAPA is the Phase-1 wedge. */
export const RecordType = z.enum([
  "capa",
  "complaint",
  "design_input",
  "design_output",
  "design_review",
  "verification",
  "validation",
  "risk_analysis",
  "traceability_matrix",
  "change_package",
  "unknown",
]);
export type RecordType = z.infer<typeof RecordType>;

export const FindingStatus = z.enum(["open", "accepted", "rejected"]);
export type FindingStatus = z.infer<typeof FindingStatus>;

/**
 * A requirement the engine can check a record against.
 */
export interface Rule {
  ruleId: string;
  source: RuleSource;
  /** Human-readable citation, e.g. "21 CFR 820.100(a)(1)" or "ISO 13485:2016 §8.5.2". */
  citation: string;
  title: string;
  /**
   * What the requirement expects, in our own words. For `iso_clause` this is
   * the ONLY text we hold — see NOTICE.md. For `cfr` this may be verbatim.
   */
  expectation: string;
  /** Record types this rule applies to. Empty means "all". */
  appliesTo: RecordType[];
  /**
   * True when a failure of this requirement plausibly connects to patient harm.
   * Feeds severity: the regulatory expert's advice was to weight records tied
   * to death or serious injury above cosmetic ones.
   */
  harmLinked: boolean;
  /**
   * How many times FDA actually cited this paragraph, summed across the
   * fiscal years ingested from the Inspectional Observation data. This is
   * empirical inspection risk, not our opinion of importance.
   */
  citationFrequency: number;
  /**
   * `citationFrequency` expressed as a percentile rank (0..1) within the rule
   * corpus. Severity uses this rather than the raw count — see severity.ts for
   * why the absolute-threshold version collapsed into rating everything high.
   */
  frequencyPercentile: number;
  corpusVersion: string;
}

/**
 * What the model is asked to return for each potential issue. Deliberately
 * shaped so that every field a reviewer needs to judge the finding is
 * mandatory — a flag with no citation and no quote is not reviewable.
 */
export const RawFinding = z.object({
  category: CheckCategory,
  /** The rule this finding is asserted against. Must exist in the rule set. */
  ruleId: z.string(),
  /**
   * The exact text from the document that the finding is about, copied
   * verbatim. This is the anchor: if this string is not found in the block,
   * the finding is discarded as unverifiable. See anchor.ts.
   */
  quote: z.string().min(1),
  /** What the problem is, in one sentence. */
  problem: z.string().min(1),
  /** Why it matters — the consequence in an inspection, not a restatement. */
  rationale: z.string().min(1),
  /**
   * A direction for the fix, phrased as "if you did X, you would satisfy Y".
   * Explicitly NOT replacement text to paste in: both discovery interviews
   * warned that engineers paste AI output unread, and a fix that introduces a
   * new error is worse than the original problem.
   */
  suggestion: z.string().min(1),
  /** The model's own confidence. Used by the verifier pass and for ranking. */
  confidence: z.enum(["high", "medium", "low"]),
  /** True when the finding concerns something tied to serious injury or death. */
  harmRelevant: z.boolean(),
});
export type RawFinding = z.infer<typeof RawFinding>;

/** The envelope the model returns per check pass. */
export const FindingBatch = z.object({
  findings: z.array(RawFinding),
});
export type FindingBatch = z.infer<typeof FindingBatch>;

/**
 * A finding after anchoring, verification, and severity derivation — i.e. what
 * a reviewer actually sees.
 */
export interface Finding {
  findingId: string;
  runId: string;
  recordId: string;
  blockId: string;
  charStart: number;
  charEnd: number;
  category: CheckCategory;
  severity: Severity;
  /** The inputs that produced `severity`, kept so the rating is auditable. */
  severityBasis: SeverityBasis;
  ruleId: string;
  citation: string;
  quote: string;
  problem: string;
  rationale: string;
  suggestion: string;
  confidence: "high" | "medium" | "low";
  status: FindingStatus;
  reviewerNote: string | null;
}

export interface SeverityBasis {
  citationFrequency: number;
  frequencyPercentile: number;
  harmLinked: boolean;
  harmRelevant: boolean;
  confidence: "high" | "medium" | "low";
  /** Which branch of deriveSeverity fired, so the rating can be explained in the UI. */
  reason: string;
}

/**
 * A unit of extracted text with offsets back into the record's normalized
 * plain-text rendering. `page`/`bbox` are present for PDFs so the viewer can
 * draw a highlight box rather than only highlight text.
 */
export interface Block {
  blockId: string;
  recordId: string;
  ordinal: number;
  text: string;
  charStart: number;
  charEnd: number;
  page: number | null;
  bbox: [number, number, number, number] | null;
  /** Heading path, e.g. ["5. Root Cause Analysis", "5.2 Investigation"]. */
  heading: string | null;
}

/**
 * One reviewable document.
 */
export interface RecordDoc {
  recordId: string;
  filename: string;
  /** Absolute path on local disk. The file itself never leaves this machine. */
  storedPath: string;
  sha256: string;
  recordType: RecordType;
  /** The company's own identifier, e.g. "CAPA-2026-0142". Extracted, not assigned. */
  docId: string | null;
  revision: string | null;
  normalizedText: string;
  createdAt: string;
}

/**
 * A structured value pulled out of a record. The consistency check is a
 * deterministic diff over these rows, NOT a model reading every document at
 * once — that is what makes cross-document continuity affordable and
 * defensible.
 */
export interface Fact {
  factId: string;
  recordId: string;
  blockId: string;
  /** e.g. "risk_severity", "requirement_id", "part_number", "date_closed". */
  kind: string;
  /** The thing being described, e.g. the failure mode or requirement it belongs to. */
  subject: string;
  /** The normalized value, e.g. "3" or "2026-04-11". */
  value: string;
  charStart: number;
  charEnd: number;
}

/**
 * One execution of the review engine against one record.
 *
 * Every field here is part of the run's identity. Fresenius named
 * repeat-run consistency as a critical technical requirement, which means a
 * finding is only comparable to another finding produced under the same model,
 * prompt version, and corpus version — so all three are recorded, not assumed.
 */
export interface Run {
  runId: string;
  recordId: string;
  model: string;
  effort: string;
  promptVersion: string;
  corpusVersion: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "complete" | "failed";
  error: string | null;
}
