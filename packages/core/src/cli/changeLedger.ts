import { migrateCustomer } from "../db/migrate.js";
import {
  addChange,
  advanceStage,
  createBaseline,
  cumulativeAssessment,
  effectiveScore,
  getCustomerDb,
  implicatedBranches,
  listBaselines,
  listChanges,
  listSubmissions,
  setScore,
  type Change,
  type ChangeType,
  type Stage,
} from "../index.js";

/**
 * Demonstrate the cumulative change ledger on the Northlake VP-400 story.
 *
 * Seeds the cleared baseline (K192214) and the six letter-to-file changes from
 * the demo narrative, spread across the workflow so the two risk pools are both
 * populated, then prints the deterministic cumulative view: the pooled totals
 * against the customer's own escalation threshold, subsystem clustering, the
 * wrong-comparator gap (GP7), the aggregate-assessment gap (GP6), the scoring
 * gaps, and the flowchart branches each change type implicates.
 *
 * It prints gaps, totals, and considerations. It never prints a submit /
 * don't-submit determination — that is the manufacturer's, and no code here
 * makes it. The escalation line it does print is a conformance statement about
 * the customer's OWN procedure, which is a different thing.
 *
 *   npm run ledger:demo            # seed if empty, then print the assessment
 *   npm run ledger:demo -- --reseed  # rebuild the VP-400 demo rows first
 */

interface SeedChange {
  proposal: string;
  comparator: string;
  changeType: ChangeType;
  subsystem: string;
  changedAt: string;
  /** Where this change has got to in the workflow. */
  stage: Extract<Stage, "implemented" | "documented">;
  /** The controlled document that captures it, once it is documented. */
  recordId?: string;
  /** A score a person has actually confirmed, where the story has one. */
  score?: { value: number; by: string };
}

// The six accumulated changes since the 2019 clearance (see the demo fact
// ledger). Five touch occlusion detection; the last adds a risk control yet is
// filed as non-significant, and two are compared to an internal revision rather
// than the cleared K-number.
//
// The stages are the story: the three oldest are written up and waiting on a
// filing decision, while the three most recent — including the risk control —
// are in shipping product with nothing in the design history describing them.
// That second pool is the one that gets found on an inspection.
const SEED_CHANGES: SeedChange[] = [
  {
    proposal: "Application software v3.1.4 -> v3.2.1: occlusion pressure-threshold parameters tuned.",
    comparator: "v3.1.4",
    changeType: "software",
    subsystem: "occlusion detection",
    changedAt: "2021-05-01",
    stage: "documented",
    recordId: "DCO-2021-0112",
  },
  {
    proposal: "Li-ion battery cell supplier change, equivalent capacity.",
    comparator: "K192214",
    changeType: "component",
    subsystem: "battery",
    changedAt: "2022-06-01",
    stage: "documented",
    recordId: "DCO-2022-0058",
  },
  {
    proposal: "Administration-set cassette elastomer durometer change (DCO-2023-0044), supplier-driven.",
    comparator: "K192214",
    changeType: "material",
    subsystem: "occlusion detection",
    changedAt: "2023-04-01",
    stage: "documented",
    recordId: "DCO-2023-0044",
    // Scored 4 with no documented rationale. The material floor is 7, so the
    // floor holds and the ledger says why — the below-floor gap in action.
    score: { value: 4, by: "m.ortiz" },
  },
  {
    proposal: "Cassette-channel chamfer added to reduce angled seating (DCO-2026-0031); new production only.",
    comparator: "K192214",
    changeType: "geometry",
    subsystem: "occlusion detection",
    changedAt: "2024-09-01",
    stage: "implemented",
  },
  {
    proposal: "Pressure transducer part substitution on shared PCA-4400 board (DCO-2025-0077), obsolescence-driven.",
    comparator: "K192214",
    changeType: "component",
    subsystem: "occlusion detection",
    changedAt: "2025-10-01",
    stage: "implemented",
  },
  {
    proposal:
      "Safety-controller firmware v4.1 -> v4.2 (CA-2026-011): adds a secondary pressure check credited as the HAZ-01 occlusion-alarm risk control.",
    comparator: "v4.1",
    changeType: "risk_control",
    subsystem: "occlusion detection",
    changedAt: "2026-02-01",
    stage: "implemented",
    score: { value: 9, by: "j.wade" },
  },
];

function bar(value: number, threshold: number, width = 40): string {
  // Scale so the threshold sits at 3/4 of the bar; a crossed threshold then has
  // somewhere visible to overflow into rather than pinning at the end.
  const perPoint = width / (threshold * (4 / 3));
  const filled = Math.min(width, Math.round(value * perPoint));
  const mark = Math.min(width, Math.round(threshold * perPoint));
  const cells: string[] = Array.from({ length: width }, (_, i) => (i < filled ? "#" : "."));
  if (mark < width) cells[mark] = "|";
  return cells.join("");
}

