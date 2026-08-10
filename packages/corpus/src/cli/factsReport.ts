/**
 * Show extracted facts and how they group for the consistency join.
 *
 * The consistency check joins on (kind, normalized subject), so when it finds
 * nothing the question is always whether the values genuinely agree or the join
 * key failed to match. This prints the normalized key next to the raw subject so
 * the two cases are distinguishable.
 *
 *   npx tsx src/cli/factsReport.ts
 */
import {
  findDiscrepancies,
  getCustomerDb,
  loadFacts,
  migrateCustomer,
  normalizeSubject,
  normalizeValue,
} from "@regreview/core";

async function main(): Promise<void> {
  await migrateCustomer();
  const db = getCustomerDb();

  const records = await db
    .prepare(
      `SELECT r.record_id, COALESCE(r.doc_id, r.filename) AS label,
              (SELECT COUNT(*) FROM facts f WHERE f.record_id = r.record_id) AS n
         FROM records r ORDER BY r.created_at`,
    )
    .all<{ record_id: string; label: string; n: number }>();

  const withFacts = records.filter((r) => r.n > 0);
  if (withFacts.length === 0) {
    console.log("No facts extracted yet. Run a review with --related <file>.");
    return;
  }

  for (const r of withFacts) {
    console.log(`\n${r.label}  (${r.n} facts)`);
    for (const f of await loadFacts([r.record_id])) {
      console.log(
        `  ${f.kind.padEnd(30)} value=${normalizeValue(f.value).padEnd(12)} ` +
          `subject="${f.subject}"`,
      );
      console.log(`  ${" ".repeat(30)} join key -> "${normalizeSubject(f.subject)}"`);
    }
  }

  // Calls the real findDiscrepancies rather than reimplementing the join, so the
  // diagnostic can never disagree with what the product actually does.
  const all = await loadFacts(withFacts.map((r) => r.record_id));
  const label = new Map(withFacts.map((r) => [r.record_id, r.label]));
  const discrepancies = findDiscrepancies(all);

  console.log(`\n${"=".repeat(76)}\nDiscrepancies (${discrepancies.length})`);
  for (const d of discrepancies) {
    console.log(`\n  ${d.kind}  "${d.subject}"`);
    for (const v of d.values) {
      for (const f of v.facts) {
        console.log(
          `      ${String(v.value).padEnd(14)} <- ${label.get(f.recordId) ?? f.recordId} ` +
            `(chars ${f.charStart}-${f.charEnd})`,
        );
      }
    }
  }

  if (discrepancies.length === 0) {
    console.log(
      "\n  None. Either the documents genuinely agree, or the subjects are not\n" +
        "  matching across documents — compare the join keys printed above.",
    );
  }
}

await main();
