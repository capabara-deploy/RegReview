import type { Finding } from "@regreview/core";
import type { LoadedFixture } from "./loadFixtures.js";
import type { ResolvedLabel } from "./types.js";

/**
 * Score predicted findings against a fixture's labels.
 *
 * Matching is at two tiers, on purpose. The team's own agreement data found the
 * engine's instability is concentrated in *rule attribution* — the same defect
 * filed under a different but overlapping rule — not in detection. A rule-strict
 * score alone therefore understates the engine the same way the strict agreement
 * metrics did. So every number is reported at both tiers:
 *
 *  - **defect tier**: a prediction matches a label if their spans overlap,
 *    regardless of rule. This answers "did it find the problem".
 *  - **rule tier**: spans overlap AND the rule id matches. This answers "did it
 *    also attribute the problem to the right requirement".
 *
 * Precision is only counted on `exhaustive` fixtures. On a non-exhaustive
 * fixture an unmatched prediction might be a real defect we simply did not
 * annotate, and counting it as a false positive would train the corpus toward
 * missing things — the opposite of what precision is supposed to protect.
 */

function overlaps(
  a: { charStart: number; charEnd: number },
  b: { charStart: number; charEnd: number },
): boolean {
  return a.charStart < b.charEnd && b.charStart < a.charEnd;
}

export interface FixtureScore {
  fixtureId: string;
  exhaustive: boolean;
  labelCount: number;
  predictionCount: number;

  /** Labels matched by at least one overlapping prediction (any rule). */
  recallDefect: number;
  /** Labels matched by an overlapping prediction with the same rule id. */
  recallRule: number;

  /** Precision at defect tier (exhaustive only; null otherwise). */
  precisionDefect: number | null;
  /** Precision at rule tier (exhaustive only; null otherwise). */
  precisionRule: number | null;

  /** Recall split out by label difficulty, defect tier. */
  recallEasy: number | null;
  recallHard: number | null;

  /** Raw counts behind the ratios, so aggregation can micro-average correctly. */
  raw: {
    matchedDefect: number;
    matchedRule: number;
    tpDefect: number;
    tpRule: number;
    easyMatched: number;
    easyTotal: number;
    hardMatched: number;
    hardTotal: number;
  };

  /** Predictions that landed on a labeled distractor — the worst false positive. */
  distractorHits: number;

  /** The specific labels no prediction matched (defect tier), for debugging. */
  missed: { ruleId: string; anchor: string; why: string }[];
  /** Predictions matching no label, on exhaustive fixtures — the false positives. */
  falsePositives: { ruleId: string; quote: string; problem: string }[];
}

function ratio(n: number, d: number): number {
  return d === 0 ? 1 : n / d;
}

export function scoreFixture(fixture: LoadedFixture, predictions: Finding[]): FixtureScore {
  const labels = fixture.labels;
  const exhaustive = fixture.meta.exhaustive;

  const labelMatchedDefect = new Set<ResolvedLabel>();
  const labelMatchedRule = new Set<ResolvedLabel>();
  for (const label of labels) {
    for (const p of predictions) {
      if (!overlaps(p, label)) continue;
      labelMatchedDefect.add(label);
      if (p.ruleId === label.ruleId) labelMatchedRule.add(label);
    }
  }

  // Precision (exhaustive only): a prediction is a true positive if it overlaps
  // some label. Predictions landing on a distractor are always false positives.
  let tpDefect = 0;
  let tpRule = 0;
  const falsePositives: FixtureScore["falsePositives"] = [];
  for (const p of predictions) {
    const overlapping = labels.filter((l) => overlaps(p, l));
    if (overlapping.length > 0) {
      tpDefect++;
      if (overlapping.some((l) => l.ruleId === p.ruleId)) tpRule++;
    } else if (exhaustive) {
      falsePositives.push({ ruleId: p.ruleId, quote: p.quote, problem: p.problem });
    }
  }

  const distractorHits = predictions.filter((p) =>
    fixture.distractors.some((d) => overlaps(p, d)),
  ).length;

  const easy = labels.filter((l) => l.difficulty !== "hard");
  const hard = labels.filter((l) => l.difficulty === "hard");
  const easyMatched = easy.filter((l) => labelMatchedDefect.has(l)).length;
  const hardMatched = hard.filter((l) => labelMatchedDefect.has(l)).length;

  return {
    fixtureId: fixture.meta.id,
    exhaustive,
    labelCount: labels.length,
    predictionCount: predictions.length,
    recallDefect: ratio(labelMatchedDefect.size, labels.length),
    recallRule: ratio(labelMatchedRule.size, labels.length),
    precisionDefect: exhaustive ? ratio(tpDefect, predictions.length) : null,
    precisionRule: exhaustive ? ratio(tpRule, predictions.length) : null,
    recallEasy: easy.length > 0 ? ratio(easyMatched, easy.length) : null,
    recallHard: hard.length > 0 ? ratio(hardMatched, hard.length) : null,
    raw: {
      matchedDefect: labelMatchedDefect.size,
      matchedRule: labelMatchedRule.size,
      tpDefect,
      tpRule,
      easyMatched,
      easyTotal: easy.length,
      hardMatched,
      hardTotal: hard.length,
    },
    distractorHits,
    missed: labels
      .filter((l) => !labelMatchedDefect.has(l))
      .map((l) => ({ ruleId: l.ruleId, anchor: l.anchor, why: l.why })),
    falsePositives,
  };
}

export interface AggregateScore {
  fixtures: number;
  totalLabels: number;
  totalPredictions: number;
  /** Micro-averaged: pooled matched labels / pooled labels. */
  recallDefect: number;
  recallRule: number;
  /** Micro-averaged precision over exhaustive fixtures only. */
  precisionDefect: number | null;
  precisionRule: number | null;
  recallEasy: number | null;
  recallHard: number | null;
  distractorHits: number;
}

/** Micro-average across fixtures: pool the raw counts, then divide. */
export function aggregate(scores: FixtureScore[]): AggregateScore {
  let labels = 0;
  let predictions = 0;
  let matchedDefect = 0;
  let matchedRule = 0;
  let tpDefect = 0;
  let tpRule = 0;
  let exhaustivePreds = 0;
  let easyMatched = 0;
  let easyTotal = 0;
  let hardMatched = 0;
  let hardTotal = 0;
  let distractorHits = 0;

  for (const s of scores) {
    labels += s.labelCount;
    predictions += s.predictionCount;
    matchedDefect += s.raw.matchedDefect;
    matchedRule += s.raw.matchedRule;
    distractorHits += s.distractorHits;
    easyMatched += s.raw.easyMatched;
    easyTotal += s.raw.easyTotal;
    hardMatched += s.raw.hardMatched;
    hardTotal += s.raw.hardTotal;
    if (s.exhaustive) {
      tpDefect += s.raw.tpDefect;
      tpRule += s.raw.tpRule;
      exhaustivePreds += s.predictionCount;
    }
  }

  return {
    fixtures: scores.length,
    totalLabels: labels,
    totalPredictions: predictions,
    recallDefect: ratio(matchedDefect, labels),
    recallRule: ratio(matchedRule, labels),
    precisionDefect: exhaustivePreds > 0 ? ratio(tpDefect, exhaustivePreds) : null,
    precisionRule: exhaustivePreds > 0 ? ratio(tpRule, exhaustivePreds) : null,
    recallEasy: easyTotal > 0 ? ratio(easyMatched, easyTotal) : null,
    recallHard: hardTotal > 0 ? ratio(hardMatched, hardTotal) : null,
    distractorHits,
  };
}
