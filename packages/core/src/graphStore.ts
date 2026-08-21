import { CORPUS_VERSION, PROMPT_VERSION } from "./config.js";
import { getCustomerDb, type Db } from "./db/index.js";
import {
  cumulativeAssessment,
  effectiveScore,
  type Baseline,
  type Change,
} from "./changeLedger.js";
import { listBaselines, listChanges, listSubmissions } from "./changeStore.js";
import {
  assembleGraph,
  extractReferenceEdges,
  extractRefsFrom,
  laneForRecordType,
  nodeIdForChange,
  nodeIdForProposed,
  nodeIdForRecord,
  nodeIdForSubmission,
  type Graph,
  type GraphNode,
  type GraphRisk,
  type NodeRisk,
  type RawEdge,
} from "./graph.js";

/**
 * Assemble the cross-document graph from the records, changes and submissions
 * we hold.
 *
 * Edges are computed on read, not stored: extraction is a deterministic regex
 * over each document's text, cheap at the tens-of-documents scale this is built
 * for, and computing live means the graph can never drift from the documents.
 * If this ever needs to scale to thousands of documents, materialize the edges;
 * until there is a customer with that many, do not.
 *
 * The graph deliberately includes things that are not documents:
 *
 *  - every active CHANGE, in the propositions lane;
 *  - for each change with no controlled document, the document it OWES, drawn
 *    as a `proposed` node in the change-documents lane;
 *  - each SUBMISSION carrying changes.
 *
 * That is what turns the map from an inventory into a picture of the record's
 * holes. The accumulated-risk arithmetic from the change ledger rides along on
 * the nodes (`NodeRisk`) and in the header (`GraphRisk`), so the map answers
 * "where is our risk concentrated" without a second screen.
 */

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const ms = now - Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : null;
}

/** The baseline changes are currently accumulating against. */
async function currentBaseline(db: Db): Promise<Baseline | null> {
  const all = await listBaselines(db);
  if (all.length === 0) return null;
  const live = all.filter((b) => !b.supersededBy);
  return (live[0] ?? all[0]) ?? null;
}

