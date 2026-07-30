import { isDocumentScoped, normalizeSubject, normalizeValue, subjectsMatch } from "../facts.js";
import { deriveSeverity } from "../severity.js";
import { stableFindingId } from "./anchor.js";
import type { Fact, Finding, RecordDoc, Rule } from "../types.js";

/**
 * The cross-document consistency check.
 *
 * Entirely deterministic — no model call. Facts extracted from each record are
 * joined on (kind, normalized subject) and any group whose normalized values
 * disagree is a finding.
 *
 * Three things follow from doing it this way, and all three matter:
 *
 *  - **It is repeatable by construction.** This pass contributes exactly the same
 *    findings on every run over the same facts, which is the requirement
 *    Fresenius named as critical. The LLM check passes cannot promise that; this
 *    one can, because a join has no temperature.
 *
 *  - **It is defensible.** The finding is not "a model thinks these disagree",
 *    it is "this document says 3 here and that document says 5 there", with both
 *    passages quoted and located. That is the form a quality engineer can take
 *    to the department that owns the other document.
 *
 *  - **It scales.** Comparing every document against every other document is a
 *    query, not N-squared model calls. The whole reason no existing process
 *    catches these is that it requires holding thousands of documents in view at
 *    once — an audit samples a few hundred out of tens of thousands. A table does
 *    not have that limitation.
 *
 * The finding text is templated rather than generated for the same reason: a
 * mechanical discrepancy has a mechanical description, and a template says it
 * identically every time. Where prose would help — nuance about which value is
 * likely correct — the reviewer is better served by seeing both values and
 * deciding, since the correct value may be either and the record may need to
 * show why the difference is justified.
 */

/** Which fact kinds are worth flagging when they disagree, and how they read. */
const COMPARABLE: Record<string, { label: string; harmRelevant: boolean }> = {
  risk_severity: { label: "risk severity rating", harmRelevant: true },
  risk_occurrence: { label: "occurrence rating", harmRelevant: false },
  risk_detection: { label: "detection rating", harmRelevant: false },
  risk_index: { label: "risk index", harmRelevant: true },
  risk_acceptability_threshold: {
    label: "risk acceptability threshold",
    harmRelevant: true,
  },
  failure_mode_cause: { label: "determined cause", harmRelevant: true },
  affected_quantity: { label: "affected quantity", harmRelevant: false },
  software_version: { label: "software version", harmRelevant: false },
  part_number: { label: "part number", harmRelevant: false },
  date_closed: { label: "closure date", harmRelevant: false },
  date_opened: { label: "date opened", harmRelevant: false },
  requirement_id: { label: "requirement identifier", harmRelevant: false },
};

/** The rule a consistency finding is asserted against. */
export const CONSISTENCY_RULE_ID = "regreview-logic-risk-rating-consistency";

export interface Discrepancy {
  kind: string;
  subject: string;
  /** Distinct normalized values, and which records asserted each. */
  values: { value: string; facts: Fact[] }[];
}

/**
 * Find facts about the same thing that disagree across documents.
 *
 * Only across documents: a disagreement inside one record is a different defect
 * with a different rule (internal contradiction), and reporting it here would
 * reintroduce exactly the rule-overlap that made repeat runs look inconsistent.
 */
export function findDiscrepancies(facts: Fact[]): Discrepancy[] {
  // Cluster by kind, then by whether the subjects refer to the same thing.
  // Clustering rather than keying on an exact string, because two documents
  // never phrase a subject identically — see subjectsMatch.
  const clusters: { kind: string; subjects: string[]; facts: Fact[] }[] = [];

  // Sorted first so clustering is deterministic regardless of extraction order:
  // which fact seeds a cluster must not depend on which document was read first.
  const ordered = [...facts]
    .filter((f) => f.kind in COMPARABLE)
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        normalizeSubject(a.subject).localeCompare(normalizeSubject(b.subject)) ||
        a.recordId.localeCompare(b.recordId),
    );

  for (const fact of ordered) {
    const normalized = normalizeSubject(fact.subject);
    const existing = clusters.find(
      (c) =>
        c.kind === fact.kind &&
        // Document-scoped values describe the document or product as a whole, so
        // the subject wording is not the identity — the kind is.
        (isDocumentScoped(fact.kind) || c.subjects.some((s) => subjectsMatch(s, normalized))),
    );
    if (existing) {
      existing.facts.push(fact);
      if (!existing.subjects.includes(normalized)) existing.subjects.push(normalized);
    } else {
      clusters.push({ kind: fact.kind, subjects: [normalized], facts: [fact] });
    }
  }

  const discrepancies: Discrepancy[] = [];

  for (const cluster of clusters) {
    // Needs at least two documents to be a cross-document finding.
    const recordIds = new Set(cluster.facts.map((f) => f.recordId));
    if (recordIds.size < 2) continue;

    const byValue = new Map<string, Fact[]>();
    for (const fact of cluster.facts) {
      const v = normalizeValue(fact.value);
      byValue.set(v, [...(byValue.get(v) ?? []), fact]);
    }
    if (byValue.size < 2) continue; // They agree — nothing to report.

    discrepancies.push({
      kind: cluster.kind,
      // Longest phrasing seen is the most informative for a reader.
      subject:
        [...cluster.facts].sort((a, b) => b.subject.length - a.subject.length)[0]!.subject,
      values: [...byValue.entries()]
        .map(([value, fs]) => ({ value, facts: fs }))
        .sort((a, b) => a.value.localeCompare(b.value)),
    });
  }

  // Stable order so the pass produces identical output across runs.
  discrepancies.sort((a, b) =>
    `${a.kind}|${a.subject}`.localeCompare(`${b.kind}|${b.subject}`),
  );
  return discrepancies;
}

