/**
 * Re-measure repeat-run agreement over already-stored runs.
 *
 * Costs nothing — the findings are in the database. Useful because agreement is
 * a property of stored output, so a better metric can be applied retroactively
 * to runs that have already been paid for.
 *
 *   npx tsx src/cli/agreement.ts <runIdA> <runIdB>
 */
import { getCustomerDb, loadFindings, migrateCustomer, runAgreement } from "@regreview/core";

async function main(): Promise<void> {
  await migrateCustomer();
  const [runA, runB] = process.argv.slice(2);
  if (!runA || !runB) {
    console.error("usage: agreement <runIdA> <runIdB>");
    process.exitCode = 2;
    return;
  }

  const db = getCustomerDb();
  const meta = (id: string) =>
    db
      .prepare(`SELECT model, effort, prompt_version FROM runs WHERE run_id = ?`)
      .get<{ model: string; effort: string; prompt_version: string }>(id);

  const a = await loadFindings(runA);
  const b = await loadFindings(runB);
  const cmp = runAgreement(a, b);

  console.log(`A ${runA}  ${cmp.countA} findings  ${JSON.stringify(await meta(runA))}`);
  console.log(`B ${runB}  ${cmp.countB} findings  ${JSON.stringify(await meta(runB))}\n`);
  // Three levels, loosest first. The loosest is the one a reviewer means by
  // "did it find the same problems"; the stricter two say how consistently
  // those problems were localized and phrased.
  console.log(
    `  rule level (same requirements flagged):                ` +
      `${(cmp.ruleLevel * 100).toFixed(0)}%  (${cmp.ruleLevelShared} shared)`,
  );
  console.log(
    `  equivalent (same rule, same block, overlapping quote): ` +
      `${(cmp.equivalent * 100).toFixed(0)}%  (${cmp.equivalentShared} shared)`,
  );
  console.log(
    `  identical  (byte-identical quote):                     ` +
      `${(cmp.strict * 100).toFixed(0)}%  (${cmp.strictShared} shared)`,
  );

  if (cmp.rulesOnlyA.length > 0 || cmp.rulesOnlyB.length > 0) {
    console.log(`\n  requirements flagged by only one run:`);
    for (const r of cmp.rulesOnlyA) console.log(`    only A: ${r}`);
    for (const r of cmp.rulesOnlyB) console.log(`    only B: ${r}`);
  } else {
    console.log(`\n  both runs flagged exactly the same set of requirements.`);
  }

  const list = (label: string, rows: typeof cmp.onlyA) => {
    if (rows.length === 0) return;
    console.log(`\n${label} (${rows.length}):`);
    for (const f of rows) {
      console.log(
        `  [${f.severity}/${f.confidence}] ${f.category.padEnd(13)} ${f.ruleId}\n` +
          `      ${f.problem.replace(/\s+/g, " ").slice(0, 150)}`,
      );
    }
  };

  list("Only in A", cmp.onlyA);
  list("Only in B", cmp.onlyB);
}

await main();
