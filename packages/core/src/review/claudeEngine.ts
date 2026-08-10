import Anthropic from "@anthropic-ai/sdk";
import { config, PROMPT_VERSION } from "../config.js";
import type { ReviewEngine, ReviewInput, ReviewResult, ReviewStats } from "../engine.js";
import { CheckCategory, FindingBatch, RawFinding, type Rule } from "../types.js";
import { extractFacts, loadFacts, saveFacts } from "../facts.js";
import type { Finding } from "../types.js";
import { anchorFindings } from "./anchor.js";
import { consensus } from "./consensus.js";
import {
  CONSISTENCY_RULE_ID,
  consistencyFindings,
  findDiscrepancies,
} from "./consistency.js";
import { buildSystemPrompt, buildUserPrompt, VERIFIER_SYSTEM } from "./prompts.js";

/**
 * The review engine, backed by the Claude API.
 *
 * Shape of a run: one call per check category (they are independent and are
 * prompted differently), then one verifier call over the pooled candidates,
 * then anchoring and severity. Categories are separate calls rather than one
 * combined prompt because a single prompt asking for five different kinds of
 * judgment produces noticeably worse output on each of them, and because it
 * lets the expensive categories be skipped for record types that don't need
 * them.
 */

/** JSON Schema for a batch of findings. Kept in lockstep with RawFinding in types.ts. */
const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: CheckCategory.options },
          ruleId: {
            type: "string",
            description: "Must be one of the ruleIds supplied in the system prompt.",
          },
          quote: {
            type: "string",
            description:
              "Exact text from the document, copied character-for-character. " +
              "A finding whose quote cannot be found in the document is discarded.",
          },
          problem: { type: "string" },
          rationale: { type: "string" },
          suggestion: {
            type: "string",
            description:
              "A direction for the fix, not replacement text for the document.",
          },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          harmRelevant: {
            type: "boolean",
            description: "True if this passage concerns something tied to serious injury or death.",
          },
        },
        required: [
          "category",
          "ruleId",
          "quote",
          "problem",
          "rationale",
          "suggestion",
          "confidence",
          "harmRelevant",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "The candidate's index as given." },
          verdict: { type: "string", enum: ["keep", "drop"] },
          reason: { type: "string" },
        },
        required: ["index", "verdict", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
} as const;

export interface ClaudeEngineOptions {
  client?: Anthropic;
  model?: string;
  effort?: string;
  /** Categories to run. Consistency is excluded: it comes from the fact diff. */
  categories?: CheckCategory[];
  /** Skip the verifier pass. Only for measuring what it actually removes. */
  skipVerifier?: boolean;
  /**
   * Self-consistency samples per category. 1 disables voting.
   *
   * 3 with a threshold of 2 is the configuration that buys a defensible
   * repeat-run consistency number, at roughly triple the cost. See consensus.ts
   * for why the remaining variance cannot be prompted away.
   */
  samples?: number;
  /** Samples a finding must appear in to survive. Defaults to a majority. */
  consensusThreshold?: number;
  onProgress?: (message: string) => void;
}

/**
 * Ceiling on simultaneous API requests per review.
 *
 * Four is enough to keep the four category passes overlapping — the case that
 * mattered for latency — while leaving headroom under the account's rate limit
 * when self-consistency sampling multiplies the request count.
 */
const MAX_CONCURRENT_REQUESTS = 4;

