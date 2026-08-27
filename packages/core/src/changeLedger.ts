import { z } from "zod";

/**
 * The cumulative change ledger — deterministic core.
 *
 * The reshaped "informal submission" feature. Ben Cass asked for a box where an
 * engineer types a proposed change and the tool returns its risk. We do NOT
 * build that, because the output that box implies — "no new 510(k) required" —
 * is the manufacturer's statutory determination (21 CFR 807.81(a)(3)), the
 * single highest-liability string this product could emit, and exactly the
 * auto-decide pattern the whole product forbids.
 *
 * What we build instead is deterministic and refuses the verdict:
 *
 *  - a comparison of what changed against the CLEARED baseline;
 *  - the wrong-comparator check (comparing to an internal revision rather than
 *    the cleared 510(k) number — "GP7"), which is code-computable and citable;
 *  - which decision-flowchart branches a change TYPE implicates, rendered as
 *    "branches to consider", never answered yes/no;
 *  - the cumulative view: how many accumulated changes touch each subsystem, and
 *    whether an aggregate assessment of them exists ("GP6").
 *
 * It also replaces the thing companies do today — a spreadsheet of 1-10 risk
 * numbers with a running total — with the same arithmetic done honestly:
 *
 *  - risk pooled by STAGE, so "in the product but undocumented" is separable
 *    from "documented but not yet filed" (`RiskPools`);
 *  - a deterministic FLOOR under each score, taken from the change type's
 *    flowchart branch, which a human may go below only by writing the rationale
 *    the guidance itself demands (`effectiveScore`);
 *  - an ESCALATION signal keyed to the customer's own procedural threshold, not
 *    to any judgment of ours about what FDA requires (`Escalation`).
 *
 * The escalation is the line to hold. "Your procedure requires a determination
 * and none has been made" is a conformance finding against the customer's SOP.
 * "You must submit a 510(k)" is the manufacturer's statutory determination and
 * is never emitted, computed, or implied here.
 *
 * Everything in this module is pure over stored primitives. No model call, no
 * severity tier, no determination. Scoring by model lives in `changeScorer.ts`
 * and only ever writes `suggestedScore`, which this module treats as provisional.
 */

export const ChangeType = z.enum([
  "software",
  "labeling",
  "material",
  "component",
  "geometry",
  "performance_spec",
  "risk_control",
  "manufacturing_process",
  "other",
]);
export type ChangeType = z.infer<typeof ChangeType>;

export const Determination = z.enum(["undecided", "letter_to_file", "new_submission"]);
export type Determination = z.infer<typeof Determination>;

/**
 * Where a change sits in the workflow.
 *
 * The two middle stages are the reason this exists. A spreadsheet knows only
 * "there is a change"; it cannot distinguish a change that is already in
 * shipping product but written down nowhere (`implemented`) from one that is
 * fully documented and merely waiting on a filing decision (`documented`).
 * The first is what an investigator finds; the second is what a regulatory
 * affairs lead manages. Pooling risk separately by stage is what makes the
 * accumulated number mean something.
 */
export const Stage = z.enum([
  "proposed",
  "implemented",
  "documented",
  "in_submission",
  "cleared",
  "superseded",
]);
export type Stage = z.infer<typeof Stage>;

/** Workflow order, for rendering and for rejecting backwards transitions. */
export const STAGE_ORDER: Stage[] = [
  "proposed",
  "implemented",
  "documented",
  "in_submission",
  "cleared",
];

export const SubmissionKind = z.enum([
  "special_510k",
  "traditional_510k",
  "abbreviated_510k",
  "letter_to_file",
  "pma_supplement",
  "other",
]);
export type SubmissionKind = z.infer<typeof SubmissionKind>;

export const SubmissionStatus = z.enum([
  "planned",
  "filed",
  "additional_info",
  "cleared",
  "withdrawn",
]);
export type SubmissionStatus = z.infer<typeof SubmissionStatus>;

export interface Submission {
  submissionId: string;
  baselineId: string;
  title: string;
  kind: SubmissionKind;
  status: SubmissionStatus;
  filedAt: string | null;
  decisionAt: string | null;
  clearanceId: string | null;
  note: string | null;
  createdAt: string;
}

