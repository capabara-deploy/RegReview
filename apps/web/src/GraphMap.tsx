import { useEffect, useMemo, useState } from "react";
import {
  api,
  AuthError,
  GRAPH_ISSUE_LABEL,
  LANE_LABEL,
  LANE_ORDER,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type GraphIssue,
  type GraphIssueKind,
  type Lane,
} from "./api";
import type { Page } from "./routes";

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

/**
 * Radial geometry.
 *
 * Three rings: the cleared device at the centre, one hub per lane, and every
 * document, change and owed document on the outer ring. Angles come from lane
 * order and a stable sort, never from a simulation, so the same corpus always
 * draws the same picture — the property that lets a screenshot of this go into
 * an audit response.
 */
const CENTER_R = 62;
const LANE_R = 36;
const LANE_DIST = 186;
const LEAF_R = 17;
const LEAF_DIST = 344;
const LABEL_GAP = 8;
/** Room outside the outer ring for leaf labels, which sit beside their node. */
const MARGIN = 168;

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
  document: "#eef1f5",
  change: "#dbe7f5",
  proposed: "#fdf2f1",
  submission: "#e2f0e9",
};
const KIND_STROKE: Record<string, string> = {
  document: "#b9c0cc",
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
  /** Angle from the centre, for placing the label on the outward side. */
  angle: number;
}

interface Hub {
  lane: Lane;
  x: number;
  y: number;
  count: number;
}

