import type { RecordType } from "@regreview/core";

/**
 * Hand-authored requirements for the CAPA wedge.
 *
 * READ NOTICE.md FIRST. Every `expectation` below is our own original prose.
 * None of it is copied, paraphrased line-by-line, or otherwise derived from the
 * text of ISO 13485 or ISO 14971, which are copyrighted and which we are not
 * licensed to redistribute. We reference clause numbers and clause titles only.
 *
 * Why this file has to exist at all: the QMSR (effective 2026-02-02) amended
 * 21 CFR Part 820 so that §820.100 (CAPA) and §820.30 (design controls) are
 * [Reserved], and their substance now enters US law by incorporation by
 * reference to ISO 13485:2016. So the operative requirements for our first
 * product area live in a document we cannot ship — which means we write our own
 * statement of each expectation and key it to the clause.
 *
 * `crosswalk` is what keeps these grounded in something empirical. Each rule
 * lists the legacy CFR paragraph(s) it corresponds to, and ingest sums the real
 * FDA citation frequency for those paragraphs onto the rule. That way severity
 * is driven by how often FDA has actually written this observation, not by our
 * opinion of how important the clause is.
 */

export interface AuthoredRule {
  ruleId: string;
  /** Clause or section reference shown to the reviewer. */
  citation: string;
  title: string;
  /** Our own prose. Never the standard's text. */
  expectation: string;
  appliesTo: RecordType[];
  /**
   * Legacy CFR paragraph(s) this expectation corresponds to. Used to inherit
   * observed FDA citation frequency; also what lets a finding be explained in
   * pre-QMSR terms, which is still how most quality staff think and talk.
   */
  crosswalk: string[];
  /**
   * True when a failure of this requirement can plausibly connect to patient
   * harm. Drives severity. Be honest here — marking everything harm-linked
   * destroys the tiering.
   */
  harmLinked: boolean;
}

/**
 * CAPA. The Fresenius interviewee named this the highest-value target: his
 * group carries fifty to sixty open events at any time, and that documentation
 * is what gets scrutinized hardest at the next inspection — especially where
 * complaints or adverse events are attached. It is also the most mechanically
 * checkable of our categories, because "was the loop closed" has an answer.
 */
