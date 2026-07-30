/**
 * What severity tiers would the current corpus actually produce?
 *
 * Diagnostic, not product. The failure mode this guards against is alarm
 * fatigue: if nearly every finding comes out "high", the tiering carries no
 * information and a quality reviewer stops trusting it — which costs us the one
 * asset we cannot rebuild. Run this after changing severity.ts or the corpus.
 */
import { deriveSeverity, getDb, migrate, type Severity } from "@regreview/core";

interface RuleRow {
  rule_id: string;
  citation_frequency: number;
  harm_linked: number;
  frequency_percentile: number | null;
}

function main(): void {
  migrate();
  const db = getDb();
  const rules = db
    .prepare(
      `SELECT rule_id, citation_frequency, harm_linked, frequency_percentile
         FROM rules ORDER BY citation_frequency DESC`,
    )
    .all() as RuleRow[];

  if (rules.length === 0) {
    console.log("No rules. Run `npm run ingest:rules` first.");
    return;
  }

  console.log(`Severity distribution across ${rules.length} rules x 3 confidence levels\n`);

  const tally = new Map<Severity, number>([
    ["high", 0],
    ["medium", 0],
    ["low", 0],
  ]);

  const confidences = ["high", "medium", "low"] as const;
  const width = Math.max(...rules.map((r) => r.rule_id.length));

  console.log(
    `  ${"rule".padEnd(width)}  freq   pct   harm  ` +
      `${confidences.map((c) => `conf=${c}`.padEnd(12)).join("")}`,
  );

  for (const rule of rules) {
    const cells: string[] = [];
    for (const confidence of confidences) {
      // Worst case for tiering: the finding itself is harm-relevant whenever
      // the rule is, which is the common case for a real hit.
      const { severity } = deriveSeverity(
        {
          confidence,
          harmRelevant: rule.harm_linked === 1,
          category: "compliance",
        },
        {
          citationFrequency: rule.citation_frequency,
          harmLinked: rule.harm_linked === 1,
          frequencyPercentile: rule.frequency_percentile ?? 0,
        },
      );
      tally.set(severity, (tally.get(severity) ?? 0) + 1);
      cells.push(severity.padEnd(12));
    }
    console.log(
      `  ${rule.rule_id.padEnd(width)}  ${String(rule.citation_frequency).padStart(5)}  ` +
        `${(rule.frequency_percentile ?? 0).toFixed(2)}  ` +
        `${rule.harm_linked ? "yes " : "no  "}  ${cells.join("")}`,
    );
  }

  const total = [...tally.values()].reduce((a, b) => a + b, 0);
  console.log("\n  tier      count   share");
  for (const [tier, count] of tally) {
    const share = total > 0 ? (count / total) * 100 : 0;
    console.log(
      `  ${tier.padEnd(9)} ${String(count).padStart(5)}   ${share.toFixed(0).padStart(3)}%  ` +
        "#".repeat(Math.round(share / 3)),
    );
  }

  const highShare = ((tally.get("high") ?? 0) / total) * 100;
  console.log(
    `\n  ${highShare <= 40 ? "OK" : "WARNING"}: ${highShare.toFixed(0)}% of ` +
      `rule/confidence combinations rate high.` +
      (highShare > 40
        ? "\n        Too many. A reviewer facing mostly-high findings will stop reading them."
        : ""),
  );
}

main();
