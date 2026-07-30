/**
 * Diff the findings of two runs over the same record.
 *
 * Possible because finding ids are deterministic (rule + normalized quote +
 * block), so "the same finding" is well defined across runs. Built to answer one
 * specific question: what is the verifier pass actually removing? A 59% drop
 * rate is either the precision filter earning its cost or it is silently
 * discarding real findings, and those look identical from the summary counts.
 *
 *   npx tsx src/cli/diffRuns.ts <runIdA> <runIdB>
 *   npx tsx src/cli/diffRuns.ts --latest 2      (the two most recent runs)
 */
import { getDb, migrate } from "@regreview/core";

interface Row {
  finding_id: string;
  severity: string;
  category: string;
  rule_id: string;
  problem: string;
  quote: string;
  confidence: string;
}

function findingsOf(runId: string): Map<string, Row> {
  const rows = getDb()
    .prepare(
      `SELECT finding_id, severity, category, rule_id, problem, quote, confidence
         FROM findings WHERE run_id = ? ORDER BY char_start`,
    )
    .all(runId) as Row[];
  return new Map(rows.map((r) => [r.finding_id, r]));
}

function main(): void {
  migrate();
  const db = getDb();
  const argv = process.argv.slice(2);

  let runA: string | undefined;
  let runB: string | undefined;

  if (argv[0] === "--latest") {
    const rows = db
      .prepare(
        `SELECT run_id FROM runs WHERE status = 'complete' ORDER BY started_at DESC LIMIT 2`,
      )
      .all() as { run_id: string }[];
    // Oldest of the two first, so "added" reads in chronological order.
    runB = rows[0]?.run_id;
    runA = rows[1]?.run_id;
  } else {
    [runA, runB] = argv;
  }

  if (!runA || !runB) {
    console.error("usage: diffRuns <runIdA> <runIdB> | --latest");
    process.exitCode = 2;
    return;
  }

  const a = findingsOf(runA);
  const b = findingsOf(runB);

  const meta = (runId: string) =>
    db.prepare(`SELECT model, effort, prompt_version FROM runs WHERE run_id = ?`).get(runId) as
      | { model: string; effort: string; prompt_version: string }
      | undefined;

  console.log(`A = ${runA}  (${a.size} findings)  ${JSON.stringify(meta(runA))}`);
  console.log(`B = ${runB}  (${b.size} findings)  ${JSON.stringify(meta(runB))}`);

  const onlyA = [...a.values()].filter((r) => !b.has(r.finding_id));
  const onlyB = [...b.values()].filter((r) => !a.has(r.finding_id));
  const shared = [...a.keys()].filter((id) => b.has(id));

  const union = new Set([...a.keys(), ...b.keys()]).size;
  console.log(
    `\nshared ${shared.length}, only in A ${onlyA.length}, only in B ${onlyB.length} ` +
      `-> agreement ${union === 0 ? 100 : Math.round((shared.length / union) * 100)}%`,
  );

  const show = (label: string, rows: Row[]) => {
    if (rows.length === 0) return;
    console.log(`\n${"=".repeat(76)}\n${label} (${rows.length})`);
    for (const r of rows) {
      console.log(
        `\n  [${r.severity}/${r.confidence}] ${r.category} · ${r.rule_id}\n` +
          `  quote  : ${JSON.stringify(r.quote.replace(/\s+/g, " ").slice(0, 110))}\n` +
          `  problem: ${r.problem.replace(/\s+/g, " ").slice(0, 200)}`,
      );
    }
  };

  show("ONLY IN A", onlyA);
  show("ONLY IN B", onlyB);
}

main();