export interface Baseline {
  baselineId: string;
  device: string;
  /** The 510(k)/clearance number that is the "original device" comparator. */
  clearanceId: string;
  clearedAt: string | null;
  configuration: Record<string, string>;
  note: string | null;
  /**
   * The accumulated-risk value at which the CUSTOMER's change-control procedure
   * requires a regulatory determination. It is their number, not ours and not
   * FDA's — see `escalation()`.
   */
  threshold: number;
  /** Citation for that threshold, e.g. "QSP-0031 §5.4". */
  thresholdSource: string | null;
  /** Set when a cleared submission establishes a successor baseline. */
  supersededBy: string | null;
  createdAt: string;
}

export interface Change {
  changeId: string;
  baselineId: string;
  proposal: string;
  /** What the change was compared against, as written. */
  comparator: string | null;
  changeType: ChangeType;
  subsystem: string | null;
  determination: Determination;
  stage: Stage;
  /** The controlled document that captures this change, once one exists. */
  recordId: string | null;
  changedAt: string | null;
  createdAt: string;

  /** Human-confirmed risk score, 1-10. Only a person ever writes this. */
  score: number | null;
  /** The model's read of the typed proposal. Never authoritative on its own. */
  suggestedScore: number | null;
  suggestedRationale: string | null;
  suggestedAt: string | null;
  scoredBy: string | null;
  scoredAt: string | null;
  /** The documented rationale required to score below the type's floor. */
  belowFloorRationale: string | null;

  implementedAt: string | null;
  documentedAt: string | null;
  documentedBy: string | null;
  submissionId: string | null;
}

/**
 * The deterministic floor under a change type's risk score.
 *
 * A model asked to score a free-text proposal will happily rate a risk-control
 * change a 3. The FDA change-decision guidance says the opposite: certain
 * classes of change are presumed significant, and the presumption is rebutted
 * only by a documented rationale. So the floor is not advice — it is the
 * guidance's own presumption expressed as a number, and the effective score is
 * clamped up to it unless a human writes that rationale down.
 *
 * The prose is ours; only the guidance's step labels are cited. Floors are
 * intentionally moderate: they set a defensible minimum, not a verdict.
 */
export const SCORE_FLOORS: Record<ChangeType, { floor: number; reason: string }> = {
  risk_control: {
    floor: 7,
    reason:
      "Software flowchart Q3b treats a change that adds or modifies a risk control as significant unless a documented rationale establishes otherwise.",
  },
  material: {
    floor: 7,
    reason:
      "Main flowchart B: a material change bears on body contact, fluid path, and biocompatibility, where prior testing may no longer apply.",
  },
  labeling: {
    floor: 6,
    reason:
      "Main flowchart D: labeling that carries indications, warnings, or instructions relied on for safe use.",
  },
  performance_spec: {
    floor: 6,
    reason:
      "Main flowchart A: a performance specification is part of the basis for the substantial-equivalence claim.",
  },
  software: {
    floor: 5,
    reason:
      "Software flowchart Q3a: a software change may create a new risk or modify an existing one.",
  },
  component: {
    floor: 5,
    reason: "Main flowchart A/B: a component change can affect performance and the risk analysis.",
  },
  geometry: {
    floor: 5,
    reason: "Main flowchart A/B: a dimensional change can affect performance and the risk analysis.",
  },
  manufacturing_process: {
    floor: 4,
    reason:
      "Main flowchart E: a manufacturing change is assessed for its effect on performance specifications and design.",
  },
  other: {
    floor: 3,
    reason:
      "Main flowchart A: any change is assessed for effect on safety, effectiveness, and the basis of the prior clearance.",
  },
};

export type ScoreSource =
  /** A person set this number, at or above the floor. */
  | "confirmed"
  /** A person set it below the floor and documented why. Honored as written. */
  | "confirmed_below_floor"
  /** The model's suggestion, unconfirmed. Counts, but visibly provisional. */
  | "suggested"
  /** Nobody has scored it; the type's floor stands in so exposure is never understated. */
  | "floor";

export interface EffectiveScore {
  value: number;
  source: ScoreSource;
  floor: number;
  floorReason: string;
  /** The raw number was under the floor with no rationale, so the floor held. */
  clampedByFloor: boolean;
  belowFloorRationale: string | null;
}

/**
 * Resolve the score that actually counts toward accumulated risk.
 *
 * Precedence is human > model > floor, and the floor is a hard minimum in every
 * branch but one: a human who writes a rationale may go below it, because that
 * is exactly the escape hatch the guidance itself provides. A model may not,
 * because a model cannot author the rationale that justifies it.
 *
 * An unscored change resolves to its floor rather than to zero. Zero would let
 * a ledger full of untouched changes read as "no exposure", which is the single
 * most dangerous way this number could be wrong.
 */
