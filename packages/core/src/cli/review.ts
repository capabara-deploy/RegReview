import { resolve } from "node:path";
import { config } from "../config.js";
import { cacheHitRate, totalInputTokens, type ReviewEngine } from "../engine.js";
import { extractRecord } from "../extract/index.js";
import { migrate } from "../db/migrate.js";
import { runAgreement } from "../review/anchor.js";
import { ClaudeReviewEngine } from "../review/claudeEngine.js";
import { OfflineReviewEngine } from "../review/offlineEngine.js";
import {
  finishRun,
  loadRulesFor,
  saveFindings,
  saveRecord,
  startRun,
} from "../store.js";
import { RecordType, type Finding } from "../types.js";

/**
 * Run a pre-inspection review over one document and print the findings.
 *
 * This is the demo surface and the debugging surface. It deliberately prints
 * the severity rationale and the drop counts, not just the findings: when this
 * tool is wrong, the interesting question is always *why* it was wrong, and the
 * answer is usually in how many candidates were dropped and by which stage.
 */

interface Args {
  path: string;
  recordType: RecordType;
  offline: boolean;
  repeat: number;
  skipVerifier: boolean;
  quiet: boolean;
  samples: number;
  /** Other documents to check cross-document consistency against. */
  related: string[];
}

function parseArgs(argv: string[]): Args | string {
  const positional: string[] = [];
  let recordType: RecordType = "capa";
  let offline = false;
  let repeat = 1;
  let skipVerifier = false;
  let quiet = false;
  let samples = 1;
  const related: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--offline") offline = true;
    else if (arg === "--no-verifier") skipVerifier = true;
    else if (arg === "--quiet") quiet = true;
    else if (arg === "--repeat") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) return "--repeat needs a positive integer";
      repeat = value;
    } else if (arg === "--samples") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) return "--samples needs a positive integer";
      samples = value;
    } else if (arg === "--related") {
      const value = argv[++i];
      if (!value) return "--related needs a file path";
      related.push(value);
    } else if (arg === "--type") {
      const parsed = RecordType.safeParse(argv[++i]);
      if (!parsed.success) {
        return `--type must be one of: ${RecordType.options.join(", ")}`;
      }
      recordType = parsed.data;
    } else if (arg.startsWith("-")) return `unknown flag: ${arg}`;
    else positional.push(arg);
  }

  const path = positional[0];
  if (!path) {
    return (
      "usage: review <file> [--type capa] [--offline] [--repeat N] [--samples N]\n" +
      "                     [--no-verifier] [--quiet]\n\n" +
      "  --samples N  self-consistency voting: sample each check N times and keep\n" +
      "               only findings a majority of samples agree on. Costs Nx but is\n" +
      "               what makes repeat-run consistency defensible. Try 3.\n" +
      "  --repeat N   run the whole review N times and report agreement between runs.\n" +
      "  --related F  another document to check cross-document consistency against.\n" +
      "               Repeatable. Without it, the consistency pass has nothing to\n" +
      "               compare and does not run."
    );
  }

  return { path, recordType, offline, repeat, skipVerifier, quiet, samples, related };
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

function printFindings(findings: Finding[], normalizedText: string): void {
  if (findings.length === 0) {
    console.log("\nNo findings.");
    return;
  }

  // Document order, because a reviewer reads top to bottom. Severity is a
  // filter in the UI, not a sort — jumping around a record loses the thread.
  for (const [i, f] of findings.entries()) {
    const line = normalizedText.slice(0, f.charStart).split("\n").length;
    console.log(
      `\n${"=".repeat(78)}\n` +
        `[${i + 1}] ${f.severity.toUpperCase().padEnd(6)} ${f.category.padEnd(13)} line ~${line}`,
    );
    console.log(`  requirement : ${f.citation}`);
    console.log(`  rule        : ${f.ruleId}`);
    console.log(`  quote       : ${JSON.stringify(truncate(f.quote, 160))}`);
    console.log(`  problem     : ${wrap(f.problem, 16)}`);
    console.log(`  matters     : ${wrap(f.rationale, 16)}`);
    console.log(`  direction   : ${wrap(f.suggestion, 16)}`);
    console.log(`  confidence  : ${f.confidence}`);
    console.log(`  rated ${f.severity.padEnd(6)}: ${wrap(f.severityBasis.reason, 16)}`);
  }

  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  console.log(
    `\n${"=".repeat(78)}\n` +
      `${findings.length} finding(s): ${counts.high} high, ${counts.medium} medium, ` +
      `${counts.low} low`,
  );

  const byCategory = new Map<string, number>();
  for (const f of findings) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
  console.log(
    "by category: " +
      [...byCategory.entries()].map(([c, n]) => `${c}=${n}`).join(", "),
  );
}

