import { useEffect, useMemo, useState } from "react";
import {
  api,
  AuthError,
  LANE_LABEL,
  LANE_ORDER,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type Lane,
} from "./api";

/**
 * The document map.
 *
 * Not an inventory of what a company has — a picture of what its record should
 * contain, which is what an investigator compares them against. So it draws
 * three things that are not documents:
 *
 *  - every active CHANGE, in the propositions lane;
 *  - for each change with no controlled document, the document it OWES, drawn
 *    dashed and labelled as not written;
 *  - the accumulated risk riding on each of them.
 *
 * Three deliberate constraints:
 *
 * **Lanes, not a blob.** Every node has a lane from its role and the flow runs
 * top to bottom through them. Edges mostly connect adjacent lanes, which is
 * what makes this read as a pathway rather than a web.
 *
 * **Deterministic layout.** Lane by role, order within lane by label. No force
 * simulation, so the same corpus always draws the same map. A picture that
 * rearranges itself on every load cannot go into an audit response, and it
 * would quietly contradict the repeat-run consistency the rest of the pipeline
 * is built on.
 *
 * **Three line kinds, not seven.** `drawKind` collapses the edge vocabulary for
 * drawing; the specific verb stays on the edge and is shown in the panel, where
 * there is room to read it.
 */

const NODE_W = 168;
const NODE_H = 46;
const COL_GAP = 18;
const LANE_GAP = 46;
/** Wide enough for the longest lane name ("Change documents", ~135px). */
const LANE_LABEL_W = 152;
const PAD = 24;

const SEV_FILL: Record<string, string> = {
  high: "#fdeaea",
  medium: "#fdf4e0",
  low: "#eaf1e6",
};
const SEV_STROKE: Record<string, string> = {
  high: "#c0392b",
  medium: "#b8860b",
  low: "#5a8a3c",
};

/** Kind decides the shape; severity only ever tints a real document. */
const KIND_FILL: Record<string, string> = {
  document: "#f4f5f7",
  change: "#e8eef7",
  proposed: "#fbfbfa",
  submission: "#e6f0ea",
};
const KIND_STROKE: Record<string, string> = {
  document: "#c4cad4",
  change: "#4a6fa5",
  proposed: "#c0392b",
  submission: "#2e7d5b",
};

