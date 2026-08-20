import { z } from "zod";
import { findDocIdReferences } from "./extract/text.js";
import type { ScoreSource, Stage } from "./changeLedger.js";
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
 * Edges target a document id AS WRITTEN and resolve to a concrete record in a
 * second pass, so an edge to a document we do not hold is itself a signal
 * ("cites a document not in scope") rather than a dropped edge.
 *
 * ## Changes are on the map too, and so are the documents they owe
 *
 * The map is not a picture of what a company has. It is a picture of what its
 * record should contain, which is what an investigator compares them against.
 * So a recorded change is a node, and when a change has been implemented with
 * no controlled document capturing it, the document it OWES is drawn as a
 * `proposed` node — a placeholder for a document that does not exist.
 *
 * Nothing about that is stored: a proposed node is any active change whose
 * `record_id` is null. It carries no document id, no findings and no severity,
 * because it is not a document — see `GraphNode.kind`.
 */

export const EdgeKind = z.enum([
  "references",
  "governed_by",
  "supersedes",
  "modifies",
  "verifies",
  "implements",
  "escalates_to",
  /** A change to the document that captures it, or to the one it owes. */
  "captured_by",
  /** A change to the submission carrying it. */
  "submitted_in",
]);
export type EdgeKind = z.infer<typeof EdgeKind>;

/**
 * How an edge is DRAWN. Seven kinds is more than an eye can hold in a diagram,
 * so drawing collapses them to three; the specific verb stays on the edge for
 * the detail panel, where there is room to read it.
 */
export type DrawKind = "derives" | "governs" | "broken";

export function drawKindFor(kind: EdgeKind, resolved: boolean): DrawKind {
  if (!resolved) return "broken";
  return kind === "governed_by" ? "governs" : "derives";
}

/**
 * The lane a node sits in. The map runs top to bottom through these, and edges
 * mostly connect adjacent lanes, which is what makes it read as a pathway
 * rather than a web.
 */
export const Lane = z.enum([
  /** The design history as cleared: inputs, outputs, risk file, V&V, traceability. */
  "cleared",
  /** Why a change happened: CAPAs, complaints. */
  "trigger",
  /** Changes since clearance. */
  "proposition",
  /** The documents that capture those changes — including the ones still owed. */
  "change_doc",
  /** What has been bundled and filed. */
  "submission",
]);
export type Lane = z.infer<typeof Lane>;

export const LANE_ORDER: Lane[] = [
  "cleared",
  "trigger",
  "proposition",
  "change_doc",
  "submission",
];

export const LANE_LABEL: Record<Lane, string> = {
  cleared: "Cleared record",
  trigger: "Triggers",
  proposition: "Propositions",
  change_doc: "Change documents",
  submission: "Submissions",
};

export function laneForRecordType(recordType: string): Lane {
  if (recordType === "capa" || recordType === "complaint") return "trigger";
  if (recordType === "change_package") return "change_doc";
  return "cleared";
}

