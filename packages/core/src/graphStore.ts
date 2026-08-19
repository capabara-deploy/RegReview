import { getCustomerDb, type Db } from "./db/index.js";
import {
  assembleGraph,
  extractReferenceEdges,
  type Graph,
  type GraphEdge,
  type GraphNode,
} from "./graph.js";

/**
 * Assemble the cross-document graph from the records we hold.
 *
 * Edges are computed on read, not stored: extraction is a deterministic regex
 * over each document's text, cheap at the tens-of-documents scale this is built
 * for, and computing live means the graph can never drift from the documents.
 * If this ever needs to scale to thousands of documents, materialize the edges;
 * until there is a customer with that many, do not.
 */
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

  const nodes: GraphNode[] = [];
  const rawEdges: Omit<GraphEdge, "dstRecordId" | "edgeId">[] = [];

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
      recordId: r.record_id,
      docId: r.doc_id,
      filename: r.filename,
      recordType: r.record_type,
      worstSeverity,
      findingCount: a?.n ?? 0,
    });

    rawEdges.push(
      ...extractReferenceEdges({
        recordId: r.record_id,
        docId: r.doc_id,
        normalizedText: r.normalized_text,
      }),
    );
  }

  return assembleGraph(nodes, rawEdges);
}
