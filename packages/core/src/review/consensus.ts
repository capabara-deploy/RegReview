import type { RawFinding } from "../types.js";

/**
 * Self-consistency voting over repeated generations.
 *
 * Why this exists. Measured repeat-run agreement on one CAPA sat between 44%
 * and 69% depending on which pair you compared, against a 90% target — and the
 * spread between those measurements is itself the point: with roughly a dozen
 * findings per run, any single pair comparison has error bars wide enough that
 * "did it get better" is unanswerable. Prompt fixes (one-sentence anchoring,
 * explicit rule precedence) closed the quote-boundary component of the variance
 * but left the detection component, where a genuine finding surfaces in one run
 * and not the next.
 *
 * Repeat-run consistency was named by the Fresenius interviewee as a critical
 * technical requirement, so the remaining variance has to be engineered out
 * rather than explained away. Voting does that directly: sample the same check
 * several times and keep only what independent samples agree on.
 *
 * It buys two things at once. Consistency, because the consensus set is far more
 * stable than any individual sample. And precision, because a finding two
 * independent readings both produced is much likelier to be real than one a
 * single reading produced — which is the tradeoff this product needs, since a
 * false alarm costs credibility a miss does not.
 *
 * The cost is linear in the number of samples. That is the honest tradeoff:
 * roughly triple spend for a defensible consistency number.
 */

export interface ConsensusOptions {
  /** How many independent samples were taken. */
  samples: number;
  /**
   * How many samples must contain a finding for it to survive.
   *
   * Two of three is the useful default: it removes findings only one reading
   * produced while keeping anything two readings independently agreed on.
   * Requiring unanimity throws away real findings, because the variance being
   * corrected here is partly which *true* findings a given reading happens to
   * surface, not just which false ones it invents.
   */
  threshold: number;
}

export interface ConsensusResult {
  findings: RawFinding[];
  /** Votes each surviving finding received, parallel to `findings`. */
  votes: number[];
  /** Candidates dropped for appearing in too few samples. */
  droppedBelowThreshold: number;
  /** Distribution of vote counts across all distinct candidates, for diagnostics. */
  voteHistogram: Record<number, number>;
}

/**
 * Are two raw findings the same finding?
 *
 * Compared before anchoring, so there are no offsets yet — the quote text is all
 * we have. Same rule plus a substantial quote overlap means the same judgment
 * about the same passage. Whitespace and case are normalized because they carry
 * no meaning here.
 *
 * Deliberately not comparing `problem`: the model phrases the same problem
 * differently every time, and requiring the prose to match would make voting
 * find agreement almost nowhere.
 */
function sameFinding(a: RawFinding, b: RawFinding): boolean {
  if (a.ruleId !== b.ruleId) return false;
  const qa = normalize(a.quote);
  const qb = normalize(b.quote);
  return qa === qb || qa.includes(qb) || qb.includes(qa);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Collapse several independent samples into an agreed set.
 *
 * A finding must appear in at least `threshold` distinct samples. Duplicates
 * *within* one sample count once — otherwise a single reading that reported the
 * same problem under two categories could outvote a genuine cross-sample
 * agreement.
 */
export function consensus(
  samples: RawFinding[][],
  options: ConsensusOptions,
): ConsensusResult {
  interface Cluster {
    representative: RawFinding;
    /** Which sample indices contained this finding. A Set, so within-sample
     *  duplicates cannot inflate the vote. */
    voters: Set<number>;
    members: RawFinding[];
  }

  const clusters: Cluster[] = [];

  for (const [sampleIndex, sample] of samples.entries()) {
    for (const finding of sample) {
      const existing = clusters.find((c) => sameFinding(c.representative, finding));
      if (existing) {
        existing.voters.add(sampleIndex);
        existing.members.push(finding);
      } else {
        clusters.push({
          representative: finding,
          voters: new Set([sampleIndex]),
          members: [finding],
        });
      }
    }
  }

  const voteHistogram: Record<number, number> = {};
  for (const c of clusters) {
    const v = c.voters.size;
    voteHistogram[v] = (voteHistogram[v] ?? 0) + 1;
  }

  const survivors = clusters.filter((c) => c.voters.size >= options.threshold);

  return {
    // Report the member with the highest confidence, and the longest quote among
    // equally confident ones — the reviewer gets the most assured phrasing and
    // the most context.
    findings: survivors.map((c) => pickBest(c.members)),
    votes: survivors.map((c) => c.voters.size),
    droppedBelowThreshold: clusters.length - survivors.length,
    voteHistogram,
  };
}

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 } as const;

function pickBest(members: RawFinding[]): RawFinding {
  return [...members].sort((a, b) => {
    const byConfidence = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (byConfidence !== 0) return byConfidence;
    return b.quote.length - a.quote.length;
  })[0]!;
}