export function effectiveScore(change: Change): EffectiveScore {
  const { floor, reason } = SCORE_FLOORS[change.changeType];
  const base = { floor, floorReason: reason, belowFloorRationale: change.belowFloorRationale };

  if (change.score !== null) {
    if (change.score < floor) {
      // The documented-rationale escape hatch. With one, the human's number
      // stands; without one, the presumption in the guidance holds.
      return change.belowFloorRationale?.trim()
        ? { ...base, value: change.score, source: "confirmed_below_floor", clampedByFloor: false }
        : { ...base, value: floor, source: "confirmed", clampedByFloor: true };
    }
    return { ...base, value: change.score, source: "confirmed", clampedByFloor: false };
  }

  if (change.suggestedScore !== null) {
    const clamped = change.suggestedScore < floor;
    return {
      ...base,
      value: Math.max(change.suggestedScore, floor),
      source: "suggested",
      clampedByFloor: clamped,
    };
  }

  return { ...base, value: floor, source: "floor", clampedByFloor: false };
}

export interface ChangeGap {
  gapId: string;
  changeId: string;
  origin: "deterministic" | "inferred";
  kind: string;
  detail: string;
  status: "open" | "accepted" | "dismissed";
  createdAt: string;
}

/**
 * A branch of a decision flowchart that a change TYPE implicates.
 *
 * Deliberately phrased as a consideration, never as an answer. The tool tells
 * the reviewer which questions the FDA change guidance flowcharts would put to
 * this kind of change; it does not answer them, because answering them is the
 * determination we refuse to make.
 */
export interface ImplicatedBranch {
  chart: "main" | "software";
  /** The guidance's own step label, e.g. "A2.1" or "software Q3b". */
  step: string;
  consider: string;
}

/**
 * Map a change type to the flowchart branches worth considering.
 *
 * Sourced from the public-domain FDA guidance "Deciding When to Submit a 510(k)
 * for a Change to an Existing Device" and its software companion. The prose is
 * our own; we cite the guidance's step labels, not its text. These are prompts
 * for the reviewer, not determinations.
 */
export function implicatedBranches(type: ChangeType): ImplicatedBranch[] {
  switch (type) {
    case "software":
      return [
        { chart: "software", step: "Q1", consider: "Is the change made solely to strengthen cybersecurity, with no other impact?" },
        { chart: "software", step: "Q2", consider: "Is the change a return of the device to its cleared specification (a correction)?" },
        { chart: "software", step: "Q3a", consider: "Could the change create a new risk or modify an existing risk that could result in significant harm?" },
        { chart: "software", step: "Q3b", consider: "Does the change add to or modify a risk control? A change that adds or modifies a risk control is significant unless a documented rationale establishes otherwise." },
      ];
    case "risk_control":
      return [
        { chart: "main", step: "C", consider: "Does the change affect a risk control or the device's risk analysis conclusions?" },
        { chart: "software", step: "Q3b", consider: "If implemented in software, adding or modifying a risk control is significant absent a documented rationale." },
      ];
    case "labeling":
      return [
        { chart: "main", step: "D", consider: "Is this a labeling change affecting indications, warnings, or instructions relied on for safe use?" },
      ];
    case "material":
      return [
        { chart: "main", step: "B", consider: "Does the material change affect body-contact, fluid-path performance, or biocompatibility?" },
      ];
    case "component":
    case "geometry":
    case "performance_spec":
      return [
        { chart: "main", step: "A", consider: "Could the change significantly affect the device's performance or the basis of the substantial-equivalence claim?" },
        { chart: "main", step: "B", consider: "Was the change assessed against the risk management file for a new or modified risk?" },
      ];
    case "manufacturing_process":
      return [
        { chart: "main", step: "E", consider: "Does the manufacturing change affect performance specifications or the device's design?" },
      ];
    case "other":
      return [
        { chart: "main", step: "A", consider: "Could the change significantly affect safety, effectiveness, or the basis of the prior clearance?" },
      ];
  }
}

/** True when a comparator string looks like the cleared 510(k) number. */
function looksLikeClearance(comparator: string): boolean {
  return /\b[KDP]\d{6}\b|\bDEN\d{6}\b/i.test(comparator);
}

/**
 * The wrong-comparator check ("GP7").
 *
 * A change assessment must compare against the most-recently-cleared
 * configuration — its 510(k) number — not an intervening internal revision.
 * When the recorded comparator is present, is not the baseline's clearance id,
 * and does not itself look like a clearance number, that is a deterministic,
 * citable defect. Returns null when there is nothing to flag.
 */
