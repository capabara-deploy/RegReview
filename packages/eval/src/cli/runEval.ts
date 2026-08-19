import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClaudeReviewEngine,
  OfflineReviewEngine,
  getCorpusDb,
  loadRulesFor,
  runAgreement,
  type Finding,
  type RecordDoc,
  type ReviewEngine,
} from "@regreview/core";
import { readdirSync } from "node:fs";
import { fixtureDocumentsIn, loadFixture, type LoadedFixture } from "../loadFixtures.js";
import { aggregate, scoreFixture, type FixtureScore } from "../score.js";

/**
 * The evaluation harness.
 *
 * Runs the review engine over labeled fixtures and reports precision and recall
 * — the number the whole product is judged on with this audience, and which was
 * unmeasured until this existed. Defaults to the offline keyword baseline so it
 * runs free and in CI; pass `--real` for the actual model number (it spends).
 *
 *   npm run eval                     # offline baseline, all labeled fixtures
 *   npm run eval -- --real           # the real engine (costs money)
 *   npm run eval -- --real --repeat 2   # + repeat-run agreement
 *   npm run eval -- --fixture capa-001-infusion-pump-alarm --real
 *
 * Exit code is non-zero if precision falls below the gate (default 0.8), so this
 * can gate a merge. Recall is reported but not gated: with this audience a false
 * alarm costs credibility that a missed finding does not, so precision is the
 * hard floor and recall is the number to watch.
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

interface Args {
  real: boolean;
  samples: number;
  repeat: number;
  fixture?: string;
  minPrecision: number;
  minAgreement: number;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const has = (f: string) => argv.includes(f);
  const val = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    real: has("--real"),
    samples: Number(val("--samples") ?? 1),
    repeat: Number(val("--repeat") ?? 1),
    fixture: val("--fixture"),
    minPrecision: Number(val("--min-precision") ?? 0.8),
    minAgreement: Number(val("--min-agreement") ?? 0.9),
    json: has("--json"),
  };
}

/** One engine pass over a fixture, without persisting a run or its findings. */
async function reviewOnce(
  engine: ReviewEngine,
  fixture: LoadedFixture,
  rulesByType: Map<string, Awaited<ReturnType<typeof loadRulesFor>>>,
): Promise<Finding[]> {
  const rules = rulesByType.get(fixture.record.recordType)!;
  const result = await engine.review({
    runId: `eval-${fixture.meta.id}-${randomUUID().slice(0, 8)}`,
    record: fixture.record,
    blocks: fixture.blocks,
    rules,
    ...(fixture.relatedDocs.length > 0 ? { related: fixture.relatedDocs } : {}),
  });
  return result.findings;
}

