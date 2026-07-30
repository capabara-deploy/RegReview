import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type Finding,
  type FindingStatus,
  type RecordDetail,
  type RecordSummary,
  type Severity,
} from "./api";
import { dominant, segment } from "./highlight";
import { FindingPanel } from "./FindingPanel";
import { Procedures } from "./Procedures";
import { ReviewControls } from "./ReviewControls";

type View = "review" | "procedures";

const SEVERITIES: Severity[] = ["high", "medium", "low"];

/** Icon plus label, never colour alone — the tier has to survive a colourblind
 *  reviewer and a black-and-white printout of a review meeting handout. */
export const SEVERITY_MARK: Record<Severity, string> = {
  high: "▲",
  medium: "■",
  low: "●",
};

export function App() {
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hiddenSeverities, setHiddenSeverities] = useState<Set<Severity>>(new Set());
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(new Set());
  const [showResolved, setShowResolved] = useState(true);
  const [view, setView] = useState<View>("review");
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refreshRecords = useCallback(async () => {
    try {
      setRecords(await api.records());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    api
      .records()
      .then((rows) => {
        setRecords(rows);
        const first = rows.find((r) => r.runs > 0) ?? rows[0];
        if (first) void openRecord(first.recordId);
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openRecord = useCallback(async (recordId: string) => {
    setError(null);
    try {
      const detail = await api.record(recordId);
      setRecord(detail);
      setSelected(null);
      // Prefer the newest real review. The offline keyword baseline is a
      // development diagnostic whose findings are deliberately crude, and
      // defaulting to it would show a reviewer output the product would never
      // produce.
      const complete = detail.runs.filter((r) => r.status === "complete");
      const latest =
        complete.find((r) => !r.model.startsWith("keyword-")) ?? complete[0] ?? detail.runs[0];
      if (latest) {
        setRunId(latest.runId);
        setFindings(await api.findings(latest.runId));
      } else {
        setRunId(null);
        setFindings([]);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const selectRun = useCallback(async (id: string) => {
    setError(null);
    setRunId(id);
    setSelected(null);
    try {
      setFindings(await api.findings(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const updateStatus = useCallback(
    async (finding: Finding, status: FindingStatus, note?: string) => {
      try {
        const updated = await api.setStatus(finding.runId, finding.findingId, status, note);
        setFindings((prev) =>
          prev.map((f) => (f.findingId === updated.findingId ? updated : f)),
        );
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [],
  );

  const onUpload = useCallback(
    async (file: File) => {
      setError(null);
      setNotice(null);
      setUploading(true);
      try {
        const result = await api.uploadRecord(file, "capa");
        if (result.warning) setNotice(result.warning);
        else setNotice(`Uploaded ${result.filename} (${result.format}, ${result.blocks} blocks).`);
        await refreshRecords();
        await openRecord(result.recordId);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading(false);
        if (fileInput.current) fileInput.current.value = "";
      }
    },
    [refreshRecords, openRecord],
  );

  // A finished review: pull the new runs and jump to the run that was produced.
  const onReviewComplete = useCallback(
    async (newRunId: string) => {
      if (!record) return;
      const detail = await api.record(record.recordId);
      setRecord(detail);
      await selectRun(newRunId);
      setNotice("Review complete.");
    },
    [record, selectRun],
  );

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

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          RegReview
          <span className="tagline">pre-inspection review</span>
        </div>

        <nav className="viewnav">
          <button
            className={`viewtab ${view === "review" ? "on" : ""}`}
            onClick={() => setView("review")}
          >
            Review
          </button>
          <button
            className={`viewtab ${view === "procedures" ? "on" : ""}`}
            onClick={() => setView("procedures")}
          >
            Procedures
          </button>
        </nav>

        {view === "review" && (
          <>
            <select
              className="record-select"
              value={record?.recordId ?? ""}
              onChange={(e) => void openRecord(e.target.value)}
            >
              {records.map((r) => (
                <option key={r.recordId} value={r.recordId}>
                  {r.docId ?? r.filename} ({r.runs} run{r.runs === 1 ? "" : "s"})
                </option>
              ))}
            </select>
            {record && record.runs.length > 0 && (
              <select
                className="run-select"
                value={runId ?? ""}
                onChange={(e) => void selectRun(e.target.value)}
              >
                {record.runs.map((r) => (
                  <option key={r.runId} value={r.runId}>
                    {new Date(r.startedAt).toLocaleString()} · {r.model} · {r.status}
                    {r.model.startsWith("keyword-") ? " (baseline)" : ""}
                  </option>
                ))}
              </select>
            )}
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.docx,.md,.txt"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onUpload(f);
              }}
            />
            <button
              className="upload-btn"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? "Uploading…" : "+ Upload document"}
            </button>
          </>
        )}
      </header>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {view === "procedures" && <Procedures onChanged={refreshRecords} />}

      {view === "review" && record && (
        <ReviewControls
          recordId={record.recordId}
          records={records}
          onComplete={(id) => void onReviewComplete(id)}
        />
      )}

      {/* Every run is stamped with the model, prompt version and corpus version.
          Two findings are only comparable if these match, so they are shown
          rather than hidden — a reviewer comparing runs needs to know. */}
      {view === "review" && currentRun && (
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

      {view === "review" && (
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
      )}

      {view === "review" && (
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
                  `hl sev-${top.severity} status-${top.status}` +
                  (isSelected ? " selected" : "")
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
              onStatus={updateStatus}
            />
          ) : (
            <div className="finding-list">
              <h2>Findings</h2>
              {visible.length === 0 && <p className="muted">No findings match the filters.</p>}
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
      )}
    </div>
  );
}