export interface GraphEdge {
  edgeId: string;
  srcNodeId: string;
  /** The document id the source wrote, e.g. "FMEA-VP400". */
  dstRef: string;
  /** Resolved target node id, or null if nothing we hold matches. */
  dstNodeId: string | null;
  kind: EdgeKind;
  drawKind: DrawKind;
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
export type RawEdge = Omit<GraphEdge, "dstNodeId" | "edgeId" | "drawKind">;

export function extractReferenceEdges(
  record: Pick<RecordDoc, "recordId" | "docId" | "normalizedText">,
): RawEdge[] {
  return extractRefsFrom(nodeIdForRecord(record.recordId), record.normalizedText, record.docId);
}

/**
 * Pull document-id references out of any text, from any node.
 *
 * Shared by documents and by change proposals. An engineer who types "per
 * CA-2026-011" into a change has made a real, checkable reference, and there is
 * no reason the map should see it only when it reaches a controlled document.
 */
export function extractRefsFrom(
  srcNodeId: string,
  text: string,
  ownDocId: string | null = null,
): RawEdge[] {
  const own = ownDocId?.toUpperCase();
  const seen = new Set<string>();
  const edges: RawEdge[] = [];

  for (const ref of findDocIdReferences(text)) {
    const id = ref.id.toUpperCase();
    if (own && id === own) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const before = text.slice(Math.max(0, ref.index - 60), ref.index);
    const { quote, start, end } = lineAround(text, ref.index);
    edges.push({
      srcNodeId,
      dstRef: ref.id,
      kind: classifyKind(before),
      quote,
      charStart: start,
      charEnd: end,
    });
  }
  return edges;
}

/** Node id namespaces. Documents, changes and owed documents share one space. */
export const nodeIdForRecord = (recordId: string) => `rec:${recordId}`;
export const nodeIdForChange = (changeId: string) => `chg:${changeId}`;
export const nodeIdForProposed = (changeId: string) => `owed:${changeId}`;
export const nodeIdForSubmission = (submissionId: string) => `sub:${submissionId}`;

export const NodeKind = z.enum([
  /** A document we hold. */
  "document",
  /** A recorded change. */
  "change",
  /** A document a change owes and has not produced. Not a document. */
  "proposed",
  /** A regulatory submission. */
  "submission",
]);
export type NodeKind = z.infer<typeof NodeKind>;

/**
 * The accumulated-risk state riding on a node.
 *
 * Present on change nodes, on the documents that capture them, and on owed
 * documents. This is what puts the change ledger's arithmetic onto the map:
 * a reviewer looking at the record can see which parts of it carry unresolved
 * risk without opening another tab.
 *
 * `gapKinds` are the ledger's own deterministic gap kinds (wrong comparator,
 * no aggregate assessment, undocumented and aging, and the scoring gaps).
 */
export interface NodeRisk {
  changeId: string;
  score: number;
  scoreSource: ScoreSource;
  stage: Stage;
  gapCount: number;
  gapKinds: string[];
  /** Days implemented without a controlled document, when that applies. */
  daysUndocumented: number | null;
}

export interface GraphNode {
  nodeId: string;
  kind: NodeKind;
  lane: Lane;
  /** Set for documents; null for changes, owed documents and submissions. */
  recordId: string | null;
  /** Set for changes and owed documents. */
  changeId: string | null;
  /** Never set on an owed document — it has no identity yet, by definition. */
  docId: string | null;
  label: string;
  sublabel: string;
  /** Highest-severity finding on this document, for problems-first rendering. */
  worstSeverity: "high" | "medium" | "low" | null;
  findingCount: number;
  risk: NodeRisk | null;
}

/** Ledger-level accumulated risk, for the map's header. */
export interface GraphRisk {
  device: string;
  clearanceId: string;
  exposure: number;
  threshold: number;
  thresholdSource: string | null;
  crossed: boolean;
  undocumented: number;
  unsubmitted: number;
  /** Changes implemented with no controlled document — the owed documents. */
  owedDocuments: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** dstRefs that resolved to nothing we hold — "cites something not in scope". */
  danglingRefs: { srcNodeId: string; dstRef: string }[];
  risk: GraphRisk | null;
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
  rawEdges: RawEdge[],
  risk: GraphRisk | null = null,
): Graph {
  // Only documents can be the target of a written reference — a change and an
  // owed document have no id anyone could have cited.
  const byDocId = new Map<string, string>();
  for (const n of nodes) {
    if (n.kind === "document" && n.docId) byDocId.set(n.docId.toUpperCase(), n.nodeId);
  }
  // Structural edges (change → its document, change → its submission) already
  // name their target node directly; they are not resolved by document id.
  const nodeIds = new Set(nodes.map((n) => n.nodeId));

  const edges: GraphEdge[] = [];
  const danglingRefs: Graph["danglingRefs"] = [];
  let i = 0;
  for (const e of rawEdges) {
    const direct = nodeIds.has(e.dstRef) ? e.dstRef : null;
    const dstNodeId = direct ?? byDocId.get(e.dstRef.toUpperCase()) ?? null;
    if (!dstNodeId) danglingRefs.push({ srcNodeId: e.srcNodeId, dstRef: e.dstRef });
    edges.push({
      ...e,
      edgeId: `edge-${i++}`,
      dstNodeId,
      drawKind: drawKindFor(e.kind, dstNodeId !== null),
    });
  }

  return { nodes, edges, danglingRefs, risk };
}
