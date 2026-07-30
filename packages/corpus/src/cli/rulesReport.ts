/**
 * What rules does each check pass actually see for a given record type?
 *
 * Exists because a whole check pass can silently receive zero rules and skip
 * itself — which is what happened to conformance before any procedure was
 * uploaded. A review missing a category reads as "nothing to report there".
 *
 *   npx tsx src/cli/rulesReport.ts [recordType]
 */
import { loadRulesFor, migrate, RecordType, rulesForCategory } from "@regreview/core";
import type { CheckCategory } from "@regreview/core";

const CATEGORIES: CheckCategory[] = [
  "compliance",
  "conformance",
  "completeness",
  "plausibility",
  "consistency",
];

function main(): void {
  migrate();
  const arg = process.argv[2] ?? "capa";
  const parsed = RecordType.safeParse(arg);
  if (!parsed.success) {
    console.error(`unknown record type "${arg}". Valid: ${RecordType.options.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const recordType = parsed.data;

  const rules = loadRulesFor(recordType);
  console.log(`Record type: ${recordType}`);
  console.log(`Applicable rules: ${rules.length}\n`);

  const bySource = new Map<string, number>();
  for (const r of rules) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
  console.log("by source:");
  for (const [source, n] of [...bySource].sort()) {
    console.log(`  ${source.padEnd(12)} ${n}`);
  }

  console.log("\nrules visible to each check pass:");
  let anyEmpty = false;
  for (const category of CATEGORIES) {
    const visible = rulesForCategory(rules, category);
    const flag = visible.length === 0 ? "  <-- pass will SKIP itself" : "";
    if (visible.length === 0 && category !== "consistency") anyEmpty = true;
    console.log(`  ${category.padEnd(14)} ${String(visible.length).padStart(3)}${flag}`);
  }

  if (anyEmpty) {
    console.log(
      "\nA pass with no rules contributes no findings, which is indistinguishable\n" +
        "from finding nothing. For conformance, load a procedure:\n" +
        "  npm run sop -- <file> --applies-to " +
        recordType,
    );
    process.exitCode = 1;
  }
}

main();
