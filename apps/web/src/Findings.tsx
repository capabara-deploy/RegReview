import { useMemo, useState } from "react";
import type { Finding, FindingStatus, RecordDetail, RecordSummary, Severity } from "./api";
import { dominant, segment, SEVERITY_MARK } from "./highlight";
import { FindingPanel } from "./FindingPanel";

/**
 * Read a completed review: the document with its findings highlighted in place,
 * and a panel for the one under inspection.
 *
 * Split out of App when running a review became its own page. Everything here is
 * about reading and judging; nothing here starts work or costs money.
 */

const SEVERITIES: Severity[] = ["high", "medium", "low"];

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function Findings({
  records,
  record,
  runId,
  findings,
  onOpenRecord,
  onSelectRun,
  onStatus,
}: {
  records: RecordSummary[];
  record: RecordDetail | null;
  runId: string | null;
  findings: Finding[];
  onOpenRecord: (recordId: string) => void;
  onSelectRun: (runId: string) => void;
  onStatus: (finding: Finding, status: FindingStatus, note?: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [hiddenSeverities, setHiddenSeverities] = useState<Set<Severity>>(new Set());
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(new Set());
  const [showResolved, setShowResolved] = useState(true);

  const categories = useMemo(
    () => [...new Set(findings.map((f) => f.category))].sort(),
    [findings],
  );

  const visible = useMemo(
    () =>
      findings.filter(
        (f) =>
          !hiddenSeverities.has(f.severity) &&
          !hiddenCategories.has(f.category) &&
          (showResolved || f.status === "open"),
      ),
    [findings, hiddenSeverities, hiddenCategories, showResolved],
  );

  const segments = useMemo(
    () => (record ? segment(record.normalizedText, visible) : []),
    [record, visible],
  );

  const counts = useMemo(() => {
    const c: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
    for (const f of findings) c[f.severity]++;
    return c;
  }, [findings]);

  const selectedFinding = findings.find((f) => f.findingId === selected) ?? null;
  const currentRun = record?.runs.find((r) => r.runId === runId);

  if (!record) {
    const reviewed = records.filter((r) => r.runs > 0);
    if (reviewed.length === 0) {
      return (
        <div className="empty-state">
          <p className="muted">
            No reviews yet. Upload a document and run a review from the{" "}
            <strong>Run a review</strong> tab.
          </p>
        </div>
      );
    }
    return (
      <div className="empty-state">
        <p className="muted">Select a document to view its findings.</p>
        <div className="record-picker">
          {reviewed.map((r) => (
            <button
              key={r.recordId}
              className="record-pick-btn"
              onClick={() => onOpenRecord(r.recordId)}
            >
              <span className="rpb-name">{r.docId ?? r.filename}</span>
              <span className="rpb-meta">
                {r.recordType} · {r.runs} run{r.runs === 1 ? "" : "s"}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="findings-bar">
        <select
          className="record-select"
          value={record.recordId}
          onChange={(e) => onOpenRecord(e.target.value)}
        >
          {records.map((r) => (
            <option key={r.recordId} value={r.recordId}>
              {r.docId ?? r.filename} ({r.runs} run{r.runs === 1 ? "" : "s"})
            </option>
          ))}
        </select>
        {record.runs.length > 0 && (
          <select
            className="run-select"
            value={runId ?? ""}
            onChange={(e) => onSelectRun(e.target.value)}
          >
            {record.runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.status === "complete" ? "" : r.status === "failed" ? "⚠ " : "… "}
                {new Date(r.startedAt).toLocaleString()} · {r.model} · {r.status}
                {r.model.startsWith("keyword-") ? " (baseline)" : ""}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* A run that failed must say so. Otherwise it renders as a document with
          an empty finding list, which is indistinguishable from a clean one —
          the most dangerous output this tool can produce. */}
      {currentRun && currentRun.status !== "complete" && (
        <div className="error run-failed">
          <strong>This run {currentRun.status === "running" ? "is unfinished" : "failed"}.</strong>{" "}
          {currentRun.error ?? "No findings were produced."} Pick another run above, or start a
          new review.
        </div>
      )}

      {/* Every run is stamped with the model, prompt version and corpus version.
          Two findings are only comparable if these match, so they are shown
          rather than hidden — a reviewer comparing runs needs to know. */}
      {currentRun && (
        <div className="provenance">
          <span>
            model <code>{currentRun.model}</code>
          </span>
          <span>
            effort <code>{currentRun.effort}</code>
          </span>
          <span>
            prompts <code>{currentRun.promptVersion}</code>
          </span>
          <span>
            corpus <code>{currentRun.corpusVersion}</code>
          </span>
        </div>
      )}

      <div className="filters">
        <span className="filter-label">Severity</span>
        {SEVERITIES.map((s) => (
          <button
            key={s}
            className={`chip sev-${s} ${hiddenSeverities.has(s) ? "off" : ""}`}
            onClick={() => setHiddenSeverities((prev) => toggle(prev, s))}
            aria-pressed={!hiddenSeverities.has(s)}
          >
            <span aria-hidden="true">{SEVERITY_MARK[s]}</span> {s} ({counts[s]})
          </button>
        ))}

        {categories.length > 0 && <span className="filter-label">Category</span>}
        {categories.map((c) => (
          <button
            key={c}
            className={`chip cat ${hiddenCategories.has(c) ? "off" : ""}`}
            onClick={() => setHiddenCategories((prev) => toggle(prev, c))}
            aria-pressed={!hiddenCategories.has(c)}
          >
            {c}
          </button>
        ))}

        <label className="resolved-toggle">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          show accepted / rejected
        </label>

        <span className="count">
          {visible.length} of {findings.length} shown
        </span>
      </div>

      <div className="body">
        <main className="document" aria-label="Document under review">
          {segments.map((seg, i) => {
            const top = dominant(seg.findings);
            if (!top) return <span key={i}>{seg.text}</span>;
            const isSelected = seg.findings.some((f) => f.findingId === selected);
            return (
              <mark
                key={i}
                className={
                  `hl sev-${top.severity} status-${top.status}` + (isSelected ? " selected" : "")
                }
                title={`${top.severity.toUpperCase()} · ${top.category} · ${top.citation}`}
                onClick={() => setSelected(top.findingId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(top.findingId);
                  }
                }}
              >
                {seg.text}
                {seg.findings.length > 1 && (
                  <sup className="overlap" title={`${seg.findings.length} overlapping findings`}>
                    {seg.findings.length}
                  </sup>
                )}
              </mark>
            );
          })}
        </main>

        <aside className="sidebar">
          {selectedFinding ? (
            <FindingPanel
              finding={selectedFinding}
              onClose={() => setSelected(null)}
              onStatus={onStatus}
            />
          ) : (
            <div className="finding-list">
              <h2>Findings</h2>
              {findings.length === 0 && (
                <p className="muted">
                  This run produced no findings, or no review has been run on this document yet.
                </p>
              )}
              {findings.length > 0 && visible.length === 0 && (
                <p className="muted">No findings match the filters.</p>
              )}
              {visible.map((f, i) => (
                <button
                  key={f.findingId}
                  className={`list-item sev-${f.severity} status-${f.status}`}
                  onClick={() => setSelected(f.findingId)}
                >
                  <div className="list-head">
                    <span className={`badge sev-${f.severity}`}>
                      <span aria-hidden="true">{SEVERITY_MARK[f.severity]}</span> {f.severity}
                    </span>
                    <span className="list-cat">{f.category}</span>
                    {f.status !== "open" && <span className="list-status">{f.status}</span>}
                  </div>
                  <div className="list-problem">
                    {i + 1}. {f.problem}
                  </div>
                  <div className="list-cite">{f.citation}</div>
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
