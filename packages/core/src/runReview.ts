import { config } from "./config.js";
import type { ReviewEngine, ReviewStats } from "./engine.js";
import { ClaudeReviewEngine } from "./review/claudeEngine.js";
import { OfflineReviewEngine } from "./review/offlineEngine.js";
import { finishRun, loadRulesFor, saveFindings, startRun } from "./store.js";
import type { Block, CheckCategory, Finding, RecordDoc, Rule, Run } from "./types.js";

/**
 * One review, orchestrated.
 *
 * Factored out of the CLI so the server can run a review without duplicating the
 * lifecycle — and so there is exactly one place that opens a run, invokes the
 * engine, persists findings, and closes the run. Duplicating that was how the
 * "findings from earlier runs silently vanished" class of bug got in the first
 * time; keeping it singular keeps the run/finding invariants in one auditable
 * spot.
 *
 * The caller is responsible for having already stored the record and its related
 * documents (via saveRecord), because storage and blocking are shared with
 * ingest and belong upstream of the review itself.
 */

export interface RunReviewArgs {
  record: RecordDoc;
  blocks: Block[];
  related?: { record: RecordDoc; blocks: Block[] }[];
  /** Self-consistency samples per check. 1 disables voting. */
  samples?: number;
  /** Use the offline keyword baseline instead of the model. No spend, crude output. */
  offline?: boolean;
  /**
   * Restrict the review to these rules. Omit to check every rule that applies to
   * the record type.
   *
   * The motivating case is a standard revision: a customer transitioning to a new
   * edition of ISO 14971 needs to know which of several hundred documents violate
   * the requirements that changed, and does not need — or want to pay for — a full
   * re-review of each one. Scoping also keeps the answer clean, because the only
   * findings produced are the ones the selected rules generate.
   */
  ruleIds?: string[];
  onProgress?: (message: string) => void;
}

export interface RunReviewResult {
  run: Run;
  findings: Finding[];
  stats: ReviewStats;
}

/**
 * Which check passes a scoped rule set should run.
 *
 * Without this, selecting two ISO clause rules would still fire compliance,
 * completeness and plausibility, because the latter two accept `iso_clause`
 * rules as well as `logic` ones. That triples the cost of a scoped scan and
 * produces near-duplicate findings from passes whose briefs ("did the record
 * close every loop it opened") have nothing to do with the question being asked.
 *
 * So a scoped review runs only the passes the selected rules actually belong to.
 * An unscoped review is unaffected and still runs all four.
 */
export function categoriesForRules(rules: Rule[]): CheckCategory[] {
  const categories: CheckCategory[] = [];
  if (rules.some((r) => r.source === "cfr" || r.source === "iso_clause" || r.source === "guidance"))
    categories.push("compliance");
  if (rules.some((r) => r.source === "sop")) categories.push("conformance");
  if (rules.some((r) => r.source === "logic")) categories.push("completeness", "plausibility");
  return categories;
}

export async function runReview(args: RunReviewArgs): Promise<RunReviewResult> {
  const applicable = loadRulesFor(args.record.recordType);
  if (applicable.length === 0) {
    throw new Error(
      `no rules apply to record type "${args.record.recordType}". ` +
        `Load the corpus (ingest:rules) first.`,
    );
  }

  // Scope to the requested rules, if any. A requested rule that does not apply
  // to this record type is reported rather than silently dropped: "0 findings"
  // from a scan that never ran the rule reads exactly like a clean document,
  // and that is the most dangerous output this tool can produce.
  let rules = applicable;
  if (args.ruleIds && args.ruleIds.length > 0) {
    const wanted = new Set(args.ruleIds);
    rules = applicable.filter((r) => wanted.has(r.ruleId));

    const missing = [...wanted].filter((id) => !rules.some((r) => r.ruleId === id));
    if (rules.length === 0) {
      throw new Error(
        `none of the ${wanted.size} selected rule(s) apply to record type ` +
          `"${args.record.recordType}": ${[...wanted].join(", ")}`,
      );
    }
    if (missing.length > 0) {
      args.onProgress?.(
        `note: ${missing.length} selected rule(s) do not apply to a ` +
          `${args.record.recordType} record and were skipped: ${missing.join(", ")}`,
      );
    }
    args.onProgress?.(
      `scoped to ${rules.length} of ${applicable.length} applicable rule(s)`,
    );
  }

  const scopedCategories = args.ruleIds && args.ruleIds.length > 0
    ? categoriesForRules(rules)
    : undefined;

  const engine: ReviewEngine = args.offline
    ? new OfflineReviewEngine()
    : new ClaudeReviewEngine({
        ...(args.samples && args.samples > 1 ? { samples: args.samples } : {}),
        ...(scopedCategories ? { categories: scopedCategories } : {}),
        ...(args.onProgress ? { onProgress: args.onProgress } : {}),
      });

  const run = startRun({
    recordId: args.record.recordId,
    model: args.offline ? engine.id : config.model,
    effort: args.offline ? "n/a" : config.effort,
  });

  try {
    const result = await engine.review({
      runId: run.runId,
      record: args.record,
      blocks: args.blocks,
      rules,
      ...(args.related && args.related.length > 0 ? { related: args.related } : {}),
    });
    saveFindings(result.findings);
    finishRun(run.runId, "complete");
    return { run, findings: result.findings, stats: result.stats };
  } catch (err) {
    finishRun(run.runId, "failed", err instanceof Error ? err.message : String(err));
    throw err;
  }
}