const CAPA_RULES: AuthoredRule[] = [
  {
    ruleId: "iso13485-8.5.2-procedure",
    citation: "ISO 13485:2016 §8.5.2 (corrective action)",
    title: "A documented corrective action procedure must exist and be followed",
    expectation:
      "The organization must have a documented procedure governing corrective action, and " +
      "the record under review must show that the procedure was actually followed. Look for " +
      "a reference to the controlling procedure by identifier and revision. A record that " +
      "describes an ad hoc process, or that cites no procedure at all, does not demonstrate " +
      "a controlled system even if the underlying engineering work was sound.",
    appliesTo: ["capa"],
    // The single most-cited device requirement in FDA's inspection record.
    crosswalk: ["820.100(a)"],
    harmLinked: false,
  },
  {
    ruleId: "iso13485-8.5.2-investigation",
    citation: "ISO 13485:2016 §8.5.2(b) (review and investigation)",
    title: "The nonconformity must be investigated and its cause determined",
    expectation:
      "The record must show an investigation that reaches a determined cause, not merely a " +
      "restatement of the symptom. A conclusion such as 'operator error' or 'supplier issue' " +
      "is a category, not a cause; it must be supported by evidence and taken far enough that " +
      "the identified cause explains the observed failure. Where the investigation could not " +
      "reach a conclusion, the record must say so explicitly and justify stopping, rather " +
      "than presenting an unsupported cause as settled.",
    appliesTo: ["capa"],
    crosswalk: ["820.100(a)(1)", "820.100(a)(2)"],
    harmLinked: true,
  },
  {
    ruleId: "iso13485-8.5.2-extent-of-action",
    citation: "ISO 13485:2016 §8.5.2(c) (action appropriate to effect)",
    title: "Action taken must be proportionate to the effect of the nonconformity",
    expectation:
      "The action taken must be commensurate with the risk and the effect of the problem. " +
      "Two failure modes to flag: action that is plainly too narrow for a systemic cause " +
      "(retraining one operator for a procedural gap that affects a whole process), and " +
      "action that does not address the cause the investigation itself identified. The " +
      "connection between the determined cause and the chosen action must be visible in the " +
      "record, not left to be inferred.",
    appliesTo: ["capa"],
    crosswalk: ["820.100(a)(3)"],
    harmLinked: true,
  },
  {
    ruleId: "iso13485-8.5.2-verification-effectiveness",
    citation: "ISO 13485:2016 §8.5.2(e) (verification of effectiveness)",
    title: "Effectiveness of the action must be verified against evidence",
    expectation:
      "The record must show that effectiveness was verified after the action was implemented, " +
      "with objective evidence and a stated acceptance criterion defined before the check was " +
      "run. Flag effectiveness checks that merely confirm the action was performed (training " +
      "was delivered, the document was revised) rather than that it worked. Flag checks whose " +
      "evidence does not actually test the cause that was identified, and checks whose " +
      "observation window or sample size is too small to detect recurrence of the original " +
      "failure rate.",
    appliesTo: ["capa"],
    crosswalk: ["820.100(a)(4)"],
    harmLinked: true,
  },
  {
    ruleId: "iso13485-8.5.2-no-adverse-effect",
    citation: "ISO 13485:2016 §8.5.2(f) (no adverse effect on regulatory or safety conformity)",
    title: "The action must not compromise safety or regulatory conformity",
    expectation:
      "Where the action changes a product, process, or specification, the record must show " +
      "that the change itself was assessed for its effect on device safety, on regulatory " +
      "conformity, and on the existing risk analysis. A corrective action that silently " +
      "introduces an unassessed change is a finding on its own, independent of whether the " +
      "original problem was fixed.",
    appliesTo: ["capa", "change_package"],
    crosswalk: ["820.100(a)(5)", "820.30(i)"],
    harmLinked: true,
  },
  {
    ruleId: "iso13485-8.5.2-documentation",
    citation: "ISO 13485:2016 §8.5.2(g) (records of activities and results)",
    title: "Activities undertaken and results achieved must both be recorded",
    expectation:
      "The record must document what was done and what resulted — both halves. The common " +
      "failure is a record that captures the plan and the approval but not the outcome, " +
      "leaving an investigator unable to confirm the action was completed or worked. Also " +
      "flag results asserted without the underlying data, and any activity referenced as " +
      "complete whose evidence is not in the record or reachable by an explicit reference " +
      "from it.",
    appliesTo: ["capa"],
    // Documentation of CAPA activities/results is separately and frequently cited.
    crosswalk: ["820.100(b)"],
    harmLinked: false,
  },
  {
    ruleId: "iso13485-8.5.3-preventive-action",
    citation: "ISO 13485:2016 §8.5.3 (preventive action)",
    title: "Potential nonconformities must be evaluated for preventive action",
    expectation:
      "Where a record identifies a potential problem rather than an occurred one, it must " +
      "show that the need for action to prevent occurrence was evaluated, with a rationale " +
      "for the conclusion reached — including where the conclusion is that no action is " +
      "needed. Flag records that identify a potential nonconformity and then simply go " +
      "silent on it.",
    appliesTo: ["capa"],
    crosswalk: ["820.100(a)"],
    harmLinked: false,
  },
  {
    ruleId: "regreview-capa-systemic-extension",
    citation: "ISO 13485:2016 §8.5.2(c); FDA inspection practice on repeat findings",
    title: "Scope must be extended to other product or processes where the cause could apply",
    expectation:
      "Where the determined cause could plausibly affect other products, lots, processes, or " +
      "sites, the record must show that the scope was considered and bounded, with a stated " +
      "basis. This matters disproportionately: FDA treats repeat findings as evidence of a " +
      "systemic problem and escalates scrutiny accordingly, and after a one-off finding it " +
      "becomes the company's own responsibility to confirm the issue is not systemic. A " +
      "record that fixes one instance without addressing that question is the specific " +
      "pattern that turns a single observation into a systemic one.",
    appliesTo: ["capa", "complaint"],
    crosswalk: ["820.100(a)(3)"],
    harmLinked: true,
  },
  {
    ruleId: "regreview-capa-complaint-linkage",
    citation: "ISO 13485:2016 §8.2.2; 21 CFR 803 (reporting)",
    title: "Complaint and adverse-event linkage must be resolved explicitly",
    expectation:
      "Where the record arises from a complaint, it must show whether the event was evaluated " +
      "against reporting obligations, and record the conclusion either way. An unresolved or " +
      "absent reportability determination on a record that describes patient impact is a " +
      "high-consequence gap: it is exactly the chain an investigator follows from complaint " +
      "to containment to CAPA, and reporting failures carry their own citations.",
    appliesTo: ["capa", "complaint"],
    crosswalk: ["820.198(a)", "820.198(d)", "803.17"],
    harmLinked: true,
  },
  {
    ruleId: "regreview-capa-closure-integrity",
    citation: "ISO 13485:2016 §8.5.2(e), (g)",
    title: "Closure must be supported by everything the record itself opened",
    expectation:
      "A closed record must have no loose ends of its own making: every action item it " +
      "raises has a documented outcome, every commitment has either evidence of completion " +
      "or an explicit transfer to a tracked successor record, and the closure date does not " +
      "precede the evidence it depends on. Flag closure approved before the effectiveness " +
      "check was performed, and closure that references a follow-up record without " +
      "identifying it.",
    appliesTo: ["capa"],
    crosswalk: ["820.100(a)(4)", "820.100(b)"],
    harmLinked: false,
  },
];