export function GraphMap({
  target,
  onNavigate,
  onAuthError,
}: {
  /** Node id from the address bar, so a map link opens with that node open. */
  target: string | null;
  onNavigate: (page: Page, target?: string | null) => void;
  onAuthError: () => void;
}) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(target);
  const [showIssues, setShowIssues] = useState(false);

  // A link into the map names a node; follow it when the address changes.
  useEffect(() => setSelected(target), [target]);

  // Selecting a node puts it in the address bar, so the view a reviewer is
  // looking at is always the one a colleague gets from the same URL.
  const select = (nodeId: string | null) => {
    setSelected(nodeId);
    onNavigate("map", nodeId);
  };

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
    const lanes = LANE_ORDER.filter((l) => (byLane.get(l)?.length ?? 0) > 0);
    const total = lanes.reduce((t, l) => t + byLane.get(l)!.length, 0) || 1;

    const size = (LEAF_DIST + LEAF_R + MARGIN) * 2;
    const cx = size / 2;
    const cy = size / 2;

    // Each lane gets an arc proportional to how many nodes it holds, with a
    // floor so a one-node lane is still a readable wedge rather than a sliver.
    const TAU = Math.PI * 2;
    const MIN_SECTOR = TAU * 0.09;
    let sectors = lanes.map((l) => Math.max((byLane.get(l)!.length / total) * TAU, MIN_SECTOR));
    const norm = TAU / sectors.reduce((a, b) => a + b, 0);
    sectors = sectors.map((r) => r * norm);

    const positioned = new Map<string, Positioned>();
    const hubs: Hub[] = [];
    let a = -Math.PI / 2; // start at the top and read clockwise, in pipeline order

    lanes.forEach((lane, li) => {
      const sector = sectors[li]!;
      const items = byLane.get(lane)!.slice().sort((x, y) => x.label.localeCompare(y.label));
      const mid = a + sector / 2;
      hubs.push({
        lane,
        x: cx + Math.cos(mid) * LANE_DIST,
        y: cy + Math.sin(mid) * LANE_DIST,
        count: items.length,
      });

      // Inset the leaves from the sector edges so neighbouring lanes' outer
      // nodes do not collide where two wedges meet.
      const inset = Math.min(sector * 0.14, 0.14);
      const from = a + inset;
      const to = a + sector - inset;
      items.forEach((n, i) => {
        const t = items.length === 1 ? 0.5 : i / (items.length - 1);
        const ang = from + (to - from) * t;
        positioned.set(n.nodeId, {
          ...n,
          x: cx + Math.cos(ang) * LEAF_DIST,
          y: cy + Math.sin(ang) * LEAF_DIST,
          angle: ang,
        });
      });
      a += sector;
    });

    return { positioned, hubs, cx, cy, size };
  }, [graph]);

  if (error) return <div className="error">{error}</div>;
  if (!graph || !layout) return <div className="empty-state muted">Loading map…</div>;

  /**
   * An API running older code than this tab returns the previous graph shape —
   * nodes keyed by `recordId` with no `nodeId`, no `lane`, and no `issues` — and
   * every surface below reads fields that are then undefined. The tsx dev server
   * does not reload server code, so this is the single most likely way this
   * screen breaks; say which thing to restart rather than rendering an empty
   * canvas or throwing.
   */
  if (graph.nodes.length > 0 && graph.nodes[0]?.nodeId === undefined) {
    return (
      <div className="error">
        This API is running an older build: it returned documents without lanes or
        node ids, which this map cannot draw. Restart the API server — the tsx dev
        server does not reload server code on edit (<code>npm run dev:server</code>).
      </div>
    );
  }

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

  const selectedNode = selected ? layout.positioned.get(selected) : null;
  const selectedEdges = selected
    ? graph.edges.filter((e) => e.srcNodeId === selected || e.dstNodeId === selected)
    : [];
  const labelFor = (nodeId: string | null) =>
    nodeId ? (layout.positioned.get(nodeId)?.label ?? "?") : "?";

  const risk = graph.risk;

  // Ordered by what a reviewer should deal with first: a document that does not
  // exist outranks one that merely has not been read again lately.
  const issueOrder: GraphIssueKind[] = [
    "owed_document",
    "broken_reference",
    "orphan",
    "unreviewed",
    "stale_review",
  ];
  // Tolerate an API that predates record-level issues: an absent list means
  // "none reported", which degrades the panel rather than the whole map.
  const issues: GraphIssue[] = graph.issues ?? [];
  const byKind = new Map<GraphIssueKind, GraphIssue[]>();
  for (const i of issues) {
    if (!byKind.has(i.kind)) byKind.set(i.kind, []);
    byKind.get(i.kind)!.push(i);
  }

  return (
    <div className="graphmap">
      <div className="graphmap-bar">
        <span className="muted">
          {graph.nodes.filter((n) => n.kind === "document").length} documents ·{" "}
          {graph.edges.filter((e) => e.dstNodeId).length} references
          {(graph.danglingRefs?.length ?? 0) > 0 && (
            <> · <strong className="gm-broken">{graph.danglingRefs!.length} broken</strong></>
          )}
          {risk && risk.owedDocuments > 0 && (
            <> · <strong className="gm-broken">{risk.owedDocuments} document(s) owed</strong></>
          )}
        </span>
        {/* References are hidden until a node is selected, so say so — otherwise
            the map looks like it has forgotten the 66 edges it just counted. */}
        {selected ? (
          <button className="secondary" onClick={() => select(null)}>
            Clear selection
          </button>
        ) : (
          <span className="muted gm-hint">Select a node to trace its references</span>
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

      {/* Problems with the RECORD, not inside a document: broken references,
          documents a change owes, orphans, and gaps in review coverage. All
          deterministic, none carrying a severity tier — they are not findings. */}
      {issues.length > 0 && (
        <div className="gm-issues">
          <button className="gm-issues-toggle" onClick={() => setShowIssues((v) => !v)}>
            <span className="rc-chevron">{showIssues ? "▾" : "▸"}</span>
            <span className="gm-issues-count">
              {issues.length} issue{issues.length === 1 ? "" : "s"} with the record
            </span>
            <span className="gm-issues-sum">
              {issueOrder
                .filter((k) => byKind.get(k)?.length)
                .map((k) => `${byKind.get(k)!.length} ${GRAPH_ISSUE_LABEL[k].toLowerCase()}`)
                .join(" · ")}
            </span>
          </button>
          {showIssues && (
            <div className="gm-issue-list">
              {issueOrder.map((kind) => {
                const rows = byKind.get(kind);
                if (!rows || rows.length === 0) return null;
                return (
                  <div key={kind} className="gm-issue-group">
                    <div className="gm-issue-kind">
                      {GRAPH_ISSUE_LABEL[kind]} <span className="muted">({rows.length})</span>
                    </div>
                    {rows.map((i, n) => (
                      <button
                        key={`${i.nodeId}-${n}`}
                        className="gm-issue-row"
                        onClick={() => select(i.nodeId)}
                        title={i.detail}
                      >
                        <span className="gm-issue-label">{i.label}</span>
                        <span className="gm-issue-detail">{i.detail}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="graphmap-scroll">
        <svg
          width={layout.size}
          height={layout.size}
          viewBox={`0 0 ${layout.size} ${layout.size}`}
          className="graphmap-svg"
        >
          {/* Spokes: centre to each lane hub, hub to each of its nodes. These
              are the structure of the record, drawn always. */}
          {layout.hubs.map((h) => (
            <line
              key={`spoke-${h.lane}`}
              x1={layout.cx}
              y1={layout.cy}
              x2={h.x}
              y2={h.y}
              stroke="#c9cdd6"
              strokeWidth={1.4}
            />
          ))}

          {[...layout.positioned.values()].map((n) => {
            const h = layout.hubs.find((x) => x.lane === n.lane);
            if (!h) return null;
            return (
              <line
                key={`twig-${n.nodeId}`}
                x1={h.x}
                y1={h.y}
                x2={n.x}
                y2={n.y}
                stroke="#d5d9e0"
                strokeWidth={1}
                opacity={isDim(n.nodeId) ? 0.25 : 1}
              />
            );
          })}

          {/* Actual references, only for the selected node.
              Drawing all 66 at once turns the picture into a hairball and hides
              the structure the rings exist to show; on selection they are the
              most useful thing on screen. Curved through the centre so a chord
              across the circle reads as a relationship, not as a spoke. */}
          {selected &&
            graph.edges.map((e) => {
              if (e.srcNodeId !== selected && e.dstNodeId !== selected) return null;
              const a = layout.positioned.get(e.srcNodeId);
              const b = e.dstNodeId ? layout.positioned.get(e.dstNodeId) : null;
              if (!a || !b) return null;
              return (
                <path
                  key={e.edgeId}
                  d={`M ${a.x} ${a.y} Q ${layout.cx} ${layout.cy} ${b.x} ${b.y}`}
                  fill="none"
                  stroke={EDGE_STROKE[e.drawKind] ?? "#8895aa"}
                  strokeWidth={1.6}
                  strokeDasharray={e.drawKind === "governs" ? "4 3" : undefined}
                  opacity={0.75}
                />
              );
            })}

          {/* The device at the centre: what every one of these documents is about. */}
          <g>
            <circle
              cx={layout.cx}
              cy={layout.cy}
              r={CENTER_R}
              fill="#2d5f8a"
              stroke="#24506f"
              strokeWidth={1.5}
            />
            <text x={layout.cx} y={layout.cy - 4} textAnchor="middle" className="gm-center">
              {risk ? risk.device.split(" ")[0] : "Documents"}
            </text>
            <text x={layout.cx} y={layout.cy + 13} textAnchor="middle" className="gm-center-sub">
              {risk ? risk.clearanceId : `${graph.nodes.length} nodes`}
            </text>
          </g>

          {layout.hubs.map((h) => (
            <g key={`hub-${h.lane}`}>
              <circle cx={h.x} cy={h.y} r={LANE_R} fill="#7ba3cc" stroke="#4a6fa5" strokeWidth={1.4} />
              <text x={h.x} y={h.y - 2} textAnchor="middle" className="gm-hub">
                {LANE_LABEL[h.lane].split(" ")[0]}
              </text>
              <text x={h.x} y={h.y + 11} textAnchor="middle" className="gm-hub-sub">
                {h.count}
              </text>
            </g>
          ))}

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

            // The label sits on the outward side, so it never crosses the ring.
            const cos = Math.cos(n.angle);
            const sin = Math.sin(n.angle);
            const anchor = cos > 0.15 ? "start" : cos < -0.15 ? "end" : "middle";
            const lx =
              anchor === "start"
                ? n.x + LEAF_R + LABEL_GAP
                : anchor === "end"
                  ? n.x - LEAF_R - LABEL_GAP
                  : n.x;
            const ly =
              anchor === "middle" ? (sin > 0 ? n.y + LEAF_R + 15 : n.y - LEAF_R - 7) : n.y + 4;
            const label = n.label.length > 20 ? `${n.label.slice(0, 19)}…` : n.label;

            return (
              <g
                key={n.nodeId}
                opacity={isDim(n.nodeId) ? 0.22 : 1}
                onClick={() => select(n.nodeId === selected ? null : n.nodeId)}
                style={{ cursor: "pointer" }}
              >
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.nodeId === selected ? LEAF_R + 3 : LEAF_R}
                  fill={fill}
                  stroke={n.nodeId === selected ? "#2d5f8a" : stroke}
                  strokeWidth={n.nodeId === selected ? 2.6 : 1.4}
                  strokeDasharray={ghost ? "4 3" : undefined}
                />
                {/* The risk score sits inside the node; the gap count rides the
                    node's edge, so a glance finds both without a legend. */}
                {n.risk && (
                  <text x={n.x} y={n.y + 4} textAnchor="middle" className="gm-risk-badge">
                    {n.risk.score}
                  </text>
                )}
                {!n.risk && n.kind === "document" && n.findingCount > 0 && (
                  <text x={n.x} y={n.y + 4} textAnchor="middle" className="gm-leaf-count">
                    {n.findingCount}
                  </text>
                )}
                {n.risk && n.risk.gapCount > 0 && (
                  <text
                    x={n.x + LEAF_R - 2}
                    y={n.y - LEAF_R + 4}
                    textAnchor="middle"
                    className="gm-gapcount"
                  >
                    ▲
                  </text>
                )}
                <text x={lx} y={ly} textAnchor={anchor} className="gm-label">
                  {label}
                </text>
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

          {/* The pathway out of the map: every node that stands for something
              elsewhere in the product offers the way there. */}
          <div className="gm-actions">
            {selectedNode.recordId && (
              <button onClick={() => onNavigate("findings", selectedNode.recordId)}>
                Open document
              </button>
            )}
            {selectedNode.changeId && (
              <button onClick={() => onNavigate("changes", selectedNode.changeId)}>
                {selectedNode.kind === "proposed" ? "Open the change that owes it" : "Open change"}
              </button>
            )}
            {selectedNode.kind === "submission" && (
              <button onClick={() => onNavigate("changes")}>Open submissions</button>
            )}
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
