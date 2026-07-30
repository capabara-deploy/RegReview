import type { RawFinding, Rule, Severity, SeverityBasis } from "./types.js";

/**
 * Deriving the risk tier for a finding.
 *
 * Severity is computed here rather than asked of the model, for two reasons.
 * First, a model asked to rate its own finding's importance produces ratings
 * that drift between runs, and repeat-run consistency is a stated customer
 * requirement. Second, the regulatory expert's advice was to prioritize the way
 * an inspection actually does — by risk to the patient, and by what
 * investigators actually cite — and both of those are facts we hold in the rule
 * corpus, not judgments the model needs to make.
 *
 * WHY FREQUENCY IS A PERCENTILE, NOT A RAW COUNT. The first version of this
 * used an absolute threshold on FDA citation counts, and it collapsed: because
 * a rule keyed to 820.100(a)(4) inherits the citation count of the paragraph
 * that contains it, all nine CAPA rules inherited roughly the same ~3,370 from
 * 820.100(a) and every one of them cleared the bar. Every CAPA finding came out
 * "high". That is worse than no tiering at all — a reviewer facing forty "high"
 * flags on one document learns to ignore the colour, and the credibility we
 * spend it on is the only asset we have with this audience. A percentile rank
 * within the corpus keeps the tiers meaningfully distributed no matter how the
 * absolute counts move when a new fiscal year is ingested.
 *
 * The `SeverityBasis` returned alongside the tier records every input, so the
 * UI can tell a reviewer *why* something is rated as it is, and so the formula
 * can be retuned later without orphaning findings recorded under the old one.
 */

/** Frequency percentile at or above which a requirement is a top inspection target. */
const TOP_QUARTILE = 0.75;
/** Percentile below which a requirement is rarely cited in practice. */
const BOTTOM_HALF = 0.5;

export function deriveSeverity(
  finding: Pick<RawFinding, "confidence" | "harmRelevant" | "category">,
  rule: Pick<Rule, "citationFrequency" | "harmLinked" | "frequencyPercentile">,
): { severity: Severity; basis: SeverityBasis } {
  const basis = (severity: Severity, reason: string) => ({
    severity,
    basis: {
      citationFrequency: rule.citationFrequency,
      frequencyPercentile: rule.frequencyPercentile,
      harmLinked: rule.harmLinked,
      harmRelevant: finding.harmRelevant,
      confidence: finding.confidence,
      reason,
    } satisfies SeverityBasis,
  });

  const frequentlyCited = rule.frequencyPercentile >= TOP_QUARTILE;
  const rarelyCited = rule.frequencyPercentile < BOTTOM_HALF;

  /*
   * Harm relevance is a property of the PASSAGE, not only of the rule.
   *
   * The first version required `rule.harmLinked && finding.harmRelevant` for the
   * top tier, which produced a visible inversion on real output: the finding
   * that the record's "Minor" severity rating was contradicted by its own
   * account of a patient blood-pressure event — arguably the most consequential
   * finding in the document, since it undermines the whole risk-acceptability
   * conclusion — came out medium, because it was filed under a general soundness
   * rule that is not itself marked harm-linked. Meanwhile a medium-confidence
   * scope question against a harm-linked CAPA rule came out high.
   *
   * A high-confidence finding on a passage that concerns serious injury is
   * high-risk regardless of which rule caught it. So harm on EITHER side counts,
   * and confidence — not rule bookkeeping — decides whether it reaches the top.
   */
  const harmInvolved = finding.harmRelevant || rule.harmLinked;

  if (harmInvolved) {
    if (finding.confidence === "high") {
      return basis(
        "high",
        finding.harmRelevant
          ? "The quoted passage concerns something tied to serious injury or death, and " +
              "the finding is stated with high confidence. This is the chain an " +
              "investigator follows from complaint to containment to corrective action."
          : "The requirement is one whose failure can connect to patient harm, and the " +
              "finding is stated with high confidence.",
      );
    }
    if (finding.confidence === "medium") {
      // Both sides harm-related and a defensible finding: still top tier.
      if (finding.harmRelevant && rule.harmLinked) {
        return basis(
          "high",
          "Both the requirement and the quoted passage concern patient harm. Findings in " +
            "this chain receive the most inspection scrutiny, so it is escalated even at " +
            "medium confidence.",
        );
      }
      return basis(
        "medium",
        "Harm-related, but only on one side — either the requirement or the passage, not " +
          "both — and confidence is medium.",
      );
    }
    return basis(
      "medium",
      "Harm-related, but confidence in this particular finding is low — worth checking, " +
        "not yet worth escalating.",
    );
  }

  // A frequently-cited requirement is where inspections empirically land. High
  // only when we are also confident; otherwise it is a lead, not a finding.
  if (frequentlyCited) {
    if (finding.confidence === "high") {
      return basis(
        "high",
        `Among the most frequently cited requirements in FDA's inspection record ` +
          `(${rule.citationFrequency} citations, ` +
          `${(rule.frequencyPercentile * 100).toFixed(0)}th percentile), and stated ` +
          `with high confidence.`,
      );
    }
    return basis(
      "medium",
      `A frequently cited requirement (${rule.citationFrequency} citations), but ` +
        `confidence in this finding is ${finding.confidence}.`,
    );
  }

  if (!rarelyCited && finding.confidence !== "low") {
    return basis(
      "medium",
      `A requirement FDA does cite (${rule.citationFrequency} citations), though not ` +
        `among the most common.`,
    );
  }

  // Real findings, but not inspection-risk drivers: documentation hygiene,
  // terminology, wording. Worth fixing; not worth interrupting anyone for.
  return basis(
    "low",
    "Not tied to patient harm and not a frequently cited requirement — worth " +
      "correcting, but unlikely on its own to drive an inspection observation.",
  );
}

/**
 * Assign each rule a percentile rank by citation frequency.
 *
 * Called at ingest so the value is stored on the rule and severity derivation
 * stays a pure function of one rule plus one finding.
 *
 * Rules with zero inherited frequency (the pure soundness checks, which have no
 * CFR crosswalk) are deliberately excluded from the ranked population and given
 * percentile 0: including them would inflate the ranks of everything else, and
 * they are not "rarely cited requirements" so much as requirements FDA does not
 * express as a citation at all.
 */
export function assignFrequencyPercentiles<T extends { citationFrequency: number }>(
  rules: T[],
): Map<T, number> {
  const ranked = rules.filter((r) => r.citationFrequency > 0);
  const sorted = [...ranked].sort((a, b) => a.citationFrequency - b.citationFrequency);
  const out = new Map<T, number>();

  for (const rule of rules) {
    if (rule.citationFrequency <= 0) {
      out.set(rule, 0);
      continue;
    }
    // Fraction of the ranked population this rule is cited at least as often as.
    // Ties share the same percentile, which is what we want when several rules
    // inherit the same parent paragraph's count.
    const atOrBelow = sorted.filter((r) => r.citationFrequency <= rule.citationFrequency).length;
    out.set(rule, sorted.length > 0 ? atOrBelow / sorted.length : 0);
  }

  return out;
}