/**
 * Cross-cutting checks that are not traceable to a single clause.
 *
 * These carry `source = 'logic'` and exist because the discovery conversations
 * were consistent that the most common real-world problems are not scientific
 * disagreements — they are inconsistency between documents, evidence filed
 * where nobody can find it, and documents written in ways that argue the
 * company into a corner.
 */
const LOGIC_RULES: AuthoredRule[] = [
  {
    ruleId: "regreview-logic-risk-rating-consistency",
    citation: "ISO 14971 risk management; ISO 13485:2016 §7.1",
    title: "Risk severity ratings must be consistent wherever the same hazard appears",
    expectation:
      "SCOPE: a rating or value in this record that disagrees with the SAME rating or value " +
      "in ANOTHER document — CAPA against FMEA, risk file, or software risk assessment. " +
      "USE A DIFFERENT RULE WHEN: the disagreement is internal to this record (use " +
      "regreview-logic-internal-contradiction), or no other document is in scope. Do not " +
      "invoke this rule speculatively: if no other document was supplied, there is nothing " +
      "to compare against and the finding belongs under one of the other two rules. " +
      "Both discovery conversations independently named cross-document rating mismatch as a " +
      "real and unmet problem — the same condition rated differently by department, and " +
      "FMEA severity scales that do not line up with software risk categories. This check is " +
      "normally driven by the deterministic fact diff rather than by reading in bulk.",
    appliesTo: ["capa", "risk_analysis", "complaint", "change_package"],
    crosswalk: ["820.30(g)"],
    harmLinked: true,
  },
  {
    ruleId: "regreview-logic-evidence-locatable",
    citation: "ISO 13485:2016 §4.2.5 (control of records)",
    title: "Referenced evidence must be identified well enough to be found",
    expectation:
      "Every piece of evidence the record relies on must be identified specifically enough " +
      "that a third party could retrieve it — a document number and revision, a report " +
      "identifier, a record type. Flag vague references ('per the test data', 'see meeting " +
      "notes'). The expert conversation named finding evidence and getting people to connect " +
      "the dots as the single slowest part of audit preparation, with results filed as " +
      "meeting minutes rather than as the record type they actually are. The information " +
      "exists; people cannot find it.",
    appliesTo: [],
    crosswalk: ["820.180", "820.184"],
    harmLinked: false,
  },
  // ---------------------------------------------------------------------------
  // The three rules below overlap in the obvious reading, and that overlap was
  // measured to be the dominant cause of poor repeat-run agreement: two runs
  // would both find "the Minor severity rating is contradicted by the patient
  // event this record describes" and file it under a different rule each time,
  // which made the same judgment look like two different findings.
  //
  // They are now scoped by WHAT THE DEFECT IS ABOUT rather than by how it feels,
  // and each carries an explicit "use X instead when" clause. The scopes are
  // mutually exclusive by construction: inference quality, self-contradiction,
  // and cross-document disagreement.
  // ---------------------------------------------------------------------------
  {
    ruleId: "regreview-logic-conclusion-supported",
    citation: "General soundness of the record",
    title: "Conclusions must be supported by the evidence presented",
    expectation:
      "SCOPE: the strength of an inference from evidence that IS present. Flag a sample too " +
      "small to justify the stated confidence, a trend claimed from too few points, a " +
      "statistical claim with no stated basis, a pass declared against no predefined " +
      "criterion, a possibility eliminated by assertion rather than by evidence, or an " +
      "absence of evidence presented as evidence of absence. " +
      "USE A DIFFERENT RULE WHEN: two statements in this record cannot both be true (use " +
      "regreview-logic-internal-contradiction), or a value disagrees with another document " +
      "(use regreview-logic-risk-rating-consistency). " +
      "Regulatory compliance often has no single correct answer — the standard is whether " +
      "the stated position could be defended, not whether we would have reached it.",
    appliesTo: [],
    crosswalk: [],
    harmLinked: false,
  },
  {
    ruleId: "regreview-logic-internal-contradiction",
    citation: "General soundness of the record",
    title: "The record must not contradict itself",
    expectation:
      "SCOPE: two statements WITHIN THIS RECORD that cannot both be true. Flag dates out of " +
      "order against the sequence described, a cause stated in one section and a different " +
      "cause in another, a quantity or identifier that changes between sections, a summary " +
      "that does not match the detail it summarizes, or a justification whose premise the " +
      "record elsewhere disproves. " +
      "USE A DIFFERENT RULE WHEN: the reasoning is merely weak or unsupported rather than " +
      "self-contradictory (use regreview-logic-conclusion-supported), or the disagreement is " +
      "with a different document (use regreview-logic-risk-rating-consistency). " +
      "Both halves of the contradiction must be quotable from this record; if one half is " +
      "only implied, this is not the right rule.",
    appliesTo: [],
    crosswalk: [],
    harmLinked: false,
  },
  {
    ruleId: "regreview-logic-audit-defensibility",
    citation: "General soundness of the record",
    title: "Wording must not concede more than the facts require",
    expectation:
      "Flag language that would be damaging when read by an investigator and that the facts " +
      "do not compel: speculation about broader failures the record does not establish, " +
      "admissions of an unassessed systemic problem, characterizing an issue as known and " +
      "unaddressed. The interviewee's point was that writing for defensibility in an audit " +
      "is a skill most engineers do not have, so documents get written in ways that paint " +
      "the company into a corner. Flag the wording; never suggest concealing a real problem " +
      "— the fix is precision about what is actually established, not omission.",
    appliesTo: [],
    crosswalk: [],
    harmLinked: false,
  },
];

export const AUTHORED_RULES: AuthoredRule[] = [...CAPA_RULES, ...LOGIC_RULES];

/**
 * Which `source` each authored rule gets. Clause-referenced rules are
 * `iso_clause` (our prose against a copyrighted standard's clause ID);
 * cross-cutting soundness checks are `logic`.
 */
export function sourceFor(rule: AuthoredRule): "iso_clause" | "logic" {
  return rule.ruleId.startsWith("iso13485-") ||
    /ISO 1(3485|4971)/.test(rule.citation)
    ? "iso_clause"
    : "logic";
}
