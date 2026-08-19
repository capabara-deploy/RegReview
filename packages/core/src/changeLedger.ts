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
 * Everything here is pure over stored primitives. No model call, no severity
 * tier, no determination. The regulatory determination is a human-owned field
 * on the change row and is never set from this module.
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

export interface Baseline {
  baselineId: string;
  device: string;
  /** The 510(k)/clearance number that is the "original device" comparator. */
  clearanceId: string;
  clearedAt: string | null;
  configuration: Record<string, string>;
  note: string | null;
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
  status: "proposed" | "implemented" | "superseded";
  recordId: string | null;
  changedAt: string | null;
  createdAt: string;
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
}

/**
 * Assemble the cumulative view over all changes against one baseline.
 *
 * This is the whole point of the feature: individually benign changes that are
 * collectively significant. The tool shows the accumulation — how many changes
 * touch the same subsystem, whether any of them used the wrong comparator, and
 * whether an aggregate assessment exists — and refuses to judge it.
 */
export function cumulativeAssessment(baseline: Baseline, changes: Change[]): CumulativeAssessment {
  const active = changes.filter((c) => c.status !== "superseded");

  const bySubsystem = new Map<string, string[]>();
  for (const c of active) {
    const key = (c.subsystem ?? "unspecified").toLowerCase();
    if (!bySubsystem.has(key)) bySubsystem.set(key, []);
    bySubsystem.get(key)!.push(c.changeId);
  }
  const clusters: SubsystemCluster[] = [...bySubsystem.entries()]
    .map(([subsystem, changeIds]) => ({ subsystem, changeIds, count: changeIds.length }))
    .sort((a, b) => b.count - a.count);

  const gaps: ChangeGap[] = [];
  for (const c of active) {
    const g = checkComparator(c, baseline);
    if (g) gaps.push(g);
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
          `${baseline.clearanceId}. These must be assessed in the aggregate, not only ` +
          `separately; confirm an aggregate assessment exists.`,
        status: "open",
        createdAt: baseline.createdAt,
      });
    }
  }

  const typesPresent = [...new Set(active.map((c) => c.changeType))];

  return {
    baseline,
    totalChanges: active.length,
    clusters,
    typesPresent,
    gaps,
    undecided: active.filter((c) => c.determination === "undecided").length,
  };
}