export function checkComparator(change: Change, baseline: Baseline): ChangeGap | null {
  const comparator = change.comparator?.trim();
  if (!comparator) return null;

  const matchesClearance =
    comparator === baseline.clearanceId ||
    comparator.toUpperCase().includes(baseline.clearanceId.toUpperCase());
  if (matchesClearance) return null;

  // If it merely looks like some clearance number (not this baseline's), still
  // flag it, because the comparator must be THIS device's cleared config.
  const detail = looksLikeClearance(comparator)
    ? `Change compares against "${comparator}", which is not this device's cleared configuration (${baseline.clearanceId}).`
    : `Change compares against "${comparator}", an internal revision rather than the cleared configuration (${baseline.clearanceId}). The change-assessment comparison must be made against the most-recently-cleared device.`;

  return {
    gapId: `gap-${change.changeId}-comparator`,
    changeId: change.changeId,
    origin: "deterministic",
    kind: "wrong_comparator",
    detail,
    status: "open",
    createdAt: change.createdAt,
  };
}

export interface SubsystemCluster {
  subsystem: string;
  changeIds: string[];
  count: number;
  /** Accumulated risk within this subsystem — where clustering actually bites. */
  score: number;
}

/**
 * A change left in shipping product this long without a controlled document is
 * the specific condition an investigator finds by walking the floor and
 * comparing what is built to what is written. Ninety days is a common internal
 * change-control target; it is a default, and a customer's own procedure should
 * override it once we read that procedure.
 */
export const UNDOCUMENTED_AGING_DAYS = 90;

/**
 * Accumulated risk, split by how exposed each pool actually is.
 *
 * `exposure` is the number that gets compared to the threshold, and it is
 * deliberately the sum of the two middle stages only. Proposed changes are not
 * in the product yet, so counting them would overstate today's exposure — but
 * ignoring them entirely wastes the one genuinely predictive thing the ledger
 * knows, so they are carried separately as `pipeline` and shown as a forecast.
 */
export interface RiskPools {
  /** Implemented but not yet captured in a controlled document. */
  undocumented: number;
  /** Documented but not yet carried by a submission. */
  unsubmitted: number;
  /** undocumented + unsubmitted — what the threshold is measured against. */
  exposure: number;
  /** Proposed, not yet implemented. A forecast, not exposure. */
  pipeline: number;
  /** exposure + pipeline: where this lands if everything proposed ships. */
  projected: number;
  /** Riding on a submission already out the door. Informational. */
  inSubmission: number;
  /**
   * How much of `exposure` rests on model suggestions or bare floors that no
   * human has confirmed. Surfaced so the headline number is never quietly
   * load-bearing on an unreviewed inference.
   */
  unconfirmed: number;
}

/**
 * The escalation signal.
 *
 * This is the closest this product comes to the sentence everyone wants it to
 * say, and the distinction is the whole design. It does not say a submission is
 * required — that determination is the manufacturer's under 21 CFR 807.81(a)(3)
 * and nothing here computes it. It says the customer's OWN change-control
 * procedure sets a threshold, that accumulated risk has passed it, and that the
 * determination the procedure calls for at that point has not been made.
 *
 * That is a conformance finding against the customer's SOP — the same thing the
 * rest of the product does to their documents — and it carries the same urgency
 * without borrowing FDA's voice.
 */
export interface Escalation {
  crossed: boolean;
  exposure: number;
  threshold: number;
  thresholdSource: string | null;
  /** Room left before the threshold; negative once crossed. */
  headroom: number;
  /** The pipeline would carry it over, even though it has not yet. */
  projectedCrosses: boolean;
  undecided: number;
  message: string;
}

export interface CumulativeAssessment {
  baseline: Baseline;
  totalChanges: number;
  /** Changes grouped by the subsystem they touch, largest cluster first. */
  clusters: SubsystemCluster[];
  /** Change types present, for the implicated-branch summary. */
  typesPresent: ChangeType[];
  /**
   * Deterministic gaps across the whole ledger — the per-change comparator
   * gaps plus ledger-level gaps like a missing aggregate assessment. Never a
   * score, never a determination.
   */
  gaps: ChangeGap[];
  /**
   * Count of changes whose determination the human has not yet made. Surfaced
   * so an accumulation of undecided changes is visible, not to decide them.
   */
  undecided: number;
  pools: RiskPools;
  escalation: Escalation;
  stageCounts: Record<Stage, number>;
  submissions: Submission[];
}

