import type { Block, Finding, RecordDoc, Rule } from "./types.js";

/**
 * The contract every review engine implements.
 *
 * This interface is deliberately defined before any real engine exists. The
 * build plan puts the evaluation harness first, and a harness needs something
 * to call — but more importantly, fixing the contract early is what lets the
 * harness compare a real engine against a crude baseline on identical terms.
 * Precision is the asset with this audience, and a precision number is
 * meaningless without a floor to compare it to.
 */
export interface ReviewEngine {
  /** Stable identifier recorded on runs, e.g. "claude-opus-4-8/p1" or "keyword-baseline". */
  readonly id: string;

  review(input: ReviewInput): Promise<ReviewResult>;
}

export interface ReviewInput {
  /**
   * The run this review belongs to. Supplied by the caller rather than minted
   * here, because the run row (with its model, prompt and corpus versions) has
   * to exist before findings can reference it.
   */
  runId: string;
  record: RecordDoc;
  blocks: Block[];
  /**
   * Rules already filtered to those applicable to this record type, and — when
   * the caller scoped the review — to the specific rules requested.
   *
   * Scoping is what makes "a standard was revised; which of my documents now
   * violate it" affordable. Running two new rules across a document base is one
   * check pass instead of four, so it costs roughly a seventh of a full review
   * per document. It is also the only honest way to answer that question: a full
   * re-review diffed against a prior run buries the real delta under repeat-run
   * variance, because the engine does not reproduce its own output exactly.
   */
  rules: Rule[];
  /**
   * Other records in scope, for cross-document consistency. Facts are extracted
   * from these and diffed deterministically — the engine is not expected to
   * read them all in full.
   */
  related?: { record: RecordDoc; blocks: Block[] }[];
}

export interface ReviewResult {
  /**
   * Findings that survived anchoring and verification. A finding whose quote
   * could not be located verbatim in the source must never appear here.
   */
  findings: Finding[];
  /** Diagnostics for the harness and the run log; not shown to reviewers. */
  stats: ReviewStats;
}

export interface ReviewStats {
  /** Findings the model proposed, before any filtering. */
  proposed: number;
  /**
   * Findings dropped because their quote was not found verbatim in the
   * document. This is the hallucination guard, and its rate is worth watching:
   * a rising number means the prompt is drifting toward paraphrase.
   */
  droppedUnanchored: number;
  /** Findings dropped by the precision verifier pass. */
  droppedByVerifier: number;
  /** Findings dropped because they cited a rule not in the supplied rule set. */
  droppedUnknownRule: number;
  /** Findings collapsed into an existing one (same rule, same block, overlapping span). */
  droppedDuplicate: number;
  /**
   * Candidates dropped for appearing in too few independent samples when
   * self-consistency voting is enabled. A high number here is the voting doing
   * its job — those are the findings that made repeat runs disagree.
   */
  droppedBelowConsensus?: number;

  /**
   * Token accounting, split so prompt-cache behaviour is observable.
   *
   * These were previously summed into one number, which made a silent caching
   * failure invisible — and a broken cache roughly doubles the cost of every
   * review, since the rule corpus is the bulk of the input and is identical
   * across every record of a type. `cacheReadTokens` should dominate
   * `uncachedInputTokens` from the second request onward; if it is zero across
   * repeated runs, something in the stable prefix is varying.
   */
  uncachedInputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;

  /**
   * Categories whose pass failed outright. Must be surfaced to the reviewer: a
   * review missing a whole category reads as "nothing to report there", which is
   * the most dangerous output this tool can produce.
   */
  failedCategories?: string[];

  /** Cross-document discrepancies found by the deterministic fact diff. */
  consistencyDiscrepancies?: number;
}

/** Total input tokens across all three buckets, for cost reporting. */
export function totalInputTokens(stats: ReviewStats): number {
  return (
    (stats.uncachedInputTokens ?? 0) +
    (stats.cacheReadTokens ?? 0) +
    (stats.cacheCreationTokens ?? 0)
  );
}

/**
 * Share of input served from cache. The number to watch: if this stays near
 * zero, the cached prefix is being invalidated by something volatile.
 */
export function cacheHitRate(stats: ReviewStats): number {
  const total = totalInputTokens(stats);
  return total === 0 ? 0 : (stats.cacheReadTokens ?? 0) / total;
}
