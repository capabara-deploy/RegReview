import type { ReviewEngine, ReviewInput, ReviewResult } from "../engine.js";
import type { RawFinding, Rule } from "../types.js";
import { anchorFindings } from "./anchor.js";

/**
 * A review engine that makes no API calls.
 *
 * Two honest uses, and one thing this is emphatically not.
 *
 * It is NOT a product feature and its findings must never be shown to a
 * customer as review output. The heuristics below are crude keyword matches;
 * they would embarrass us in front of a quality engineer.
 *
 * What it is for:
 *
 *  1. **Proving the pipeline.** Everything except the model call — blocking,
 *     offset arithmetic, the anchoring guard, duplicate collapse, stable ids,
 *     severity derivation, persistence, the viewer — can be exercised and
 *     verified without a credential or a cent of spend. That matters: those
 *     parts are where the silent, wrong-answer bugs live, and they are much
 *     easier to debug against deterministic input than against a model.
 *
 *  2. **A precision floor for the eval harness.** A real engine's precision
 *     number is meaningless without something to beat. If Claude cannot clear a
 *     keyword baseline on the fixture set, that is worth knowing early.
 *
 * It is deliberately deterministic, so repeat-run agreement over it is exactly
 * 1.0 — which is how the agreement metric itself gets tested.
 */

interface Heuristic {
  /** Which rule this crude check stands in for. */
  ruleId: string;
  /** Matches text that suggests the defect. */
  pattern: RegExp;
  problem: string;
  rationale: string;
  suggestion: string;
  confidence: RawFinding["confidence"];
  harmRelevant: boolean;
  category: RawFinding["category"];
}

/**
 * Keyword heuristics standing in for real judgment.
 *
 * Chosen to be things a regex can actually see — vague evidence references, an
 * unsupported cause attribution, an effectiveness claim resting on training
 * having been delivered. Anything requiring the document to be understood as a
 * whole is out of reach here, which is precisely the gap the real engine has to
 * justify its cost by filling.
 */
const HEURISTICS: Heuristic[] = [
  {
    ruleId: "regreview-logic-evidence-locatable",
    pattern: /\b(?:see|per|refer to)\s+(?:the\s+)?(?:test data|attached|meeting minutes|notes)\b/gi,
    problem: "Evidence is referenced without an identifier that would let anyone retrieve it.",
    rationale:
      "An investigator asked to verify this claim would have no way to locate the underlying " +
      "record. Unfindable evidence is treated as absent evidence.",
    suggestion:
      "If the reference named the document number, revision, and record type, the evidence " +
      "would be retrievable during an inspection.",
    confidence: "medium",
    harmRelevant: false,
    category: "compliance",
  },
  {
    ruleId: "iso13485-8.5.2-investigation",
    pattern: /\bcause was\s+\*{0,2}operator error\*{0,2}/gi,
    problem: "The stated cause is a category of blame rather than a determined cause.",
    rationale:
      "Operator error is where an investigation stops, not where it concludes. An investigator " +
      "reading this would ask what about the design or the procedure permitted the error.",
    suggestion:
      "If the record showed why the design allowed the misseating to occur undetected, the " +
      "cause determination would be supportable.",
    confidence: "high",
    harmRelevant: true,
    category: "compliance",
  },
  {
    ruleId: "iso13485-8.5.2-verification-effectiveness",
    pattern: /\bconsidered effective\b/gi,
    problem:
      "Effectiveness is asserted without evidence that the problem stopped recurring.",
    rationale:
      "Confirming an action was performed is not the same as confirming it worked. This is one " +
      "of the most frequently cited CAPA deficiencies.",
    suggestion:
      "If effectiveness were measured against the original complaint rate over a stated " +
      "window, with an acceptance criterion set beforehand, the conclusion would be supported.",
    confidence: "high",
    harmRelevant: true,
    category: "completeness",
  },
  {
    ruleId: "regreview-logic-conclusion-supported",
    pattern: /\bwas ruled out\b/gi,
    problem: "A possible cause is eliminated by assertion rather than by evidence.",
    rationale:
      "An investigator will read an unsupported elimination as an incomplete investigation, " +
      "particularly where the eliminated cause is software.",
    suggestion:
      "If the record stated what was examined and what result justified the elimination, the " +
      "conclusion would be defensible.",
    confidence: "medium",
    harmRelevant: false,
    category: "plausibility",
  },
];

export class OfflineReviewEngine implements ReviewEngine {
  readonly id = "keyword-baseline";

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async
  async review(input: ReviewInput): Promise<ReviewResult> {
    const available = new Set(input.rules.map((r: Rule) => r.ruleId));
    const raw: RawFinding[] = [];

    for (const heuristic of HEURISTICS) {
      if (!available.has(heuristic.ruleId)) continue;

      // Fresh regex per use: a /g pattern carries lastIndex between calls, and
      // reusing one across documents silently skips early matches.
      const pattern = new RegExp(heuristic.pattern.source, heuristic.pattern.flags);
      for (const match of input.record.normalizedText.matchAll(pattern)) {
        raw.push({
          category: heuristic.category,
          ruleId: heuristic.ruleId,
          quote: match[0],
          problem: heuristic.problem,
          rationale: heuristic.rationale,
          suggestion: heuristic.suggestion,
          confidence: heuristic.confidence,
          harmRelevant: heuristic.harmRelevant,
        });
      }
    }

    const anchored = anchorFindings({
      runId: input.runId,
      record: input.record,
      blocks: input.blocks,
      rules: input.rules,
      raw,
    });

    return {
      findings: anchored.findings,
      stats: {
        proposed: raw.length,
        droppedUnanchored: anchored.droppedUnanchored,
        droppedByVerifier: 0,
        droppedUnknownRule: anchored.droppedUnknownRule,
        droppedDuplicate: anchored.droppedDuplicate,
      },
    };
  }
}

/**
 * An engine that replays a canned set of raw findings.
 *
 * Used to test the parts of the pipeline that a keyword baseline cannot reach —
 * in particular the anchoring guard's rejection path, which needs a finding
 * whose quote is deliberately absent from the document.
 */
export class ScriptedReviewEngine implements ReviewEngine {
  readonly id = "scripted";

  constructor(private readonly raw: RawFinding[]) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async
  async review(input: ReviewInput): Promise<ReviewResult> {
    const anchored = anchorFindings({
      runId: input.runId,
      record: input.record,
      blocks: input.blocks,
      rules: input.rules,
      raw: this.raw,
    });
    return {
      findings: anchored.findings,
      stats: {
        proposed: this.raw.length,
        droppedUnanchored: anchored.droppedUnanchored,
        droppedByVerifier: 0,
        droppedUnknownRule: anchored.droppedUnknownRule,
        droppedDuplicate: anchored.droppedDuplicate,
      },
    };
  }
}