function pct(n: number | null): string {
  return n === null ? "  n/a" : `${(n * 100).toFixed(0).padStart(3)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Map EVERY document in the fixtures dir by id, so a fixture can name its
  // cross-document companions by id even when the companion has no labels of
  // its own (a related doc is read for consistency, not scored). Prefer the
  // source .md/.txt on a base-name collision, so both related-doc resolution and
  // --fixture selection land on the format the anchors were authored against —
  // never a .docx/.pdf sibling whose extraction strips the quoted markup.
  const preference = [".md", ".txt", ".docx", ".pdf"];
  const idToPath = new Map<string, string>();
  for (const f of readdirSync(FIXTURES_DIR)) {
    if (!/\.(md|txt|pdf|docx)$/i.test(f)) continue;
    const id = f.replace(/\.(md|txt|pdf|docx)$/i, "");
    const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
    const cur = idToPath.get(id);
    if (!cur || preference.indexOf(ext) < preference.indexOf(cur.slice(cur.lastIndexOf(".")).toLowerCase())) {
      idToPath.set(id, join(FIXTURES_DIR, f));
    }
  }

  // Fixtures to actually score are those with a labels sidecar.
  let docs = fixtureDocumentsIn(FIXTURES_DIR);
  if (args.fixture) {
    const one = docs.find((d) => basename(d).replace(/\.(md|txt|pdf|docx)$/i, "") === args.fixture);
    if (!one) {
      const labeled = docs.map((d) => basename(d).replace(/\.(md|txt|pdf|docx)$/i, ""));
      console.error(`no labeled fixture "${args.fixture}". Labeled fixtures:\n  ${labeled.join("\n  ")}`);
      process.exit(2);
    }
    docs = [one];
  }

  if (docs.length === 0) {
    console.error(
      `no labeled fixtures found in ${FIXTURES_DIR}.\n` +
        `A fixture is a document with a <id>.labels.json sidecar.`,
    );
    process.exit(2);
  }

  // Known corpus rule ids, so a label naming a renamed rule fails loudly.
  const corpusRows = (await getCorpusDb()
    .prepare(`SELECT rule_id FROM rules`)
    .all()) as { rule_id: string }[];
  const knownRuleIds = new Set(corpusRows.map((r) => r.rule_id));

  const engine: ReviewEngine = args.real
    ? new ClaudeReviewEngine(args.samples > 1 ? { samples: args.samples } : {})
    : new OfflineReviewEngine();

  console.error(
    `Evaluating ${docs.length} fixture(s) with ${engine.id}` +
      `${args.repeat > 1 ? `, ${args.repeat} repeats` : ""}...\n`,
  );

  // Cache rules per record type, so N fixtures of one type load rules once.
  const rulesByType = new Map<string, Awaited<ReturnType<typeof loadRulesFor>>>();

  const scores: FixtureScore[] = [];
  const agreements: number[] = [];

  for (const doc of docs) {
    let fixture: LoadedFixture;
    try {
      fixture = await loadFixture(doc, {
        knownRuleIds,
        resolveRelated: (id) => idToPath.get(id),
      });
    } catch (err) {
      console.error(`✗ ${basename(doc)}: ${(err as Error).message}\n`);
      process.exitCode = 2;
      continue;
    }

    if (!rulesByType.has(fixture.record.recordType)) {
      rulesByType.set(fixture.record.recordType, await loadRulesFor(fixture.record.recordType));
    }

    // First pass scores; extra passes (real only) measure agreement.
    const runs: Finding[][] = [];
    for (let i = 0; i < Math.max(1, args.repeat); i++) {
      runs.push(await reviewOnce(engine, fixture, rulesByType));
    }
    const predictions = runs[0]!;
    const score = scoreFixture(fixture, predictions);
    scores.push(score);

    if (args.repeat > 1) {
      // Pairwise agreement at rule level (the "same problems?" question).
      for (let i = 1; i < runs.length; i++) {
        const a = runAgreement(runs[0]!, runs[i]!);
        if (a.comparable) agreements.push(a.ruleLevel);
      }
    }

    if (!args.json) {
      console.error(
        `${score.recallDefect >= 0.999 ? "✓" : " "} ${fixture.meta.id}` +
          `  recall ${pct(score.recallDefect)} (rule ${pct(score.recallRule)})` +
          `  precision ${pct(score.precisionDefect)} (rule ${pct(score.precisionRule)})` +
          `  ${score.predictionCount} findings / ${score.labelCount} labeled` +
          `${score.distractorHits > 0 ? `  ⚠ ${score.distractorHits} distractor hit(s)` : ""}`,
      );
      for (const m of score.missed) {
        console.error(`      missed: [${m.ruleId}] ${m.why}`);
      }
      for (const fp of score.falsePositives) {
        console.error(`      false +: [${fp.ruleId}] ${fp.problem.slice(0, 80)}`);
      }
    }
  }

  const agg = aggregate(scores);
  const avgAgreement =
    agreements.length > 0 ? agreements.reduce((s, x) => s + x, 0) / agreements.length : null;

  if (args.json) {
    console.log(JSON.stringify({ engine: engine.id, aggregate: agg, agreement: avgAgreement, perFixture: scores }, null, 2));
  } else {
    console.error(`\n${"=".repeat(64)}`);
    console.error(`Engine        : ${engine.id}`);
    console.error(`Fixtures      : ${agg.fixtures}   (${agg.totalLabels} labels, ${agg.totalPredictions} findings)`);
    console.error(`Recall        : ${pct(agg.recallDefect)} defect   ${pct(agg.recallRule)} rule-attributed`);
    console.error(`  easy / hard : ${pct(agg.recallEasy)} / ${pct(agg.recallHard)}`);
    console.error(`Precision     : ${pct(agg.precisionDefect)} defect   ${pct(agg.precisionRule)} rule-attributed   (exhaustive fixtures only)`);
    if (agg.distractorHits > 0) console.error(`Distractor FPs: ${agg.distractorHits}  (predictions on planted-correct text — the worst kind)`);
    if (avgAgreement !== null) console.error(`Agreement     : ${pct(avgAgreement)} rule-level over ${agreements.length} pair(s)`);
    console.error("=".repeat(64));
  }

  // Gate on precision (the hard floor). Recall is reported, not gated.
  const failures: string[] = [];
  if (agg.precisionDefect !== null && agg.precisionDefect < args.minPrecision) {
    failures.push(`precision ${pct(agg.precisionDefect)} < gate ${(args.minPrecision * 100).toFixed(0)}%`);
  }
  if (avgAgreement !== null && avgAgreement < args.minAgreement) {
    failures.push(`agreement ${pct(avgAgreement)} < gate ${(args.minAgreement * 100).toFixed(0)}%`);
  }
  if (agg.distractorHits > 0) {
    failures.push(`${agg.distractorHits} distractor false positive(s)`);
  }

  if (failures.length > 0) {
    console.error(`\nFAIL: ${failures.join("; ")}`);
    process.exit(1);
  }
  if (!args.json) console.error(`\nPASS`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