export async function loadGraph(db: Db = getCustomerDb()): Promise<Graph> {
  const recs = (await db
    .prepare(`SELECT record_id, filename, record_type, doc_id, normalized_text FROM records`)
    .all()) as {
    record_id: string;
    filename: string;
    record_type: string;
    doc_id: string | null;
    normalized_text: string;
  }[];

  // Finding severity per record, from that record's most recent complete run —
  // so the map colours a document by the state of its latest review, not by a
  // pile-up of findings across every run it has ever had.
  const agg = (await db
    .prepare(
      `SELECT f.record_id,
              SUM(CASE WHEN f.severity = 'high'   THEN 1 ELSE 0 END) AS high,
              SUM(CASE WHEN f.severity = 'medium' THEN 1 ELSE 0 END) AS medium,
              SUM(CASE WHEN f.severity = 'low'    THEN 1 ELSE 0 END) AS low,
              COUNT(*) AS n
         FROM findings f
         JOIN (
           SELECT record_id, run_id,
                  ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY started_at DESC) AS rn
             FROM runs WHERE status = 'complete'
         ) lr ON lr.record_id = f.record_id AND lr.run_id = f.run_id AND lr.rn = 1
        GROUP BY f.record_id`,
    )
    .all()) as { record_id: string; high: number; medium: number; low: number; n: number }[];

  const aggByRecord = new Map(agg.map((a) => [a.record_id, a]));

  // Review coverage per record, for the record-level issues. A document that
  // was never reviewed, or was last reviewed under a superseded corpus, is a
  // hole in the record that nothing else in the product says out loud —
  // findings from different corpus versions are explicitly not comparable.
  const runRows = (await db
    .prepare(
      `SELECT record_id, corpus_version, prompt_version
         FROM (
           SELECT record_id, corpus_version, prompt_version,
                  ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY started_at DESC) AS rn
             FROM runs WHERE status = 'complete'
         ) r WHERE rn = 1`,
    )
    .all()) as { record_id: string; corpus_version: string | null; prompt_version: string | null }[];
  const latestRun = new Map(runRows.map((r) => [r.record_id, r]));

  const coverage = new Map<
    string,
    { reviewed: boolean; stale: boolean; corpusVersion: string | null }
  >();
  for (const r of recs) {
    const run = latestRun.get(r.record_id);
    coverage.set(r.record_id, {
      reviewed: run !== undefined,
      stale:
        run !== undefined &&
        (run.corpus_version !== CORPUS_VERSION || run.prompt_version !== PROMPT_VERSION),
      corpusVersion: run?.corpus_version ?? null,
    });
  }

  const nodes: GraphNode[] = [];
  const rawEdges: RawEdge[] = [];

  for (const r of recs) {
    const a = aggByRecord.get(r.record_id);
    const worstSeverity: GraphNode["worstSeverity"] = a
      ? a.high > 0
        ? "high"
        : a.medium > 0
          ? "medium"
          : a.low > 0
            ? "low"
            : null
      : null;
    nodes.push({
      nodeId: nodeIdForRecord(r.record_id),
      kind: "document",
      lane: laneForRecordType(r.record_type),
      recordId: r.record_id,
      changeId: null,
      docId: r.doc_id,
      label: r.doc_id ?? r.filename.replace(/\.(md|pdf|docx|txt)$/i, ""),
      sublabel: r.record_type.replace(/_/g, " "),
      worstSeverity,
      findingCount: a?.n ?? 0,
      risk: null,
    });

    rawEdges.push(
      ...extractReferenceEdges({
        recordId: r.record_id,
        docId: r.doc_id,
        normalizedText: r.normalized_text,
      }),
    );
  }

  // --- changes, the documents they owe, and the submissions carrying them ---

  const baseline = await currentBaseline(db);
  let risk: GraphRisk | null = null;

  if (baseline) {
    const changes = await listChanges(baseline.baselineId, db);
    const submissions = await listSubmissions(baseline.baselineId, db);
    const assessment = cumulativeAssessment(baseline, changes, submissions);

    const gapsByChange = new Map<string, string[]>();
    for (const g of assessment.gaps) {
      if (!gapsByChange.has(g.changeId)) gapsByChange.set(g.changeId, []);
      gapsByChange.get(g.changeId)!.push(g.kind);
    }

    const now = Date.now();
    const nodeById = new Map(nodes.map((n) => [n.nodeId, n]));
    // Cleared and superseded changes are not accumulated deviation from this
    // clearance any more; drawing them would show a record that no longer exists.
    const active = changes.filter((c) => c.stage !== "superseded" && c.stage !== "cleared");

    const riskFor = (c: Change): NodeRisk => {
      const eff = effectiveScore(c);
      const kinds = gapsByChange.get(c.changeId) ?? [];
      return {
        changeId: c.changeId,
        score: eff.value,
        scoreSource: eff.source,
        stage: c.stage,
        gapCount: kinds.length,
        gapKinds: kinds,
        daysUndocumented:
          c.stage === "implemented"
            ? daysSince(c.implementedAt ?? c.changedAt ?? c.createdAt, now)
            : null,
      };
    };

    for (const s of submissions) {
      nodes.push({
        nodeId: nodeIdForSubmission(s.submissionId),
        kind: "submission",
        lane: "submission",
        recordId: null,
        changeId: null,
        docId: s.clearanceId,
        label: s.title,
        sublabel: s.status.replace(/_/g, " "),
        worstSeverity: null,
        findingCount: 0,
        risk: null,
      });
    }

    for (const c of active) {
      const r = riskFor(c);
      const changeNodeId = nodeIdForChange(c.changeId);
      nodes.push({
        nodeId: changeNodeId,
        kind: "change",
        lane: "proposition",
        recordId: null,
        changeId: c.changeId,
        docId: null,
        label: c.proposal.length > 46 ? `${c.proposal.slice(0, 44)}…` : c.proposal,
        sublabel: c.subsystem ?? c.changeType.replace(/_/g, " "),
        worstSeverity: null,
        findingCount: 0,
        risk: r,
      });

      // A change references whatever document ids the engineer typed into it.
      // "per CA-2026-011" is a real, checkable reference and there is no reason
      // to see it only once it reaches a controlled document.
      rawEdges.push(...extractRefsFrom(changeNodeId, c.proposal));

      if (c.recordId) {
        const target = nodeIdForRecord(c.recordId);
        rawEdges.push({
          srcNodeId: changeNodeId,
          dstRef: target,
          kind: "captured_by",
          quote: "",
          charStart: 0,
          charEnd: 0,
        });
        // The accumulated risk rides onto the document that carries it, so the
        // record itself shows where unresolved change risk is concentrated.
        const doc = nodeById.get(target);
        if (doc) doc.risk = r;
      } else {
        // No controlled document: draw the one this change owes. It is not a
        // document — no id, no findings, no severity — and the edge to it is
        // deliberately unresolvable, so it renders as broken.
        const owed = nodeIdForProposed(c.changeId);
        nodes.push({
          nodeId: owed,
          kind: "proposed",
          lane: "change_doc",
          recordId: null,
          changeId: c.changeId,
          docId: null,
          label: "Document not written",
          sublabel: c.subsystem ?? c.changeType.replace(/_/g, " "),
          worstSeverity: null,
          findingCount: 0,
          risk: r,
        });
        rawEdges.push({
          srcNodeId: changeNodeId,
          dstRef: owed,
          kind: "captured_by",
          quote: "",
          charStart: 0,
          charEnd: 0,
        });
      }

      if (c.submissionId) {
        rawEdges.push({
          srcNodeId: changeNodeId,
          dstRef: nodeIdForSubmission(c.submissionId),
          kind: "submitted_in",
          quote: "",
          charStart: 0,
          charEnd: 0,
        });
      }
    }

    risk = {
      device: baseline.device,
      clearanceId: baseline.clearanceId,
      exposure: assessment.pools.exposure,
      threshold: baseline.threshold,
      thresholdSource: baseline.thresholdSource,
      crossed: assessment.escalation.crossed,
      undocumented: assessment.pools.undocumented,
      unsubmitted: assessment.pools.unsubmitted,
      owedDocuments: active.filter((c) => !c.recordId && c.stage === "implemented").length,
    };
  }

  return assembleGraph(nodes, rawEdges, risk, coverage);
}