const EDGE_STROKE: Record<string, string> = {
  derives: "#8895aa",
  governs: "#a8adb8",
  broken: "#c0392b",
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
    const byLane = new Map<Lane, GraphNode[]>();
    for (const n of graph.nodes) {
      if (!byLane.has(n.lane)) byLane.set(n.lane, []);
      byLane.get(n.lane)!.push(n);
    }

    const positioned = new Map<string, Positioned>();
    const lanes: { lane: Lane; y: number; h: number; count: number }[] = [];
    // Widest lane decides the canvas; every lane wraps at that column count so
    // the picture stays rectangular instead of one lane running off the side.
    const widest = Math.max(1, ...[...byLane.values()].map((v) => v.length));
    const perRow = Math.min(widest, 6);
    let y = PAD;

    for (const lane of LANE_ORDER) {
      const items = byLane.get(lane);
      if (!items || items.length === 0) continue;
      items.sort((a, b) => a.label.localeCompare(b.label));
      const rows = Math.ceil(items.length / perRow);
      items.forEach((n, i) => {
        const col = i % perRow;
        const row = Math.floor(i / perRow);
        positioned.set(n.nodeId, {
          ...n,
          x: PAD + LANE_LABEL_W + col * (NODE_W + COL_GAP),
          y: y + row * (NODE_H + 12),
        });
      });
      const h = rows * (NODE_H + 12) - 12;
      lanes.push({ lane, y, h, count: items.length });
      y += h + LANE_GAP;
    }

    return {
      positioned,
      lanes,
      width: PAD * 2 + LANE_LABEL_W + perRow * (NODE_W + COL_GAP),
      height: y - LANE_GAP + PAD,
    };
  }, [graph]);

  if (error) return <div className="error">{error}</div>;
  if (!graph || !layout) return <div className="empty-state muted">Loading map…</div>;
  if (graph.nodes.length === 0) {
    return (
      <div className="empty-state">
        <p className="muted">
          Nothing to map yet. Upload documents from <strong>Run a review</strong>, or record a
          change in <strong>Changes</strong> — the map draws both, and the documents your
          changes still owe.
        </p>
      </div>
    );
  }

  const connected = new Set<string>();
  if (selected) {
    for (const e of graph.edges) {
      if (e.srcNodeId === selected && e.dstNodeId) connected.add(e.dstNodeId);
      if (e.dstNodeId === selected) connected.add(e.srcNodeId);
    }
  }

  const isDim = (nodeId: string): boolean =>
    selected !== null && nodeId !== selected && !connected.has(nodeId);
  const edgeVisible = (e: GraphEdge): boolean =>
    !selected || e.srcNodeId === selected || e.dstNodeId === selected;

  const center = (n: Positioned) => ({ x: n.x + NODE_W / 2, y: n.y + NODE_H / 2 });
  const selectedNode = selected ? layout.positioned.get(selected) : null;
  const selectedEdges = selected
    ? graph.edges.filter((e) => e.srcNodeId === selected || e.dstNodeId === selected)
    : [];
  const labelFor = (nodeId: string | null) =>
    nodeId ? (layout.positioned.get(nodeId)?.label ?? "?") : "?";

  const risk = graph.risk;

  return (
    <div className="graphmap">
      <div className="graphmap-bar">
        <span className="muted">
          {graph.nodes.filter((n) => n.kind === "document").length} documents ·{" "}
          {graph.edges.filter((e) => e.dstNodeId).length} references
          {graph.danglingRefs.length > 0 && (
            <> · <strong className="gm-broken">{graph.danglingRefs.length} broken</strong></>
          )}
          {risk && risk.owedDocuments > 0 && (
            <> · <strong className="gm-broken">{risk.owedDocuments} document(s) owed</strong></>
          )}
        </span>
        {selected && (
          <button className="secondary" onClick={() => setSelected(null)}>
            Clear selection
          </button>
        )}
      </div>

      {/* Accumulated risk, from the change ledger, on the map it belongs to.
          Reports the customer's own threshold — never a submission verdict. */}
      {risk && (
        <div className={`gm-risk ${risk.crossed ? "crossed" : ""}`}>
          <span className="gm-risk-num">{risk.exposure}</span>
          <span className="muted">
            of {risk.threshold} accumulated risk since {risk.clearanceId}
            {risk.thresholdSource ? ` (${risk.thresholdSource})` : ""} ·{" "}
            {risk.undocumented} undocumented · {risk.unsubmitted} documented, not filed
          </span>
        </div>
      )}

      <div className="graphmap-scroll">
        <svg width={layout.width} height={layout.height} className="graphmap-svg">
          <defs>
            <marker id="gm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>

          {layout.lanes.map((l) => (
            <g key={l.lane}>
              <rect
                x={PAD}
                y={l.y - 8}
                width={layout.width - PAD * 2}
                height={l.h + 16}
                rx={8}
                fill={l.lane === "proposition" ? "#f7f9fc" : "#fafaf8"}
                stroke="#eceae4"
              />
              <text x={PAD + 12} y={l.y + 16} className="gm-lane">
                {LANE_LABEL[l.lane]}
              </text>
              <text x={PAD + 12} y={l.y + 32} className="gm-sub">
                {l.count}
              </text>
            </g>
          ))}

          {graph.edges.map((e) => {
            const a = layout.positioned.get(e.srcNodeId);
            const b = e.dstNodeId ? layout.positioned.get(e.dstNodeId) : null;
            if (!a || !b) return null;
            const p1 = center(a);
            const p2 = center(b);
            const stroke = EDGE_STROKE[e.drawKind] ?? "#8895aa";
            // Two nodes on the same row share a y, so a centre-to-centre curve
            // degenerates to a straight horizontal line that runs through every
            // node between them. Bow those under the row instead. Most edges in
            // the cleared lane are same-row (documents citing procedures), so
            // without this the busiest lane is also the least readable one.
            const sameRow = Math.abs(a.y - b.y) < 4;
            const d = sameRow
              ? `M ${p1.x} ${a.y + NODE_H} C ${p1.x} ${a.y + NODE_H + 26}, ${p2.x} ${b.y + NODE_H + 26}, ${p2.x} ${b.y + NODE_H}`
              : `M ${p1.x} ${p1.y} C ${p1.x} ${(p1.y + p2.y) / 2}, ${p2.x} ${(p1.y + p2.y) / 2}, ${p2.x} ${p2.y}`;
            return (
              <path
                key={e.edgeId}
                d={d}
                fill="none"
                stroke={edgeVisible(e) ? stroke : "#e6e9ef"}
                strokeWidth={edgeVisible(e) && selected ? 1.8 : 1}
                strokeDasharray={e.drawKind === "governs" ? "3 3" : undefined}
                markerEnd="url(#gm-arrow)"
                opacity={edgeVisible(e) ? 0.8 : 0.2}
              />
            );
          })}

          {[...layout.positioned.values()].map((n) => {
            const ghost = n.kind === "proposed";
            // Severity tints documents only. A change or an owed document has no
            // findings and must never look like it does.
            const fill =
              n.kind === "document" && n.worstSeverity
                ? SEV_FILL[n.worstSeverity]!
                : KIND_FILL[n.kind]!;
            const stroke =
              n.kind === "document" && n.worstSeverity
                ? SEV_STROKE[n.worstSeverity]!
                : KIND_STROKE[n.kind]!;
            return (
              <g
                key={n.nodeId}
                transform={`translate(${n.x},${n.y})`}
                opacity={isDim(n.nodeId) ? 0.25 : 1}
                onClick={() => setSelected(n.nodeId === selected ? null : n.nodeId)}
                style={{ cursor: "pointer" }}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill={fill}
                  fillOpacity={ghost ? 0.5 : 1}
                  stroke={n.nodeId === selected ? "#2d5f8a" : stroke}
                  strokeWidth={n.nodeId === selected ? 2.4 : 1.2}
                  strokeDasharray={ghost ? "5 4" : undefined}
                />
                <text x={10} y={19} className="gm-label">
                  {n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label}
                </text>
                <text x={10} y={34} className="gm-sub">
                  {n.sublabel.length > 26 ? `${n.sublabel.slice(0, 25)}…` : n.sublabel}
                </text>
                {/* Risk badge: the change ledger's score, on the map. */}
                {n.risk && (
                  <g transform={`translate(${NODE_W - 34},8)`}>
                    <rect width={26} height={16} rx={3} fill="#fff" stroke={stroke} strokeWidth={1} />
                    <text x={13} y={12} textAnchor="middle" className="gm-risk-badge">
                      {n.risk.score}
                    </text>
                  </g>
                )}
                {n.risk && n.risk.gapCount > 0 && (
                  <text x={NODE_W - 8} y={38} textAnchor="end" className="gm-gapcount">
                    ▲ {n.risk.gapCount}
                  </text>
                )}
                {n.kind === "document" && n.findingCount > 0 && (
                  <text x={NODE_W - 8} y={19} textAnchor="end" className="gm-sub">
                    {n.findingCount}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {selectedNode && (
        <aside className="graphmap-panel">
          <h3>{selectedNode.label}</h3>
          <div className="muted">
            {selectedNode.sublabel}
            {selectedNode.kind === "document" && selectedNode.findingCount > 0 &&
              ` · ${selectedNode.findingCount} finding(s)`}
          </div>

          {selectedNode.kind === "proposed" && (
            <p className="gm-owed">
              No controlled document captures this change. It is drawn here because the
              record owes one — this is a placeholder, not a document.
            </p>
          )}

          {selectedNode.risk && (
            <div className="gm-risk-detail">
              <div>
                Risk <strong>{selectedNode.risk.score}</strong> · {selectedNode.risk.stage.replace(/_/g, " ")}
                {selectedNode.risk.scoreSource !== "confirmed" &&
                  selectedNode.risk.scoreSource !== "confirmed_below_floor" && (
                    <span className="gm-unconfirmed"> · unconfirmed</span>
                  )}
              </div>
              {selectedNode.risk.daysUndocumented !== null && (
                <div className="muted">
                  {selectedNode.risk.daysUndocumented} days implemented without a document
                </div>
              )}
              {selectedNode.risk.gapKinds.length > 0 && (
                <ul className="gm-gaps">
                  {selectedNode.risk.gapKinds.map((k, i) => (
                    <li key={i}>{k.replace(/_/g, " ")}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <ul className="gm-edges">
            {selectedEdges.map((e) => (
              <li key={e.edgeId}>
                {e.srcNodeId === selected ? (
                  <>
                    <span className="gm-kind">{e.kind.replace(/_/g, " ")}</span> →{" "}
                    {e.dstNodeId ? labelFor(e.dstNodeId) : <em>{e.dstRef} (not held)</em>}
                  </>
                ) : (
                  <>
                    {labelFor(e.srcNodeId)} <span className="gm-kind">{e.kind.replace(/_/g, " ")}</span> → this
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
