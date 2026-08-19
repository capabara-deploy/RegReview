import { useEffect, useMemo, useState } from "react";
import { api, AuthError, type Graph, type GraphEdge, type GraphNode } from "./api";

/**
 * The cross-document reference map (Ben's spider map).
 *
 * A deliberately dependency-free SVG. The value is not the picture but what it
 * makes legible: which documents reference which, laid out by document class so
 * the design-history flow reads left-to-right, and each document coloured by the
 * severity of its latest review so problems are visible at a glance. Selecting a
 * node isolates its edges — the honest way to read a dense graph.
 *
 * Deterministic layout, computed here: columns by record type, nodes stacked
 * within a column. No force simulation, so the same corpus always draws the same
 * map — the same property the rest of the pipeline is built on.
 */

const COLUMN_ORDER = [
  "design_input",
  "design_output",
  "design_review",
  "verification",
  "validation",
  "traceability_matrix",
  "risk_analysis",
  "complaint",
  "capa",
  "change_package",
  "unknown",
];

const COL_W = 190;
const NODE_W = 150;
const NODE_H = 40;
const ROW_H = 58;
const PAD_Y = 40;

const SEV_FILL: Record<string, string> = {
  high: "#f8d7da",
  medium: "#fff3cd",
  low: "#e7f1dd",
};
const SEV_STROKE: Record<string, string> = {
  high: "#c0392b",
  medium: "#d18b12",
  low: "#5a8a3c",
};

interface Positioned extends GraphNode {
  x: number;
  y: number;
}