/**
 * Run tasks with a bounded number in flight, preserving input order in the
 * results. Same result shape as `Promise.allSettled`.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const DEFAULT_CATEGORIES: CheckCategory[] = [
  "compliance",
  "conformance",
  "completeness",
  "plausibility",
];

export class ClaudeReviewEngine implements ReviewEngine {
  readonly id: string;

  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: string;
  private readonly categories: CheckCategory[];
  private readonly skipVerifier: boolean;
  private readonly samples: number;
  private readonly consensusThreshold: number;
  private readonly onProgress: (message: string) => void;

  constructor(options: ClaudeEngineOptions = {}) {
    // A bare constructor resolves credentials from the environment: an API key,
    // or an `ant auth login` profile. Do not pass a key in from application
    // code — the server process is the only thing that should ever hold one.
    //
    // maxRetries is raised well above the default of 2 because a whole review
    // was lost to transient HTTP 529 `overloaded_error` responses: every check
    // pass exhausted its retries within about forty seconds and the run produced
    // nothing. 529 and 429 are precisely the conditions that clear on their own,
    // and the SDK already applies exponential backoff, so the correct response
    // is patience. For a tool whose pitch is reviewing tens of thousands of
    // documents, losing a document to a capacity blip is not acceptable.
    this.client =
      options.client ??
      new Anthropic({
        maxRetries: 8,
        // Individual requests can legitimately run for minutes at high effort
        // with adaptive thinking; the default 10 minutes is per attempt.
        timeout: 15 * 60 * 1000,
      });
    this.model = options.model ?? config.model;
    this.effort = options.effort ?? config.effort;
    this.categories = options.categories ?? DEFAULT_CATEGORIES;
    this.skipVerifier = options.skipVerifier ?? false;
    this.samples = Math.max(1, options.samples ?? 1);
    this.consensusThreshold = Math.max(
      1,
      Math.min(options.consensusThreshold ?? Math.ceil(this.samples / 2), this.samples),
    );
    this.onProgress = options.onProgress ?? (() => {});
    // The sample count is part of the engine's identity: findings produced by a
    // 3-sample consensus are not comparable to single-sample findings.
    this.id =
      this.samples > 1
        ? `${this.model}/${PROMPT_VERSION}/consensus-${this.consensusThreshold}of${this.samples}`
        : `${this.model}/${PROMPT_VERSION}`;
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    const stats: ReviewStats = {
      proposed: 0,
      droppedUnanchored: 0,
      droppedByVerifier: 0,
      droppedUnknownRule: 0,
      droppedDuplicate: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
    };

    // The category passes are independent — separate prompts, separate rule
    // subsets, no shared state — so they run concurrently. Sequentially they
    // dominated wall-clock time for no reason: four passes at high effort with
    // adaptive thinking took about ten minutes per document, which undercuts the
    // product's central claim of reviewing a whole document base rather than a
    // sample.
    const applicable = this.categories
      .map((category) => ({ category, rules: rulesForCategory(input.rules, category) }))
      .filter(({ category, rules }) => {
        if (rules.length === 0) {
          this.onProgress(`${category}: no applicable rules, skipped`);
          return false;
        }
        return true;
      });

    // Each (category, sample) pair is an independent request.
    const jobs = applicable.flatMap(({ category, rules }) =>
      Array.from({ length: this.samples }, (_, sample) => ({ category, rules, sample })),
    );

    // Bounded, not unbounded. Firing all of them at once looked fine with four
    // categories and one sample, but three samples made it nine simultaneous
    // Opus requests at high effort, and every one of them failed — most likely
    // rate-limited, though the reason was swallowed at the time. A modest limit
    // keeps the latency win from concurrency without turning a review into a
    // burst that gets throttled.
    const settled = await mapWithConcurrency(jobs, MAX_CONCURRENT_REQUESTS, ({ category, rules }) =>
      this.runCheck(category, rules, input, stats),
    );

    // Collect per category, keeping samples separate so they can vote.
    const perCategory = new Map<CheckCategory, RawFinding[][]>();
    for (const [i, outcome] of settled.entries()) {
      const { category } = jobs[i]!;
      if (outcome.status === "fulfilled") {
        const existing = perCategory.get(category) ?? [];
        existing.push(outcome.value);
        perCategory.set(category, existing);
      }
    }

    const candidates: RawFinding[] = [];
    for (const { category } of applicable) {
      const samples = perCategory.get(category);
      if (!samples || samples.length === 0) continue;

      if (this.samples === 1) {
        this.onProgress(`${category}: ${samples[0]!.length} candidate(s)`);
        candidates.push(...samples[0]!);
        continue;
      }

      const voted = consensus(samples, {
        samples: samples.length,
        threshold: this.consensusThreshold,
      });
      this.onProgress(
        `${category}: ${samples.map((s) => s.length).join("+")} candidates across ` +
          `${samples.length} samples -> ${voted.findings.length} agreed ` +
          `(dropped ${voted.droppedBelowThreshold} below ${this.consensusThreshold} votes; ` +
          `votes ${JSON.stringify(voted.voteHistogram)})`,
      );
      stats.droppedBelowConsensus =
        (stats.droppedBelowConsensus ?? 0) + voted.droppedBelowThreshold;
      candidates.push(...voted.findings);
    }

    // Report failures after the successes, so a partial run is unmistakable.
    for (const [i, outcome] of settled.entries()) {
      const category = jobs[i]!.category;
      if (outcome.status === "rejected") {
        // One failed pass must not lose the other three. Report it loudly —
        // a review silently missing a whole category is the most dangerous
        // possible output, because it reads as "nothing to report here".
        const reason =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        // console.error, not onProgress: a suppressed progress channel (--quiet)
        // once hid the reason every pass failed, leaving only "0 findings" and a
        // metric that called it a pass. Failures are never optional output.
        console.error(`  [${category}] request FAILED: ${reason}`);
        // Deduplicated: with voting, one category has several samples and could
        // otherwise appear in this list once per failed sample.
        if (!stats.failedCategories?.includes(category)) {
          stats.failedCategories = [...(stats.failedCategories ?? []), category];
        }
      }
    }

    // A category whose every sample failed contributed nothing at all. That is
    // materially different from a category that merely lost one sample, and it
    // must not be mistaken for "found nothing".
    for (const { category } of applicable) {
      if (!perCategory.has(category)) {
        console.error(
          `  [${category}] ALL samples failed - this category contributed no findings`,
        );
      }
    }

    stats.proposed = candidates.length;

    const kept = this.skipVerifier
      ? candidates
      : await this.verify(candidates, input, stats);

    const anchored = anchorFindings({
      runId: input.runId,
      record: input.record,
      blocks: input.blocks,
      rules: input.rules,
      raw: kept,
    });

    stats.droppedUnanchored = anchored.droppedUnanchored;
    stats.droppedUnknownRule = anchored.droppedUnknownRule;
    stats.droppedDuplicate = anchored.droppedDuplicate;

    // Cross-document consistency. Runs after the LLM passes and is entirely
    // deterministic: facts are extracted per document (a model reads), then
    // compared by code (a join decides). Only fires when other documents are in
    // scope — with nothing to compare against there is no such thing as a
    // cross-document inconsistency, and inventing one would collide with the
    // internal-contradiction rule.
    const consistencyFound = await this.checkConsistency(input, stats);
    anchored.findings.push(...consistencyFound);
    anchored.findings.sort((a, b) => a.charStart - b.charStart);

    this.onProgress(
      `anchored ${anchored.findings.length}; dropped ${anchored.droppedUnanchored} unanchored, ` +
        `${anchored.droppedUnknownRule} unknown-rule, ${anchored.droppedDuplicate} duplicate`,
    );

    return { findings: anchored.findings, stats };
  }

  /**
   * Extract facts from the record and everything in scope, then diff.
   *
   * Facts are cached in the database per record, so reviewing a second CAPA
   * against the same FMEA does not re-extract the FMEA. That is what makes the
   * check affordable across a whole document base rather than a sample: N
   * documents cost N extractions, not N-squared comparisons.
   */
  private async checkConsistency(
    input: ReviewInput,
    stats: ReviewStats,
  ): Promise<Finding[]> {
    const related = input.related ?? [];
    if (related.length === 0) return [];

    const rule = input.rules.find((r) => r.ruleId === CONSISTENCY_RULE_ID);
    if (!rule) {
      console.error(
        `  [consistency] rule ${CONSISTENCY_RULE_ID} not in the corpus - pass skipped`,
      );
      return [];
    }

    const all = [
      { record: input.record, blocks: input.blocks },
      ...related,
    ];

    for (const doc of all) {
      // Reuse stored facts when the document has not changed.
      const existing = await loadFacts([doc.record.recordId]);
      if (existing.length > 0) {
        this.onProgress(`consistency: ${doc.record.docId ?? doc.record.filename} - ` +
          `${existing.length} fact(s) from cache`);
        continue;
      }
      const extracted = await extractFacts(doc, this.client, this.model);
      await saveFacts(doc.record.recordId, extracted.facts);
      stats.uncachedInputTokens = (stats.uncachedInputTokens ?? 0) + extracted.inputTokens;
      stats.outputTokens = (stats.outputTokens ?? 0) + extracted.outputTokens;
      this.onProgress(
        `consistency: ${doc.record.docId ?? doc.record.filename} - ` +
          `${extracted.facts.length} fact(s) extracted` +
          (extracted.droppedUnanchored > 0
            ? `, ${extracted.droppedUnanchored} dropped unanchored`
            : ""),
      );
    }

    const facts = await loadFacts(all.map((d) => d.record.recordId));
    const discrepancies = findDiscrepancies(facts);
    this.onProgress(
      `consistency: ${facts.length} fact(s) across ${all.length} document(s) -> ` +
        `${discrepancies.length} discrepancy(ies)`,
    );

    const findings = consistencyFindings({
      runId: input.runId,
      record: input.record,
      relatedRecords: related.map((r) => r.record),
      discrepancies,
      rule,
    });
    stats.consistencyDiscrepancies = discrepancies.length;
    return findings;
  }

  private async runCheck(
    category: CheckCategory,
    rules: Rule[],
    input: ReviewInput,
    stats: ReviewStats,
  ): Promise<RawFinding[]> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: this.effort as "low" | "medium" | "high" | "xhigh" | "max",
        format: { type: "json_schema", schema: FINDINGS_SCHEMA },
      },
      // The stable prefix — instructions plus the rule corpus — is cached. It is
      // identical for every record of a given type, and it is by far the largest
      // part of the request, so this is where the cost saving is.
      system: [
        {
          type: "text",
          text: buildSystemPrompt(category, rules),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildUserPrompt(input.record) }],
    });

    accumulateUsage(stats, response.usage);
    return parseFindings(response, category);
  }

  /**
   * Second-pass filter over pooled candidates.
   *
   * Runs once over all categories rather than per category so the verifier can
   * also catch the same problem reported twice under different rules — which is
   * the most common redundancy, and the one most likely to make a reviewer feel
   * the tool is padding its output.
   */
  private async verify(
    candidates: RawFinding[],
    input: ReviewInput,
    stats: ReviewStats,
  ): Promise<RawFinding[]> {
    if (candidates.length === 0) return [];

    const listed = candidates
      .map(
        (c, i) =>
          `[${i}] rule=${c.ruleId} category=${c.category} confidence=${c.confidence}\n` +
          `    quote: ${JSON.stringify(c.quote)}\n` +
          `    problem: ${c.problem}`,
      )
      .join("\n\n");

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: this.effort as "low" | "medium" | "high" | "xhigh" | "max",
        format: { type: "json_schema", schema: VERDICT_SCHEMA },
      },
      system: [{ type: "text", text: VERIFIER_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            "--- BEGIN DOCUMENT ---",
            input.record.normalizedText,
            "--- END DOCUMENT ---",
            "",
            `Candidate findings (${candidates.length}):`,
            "",
            listed,
            "",
            "Return a verdict for every index.",
          ].join("\n"),
        },
      ],
    });

    accumulateUsage(stats, response.usage);

    const text = firstText(response);
    let dropped = 0;
    const keep = new Set<number>(candidates.map((_, i) => i));

    if (text) {
      try {
        const parsed = JSON.parse(text) as {
          verdicts?: { index: number; verdict: string; reason: string }[];
        };
        for (const v of parsed.verdicts ?? []) {
          if (v.verdict === "drop" && keep.delete(v.index)) dropped++;
        }
      } catch {
        // A verifier that returns unparseable output must not silently discard
        // every finding. Fail open — keep the candidates — and say so, because
        // the alternative is a run that reports "no issues found" for the wrong
        // reason, which is the most dangerous possible output for this tool.
        this.onProgress("verifier response was unparseable; keeping all candidates");
      }
    }

    stats.droppedByVerifier = dropped;
    this.onProgress(`verifier dropped ${dropped} of ${candidates.length}`);
    return candidates.filter((_, i) => keep.has(i));
  }
}