async function main(): Promise<void> {
  await migrateCustomer();

  const device = "VP-400 Volumetric Infusion Pump";
  // A baseline seeded before the workflow existed has every change sitting at
  // `implemented` and unscored, which demonstrates only half the ledger. This
  // rebuilds the demo baseline so both risk pools and all four score
  // provenances are populated. Scoped to the VP-400 demo rows and opt-in,
  // because it deletes them.
  const reseed = process.argv.includes("--reseed");
  if (reseed) {
    const db = getCustomerDb();
    const stale = (await listBaselines()).filter((b) => b.clearanceId === "K192214");
    for (const b of stale) {
      // changes and submissions cascade from baselines.
      await db.prepare(`DELETE FROM baselines WHERE baseline_id = ?`).run(b.baselineId);
    }
    if (stale.length > 0) console.log(`Removed ${stale.length} existing VP-400 baseline(s).`);
  }

  let baseline = (await listBaselines()).find((b) => b.clearanceId === "K192214");

  if (!baseline) {
    baseline = await createBaseline({
      device,
      clearanceId: "K192214",
      clearedAt: "2019-06-14",
      configuration: { software: "3.1.4", firmware: "4.1", occlusionThresholdMmHg: "525" },
      note: "VP-400 cleared configuration of record.",
      // Northlake's own change-control procedure sets both of these. They are
      // the customer's numbers; the tool reports against them, it does not
      // propose them.
      threshold: 30,
      thresholdSource: "QSP-0031 §5.4",
    });
    for (const s of SEED_CHANGES) {
      const change = await addChange({
        baselineId: baseline.baselineId,
        proposal: s.proposal,
        comparator: s.comparator,
        changeType: s.changeType,
        subsystem: s.subsystem,
        stage: "implemented",
        changedAt: s.changedAt,
      });
      if (s.stage === "documented" && s.recordId) {
        await advanceStage(change.changeId, "documented", {
          recordId: s.recordId,
          actor: "seed",
          at: s.changedAt,
        });
      }
      if (s.score) {
        await setScore(change.changeId, s.score.value, { actor: s.score.by });
      }
    }
    console.log(`Seeded baseline ${baseline.clearanceId} with ${SEED_CHANGES.length} changes.\n`);
  } else {
    console.log(`Using existing baseline ${baseline.clearanceId}.\n`);
  }

  const changes = await listChanges(baseline.baselineId);
  const submissions = await listSubmissions(baseline.baselineId);
  const assessment = cumulativeAssessment(baseline, changes, submissions);
  const { pools, escalation } = assessment;

  console.log(`Cumulative change assessment — ${baseline.device}`);
  console.log(`Cleared baseline: ${baseline.clearanceId} (${baseline.clearedAt ?? "date unknown"})`);
  console.log(`Changes since clearance: ${assessment.totalChanges}  (${assessment.undecided} undecided)\n`);

  console.log("Accumulated risk");
  console.log(`  ${bar(pools.exposure, baseline.threshold)}  ${pools.exposure} / ${baseline.threshold}`);
  console.log(`  implemented, not documented : ${String(pools.undocumented).padStart(3)}`);
  console.log(`  documented, not submitted   : ${String(pools.unsubmitted).padStart(3)}`);
  console.log(`  ---------------------------------`);
  console.log(`  exposure                    : ${String(pools.exposure).padStart(3)}`);
  console.log(`  proposed (not yet exposure) : ${String(pools.pipeline).padStart(3)}  -> would reach ${pools.projected}`);
  console.log(`  of exposure, unconfirmed    : ${String(pools.unconfirmed).padStart(3)}`);

  console.log(`\n${escalation.crossed ? "!! " : ""}${escalation.message}\n`);

  console.log("Subsystem clustering (individually benign, collectively significant):");
  for (const c of assessment.clusters) {
    console.log(`  ${String(c.count).padStart(2)}x  ${c.subsystem.padEnd(24)} ${c.score} pts`);
  }

  console.log(`\nDeterministic gaps (${assessment.gaps.length}) — flags, not determinations:`);
  for (const g of assessment.gaps) {
    console.log(`  [${g.kind}] ${g.detail}`);
  }

  console.log("\nPer-change score provenance:");
  for (const change of changes.filter((c: Change) => c.stage !== "superseded")) {
    const s = effectiveScore(change);
    const note =
      s.source === "floor"
        ? "floor (nobody has scored it)"
        : s.source === "suggested"
          ? "model suggestion, unconfirmed"
          : s.source === "confirmed_below_floor"
            ? "below floor, rationale on file"
            : s.clampedByFloor
              ? `raised to floor from ${change.score}`
              : "confirmed";
    console.log(
      `  ${String(s.value).padStart(2)}  ${change.stage.padEnd(14)} ${note.padEnd(30)} ${change.proposal.slice(0, 54)}`,
    );
  }

  console.log("\nFlowchart branches to consider, by change:");
  for (const change of changes.filter((c: Change) => c.stage !== "superseded")) {
    const branches = implicatedBranches(change.changeType);
    console.log(`  ${change.changedAt ?? ""}  (${change.changeType})  ${change.proposal.slice(0, 70)}`);
    for (const b of branches) {
      console.log(`       - ${b.chart}/${b.step}: ${b.consider}`);
    }
  }

  console.log(
    `\nThe tool flags gaps, totals risk against the threshold in Northlake's own\n` +
      `change-control procedure, and lists the questions the guidance would ask. It\n` +
      `does not answer them: the submit / don't-submit determination is the\n` +
      `manufacturer's, and every change above is 'undecided' until a person sets it.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