function daysBetween(fromIso: string, toIso: string): number {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : 0;
}

/**
 * Compose the escalation message.
 *
 * Every branch names the threshold as the customer's, and the crossed branch
 * closes by disclaiming the determination explicitly. Both are load-bearing:
 * this string is the one a regulatory lead is most likely to screenshot.
 */
function escalationMessage(
  crossed: boolean,
  projectedCrosses: boolean,
  pools: RiskPools,
  baseline: Baseline,
  undecided: number,
): string {
  const source = baseline.thresholdSource
    ? ` set by your change-control procedure (${baseline.thresholdSource})`
    : " set by your change-control procedure";

  if (crossed) {
    const undecidedClause =
      undecided > 0
        ? ` ${undecided} change${undecided === 1 ? "" : "s"} ${undecided === 1 ? "is" : "are"} still undecided.`
        : " Every change here already carries a recorded determination.";
    return (
      `Accumulated change risk since clearance ${baseline.clearanceId} is ${pools.exposure}, ` +
      `above the escalation threshold of ${baseline.threshold}${source}. ` +
      `Your procedure calls for a regulatory determination at this point.${undecidedClause} ` +
      `This tool does not determine whether a new submission is required — that is the ` +
      `manufacturer's call under 21 CFR 807.81(a)(3).`
    );
  }
  if (projectedCrosses) {
    return (
      `Accumulated change risk is ${pools.exposure} of ${baseline.threshold}${source}. ` +
      `The ${pools.pipeline} points of proposed-but-not-yet-implemented change would bring it ` +
      `to ${pools.projected}, past that threshold — worth deciding before those changes ship, ` +
      `rather than after.`
    );
  }
  return (
    `Accumulated change risk is ${pools.exposure} of ${baseline.threshold}${source}. ` +
    `${baseline.threshold - pools.exposure} points of headroom remain.`
  );
}

/**
 * Assemble the cumulative view over all changes against one baseline.
 *
 * This is the whole point of the feature: individually benign changes that are
 * collectively significant. The tool shows the accumulation — the risk pooled by
 * stage, how many changes touch the same subsystem, whether any of them used the
 * wrong comparator, and whether the customer's own threshold has been passed —
 * and refuses to judge it.
 *
 * `now` is a parameter rather than a call to the clock so the aging checks are
 * deterministic under test and identical across a re-read of the same ledger.
 */
