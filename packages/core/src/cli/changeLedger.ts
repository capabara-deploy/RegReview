import { migrateCustomer } from "../db/migrate.js";
import {
  addChange,
  createBaseline,
  cumulativeAssessment,
  implicatedBranches,
  listBaselines,
  listChanges,
  type Change,
  type ChangeType,
} from "../index.js";

/**
 * Demonstrate the cumulative change ledger on the Northlake VP-400 story.
 *
 * Seeds the cleared baseline (K192214) and the six letter-to-file changes from
 * the demo narrative, then prints the deterministic cumulative view: subsystem
 * clustering, the wrong-comparator gap (GP7), the aggregate-assessment gap
 * (GP6), and the flowchart branches each change type implicates.
 *
 * It prints gaps and considerations. It never prints a submit / don't-submit
 * determination — that is the manufacturer's, and no code here makes it.
 *
 *   npm run ledger:demo            # seed if empty, then print the assessment
 */

interface SeedChange {
  proposal: string;
  comparator: string;
  changeType: ChangeType;
  subsystem: string;
  changedAt: string;
}

// The six accumulated changes since the 2019 clearance (see the demo fact
// ledger). Five touch occlusion detection; the last adds a risk control yet is
// filed as non-significant, and the whole ledger is compared to an internal
// revision rather than the cleared K-number.
const SEED_CHANGES: SeedChange[] = [
  {
    proposal: "Application software v3.1.4 -> v3.2.1: occlusion pressure-threshold parameters tuned.",
    comparator: "v3.1.4",
    changeType: "software",
    subsystem: "occlusion detection",
    changedAt: "2021-05-01",
  },
  {
    proposal: "Li-ion battery cell supplier change, equivalent capacity.",
    comparator: "K192214",
    changeType: "component",
    subsystem: "battery",
    changedAt: "2022-06-01",
  },
  {
    proposal: "Administration-set cassette elastomer durometer change (DCO-2023-0044), supplier-driven.",
    comparator: "K192214",
    changeType: "material",
    subsystem: "occlusion detection",
    changedAt: "2023-04-01",
  },
  {
    proposal: "Cassette-channel chamfer added to reduce angled seating (DCO-2026-0031); new production only.",
    comparator: "K192214",
    changeType: "geometry",
    subsystem: "occlusion detection",
    changedAt: "2024-09-01",
  },
  {
    proposal: "Pressure transducer part substitution on shared PCA-4400 board (DCO-2025-0077), obsolescence-driven.",
    comparator: "K192214",
    changeType: "component",
    subsystem: "occlusion detection",
    changedAt: "2025-10-01",
  },
  {
    proposal:
      "Safety-controller firmware v4.1 -> v4.2 (CA-2026-011): adds a secondary pressure check credited as the HAZ-01 occlusion-alarm risk control.",
    comparator: "v4.1",
    changeType: "risk_control",
    subsystem: "occlusion detection",
    changedAt: "2026-02-01",
  },
];

async function main(): Promise<void> {
  await migrateCustomer();

  const device = "VP-400 Volumetric Infusion Pump";
  let baseline = (await listBaselines()).find((b) => b.clearanceId === "K192214");

  if (!baseline) {
    baseline = await createBaseline({
      device,
      clearanceId: "K192214",
      clearedAt: "2019-06-14",
      configuration: { software: "3.1.4", firmware: "4.1", occlusionThresholdMmHg: "525" },
      note: "VP-400 cleared configuration of record.",
    });
    for (const s of SEED_CHANGES) {
      await addChange({
        baselineId: baseline.baselineId,
        proposal: s.proposal,
        comparator: s.comparator,
        changeType: s.changeType,
        subsystem: s.subsystem,
        status: "implemented",
        changedAt: s.changedAt,
      });
    }
    console.log(`Seeded baseline ${baseline.clearanceId} with ${SEED_CHANGES.length} changes.\n`);
  } else {
    console.log(`Using existing baseline ${baseline.clearanceId}.\n`);
  }

  const changes = await listChanges(baseline.baselineId);
  const assessment = cumulativeAssessment(baseline, changes);

  console.log(`Cumulative change assessment — ${baseline.device}`);
  console.log(`Cleared baseline: ${baseline.clearanceId} (${baseline.clearedAt ?? "date unknown"})`);
  console.log(`Changes since clearance: ${assessment.totalChanges}  (${assessment.undecided} undecided)\n`);

  console.log("Subsystem clustering (individually benign, collectively significant):");
  for (const c of assessment.clusters) {
    console.log(`  ${String(c.count).padStart(2)}x  ${c.subsystem}`);
  }

  console.log(`\nDeterministic gaps (${assessment.gaps.length}) — flags, not determinations:`);
  for (const g of assessment.gaps) {
    console.log(`  [${g.kind}] ${g.detail}`);
  }

  console.log("\nFlowchart branches to consider, by change:");
  for (const change of changes.filter((c: Change) => c.status !== "superseded")) {
    const branches = implicatedBranches(change.changeType);
    console.log(`  ${change.changedAt ?? ""}  (${change.changeType})  ${change.proposal.slice(0, 70)}`);
    for (const b of branches) {
      console.log(`       - ${b.chart}/${b.step}: ${b.consider}`);
    }
  }

  console.log(
    `\nThe tool flags gaps and lists the questions the guidance would ask. It does\n` +
      `not answer them: the submit / don't-submit determination is the\n` +
      `manufacturer's, and every change above is 'undecided' until a person sets it.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