export function GraphMap({ onAuthError }: { onAuthError: () => void }) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setGraph(await api.graph());
      } catch (e) {
        if (e instanceof AuthError) return onAuthError();
        setError((e as Error).message);
      }
    })();
  }, [onAuthError]);

  const layout = useMemo(() => {
    if (!graph) return null;
    const columns = new Map<string, GraphNode[]>();
    for (const n of graph.nodes) {
      const key = COLUMN_ORDER.includes(n.recordType) ? n.recordType : "unknown";
      if (!columns.has(key)) columns.set(key, []);
      columns.get(key)!.push(n);
    }
    const positioned = new Map<string, Positioned>();
    let colIndex = 0;
    let maxRows = 0;
    for (const type of COLUMN_ORDER) {
      const col = columns.get(type);
      if (!col || col.length === 0) continue;
      col.sort((a, b) => (a.docId ?? a.filename).localeCompare(b.docId ?? b.filename));
      col.forEach((n, row) => {
        positioned.set(n.recordId, {
          ...n,
          x: colIndex * COL_W + 30,
          y: PAD_Y + row * ROW_H,
        });
      });
      maxRows = Math.max(maxRows, col.length);
      colIndex++;
    }
    const width = colIndex * COL_W + 60;
    const height = PAD_Y * 2 + maxRows * ROW_H;
    return { positioned, width, height, columns: colIndex };
  }, [graph]);

  if (error) return <div className="error">{error}</div>;
  if (!graph || !layout) return <div className="empty-state muted">Loading map…</div>;
  if (graph.nodes.length === 0) {
    return (
      <div className="empty-state">
        <p className="muted">
          No documents yet. Upload documents from the <strong>Run a review</strong> tab; the
          map draws the references between them.
        </p>
      </div>
    );
  }

  const connected = new Set<string>();
  if (selected) {
    for (const e of graph.edges) {
      if (e.srcRecordId === selected) e.dstRecordId && connected.add(e.dstRecordId);
      if (e.dstRecordId === selected) connected.add(e.srcRecordId);
    }
  }

  const isDim = (recordId: string): boolean =>
    selected !== null && recordId !== selected && !connected.has(recordId);

  const edgeVisible = (e: GraphEdge): boolean =>
    !selected || e.srcRecordId === selected || e.dstRecordId === selected;

  const center = (n: Positioned) => ({ x: n.x + NODE_W / 2, y: n.y + NODE_H / 2 });

  const selectedNode = selected ? layout.positioned.get(selected) : null;
  const selectedEdges = selected
    ? graph.edges.filter((e) => e.srcRecordId === selected || e.dstRecordId === selected)
    : [];
  const idFor = (recordId: string | null) =>
    recordId ? layout.positioned.get(recordId)?.docId ?? layout.positioned.get(recordId)?.filename ?? "?" : "?";

  return (
    <div className="graphmap">
      <div className="graphmap-bar">
        <span className="muted">
          {graph.nodes.length} documents · {graph.edges.length} references
          {graph.danglingRefs.length > 0 && ` · ${graph.danglingRefs.length} cite a document not in scope`}
        </span>
        {selected && (
          <button className="secondary" onClick={() => setSelected(null)}>
            Clear selection
          </button>
        )}
      </div>

      <div className="graphmap-scroll">
        <svg width={layout.width} height={layout.height} className="graphmap-svg">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#aab" />
            </marker>
          </defs>

          {graph.edges.map((e) => {
            if (!e.dstRecordId) return null;
            const a = layout.positioned.get(e.srcRecordId);
            const b = layout.positioned.get(e.dstRecordId);
            if (!a || !b) return null;
            const p1 = center(a);
            const p2 = center(b);
            const mx = (p1.x + p2.x) / 2;
            return (
              <path
                key={e.edgeId}
                d={`M ${p1.x} ${p1.y} C ${mx} ${p1.y}, ${mx} ${p2.y}, ${p2.x} ${p2.y}`}
                fill="none"
                stroke={edgeVisible(e) ? "#8895aa" : "#e6e9ef"}
                strokeWidth={edgeVisible(e) && selected ? 1.6 : 1}
                markerEnd="url(#arrow)"
                opacity={edgeVisible(e) ? 0.85 : 0.25}
              />
            );
          })}

          {[...layout.positioned.values()].map((n) => {
            const fill = n.worstSeverity ? SEV_FILL[n.worstSeverity] : "#f2f4f7";
            const stroke = n.worstSeverity ? SEV_STROKE[n.worstSeverity] : "#c4cad4";
            return (
              <g
                key={n.recordId}
                transform={`translate(${n.x},${n.y})`}
                opacity={isDim(n.recordId) ? 0.28 : 1}
                onClick={() => setSelected(n.recordId === selected ? null : n.recordId)}
                style={{ cursor: "pointer" }}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={7}
                  fill={fill}
                  stroke={n.recordId === selected ? "#2b6cb0" : stroke}
                  strokeWidth={n.recordId === selected ? 2.5 : 1.2}
                />
                <text x={NODE_W / 2} y={17} textAnchor="middle" className="gm-label">
                  {n.docId ?? n.filename.replace(/\.(md|pdf|docx)$/, "")}
                </text>
                <text x={NODE_W / 2} y={31} textAnchor="middle" className="gm-sub">
                  {n.recordType.replace(/_/g, " ")}
                  {n.findingCount > 0 ? ` · ${n.findingCount}` : ""}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {selectedNode && (
        <aside className="graphmap-panel">
          <h3>{selectedNode.docId ?? selectedNode.filename}</h3>
          <div className="muted">
            {selectedNode.recordType.replace(/_/g, " ")}
            {selectedNode.findingCount > 0 && ` · ${selectedNode.findingCount} finding(s)`}
          </div>
          <ul className="gm-edges">
            {selectedEdges.map((e) => (
              <li key={e.edgeId}>
                {e.srcRecordId === selected ? (
                  <>
                    <span className="gm-kind">{e.kind.replace(/_/g, " ")}</span> →{" "}
                    {e.dstRecordId ? idFor(e.dstRecordId) : <em>{e.dstRef} (not in scope)</em>}
                  </>
                ) : (
                  <>
                    {idFor(e.srcRecordId)} <span className="gm-kind">{e.kind.replace(/_/g, " ")}</span> → this
                  </>
                )}
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