/** Rules applicable to a record type, partitioned by which pass should see them. */
export function rulesForCategory(rules: Rule[], category: CheckCategory): Rule[] {
  return rules.filter((rule) => {
    switch (category) {
      // The customer's own procedures are the conformance pass, by definition.
      case "conformance":
        return rule.source === "sop";
      case "compliance":
        return rule.source === "cfr" || rule.source === "iso_clause" || rule.source === "guidance";
      // Completeness and plausibility are cross-cutting soundness checks; they
      // read against the logic rules plus whatever the record is measured by.
      case "completeness":
      case "plausibility":
        return rule.source === "logic" || rule.source === "iso_clause";
      case "consistency":
        return rule.source === "logic";
    }
  });
}

function firstText(response: Anthropic.Message): string | undefined {
  for (const block of response.content) {
    if (block.type === "text") return block.text;
  }
  return undefined;
}

/**
 * Accumulate usage, keeping the three input buckets separate.
 *
 * Kept separate deliberately: summing them hides whether prompt caching is
 * working at all, and a broken cache roughly doubles the cost of every review
 * with no other visible symptom.
 */
function accumulateUsage(stats: ReviewStats, usage: Anthropic.Usage): void {
  stats.uncachedInputTokens = (stats.uncachedInputTokens ?? 0) + usage.input_tokens;
  stats.cacheReadTokens = (stats.cacheReadTokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  stats.cacheCreationTokens =
    (stats.cacheCreationTokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  stats.outputTokens = (stats.outputTokens ?? 0) + usage.output_tokens;
}

/**
 * Parse and validate a check response.
 *
 * Structured outputs guarantee the shape, but the *values* still need checking —
 * particularly that the category matches the pass, since a model asked for
 * completeness findings will occasionally label one "compliance" and that would
 * quietly bypass the category's rule filtering.
 */
function parseFindings(response: Anthropic.Message, category: CheckCategory): RawFinding[] {
  const text = firstText(response);
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const result = FindingBatch.safeParse(parsed);
  if (!result.success) return [];

  return result.data.findings.map((f) => ({ ...f, category }));
}
