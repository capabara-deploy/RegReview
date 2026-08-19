import { z } from "zod";
import { findDocIdReferences } from "./extract/text.js";
import type { RecordDoc } from "./types.js";

/**
 * The cross-document graph — deterministic core.
 *
 * Shared infrastructure for the reference map (Ben's spider map) and for
 * cumulative risk. The design principle is the team's own: maximize the
 * DETERMINISTIC share. A reference from one document to another is a document-id
 * appearing in another document's text — code can find that with no model call,
 * no temperature, and perfect repeatability, which is the same property that
 * makes the consistency pass defensible.
 *
 * Nodes are documents (records). Edges are typed and directional. The target of
 * an edge is stored AS WRITTEN (the id string the document used) and resolved to
 * a concrete record separately, so an edge to a document we do not hold is itself
 * a signal ("cites a document not in scope") rather than a dropped edge.
 */

export const EdgeKind = z.enum([
  "references",
  "governed_by",
  "supersedes",
  "modifies",
  "verifies",
  "implements",
  "escalates_to",
]);
export type EdgeKind = z.infer<typeof EdgeKind>;

export interface GraphEdge {
  edgeId: string;
  srcRecordId: string;
  /** The document id the source wrote, e.g. "FMEA-VP400". */
  dstRef: string;
  /** Resolved target record id, or null if we hold no such document. */
  dstRecordId: string | null;
  kind: EdgeKind;
  /** The line the reference appeared on, for provenance and highlighting. */
  quote: string;
  charStart: number;
  charEnd: number;
}

/** Classify an edge from the words immediately preceding the reference. */
function classifyKind(before: string): EdgeKind {
  const w = before.toLowerCase();
  if (/\bsupersed/.test(w)) return "supersedes";
  if (/\bverif/.test(w)) return "verifies";
  if (/\b(implement|satisf)/.test(w)) return "implements";
  if (/\b(modif|updat|revised|change[sd]? to|effective)\b/.test(w)) return "modifies";
  if (/\b(escalat|forwarded to|opened under|raised under)\b/.test(w)) return "escalates_to";
  if (/\b(per|under|governed by|in accordance with|conformance with|conform to|referenced? in)\b/.test(w))
    return "governed_by";
  return "references";
}

/** The line containing an offset, trimmed — used as the edge's provenance quote. */
function lineAround(text: string, index: number): { quote: string; start: number; end: number } {
  const start = text.lastIndexOf("\n", index) + 1;
  const nl = text.indexOf("\n", index);
  const end = nl === -1 ? text.length : nl;
  return { quote: text.slice(start, end).trim(), start, end };
}

/**
 * Extract reference edges from one record's text.
 *
 * `ownDocId` is excluded so a document that names itself does not edge to itself.
 * Duplicate references to the same target from the same document are collapsed to
 * the first occurrence — the edge exists once; its multiplicity is not the point.
 */
export function extractReferenceEdges(
  record: Pick<RecordDoc, "recordId" | "docId" | "normalizedText">,
): Omit<GraphEdge, "dstRecordId" | "edgeId">[] {
  const text = record.normalizedText;
  const own = record.docId?.toUpperCase();
  const seen = new Set<string>();
  const edges: Omit<GraphEdge, "dstRecordId" | "edgeId">[] = [];

  for (const ref of findDocIdReferences(text)) {
    const id = ref.id.toUpperCase();
    if (own && id === own) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const before = text.slice(Math.max(0, ref.index - 60), ref.index);
    const { quote, start, end } = lineAround(text, ref.index);
    edges.push({
      srcRecordId: record.recordId,
      dstRef: ref.id,
      kind: classifyKind(before),
      quote,
      charStart: start,
      charEnd: end,
    });
  }
  return edges;
}

export interface GraphNode {
  recordId: string;
  docId: string | null;
  filename: string;
  recordType: string;
  /** Highest-severity finding on this document, for problems-first rendering. */
  worstSeverity: "high" | "medium" | "low" | null;
  findingCount: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** dstRefs that resolved to no held document — "cites something not in scope". */
  danglingRefs: { srcRecordId: string; dstRef: string }[];
}

/**
 * Resolve raw edges against the set of documents we hold and assemble the graph.
 *
 * Resolution is a second deterministic pass: match each edge's `dstRef` to a
 * node by document id (case-insensitive). This keeps extraction O(N) — each
 * document is read once, independently — and turns "references a document we do
 * not hold" into an explicit output rather than a silently missing edge.
 */
export function assembleGraph(
  nodes: GraphNode[],
  rawEdges: Omit<GraphEdge, "dstRecordId" | "edgeId">[],
): Graph {
  const byDocId = new Map<string, string>();
  for (const n of nodes) {
    if (n.docId) byDocId.set(n.docId.toUpperCase(), n.recordId);
  }

  const edges: GraphEdge[] = [];
  const danglingRefs: Graph["danglingRefs"] = [];
  let i = 0;
  for (const e of rawEdges) {
    const dstRecordId = byDocId.get(e.dstRef.toUpperCase()) ?? null;
    if (!dstRecordId) danglingRefs.push({ srcRecordId: e.srcRecordId, dstRef: e.dstRef });
    edges.push({ ...e, edgeId: `edge-${i++}`, dstRecordId });
  }

  return { nodes, edges, danglingRefs };
}