function describe(record: RecordDoc | undefined, fact: Fact): string {
  const label = record?.docId ?? record?.filename ?? fact.recordId;
  return `${label} (chars ${fact.charStart}-${fact.charEnd})`;
}

/**
 * Turn discrepancies into findings anchored in the record under review.
 *
 * The finding is anchored to the passage in *this* record, because that is the
 * document the reviewer has open; the other document's value and location are
 * named in the text so the disagreement is actionable.
 */
export function consistencyFindings(args: {
  runId: string;
  record: RecordDoc;
  relatedRecords: RecordDoc[];
  discrepancies: Discrepancy[];
  rule: Rule;
}): Finding[] {
  const byId = new Map<string, RecordDoc>(
    [args.record, ...args.relatedRecords].map((r) => [r.recordId, r]),
  );
  const findings: Finding[] = [];

  for (const d of args.discrepancies) {
    const meta = COMPARABLE[d.kind];
    if (!meta) continue;

    // The passage in the record being reviewed. If this discrepancy does not
    // involve the current record, there is nothing to highlight here.
    const own = d.values
      .flatMap((v) => v.facts)
      .find((f) => f.recordId === args.record.recordId);
    if (!own) continue;

    const ownValue = normalizeValue(own.value);
    const others = d.values
      .filter((v) => v.value !== ownValue)
      .flatMap((v) => v.facts.filter((f) => f.recordId !== args.record.recordId));
    if (others.length === 0) continue;

    const otherSummary = others
      .map((f) => `"${f.value}" in ${describe(byId.get(f.recordId), f)}`)
      .join("; ");

    const problem =
      `The ${meta.label} for "${d.subject}" is "${own.value}" in this record, but ` +
      `${otherSummary}.`;

    const rationale =
      `An investigator comparing these documents would find the same ${meta.label} ` +
      `recorded differently, and would treat the inconsistency as evidence that the ` +
      `risk position is not controlled across the quality system. Repeat findings of ` +
      `this kind are treated as systemic rather than isolated.`;

    const suggestion =
      `If the records agreed on one ${meta.label}, or this record stated why the ` +
      `difference is justified, the position would be defensible. Note that the correct ` +
      `value may be either one — resolving this is a judgement about the hazard, not a ` +
      `matter of copying one number over the other.`;

    const candidate = {
      confidence: "high" as const,
      harmRelevant: meta.harmRelevant,
      category: "consistency" as const,
    };
    const { severity, basis } = deriveSeverity(candidate, args.rule);

    findings.push({
      findingId: stableFindingId({
        ruleId: args.rule.ruleId,
        quote: own.value + d.kind + normalizeSubject(d.subject),
        blockId: own.blockId,
      }),
      runId: args.runId,
      recordId: args.record.recordId,
      blockId: own.blockId,
      charStart: own.charStart,
      charEnd: own.charEnd,
      category: "consistency",
      severity,
      severityBasis: basis,
      ruleId: args.rule.ruleId,
      citation: args.rule.citation,
      quote: args.record.normalizedText.slice(own.charStart, own.charEnd),
      problem,
      rationale,
      suggestion,
      // Deterministically derived from recorded values, so confidence is not a
      // guess: either the values differ or they do not.
      confidence: "high",
      status: "open",
      reviewerNote: null,
    });
  }

  return findings;
}