export function cumulativeAssessment(
  baseline: Baseline,
  changes: Change[],
  submissions: Submission[] = [],
  now: string = new Date().toISOString(),
): CumulativeAssessment {
  // Cleared changes were retired by a successor baseline; superseded ones were
  // replaced. Neither is accumulated exposure against THIS clearance.
  const active = changes.filter((c) => c.stage !== "superseded" && c.stage !== "cleared");

  const scoreOf = new Map<string, EffectiveScore>();
  for (const c of changes) scoreOf.set(c.changeId, effectiveScore(c));
  const points = (c: Change) => scoreOf.get(c.changeId)?.value ?? 0;
  const sum = (list: Change[]) => list.reduce((t, c) => t + points(c), 0);

  const inStage = (s: Stage) => active.filter((c) => c.stage === s);
  const undocumented = sum(inStage("implemented"));
  const unsubmitted = sum(inStage("documented"));
  const pipeline = sum(inStage("proposed"));
  const exposure = undocumented + unsubmitted;

  const pools: RiskPools = {
    undocumented,
    unsubmitted,
    exposure,
    pipeline,
    projected: exposure + pipeline,
    inSubmission: sum(inStage("in_submission")),
    unconfirmed: sum(
      active.filter(
        (c) =>
          (c.stage === "implemented" || c.stage === "documented") &&
          scoreOf.get(c.changeId)?.source !== "confirmed" &&
          scoreOf.get(c.changeId)?.source !== "confirmed_below_floor",
      ),
    ),
  };

  const bySubsystem = new Map<string, Change[]>();
  for (const c of active) {
    const key = (c.subsystem ?? "unspecified").toLowerCase();
    if (!bySubsystem.has(key)) bySubsystem.set(key, []);
    bySubsystem.get(key)!.push(c);
  }
  const clusters: SubsystemCluster[] = [...bySubsystem.entries()]
    .map(([subsystem, list]) => ({
      subsystem,
      changeIds: list.map((c) => c.changeId),
      count: list.length,
      score: sum(list),
    }))
    .sort((a, b) => b.score - a.score || b.count - a.count);

  const gaps: ChangeGap[] = [];
  for (const c of active) {
    const g = checkComparator(c, baseline);
    if (g) gaps.push(g);

    const s = scoreOf.get(c.changeId)!;

    // Nobody has put a number on this, so its floor is standing in. Worth
    // saying out loud: an unreviewed change is contributing to the total.
    if (s.source === "floor") {
      gaps.push({
        gapId: `gap-${c.changeId}-unscored`,
        changeId: c.changeId,
        origin: "deterministic",
        kind: "unscored_change",
        detail:
          `No risk score has been recorded. The change type's floor (${s.floor}) is being ` +
          `counted instead, so the accumulated total is a lower bound, not an estimate.`,
        status: "open",
        createdAt: c.createdAt,
      });
    }

    // The honesty check on the model's contribution.
    if (s.source === "suggested") {
      gaps.push({
        gapId: `gap-${c.changeId}-unconfirmed`,
        changeId: c.changeId,
        origin: "deterministic",
        kind: "unconfirmed_score",
        detail:
          `This change counts ${s.value} toward the accumulated total on a suggested score ` +
          `that no reviewer has confirmed. Confirm or correct it before relying on the total.`,
        status: "open",
        createdAt: c.createdAt,
      });
    }

    // Scored under the guidance's presumption with nothing written down. The
    // floor held; this says why, and what would release it.
    if (s.clampedByFloor && s.source === "confirmed") {
      gaps.push({
        gapId: `gap-${c.changeId}-below-floor`,
        changeId: c.changeId,
        origin: "deterministic",
        kind: "below_floor_no_rationale",
        detail:
          `Scored below the floor of ${s.floor} for this change type, with no documented ` +
          `rationale. ${s.floorReason} The floor is being counted until a rationale is recorded.`,
        status: "open",
        createdAt: c.createdAt,
      });
    }

    // In the product, not in the documentation, and aging.
    if (c.stage === "implemented") {
      const since = c.implementedAt ?? c.changedAt ?? c.createdAt;
      const age = daysBetween(since, now);
      if (age >= UNDOCUMENTED_AGING_DAYS) {
        gaps.push({
          gapId: `gap-${c.changeId}-aging`,
          changeId: c.changeId,
          origin: "deterministic",
          kind: "undocumented_aging",
          detail:
            `Implemented ${age} days ago and still not captured in a controlled document. ` +
            `A change present in the product but absent from the design history is what an ` +
            `investigator finds by comparing the two.`,
          status: "open",
          createdAt: c.createdAt,
        });
      }
    }
  }

  // GP6: where several changes touch the same subsystem since clearance, an
  // aggregate assessment of them is expected. We cannot see whether one exists
  // as a document from here, so we flag the CONDITION that requires one — a
  // subsystem with more than one accumulated change — as a deterministic gap.
  for (const cluster of clusters) {
    if (cluster.subsystem !== "unspecified" && cluster.count > 1) {
      gaps.push({
        gapId: `gap-${baseline.baselineId}-aggregate-${cluster.subsystem}`,
        changeId: cluster.changeIds[0]!,
        origin: "deterministic",
        kind: "no_aggregate_assessment",
        detail:
          `${cluster.count} accumulated changes touch "${cluster.subsystem}" since clearance ` +
          `${baseline.clearanceId}, carrying ${cluster.score} points between them. These must be ` +
          `assessed in the aggregate, not only separately; confirm an aggregate assessment exists.`,
        status: "open",
        createdAt: baseline.createdAt,
      });
    }
  }

  const typesPresent = [...new Set(active.map((c) => c.changeType))];
  const undecided = active.filter((c) => c.determination === "undecided").length;

  const crossed = pools.exposure > baseline.threshold;
  const projectedCrosses = !crossed && pools.projected > baseline.threshold;

  const stageCounts = Object.fromEntries(
    Stage.options.map((s) => [s, changes.filter((c) => c.stage === s).length]),
  ) as Record<Stage, number>;

  return {
    baseline,
    totalChanges: active.length,
    clusters,
    typesPresent,
    gaps,
    undecided,
    pools,
    escalation: {
      crossed,
      exposure: pools.exposure,
      threshold: baseline.threshold,
      thresholdSource: baseline.thresholdSource,
      headroom: baseline.threshold - pools.exposure,
      projectedCrosses,
      undecided,
      message: escalationMessage(crossed, projectedCrosses, pools, baseline, undecided),
    },
    stageCounts,
    submissions,
  };
}