/**
 * Rough cost estimate for one run.
 *
 * Opus 4.8 list prices: $5/MTok input, $25/MTok output. Cache reads bill at
 * about 0.1x input and cache writes at about 1.25x. Approximate by design —
 * it exists so cost trends are visible while iterating, not for billing.
 */
function estimateCost(stats: {
  uncachedInputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
}): number {
  return (
    ((stats.uncachedInputTokens ?? 0) * 5 +
      (stats.cacheReadTokens ?? 0) * 0.5 +
      (stats.cacheCreationTokens ?? 0) * 6.25 +
      (stats.outputTokens ?? 0) * 25) /
    1_000_000
  );
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

function wrap(s: string, indent: number, width = 78): string {
  const words = s.replace(/\s+/g, " ").trim().split(" ");
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") current = word;
    else if (`${current} ${word}`.length + indent <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.join(`\n${pad}`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    console.error(parsed);
    process.exitCode = 2;
    return;
  }

  migrate();

  const path = resolve(parsed.path);
  const extraction = await extractRecord({ path, recordType: parsed.recordType });
  const { record, blocks } = extraction;

  // A document we could not read must never be reviewed silently. "No findings"
  // on a scan reads as a clean result, which is the most damaging thing this
  // tool could say.
  if (extraction.warning) {
    console.warn(`\nWARNING: ${extraction.warning}\n`);
  }

  const rules = loadRulesFor(record.recordType);
  if (rules.length === 0) {
    console.error(
      "No rules apply to this record type. Run `npm run ingest:rules` " +
        "(and `npm run ingest:observations` before it).",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Document : ${record.filename}`);
  console.log(
    `Format   : ${extraction.format}` +
      (extraction.pageCount ? ` (${extraction.pageCount} page(s))` : ""),
  );
  console.log(`Type     : ${record.recordType}`);
  console.log(`Doc ID   : ${record.docId ?? "(not found in text)"}`);
  console.log(`Revision : ${record.revision ?? "(not found in text)"}`);
  console.log(`Blocks   : ${blocks.length}`);
  console.log(`Rules    : ${rules.length} applicable`);

  // Load documents in scope for cross-document consistency. Each is stored and
  // blocked exactly like the record under review, because a consistency finding
  // has to be able to point at real, located text in the *other* document too.
  const relatedDocs: { record: typeof record; blocks: typeof blocks }[] = [];
  for (const relPath of parsed.related) {
    // Type is not asserted for related documents: they are read for their
    // recorded values, not reviewed against rules, so a wrong guess here cannot
    // produce a wrong finding.
    const built = await extractRecord({ path: resolve(relPath) });
    if (built.warning) console.warn(`\nWARNING: ${built.warning}\n`);
    saveRecord(built.record, built.blocks);
    relatedDocs.push({ record: built.record, blocks: built.blocks });
  }

  if (relatedDocs.length > 0) {
    console.log(
      `Related  : ${relatedDocs
        .map((d) => d.record.docId ?? d.record.filename)
        .join(", ")}`,
    );
  } else {
    console.log(
      `Related  : none — cross-document consistency will not run (pass --related <file>)`,
    );
  }

  const saved = saveRecord(record, blocks);
  if (saved.discardedFindings > 0) {
    // Never let this be silent: it means prior runs are no longer comparable.
    console.warn(
      `\nNOTE: the document text changed since it was last reviewed, so ` +
        `${saved.discardedFindings} finding(s) from earlier runs were discarded.\n` +
        `  Those findings were anchored to character offsets in the previous text.\n`,
    );
  }

  let engine: ReviewEngine;
  if (parsed.offline) {
    engine = new OfflineReviewEngine();
    console.log(
      `Engine   : ${engine.id} (OFFLINE - crude keyword heuristics, not product output)`,
    );
  } else {
    if (!process.env["ANTHROPIC_API_KEY"] && !process.env["ANTHROPIC_AUTH_TOKEN"]) {
      console.error(
        "\nNo credential found.\n" +
          "  Put ANTHROPIC_API_KEY in .env at the repo root, or export it, or run\n" +
          "  `ant auth login`. To exercise the pipeline without a key, pass --offline.",
      );
      process.exitCode = 1;
      return;
    }
    // A base URL override sends requests somewhere other than the API. It is a
    // legitimate setting for a gateway, but it is far more often left over from
    // another tool, and the resulting failure is confusing. Only warn when it
    // actually points somewhere else — warning about a value equal to the real
    // API host trains people to ignore the warning.
    const baseUrl = process.env["ANTHROPIC_BASE_URL"];
    if (baseUrl && !/^https:\/\/api\.anthropic\.com\/?$/.test(baseUrl.trim())) {
      console.warn(
        `\nWARNING: ANTHROPIC_BASE_URL is set (${baseUrl}).\n` +
          "  Requests go there, not to api.anthropic.com. Unset it if unintended.\n",
      );
    }
    engine = new ClaudeReviewEngine({
      ...(parsed.skipVerifier ? { skipVerifier: true } : {}),
      ...(parsed.samples > 1 ? { samples: parsed.samples } : {}),
      ...(parsed.quiet ? {} : { onProgress: (m) => console.log(`  ${m}`) }),
    });
    console.log(`Engine   : ${engine.id} (effort=${config.effort})`);
    if (parsed.samples > 1) {
      console.log(
        `Sampling : ${parsed.samples} samples per check, majority vote ` +
          `(~${parsed.samples}x cost)`,
      );
    }
  }

  const allRuns: Finding[][] = [];
  let totalCost = 0;

  for (let attempt = 1; attempt <= parsed.repeat; attempt++) {
    if (parsed.repeat > 1) console.log(`\n--- run ${attempt} of ${parsed.repeat} ---`);
    const run = startRun({
      recordId: record.recordId,
      model: parsed.offline ? engine.id : config.model,
      effort: parsed.offline ? "n/a" : config.effort,
    });

    try {
      const result = await engine.review({
        runId: run.runId,
        record,
        blocks,
        rules,
        ...(relatedDocs.length > 0 ? { related: relatedDocs } : {}),
      });
      saveFindings(result.findings);
      finishRun(run.runId, "complete");
      allRuns.push(result.findings);

      const showDetail = attempt === 1 || parsed.repeat === 1;
      if (showDetail) {
        printFindings(result.findings, record.normalizedText);
        console.log(
          `\npipeline: ${result.stats.proposed} proposed -> ` +
            `${result.stats.droppedByVerifier} verifier, ` +
            `${result.stats.droppedDuplicate} duplicate, ` +
            `${result.stats.droppedUnanchored} unanchored, ` +
            `${result.stats.droppedUnknownRule} unknown rule -> ` +
            `${result.findings.length} shown`,
        );

        if (result.stats.failedCategories?.length) {
          console.warn(
            `\nWARNING: these check passes FAILED and contributed no findings: ` +
              `${result.stats.failedCategories.join(", ")}.\n` +
              `  Treat this review as incomplete for those categories.`,
          );
        }

      } else {
        console.log(`  ${result.findings.length} finding(s)`);
      }

      // Cost and cache accounting for EVERY run, not just the first. The first
      // run of a fresh prefix can only ever write the cache, so reporting its
      // 0% read rate as a problem is a false alarm — the number that matters is
      // whether later runs read what it wrote.
      const totalIn = totalInputTokens(result.stats);
      if (totalIn > 0) {
        const hit = cacheHitRate(result.stats);
        const cost = estimateCost(result.stats);
        totalCost += cost;
        console.log(
          `  tokens: ${totalIn} in (${result.stats.uncachedInputTokens} uncached, ` +
            `${result.stats.cacheReadTokens} cache read, ` +
            `${result.stats.cacheCreationTokens} cache write), ` +
            `${result.stats.outputTokens} out  |  cache ${(hit * 100).toFixed(0)}%  |  ` +
            `~$${cost.toFixed(3)}`,
        );
        // Only a warning from the second run onward, where a read is expected.
        if (attempt > 1 && hit < 0.2) {
          console.warn(
            `  WARNING: only ${(hit * 100).toFixed(0)}% of input was served from cache on ` +
              `run ${attempt}.\n` +
              `    The stable prefix should be reusable across runs of the same record type.\n` +
              `    Check for volatile content above the cache breakpoint, and note that\n` +
              `    concurrent passes cannot read a cache their siblings are still writing.`,
          );
        }
      }
      console.log(`  run id: ${run.runId}`);
    } catch (err) {
      finishRun(run.runId, "failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // Repeat-run agreement. Fresenius named this a critical technical
  // requirement, so it is measured on demand rather than assumed.
  if (allRuns.length > 1) {
    console.log(`\n${"=".repeat(78)}\nRepeat-run agreement`);
    let worstEquivalent = 1;

    let incomparable = 0;
    for (let i = 1; i < allRuns.length; i++) {
      const cmp = runAgreement(allRuns[0]!, allRuns[i]!);

      // An empty run is not agreement, it is absence of evidence. Saying so
      // explicitly, because the arithmetic alternative — Jaccard of two empty
      // sets being 1 — reported a totally failed review as 100% consistent.
      if (!cmp.comparable) {
        incomparable++;
        console.log(
          `\n  run 1 (${cmp.countA}) vs run ${i + 1} (${cmp.countB}):\n` +
            `    NOT COMPARABLE - one or both runs produced no findings.\n` +
            `    This is not agreement. Check for failed check passes above.`,
        );
        continue;
      }

      // Gated on the rule level: whether the same problems were found is the
      // question the consistency requirement is actually about. The stricter
      // levels are reported alongside because a gap between them localises the
      // instability — same problems, different sentences.
      worstEquivalent = Math.min(worstEquivalent, cmp.ruleLevel);
      console.log(
        `\n  run 1 (${cmp.countA}) vs run ${i + 1} (${cmp.countB}):\n` +
          `    same requirements  : ${(cmp.ruleLevel * 100).toFixed(0)}%  ` +
          `(${cmp.ruleLevelShared} shared, ${cmp.rulesOnlyA.length} only in run 1, ` +
          `${cmp.rulesOnlyB.length} only in run ${i + 1})\n` +
          `    same localisation  : ${(cmp.equivalent * 100).toFixed(0)}%  ` +
          `(${cmp.equivalentShared} shared)\n` +
          `    identical quotes   : ${(cmp.strict * 100).toFixed(0)}%  ` +
          `(${cmp.strictShared} shared)`,
      );
      for (const r of cmp.rulesOnlyA) console.log(`      only run 1: ${r}`);
      for (const r of cmp.rulesOnlyB) console.log(`      only run ${i + 1}: ${r}`);

      // Naming what actually differed is the only way to act on a low score.
    }

    if (incomparable === allRuns.length - 1) {
      console.log(
        `\n  NO RESULT: every comparison was incomparable. Agreement is unknown, ` +
          `not passing.`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        `\n  ${worstEquivalent >= 0.9 ? "PASS" : "BELOW TARGET"}: worst-case ` +
          `same-requirements agreement ${(worstEquivalent * 100).toFixed(0)}% (target >= 90%)` +
          (incomparable > 0 ? `  (${incomparable} comparison(s) skipped as incomparable)` : ""),
      );
    }
    console.log(
      "  Read the three levels together. A low same-requirements figure means the\n" +
        "  engine genuinely disagrees with itself about what is wrong. A high one with\n" +
        "  lower localisation means it agrees on the problems but points at different\n" +
        "  sentences — a different, milder defect.",
    );
  }

  if (totalCost > 0) {
    console.log(`\ntotal estimated cost: ~$${totalCost.toFixed(2)}`);
  }
}

await main();
