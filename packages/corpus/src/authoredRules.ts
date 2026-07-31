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

export const AUTHORED_RULES: AuthoredRule[] = [
  ...CAPA_RULES,
  ...RISK_MANAGEMENT_RULES,
  ...LOGIC_RULES,
];

/**
 * Which `source` each authored rule gets. Clause-referenced rules are
 * `iso_clause` (our prose against a copyrighted standard's clause ID);
 * cross-cutting soundness checks are `logic`.
 */
export function sourceFor(rule: AuthoredRule): "iso_clause" | "logic" {
  return rule.ruleId.startsWith("iso13485-") ||
    rule.ruleId.startsWith("iso14971-") ||
    /ISO 1(3485|4971)/.test(rule.citation)
    ? "iso_clause"
    : "logic";
}
