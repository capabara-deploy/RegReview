import { config } from "./config.js";
import type { ReviewEngine, ReviewStats } from "./engine.js";
import { ClaudeReviewEngine } from "./review/claudeEngine.js";
import { OfflineReviewEngine } from "./review/offlineEngine.js";
import { finishRun, loadRulesFor, saveFindings, startRun } from "./store.js";
import type { Block, Finding, RecordDoc, Run } from "./types.js";

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
  onProgress?: (message: string) => void;
}

export interface RunReviewResult {
  run: Run;
  findings: Finding[];
  stats: ReviewStats;
}

export async function runReview(args: RunReviewArgs): Promise<RunReviewResult> {
  const rules = loadRulesFor(args.record.recordType);
  if (rules.length === 0) {
    throw new Error(
      `no rules apply to record type "${args.record.recordType}". ` +
        `Load the corpus (ingest:rules) first.`,
    );
  }

  const engine: ReviewEngine = args.offline
    ? new OfflineReviewEngine()
    : new ClaudeReviewEngine({
        ...(args.samples && args.samples > 1 ? { samples: args.samples } : {}),
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
