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
 * Risk management, keyed to ISO 14971:2019 clause IDs.
 *
 * Same licensing posture as the CAPA set and it matters more here, because
 * 14971 is the standard a device company is most likely to be *mid-transition*
 * on at any given moment: every `expectation` below is our own prose describing
 * what a risk management file has to demonstrate. None of it is ISO's text, and
 * a customer still needs their own licensed copy of the standard.
 *
 * Edition is pinned in the citation deliberately. A rule that says only
 * "ISO 14971" cannot answer the question these rules exist to answer — which
 * documents were written against which edition — so the edition is part of the
 * citation string a reviewer sees.
 *
 * Crosswalk note: risk management has no dedicated CFR paragraph of its own.
 * Its enforcement footprint shows up under design validation (820.30(g)), which
 * explicitly required risk analysis, and under design changes (820.30(i)) and
 * the CAPA/complaint loop where post-production information feeds back. Those
 * are the paragraphs these rules inherit citation frequency from, and 820.30(g)
 * is among the most-cited device requirements FDA has on record.
 */
const RISK_MANAGEMENT_RULES: AuthoredRule[] = [
  {
    ruleId: "iso14971-4.4-risk-management-plan",
    citation: "ISO 14971:2019 §4.4 (risk management plan)",
    title: "A risk management plan must exist and govern the work actually done",
    expectation:
      "The file must reference a risk management plan covering the scope of the device and " +
      "the lifecycle phases in scope, and the work recorded must match what that plan says. " +
      "Two failures to flag: activities performed that the plan does not cover, and planned " +
      "activities with no recorded result. The plan must also state the criteria for risk " +
      "acceptability BEFORE risks are evaluated against them — acceptance criteria introduced " +
      "after the estimates exist, or inferred from the conclusions reached, are not criteria.",
    appliesTo: ["risk_analysis"],
    crosswalk: ["820.30(g)"],
    harmLinked: false,
  },
  {
    ruleId: "iso14971-4.5-risk-management-file",
    citation: "ISO 14971:2019 §4.5 (risk management file)",
    title: "Every risk management record must be traceable to the file",
    expectation:
      "Each identified hazard must be traceable through the file from analysis, to estimation, " +
      "to control, to residual risk, to verification of the control's implementation and " +
      "effectiveness. Flag any hazard whose chain breaks — identified but never estimated, " +
      "controlled but with no verification that the control was actually implemented, or a " +
      "control referenced with no locatable evidence. Traceability is the property an " +
      "investigator tests by picking one hazard at random and following it end to end.",
    appliesTo: ["risk_analysis", "traceability_matrix"],
    crosswalk: ["820.30(g)", "820.184"],
    harmLinked: false,
  },
  {
    ruleId: "iso14971-5.2-intended-use-misuse",
    citation: "ISO 14971:2019 §5.2 (intended use and reasonably foreseeable misuse)",
    title: "Intended use and reasonably foreseeable misuse must both be documented",
    expectation:
      "The file must state the intended use and must separately address reasonably " +
      "foreseeable misuse — how the device will predictably be used incorrectly by real " +
      "users under real conditions. Misuse is the half that gets skipped. A file that " +
      "documents intended use and then treats every off-label or erroneous use as out of " +
      "scope has not done this; foreseeable misuse is in scope by definition, and use error " +
      "is one of the most common real-world hazard sources.",
    appliesTo: ["risk_analysis", "design_input"],
    crosswalk: ["820.30(c)", "820.30(g)"],
    harmLinked: true,
  },
  {
    ruleId: "iso14971-5.4-hazard-identification",
    citation: "ISO 14971:2019 §5.4 (hazards and hazardous situations)",
    title: "Hazards must be carried through to the hazardous situations they produce",
    expectation:
      "Identifying a hazard is not sufficient on its own: the file must show the sequence of " +
      "events by which that hazard leads to a hazardous situation and then to harm. Flag " +
      "entries that name a hazard and jump straight to a severity rating with no described " +
      "sequence, because the sequence is what makes the probability estimate reviewable. Also " +
      "flag hazard identification that considers only device failure — normal-use conditions, " +
      "foreseeable misuse, and reasonably foreseeable environmental conditions all belong here.",
    appliesTo: ["risk_analysis"],
    crosswalk: ["820.30(g)"],
    harmLinked: true,
  },
  {
    ruleId: "iso14971-5.5-risk-estimation",
    citation: "ISO 14971:2019 §5.5 (risk estimation)",
    title: "Severity and probability estimates must have a stated basis",
    expectation:
      "For each hazardous situation the file must estimate the associated risk using the " +
      "categories defined in the plan, and the basis for each estimate must be visible — " +
      "field data, published literature, testing, or documented expert judgement identified " +
      "as such. Flag probability estimates asserted with no basis at all, and flag any case " +
      "where probability cannot be estimated but the file quietly assumes a low one instead " +
      "of defaulting to the conservative treatment the plan requires.",
    appliesTo: ["risk_analysis"],
    crosswalk: ["820.30(g)"],
    harmLinked: true,
  },
  {
    ruleId: "iso14971-6-risk-evaluation",
    citation: "ISO 14971:2019 §6 (risk evaluation)",
    title: "Each risk must be evaluated against the pre-defined acceptability criteria",
    expectation:
      "Every estimated risk must be compared against the acceptability criteria from the plan, " +
      "and the outcome recorded. Flag risks with an estimate but no acceptability decision, " +
      "and flag any risk declared acceptable by a criterion that differs from the one the plan " +
      "states. A criterion applied inconsistently between hazards in the same file is a " +
      "finding in its own right: it is the pattern that suggests the conclusion was chosen " +
      "first and the criterion fitted to it.",
    appliesTo: ["risk_analysis"],
    crosswalk: ["820.30(g)"],
    harmLinked: true,
  },
  {
    ruleId: "iso14971-7.1-risk-control-option-analysis",
    citation: "ISO 14971:2019 §7.1 (risk control option analysis)",
    title: "Risk control options must be considered in priority order",
    expectation:
      "Risk control measures must be selected in a defined order of priority: first make the " +
      "device inherently safe by design, then add protective measures in the device or the " +
      "manufacturing process, and only then provide information for safety — labelling, " +
      "warnings, training, instructions for use. This is the single most commonly skipped " +
      "requirement in the standard. Flag any control that relies on a warning, a labelling " +
      "change, or user training where the file does not record that design and protective " +
      "options were considered first and why they were rejected as impracticable. " +
      "'Add a warning to the IFU' as a first-line control, with no such analysis, is the " +
      "canonical finding here.",
    appliesTo: ["risk_analysis", "capa", "change_package"],
    crosswalk: ["820.30(g)"],
    harmLinked: true,
  },
  {
    ruleId: "iso14971-7.3-residual-risk-evaluation",
    citation: "ISO 14971:2019 §7.3 (residual risk evaluation)",
    title: "Residual risk must be re-evaluated after controls are applied",
    expectation:
      "After each control is implemented the remaining risk must be estimated again and " +
      "evaluated against the acceptability criteria. Flag files that assert a control reduces " +
      "risk without re-estimating what is left, and flag residual ratings that appear without " +
      "a stated reason for the reduction. A severity that drops purely because a control was " +
      "added deserves scrutiny: most controls reduce probability, and severity of the harm " +
      "usually does not change once the harm occurs.",
    appliesTo: ["risk_analysis"],
    crosswalk: ["820.30(g)"],
    harmLinked: true,
  },
  {
    ruleId: "iso14971-7.4-benefit-risk-analysis",
    citation: "ISO 14971:2019 §7.4 (benefit-risk analysis)",
    title: "Risk that remains unacceptable requires a documented benefit-risk analysis",
    expectation:
      "Where a residual risk stays above the acceptability criteria and no further control is " +
      "practicable, the file must contain a benefit-risk analysis concluding that the clinical " +
      "benefit outweighs that risk, supported by evidence rather than assertion. Flag any risk " +
      "left unacceptable with no such analysis, and flag benefit-risk conclusions whose " +
      "supporting evidence is not identified. This is not a formality: it is the justification " +
      "an investigator will ask to see for exactly the risks a company most wants to move past.",
    appliesTo: ["risk_analysis"],
    crosswalk: ["820.30(g)"],
    harmLinked: true,
  },
  {
    ruleId: "iso14971-7.5-risks-from-control-measures",
    citation: "ISO 14971:2019 §7.5 (risks arising from risk control measures)",
    title: "Controls must be assessed for the new risks they introduce",
    expectation:
      "Every risk control measure must itself be reviewed for whether it introduces new " +
      "hazards or makes an existing estimated risk worse. This is routinely missed because " +
      "the fix feels like the end of the analysis. Flag any newly added control — an alarm, " +
      "an interlock, a process step, a software check — where the file does not record that " +
      "its own risks were considered. Alarm fatigue from an added alarm, and a protective " +
      "interlock that creates a new failure mode, are the recurring real examples.",
    appliesTo: ["risk_analysis", "capa", "change_package"],
    crosswalk: ["820.30(g)", "820.30(i)"],
    harmLinked: true,
  },
  {
    ruleId: "iso14971-7.6-completeness-of-risk-control",
    citation: "ISO 14971:2019 §7.6 (completeness of risk control)",
    title: "All identified risks must be shown to have been considered",
    expectation:
      "The file must demonstrate that risk from every identified hazardous situation has been " +
      "considered and dispositioned — controlled, accepted, or justified. Flag hazards that " +
      "appear in the analysis and then never reappear, and flag any summary claiming complete " +
      "control that the detail behind it does not support. This is a loop-closure check " +
      "against the file's own contents, so it is mechanically verifiable.",
    appliesTo: ["risk_analysis"],
    crosswalk: ["820.30(g)"],
    harmLinked: true,
  },
  {
    ruleId: "iso14971-8-overall-residual-risk",
    citation: "ISO 14971:2019 §8 (evaluation of overall residual risk)",
    title: "Overall residual risk must be evaluated as a whole, not hazard by hazard",
    expectation:
      "After all controls are implemented the file must evaluate the overall residual risk of " +
      "the device taken together, against the criteria in the plan, and separately from the " +
      "individual per-hazard evaluations. Flag a file where every individual risk is " +
      "acceptable but no combined evaluation exists — that is the standard failure mode, and " +
      "it matters because risks that are each tolerable alone can be intolerable in " +
      "aggregate. Where overall residual risk is judged acceptable, the reasoning must be " +
      "recorded, not merely the conclusion.",
    appliesTo: ["risk_analysis"],
    crosswalk: ["820.30(g)"],
    harmLinked: true,
  },
  {
    ruleId: "iso14971-9-risk-management-review",
    citation: "ISO 14971:2019 §9 (risk management review)",
    title: "The file must be reviewed and the review recorded before release",
    expectation:
      "Before commercial release the risk management process must be reviewed to confirm the " +
      "plan was implemented, overall residual risk is acceptable, and arrangements to collect " +
      "production and post-production information are in place. The result belongs in the file " +
      "as a dated, attributed record. Flag a review recorded after the release date it " +
      "authorises, and flag a review that asserts completion without addressing all three of " +
      "those points.",
    appliesTo: ["risk_analysis", "design_review"],
    crosswalk: ["820.30(g)", "820.30(e)"],
    harmLinked: false,
  },
  {
    ruleId: "iso14971-10-production-post-production",
    citation: "ISO 14971:2019 §10 (production and post-production activities)",
    title: "Post-production information must be actively reviewed against the risk file",
    expectation:
      "The file must show a working feedback loop: information from production, from the " +
      "field, from complaints and from comparable devices is collected, reviewed for risk " +
      "relevance, and fed back into the analysis where it changes an estimate. Flag a file " +
      "whose risk estimates predate field experience that contradicts them, and flag any case " +
      "where a complaint or CAPA established a failure occurring more often, or more severely, " +
      "than the file estimates and the file was not updated. This clause is where a stale risk " +
      "file becomes a finding rather than merely out of date.",
    appliesTo: ["risk_analysis", "capa", "complaint"],
    crosswalk: ["820.100(a)", "820.198(a)", "820.30(g)"],
    harmLinked: true,
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

/**
 * 21 CFR Part 820 / Part 803 requirements, keyed to the paragraph FDA actually
 * cites. Unlike the CAPA and design clauses (which QMSR reserved and pushed into
 * copyrighted ISO 13485), these paragraphs are US Government works: the legacy
 * QSR text is public domain and still governs every historical record and every
 * historical 483 citation. Every `expectation` here is nonetheless our own
 * original prose describing what the paragraph requires — we do not paste
 * regulation text either, both for consistency and because a plain-English
 * expectation reviews better than a statute quotation.
 *
 * These fill the corpus's biggest empirical gaps: the requirements FDA cites
 * most that the CAPA/risk rules did not cover — complaint handling (the #2
 * device citation), process validation, purchasing controls, nonconforming
 * product, acceptance activities, records, and MDR. `crosswalk` is the same
 * paragraph, so each inherits its real inspection-citation frequency.
 *
 * `appliesTo` maps each rule to the record types a customer actually uploads and
 * reviews. System-level requirements with no natural document home (management
 * review, internal audit) are deliberately omitted — a rule that can fire on no
 * record is dead weight and only muddies rule attribution.
 */
const FDA_QSR_RULES: AuthoredRule[] = [
  {
    ruleId: "cfr-820.198a-complaint-procedure",
    citation: "21 CFR 820.198(a) (complaint files)",
    title: "Complaints must be handled under a defined procedure and evaluated for reportability",
    expectation:
      "The record must show the complaint was processed through a defined complaint-handling " +
      "system: received and recorded, evaluated for whether it represents an event that must " +
      "be reported, and investigated where indicated. A complaint captured only as an informal " +
      "note, or closed without a recorded evaluation of whether it needed reporting, does not " +
      "demonstrate a controlled process even if the underlying issue was addressed.",
    appliesTo: ["complaint"],
    crosswalk: ["820.198(a)"],
    harmLinked: false,
  },
  {
    ruleId: "cfr-820.198c-complaint-reportability",
    citation: "21 CFR 820.198(c) (complaints involving reportable events)",
    title: "A complaint that may involve a reportable death or injury must record a reportability determination",
    expectation:
      "Where a complaint describes an event that may have caused or contributed to a death or " +
      "serious injury, the record must document a specific determination of whether the event is " +
      "reportable, with its basis, rather than leaving reportability unaddressed. Silence on " +
      "reportability for an event that reaches a patient is itself the finding.",
    appliesTo: ["complaint", "capa"],
    crosswalk: ["820.198(c)", "820.198(e)"],
    harmLinked: true,
  },
  {
    ruleId: "cfr-803.17-mdr-procedure",
    citation: "21 CFR 803.17 (written MDR procedures)",
    title: "Medical device reporting decisions must follow a written procedure with timely evaluation",
    expectation:
      "The record must show that the decision about whether and when to file a medical device " +
      "report was made under the firm's written MDR procedure — that the event was evaluated for " +
      "reportability against defined criteria and within the required timeframe. An event that " +
      "sits without an MDR decision, or a decision with no basis recorded, is a gap.",
    appliesTo: ["complaint"],
    crosswalk: ["803.17", "803.50(a)(1)", "803.50(a)(2)"],
    harmLinked: true,
  },
  {
    ruleId: "cfr-820.90a-nonconforming-control",
    citation: "21 CFR 820.90(a) (control of nonconforming product)",
    title: "Nonconforming product must be identified, evaluated, and controlled to prevent unintended use",
    expectation:
      "Where the record involves product that does not meet specification, it must show the " +
      "nonconforming product was identified and controlled — documented, evaluated, and " +
      "segregated or otherwise prevented from unintended use or distribution. Product found " +
      "nonconforming with no recorded evaluation or disposition, or allowed to proceed without " +
      "justification, is the finding.",
    appliesTo: ["capa", "complaint", "change_package"],
    crosswalk: ["820.90(a)"],
    harmLinked: true,
  },
  {
    ruleId: "cfr-820.90b-nonconforming-disposition",
    citation: "21 CFR 820.90(b) (nonconformity review and disposition)",
    title: "Nonconformity disposition, including any use-as-is or rework, must be documented and justified",
    expectation:
      "The disposition of a nonconformity must be recorded with its justification, and any " +
      "concession to use nonconforming product as-is must name who authorized it and on what " +
      "basis. Rework must be performed under a procedure assessed for adverse effect and the " +
      "reworked product re-evaluated. A disposition asserted without justification, or a rework " +
      "with no re-evaluation, does not close the loop.",
    appliesTo: ["capa", "change_package"],
    crosswalk: ["820.90(b)", "820.90(b)(2)"],
    harmLinked: false,
  },
  {
    ruleId: "cfr-820.75a-process-validation",
    citation: "21 CFR 820.75(a) (process validation)",
    title: "A process whose output cannot be fully verified must be validated with defined criteria",
    expectation:
      "Where a production process's results cannot be fully verified by later inspection or test, " +
      "the record must show the process was validated: defined parameters and operating ranges, " +
      "a defined number of runs, acceptance criteria established in advance, and approval by " +
      "qualified personnel. A change to such a process that relies on assertion of equivalence, " +
      "with no revalidation or documented rationale, is the finding.",
    appliesTo: ["validation", "change_package"],
    crosswalk: ["820.75(a)"],
    harmLinked: false,
  },
  {
    ruleId: "cfr-820.75b-process-monitoring",
    citation: "21 CFR 820.75(b) (process control and monitoring)",
    title: "A validated process must be monitored and revalidated when it changes",
    expectation:
      "A validated process must be controlled to its validated parameters, monitored, and " +
      "revalidated when the process or its product specification changes. The record must show " +
      "that a change to the process was assessed against the validated state and revalidated to " +
      "the extent the assessment required, not applied on the assumption that a small change " +
      "cannot matter.",
    appliesTo: ["validation", "change_package"],
    crosswalk: ["820.75(b)"],
    harmLinked: false,
  },
  {
    ruleId: "cfr-820.50-purchasing-controls",
    citation: "21 CFR 820.50 (purchasing controls)",
    title: "Suppliers of components and services must be evaluated and controlled to defined requirements",
    expectation:
      "Where the record depends on a supplier — a component, a contract process, a substituted " +
      "part — it must show the supplier was evaluated against defined requirements and that the " +
      "purchased item's requirements are specified. A supplier or part change accepted as " +
      "'equivalent' with no recorded evaluation or requirement basis does not demonstrate " +
      "control of purchasing.",
    appliesTo: ["change_package", "capa"],
    crosswalk: ["820.50", "820.50(a)", "820.50(a)(1)", "820.50(a)(3)"],
    harmLinked: false,
  },
  {
    ruleId: "cfr-820.80d-final-acceptance",
    citation: "21 CFR 820.80(d) (final acceptance activities)",
    title: "Finished product must pass defined final acceptance before release for distribution",
    expectation:
      "The record must show that finished product was not released until the activities required " +
      "by the device master record were completed and the associated records reviewed and " +
      "approved. Evidence that product shipped before its acceptance was complete — or that " +
      "release criteria were waived without authority — is the finding.",
    appliesTo: ["verification", "validation", "change_package"],
    crosswalk: ["820.80(d)", "820.80(a)"],
    harmLinked: true,
  },
  {
    ruleId: "cfr-820.80e-acceptance-records",
    citation: "21 CFR 820.80(e) (acceptance records)",
    title: "Acceptance activities must be recorded with the equipment and personnel involved",
    expectation:
      "Acceptance activities must be documented so that the record shows what was accepted, the " +
      "acceptance criteria, the equipment used, the date, and the individual performing the " +
      "activity. An acceptance asserted without a locatable record, or a record missing the " +
      "equipment or personnel, does not demonstrate the activity occurred as claimed.",
    appliesTo: ["verification", "validation"],
    crosswalk: ["820.80(e)"],
    harmLinked: false,
  },
  {
    ruleId: "cfr-820.72a-equipment-calibration",
    citation: "21 CFR 820.72(a) (inspection, measuring, and test equipment)",
    title: "Measuring and test equipment used to show conformance must be calibrated and traceable",
    expectation:
      "Where conformance is demonstrated using measuring or test equipment, the record must show " +
      "the equipment was calibrated against a traceable standard at a defined interval. Equipment " +
      "found out of calibration must trigger an assessment of the product accepted on its readings " +
      "since the last valid calibration. A conformance claim resting on uncalibrated or " +
      "unverified equipment is not supported.",
    appliesTo: ["verification", "validation", "change_package"],
    crosswalk: ["820.72(a)"],
    harmLinked: false,
  },
  {
    ruleId: "cfr-820.70a-production-controls",
    citation: "21 CFR 820.70(a) (production and process controls)",
    title: "Production processes affecting quality must be controlled to documented parameters",
    expectation:
      "Where the record involves a production process that can affect device quality, it must " +
      "show the process is carried out under documented procedures that define the parameters and " +
      "controls, and that those parameters are monitored and recorded where needed for " +
      "conformance. A process change made outside a controlled procedure, or with parameters " +
      "unspecified, is the finding.",
    appliesTo: ["change_package", "validation"],
    crosswalk: ["820.70(a)", "820.70(c)"],
    harmLinked: false,
  },
  {
    ruleId: "cfr-820.70i-automated-process-validation",
    citation: "21 CFR 820.70(i) (automated processes)",
    title: "Software used to automate a production or quality process must be validated for its intended use",
    expectation:
      "Where software controls or automates a production or quality-system process, the record " +
      "must show that software was validated for its intended use, and revalidated after a change " +
      "to it. Firmware or application-software changes credited with a quality function but not " +
      "validated as software are a gap that FDA cites specifically.",
    appliesTo: ["validation", "change_package", "verification"],
    crosswalk: ["820.70(i)"],
    harmLinked: false,
  },
  {
    ruleId: "cfr-820.40-document-controls",
    citation: "21 CFR 820.40 (document controls)",
    title: "Controlled documents must be reviewed, approved, and current at point of use",
    expectation:
      "The record must show that the documents it relies on are controlled — approved before " +
      "use, identified by revision, and current. A reference to a procedure or specification " +
      "without a revision, or reliance on a document a later change should have superseded, " +
      "undermines the record's traceability even when the underlying work was correct.",
    appliesTo: ["change_package", "design_output"],
    crosswalk: ["820.40", "820.40(a)"],
    harmLinked: false,
  },
  {
    ruleId: "cfr-820.184-device-history-record",
    citation: "21 CFR 820.184 (device history record)",
    title: "The device history record must show each unit or lot was made per the device master record",
    expectation:
      "Where the record concerns manufactured product, it must demonstrate a device history " +
      "record exists showing the product was made in accordance with the device master record, " +
      "including the acceptance records and the primary identification and control number. A " +
      "unit or lot whose manufacturing conformance cannot be traced from its record is the " +
      "finding.",
    appliesTo: ["traceability_matrix", "design_output", "change_package"],
    crosswalk: ["820.184"],
    harmLinked: false,
  },
  {
    ruleId: "cfr-820.181-device-master-record",
    citation: "21 CFR 820.181 (device master record)",
    title: "The device master record must define the specifications and procedures the product is built to",
    expectation:
      "The record must trace to a device master record that defines the device's specifications, " +
      "production process, quality-assurance procedures, and labeling. A design output or change " +
      "that is not reflected back into the device master record leaves production building to a " +
      "specification the record no longer matches.",
    appliesTo: ["design_output", "traceability_matrix", "change_package"],
    crosswalk: ["820.181"],
    harmLinked: false,
  },
  {
    ruleId: "cfr-820.250-statistical-techniques",
    citation: "21 CFR 820.250 (statistical techniques)",
    title: "Sampling plans and statistical methods must be valid for their purpose and justified",
    expectation:
      "Where the record relies on a sample — an acceptance sample, an effectiveness check, a " +
      "validation run count — the sample size and method must be justified with respect to what " +
      "it is meant to detect. A sample of convenience ('5 units', 'a few lots') offered as " +
      "evidence, with no rationale tying it to the failure rate or confidence required, does not " +
      "support the conclusion drawn from it.",
    appliesTo: ["capa", "validation", "verification"],
    crosswalk: ["820.250(b)", "820.250"],
    harmLinked: false,
  },
  {
    ruleId: "cfr-820.30g-design-validation",
    citation: "21 CFR 820.30(g) (design validation)",
    title: "Design validation must show the device meets user needs and intended uses under actual or simulated use",
    expectation:
      "Design validation must demonstrate that the device conforms to defined user needs and " +
      "intended uses, under actual or simulated use conditions, on initial production units or " +
      "their equivalents, and must include risk analysis where appropriate. Validation that only " +
      "confirms the output met the input specification (that is verification, not validation), or " +
      "that omits the actual-use dimension, does not satisfy the requirement. (Under QMSR this " +
      "requirement now enters via ISO 13485 7.3.7; the legacy paragraph still governs historical " +
      "records and is where FDA's citation history sits.)",
    appliesTo: ["validation", "design_review"],
    crosswalk: ["820.30(g)"],
    harmLinked: true,
  },
  {
    ruleId: "cfr-820.25b-personnel-training",
    citation: "21 CFR 820.25(b) (personnel training)",
    title: "Personnel performing a controlled activity must be trained, with the training recorded",
    expectation:
      "Where the record depends on a person having performed a controlled activity — an " +
      "inspection, a rework, a validated process step — it must show that person was trained for " +
      "it and that the training is recorded. A corrective action whose control is 'retraining' " +
      "with no record of who was trained, when, or against what, is not verifiable.",
    appliesTo: ["capa", "change_package"],
    crosswalk: ["820.25(b)"],
    harmLinked: false,
  },
];

export const AUTHORED_RULES: AuthoredRule[] = [
  ...CAPA_RULES,
  ...RISK_MANAGEMENT_RULES,
  ...FDA_QSR_RULES,
  ...LOGIC_RULES,
];

/**
 * Which `source` each authored rule gets. Clause-referenced rules are
 * `iso_clause` (our prose against a copyrighted standard's clause ID);
 * cross-cutting soundness checks are `logic`.
 */
export function sourceFor(rule: AuthoredRule): "iso_clause" | "cfr" | "guidance" | "logic" {
  // Public-domain 21 CFR requirements (our prose, keyed to the paragraph).
  if (rule.ruleId.startsWith("cfr-")) return "cfr";
  // Public-domain FDA guidance documents (our prose, keyed to the guidance).
  if (rule.ruleId.startsWith("guidance-")) return "guidance";
  // Copyrighted standards, referenced by clause id only — never their text.
  if (
    rule.ruleId.startsWith("iso13485-") ||
    rule.ruleId.startsWith("iso14971-") ||
    /ISO 1(3485|4971)/.test(rule.citation)
  )
    return "iso_clause";
  return "logic";
}
