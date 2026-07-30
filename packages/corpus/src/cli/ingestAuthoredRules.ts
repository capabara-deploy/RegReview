import { CORPUS_VERSION, assignFrequencyPercentiles, getDb, migrate } from "@regreview/core";
import { AUTHORED_RULES, sourceFor, type AuthoredRule } from "../authoredRules.js";
import { isRelated, parseCitation } from "../citation.js";

/**
 * Load our hand-authored requirements into the rule corpus, attaching the real
 * FDA citation frequency for each via its CFR crosswalk.
 *
 * Depends on `ingest:observations` having run: without the observation data
 * every rule gets frequency 0, and the severity model then rates almost
 * everything low. The CLI says so loudly rather than quietly producing a
 * useless corpus.
 */

interface ObservationRow {
  citation: string;
  frequency: number;
}

/**
 * Sum observed FDA citation counts for a rule's crosswalk.
 *
 * Frequencies are summed across all ingested fiscal years, then matched
 * structurally (see citation.ts) so a rule keyed to 820.100(a)(4) inherits the
 * count FDA recorded against 820.100(a).
 *
 * A single observation row can contribute to several different rules — that is
 * intended. This is a per-rule weight, not a partition of a total.
 */
function frequencyFor(rule: AuthoredRule, observations: ObservationRow[]): number {
  const targets = rule.crosswalk
    .map(parseCitation)
    .filter((c): c is NonNullable<typeof c> => c !== undefined);
  if (targets.length === 0) return 0;

  let total = 0;
  // Track which observation citations already counted for THIS rule, so two
  // crosswalk entries in the same paragraph family don't double-count it.
  const counted = new Set<string>();

  for (const obs of observations) {
    const parsed = parseCitation(obs.citation);
    if (!parsed) continue;
    if (counted.has(parsed.canonical)) continue;
    if (targets.some((t) => isRelated(t, parsed))) {
      total += obs.frequency;
      counted.add(parsed.canonical);
    }
  }
  return total;
}

function main(): void {
  migrate();
  const db = getDb();

  // Collapse to one row per distinct citation, summed over fiscal years.
  const observations = db
    .prepare(
      `SELECT citation, SUM(frequency) AS frequency
         FROM fda_observations
        GROUP BY citation`,
    )
    .all() as ObservationRow[];

  if (observations.length === 0) {
    console.error(
      "No FDA observation data found. Run `npm run ingest:observations` first —\n" +
        "otherwise every rule gets citation_frequency 0 and the severity model\n" +
        "will rate nearly everything low.",
    );
    process.exitCode = 1;
    return;
  }

  const insert = db.prepare(
    `INSERT INTO rules
       (rule_id, source, citation, title, expectation, applies_to,
        harm_linked, citation_frequency, frequency_percentile,
        corpus_version, sop_document_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(rule_id) DO UPDATE SET
       source               = excluded.source,
       citation             = excluded.citation,
       title                = excluded.title,
       expectation          = excluded.expectation,
       applies_to           = excluded.applies_to,
       harm_linked          = excluded.harm_linked,
       citation_frequency   = excluded.citation_frequency,
       frequency_percentile = excluded.frequency_percentile,
       corpus_version       = excluded.corpus_version`,
  );

  // Resolve frequencies first, then rank them, so the percentile each rule gets
  // reflects the whole corpus rather than insertion order.
  const withFrequency = AUTHORED_RULES.map((rule) => ({
    rule,
    citationFrequency: frequencyFor(rule, observations),
  }));
  const percentiles = assignFrequencyPercentiles(withFrequency);

  const loaded: { rule: AuthoredRule; frequency: number; percentile: number }[] = [];

  db.transaction(() => {
    for (const entry of withFrequency) {
      const { rule, citationFrequency } = entry;
      const percentile = percentiles.get(entry) ?? 0;
      insert.run(
        rule.ruleId,
        sourceFor(rule),
        rule.citation,
        rule.title,
        rule.expectation,
        JSON.stringify(rule.appliesTo),
        rule.harmLinked ? 1 : 0,
        citationFrequency,
        percentile,
        CORPUS_VERSION,
      );
      loaded.push({ rule, frequency: citationFrequency, percentile });
    }
  })();

  console.log(`Loaded ${loaded.length} authored rules (corpus ${CORPUS_VERSION}).\n`);

  const width = Math.max(...loaded.map((l) => l.rule.ruleId.length));
  for (const { rule, frequency, percentile } of [...loaded].sort(
    (a, b) => b.frequency - a.frequency,
  )) {
    const source = sourceFor(rule) === "iso_clause" ? "iso  " : "logic";
    const harm = rule.harmLinked ? "harm" : "    ";
    console.log(
      `  ${rule.ruleId.padEnd(width)}  ${source} ${harm}  ` +
        `freq=${String(frequency).padStart(5)}  pct=${percentile.toFixed(2)}  ` +
        `${rule.crosswalk.join(", ") || "(no crosswalk)"}`,
    );
  }

  // A rule with no inherited frequency can never be rated high on the
  // frequency branch of the severity model. That's legitimate for the pure
  // soundness checks, but worth surfacing so it's a decision rather than a
  // silent gap.
  const zero = loaded.filter((l) => l.frequency === 0 && l.rule.crosswalk.length > 0);
  if (zero.length > 0) {
    console.log(
      `\nNote: ${zero.length} rule(s) have a crosswalk but inherited zero frequency —\n` +
        `their CFR paragraphs do not appear in the ingested observation data:`,
    );
    for (const z of zero) {
      console.log(`  ${z.rule.ruleId}  (${z.rule.crosswalk.join(", ")})`);
    }
  }
}

main();
