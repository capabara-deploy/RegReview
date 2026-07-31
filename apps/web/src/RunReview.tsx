import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type CorpusRule, type Job, type RecordSummary } from "./api";

/**
 * The "run a review" page.
 *
 * Its own page rather than a strip above the document, because starting a review
 * and reading its findings are different jobs done at different times: one is
 * setup — which documents, which requirements, what will it cost — and the other
 * is careful reading. Crowding them into one screen made the setup controls feel
 * like something to dismiss.
 *
 * The page is ordered the way the decision is actually made: which documents,
 * then what to check them against, then what it costs, then go.
 */

const RECORD_TYPES: { value: string; label: string }[] = [
  { value: "capa", label: "CAPA" },
  { value: "complaint", label: "Complaint" },
  { value: "risk_analysis", label: "Risk analysis / RMF" },
  { value: "design_input", label: "Design input" },
  { value: "design_output", label: "Design output" },
  { value: "design_review", label: "Design review" },
  { value: "verification", label: "Verification" },
  { value: "validation", label: "Validation" },
  { value: "traceability_matrix", label: "Traceability matrix" },
  { value: "change_package", label: "Change package" },
  { value: "unknown", label: "Other" },
];

const SOURCE_GROUPS: { key: string; label: string; sources: string[] }[] = [
  { key: "standards", label: "FDA & standards", sources: ["iso_clause", "cfr", "guidance"] },
  { key: "sop", label: "Your procedures", sources: ["sop"] },
  { key: "logic", label: "Logic & soundness", sources: ["logic"] },
];

/**
 * Which check passes a rule selection will run. Mirrors `categoriesForRules` in
 * runReview.ts, duplicated rather than fetched because it drives only the cost
 * estimate shown before the run — a round-trip to price a checkbox would make
 * the picker feel broken. The server stays the authority on what actually runs.
 */
function passesFor(rules: CorpusRule[]): number {
  let n = 0;
  if (rules.some((r) => ["iso_clause", "cfr", "guidance"].includes(r.source))) n += 1;
  if (rules.some((r) => r.source === "sop")) n += 1;
  if (rules.some((r) => r.source === "logic")) n += 2;
  return n;
}

function ProgressBar({ value, state }: { value: number; state: string }) {
  return (
    <div className="pbar" role="progressbar" aria-valuenow={Math.round(value * 100)}>
      <div className={`pbar-fill ${state}`} style={{ width: `${Math.max(2, value * 100)}%` }} />
    </div>
  );
}

export function RunReview({
  records,
  jobs,
  onStartJob,
  onRefreshRecords,
  onOpenRun,
}: {
  records: RecordSummary[];
  jobs: Job[];
  onStartJob: (jobId: string) => void;
  onRefreshRecords: () => Promise<void>;
  onOpenRun: (runId: string) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [crossCheck, setCrossCheck] = useState<Set<string>>(new Set());
  const [samples, setSamples] = useState(1);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [allRules, setAllRules] = useState<CorpusRule[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showRules, setShowRules] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadType, setUploadType] = useState("capa");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .allRules()
      .then((rules) => {
        setAllRules(rules);
        setSelected(new Set(rules.map((r) => r.ruleId)));
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  // Default to the most recently touched document so the page is usable on
  // arrival rather than requiring a selection before anything makes sense.
  useEffect(() => {
    if (picked.size === 0 && records.length > 0) {
      setPicked(new Set([records[0]!.recordId]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records.length]);

  const pickedRecords = records.filter((r) => picked.has(r.recordId));
  const single = pickedRecords.length === 1 ? pickedRecords[0] : null;

  // Rules are filtered to the selected documents' types. With several types
  // picked, a rule is offered if it applies to any of them — the per-document
  // filtering still happens server-side, so an inapplicable rule is skipped for
  // the documents it does not govern rather than silently dropping the run.
  const types = useMemo(
    () => new Set(pickedRecords.map((r) => r.recordType)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [picked, records],
  );
  const applicable = useMemo(
    () =>
      allRules.filter(
        (r) => r.appliesTo.length === 0 || r.appliesTo.some((t) => types.has(t)),
      ),
    [allRules, types],
  );

  const selectedApplicable = useMemo(
    () => applicable.filter((r) => selected.has(r.ruleId)),
    [applicable, selected],
  );
  const isAll = selectedApplicable.length === applicable.length && applicable.length > 0;
  const noneSelected = selectedApplicable.length === 0;

  const perDoc = offline ? 0 : (0.13 * passesFor(selectedApplicable) + 0.1) * samples;
  const estCost = perDoc * Math.max(1, pickedRecords.length);

  const groups = useMemo(
    () =>
      SOURCE_GROUPS.map((g) => ({
        ...g,
        rules: applicable.filter((r) => g.sources.includes(r.source)),
      })).filter((g) => g.rules.length > 0),
    [applicable],
  );

  // All of these use the functional updater rather than reading the current set
  // from the closure. Reading it directly means two updates dispatched before a
  // re-render both start from the same stale value and the second silently
  // discards the first — which is exactly what happened when "none" was clicked
  // on three rule groups in quick succession: only the last group cleared.
  const flip = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const togglePicked = (id: string) => {
    setPicked((prev) => flip(prev, id));
    // A document cannot be both under review and a cross-check target for
    // itself; drop it from the other list rather than sending a contradiction.
    setCrossCheck((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const toggleCross = (id: string) => setCrossCheck((prev) => flip(prev, id));

  const toggleRule = (ruleId: string) => setSelected((prev) => flip(prev, ruleId));

  const setGroup = (rules: CorpusRule[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of rules) {
        if (on) next.add(r.ruleId);
        else next.delete(r.ruleId);
      }
      return next;
    });
  };

  const onUpload = useCallback(
    async (file: File) => {
      setError(null);
      setNotice(null);
      setUploading(true);
      try {
        const result = await api.uploadRecord(file, uploadType);
        setNotice(
          result.warning ??
            `Uploaded ${result.filename} — ${result.format}, ${result.blocks} blocks.`,
        );
        await onRefreshRecords();
        setPicked(new Set([result.recordId]));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading(false);
        if (fileInput.current) fileInput.current.value = "";
      }
    },
    [uploadType, onRefreshRecords],
  );

  const onDelete = useCallback(
    async (r: RecordSummary) => {
      const label = r.docId ?? r.filename;
      if (
        !confirm(
          `Delete ${label}?\n\nThis permanently removes the document, its ${r.runs} run(s), ` +
            `all findings, and the reviewer audit trail behind them. The uploaded file ` +
            `itself is left on disk.`,
        )
      )
        return;
      try {
        const res = await api.deleteRecord(r.recordId);
        setNotice(
          `Deleted ${label} — ${res.runs} run(s) and ${res.findings} finding(s) removed.`,
        );
        const next = new Set(picked);
        next.delete(r.recordId);
        setPicked(next);
        const cc = new Set(crossCheck);
        cc.delete(r.recordId);
        setCrossCheck(cc);
        await onRefreshRecords();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [picked, crossCheck, onRefreshRecords],
  );

  const start = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    const ruleIds = isAll ? undefined : selectedApplicable.map((r) => r.ruleId);
    try {
      if (pickedRecords.length === 1) {
        const { jobId } = await api.startReview(pickedRecords[0]!.recordId, {
          samples,
          offline,
          related: [...crossCheck],
          ...(ruleIds ? { ruleIds } : {}),
        });
        onStartJob(jobId);
      } else {
        const { jobId } = await api.startBatchReview({
          recordIds: pickedRecords.map((r) => r.recordId),
          samples,
          offline,
          ...(ruleIds ? { ruleIds } : {}),
        });
        onStartJob(jobId);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [pickedRecords, samples, offline, crossCheck, isAll, selectedApplicable, onStartJob]);

  const anyRunning = jobs.some((j) => j.status === "running");

  return (
    <div className="runpage">
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {/* 1 — which documents */}
      <section className="rp-section">
        <div className="rp-head">
          <h2>Documents to review</h2>
          <div className="rp-head-actions">
            <select
              className="rp-type"
              value={uploadType}
              onChange={(e) => setUploadType(e.target.value)}
              title="Record type for the next upload"
            >
              {RECORD_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
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
              className="act accept"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? "Uploading…" : "+ Upload"}
            </button>
          </div>
        </div>

        {records.length === 0 && (
          <p className="muted">No documents yet. Upload one to get started.</p>
        )}

        <div className="doclist">
          {records.map((r) => {
            const on = picked.has(r.recordId);
            return (
              <div key={r.recordId} className={`docrow ${on ? "on" : ""}`}>
                <label className="docrow-main">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => togglePicked(r.recordId)}
                  />
                  <span className="docrow-name">{r.docId ?? r.filename}</span>
                  <span className="docrow-type">{r.recordType.replace(/_/g, " ")}</span>
                  <span className="docrow-runs">
                    {r.runs === 0 ? "never reviewed" : `${r.runs} run${r.runs === 1 ? "" : "s"}`}
                  </span>
                </label>
                <button
                  className="docrow-del"
                  title="Delete this document and all its findings"
                  onClick={() => void onDelete(r)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        <p className="muted small rp-foot">
          {pickedRecords.length === 0
            ? "Select at least one document."
            : pickedRecords.length === 1
              ? "One document — cross-document checking is available below."
              : `${pickedRecords.length} documents — each reviewed separately against the same rules.`}
        </p>
      </section>

      {/* 2 — cross-check, only meaningful for a single document */}
      {single && records.length > 1 && (
        <section className="rp-section">
          <div className="rp-head">
            <h2>Cross-check against</h2>
            <span className="muted small">
              finds facts that disagree between documents — risk ratings, dates, thresholds
            </span>
          </div>
          <div className="doclist">
            {records
              .filter((r) => r.recordId !== single.recordId)
              .map((r) => (
                <label
                  key={r.recordId}
                  className={`docrow ${crossCheck.has(r.recordId) ? "on" : ""}`}
                >
                  <span className="docrow-main">
                    <input
                      type="checkbox"
                      checked={crossCheck.has(r.recordId)}
                      onChange={() => toggleCross(r.recordId)}
                    />
                    <span className="docrow-name">{r.docId ?? r.filename}</span>
                    <span className="docrow-type">{r.recordType.replace(/_/g, " ")}</span>
                  </span>
                </label>
              ))}
          </div>
          {crossCheck.size === 0 && (
            <p className="muted small rp-foot">
              None selected — the consistency pass will not run.
            </p>
          )}
        </section>
      )}

      {/* 3 — what to check against */}
      <section className="rp-section">
        <div className="rp-head">
          <h2>
            Requirements to check
            <span className="rc-badge">
              {isAll
                ? `all ${applicable.length}`
                : `${selectedApplicable.length} of ${applicable.length}`}
            </span>
          </h2>
          <div className="rp-head-actions">
            {!isAll && !noneSelected && (
              <span className="muted small">
                scoped — runs {passesFor(selectedApplicable)} of 4 check passes
              </span>
            )}
            {noneSelected && <span className="rc-warn">select at least one</span>}
            <button className="rc-disclose" onClick={() => setShowRules((v) => !v)}>
              {showRules ? "▾ hide" : "▸ choose"}
            </button>
          </div>
        </div>

        {showRules && (
          <div className="rc-rules">
            {groups.map((g) => {
              const on = g.rules.filter((r) => selected.has(r.ruleId)).length;
              return (
                <div key={g.key} className="rc-rule-group">
                  <div className="rc-rule-group-head">
                    <span className="rc-rule-group-title">
                      {g.label}
                      <span className="rc-badge">
                        {on}/{g.rules.length}
                      </span>
                    </span>
                    <button className="rc-mini" onClick={() => setGroup(g.rules, true)}>
                      all
                    </button>
                    <button className="rc-mini" onClick={() => setGroup(g.rules, false)}>
                      none
                    </button>
                  </div>
                  {g.rules.map((r) => (
                    <label key={r.ruleId} className="rc-rule">
                      <input
                        type="checkbox"
                        checked={selected.has(r.ruleId)}
                        onChange={() => toggleRule(r.ruleId)}
                      />
                      <span className="rc-rule-body">
                        <span className="rc-rule-title">{r.title}</span>
                        <span className="rc-rule-cite">{r.citation}</span>
                      </span>
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 4 — cost and go */}
      <section className="rp-section rp-go">
        <label className="rc-opt">
          samples
          <select
            value={samples}
            disabled={offline}
            onChange={(e) => setSamples(Number(e.target.value))}
          >
            <option value={1}>1</option>
            <option value={3}>3 (vote)</option>
            <option value={5}>5 (vote)</option>
          </select>
        </label>
        <label className="rc-opt">
          <input
            type="checkbox"
            checked={offline}
            onChange={(e) => setOffline(e.target.checked)}
          />
          offline (free, crude)
        </label>
        <span className="rc-cost">
          {offline
            ? "no API cost"
            : `est. ~$${estCost.toFixed(2)}` +
              (pickedRecords.length > 1 ? ` · ${pickedRecords.length} docs` : "")}
        </span>
        <button
          className="act accept on rp-start"
          disabled={busy || noneSelected || pickedRecords.length === 0}
          onClick={() => void start()}
        >
          {busy
            ? "Starting…"
            : pickedRecords.length > 1
              ? `Review ${pickedRecords.length} documents`
              : "Start review"}
        </button>
      </section>

      {/* 5 — what is running */}
      {jobs.length > 0 && (
        <section className="rp-section">
          <div className="rp-head">
            <h2>{anyRunning ? "Running" : "Recent runs"}</h2>
          </div>
          {jobs.map((j) => (
            <div key={j.jobId} className="jobcard">
              {j.results.map((r) => {
                const pct = r.stepsTotal > 0 ? r.stepsDone / r.stepsTotal : 0;
                return (
                  <div key={r.recordId} className="jobrow">
                    <div className="jobrow-top">
                      <span className="jobrow-name">{r.docId ?? r.filename}</span>
                      <span className={`jobrow-state ${r.status}`}>
                        {r.status === "complete"
                          ? `${r.findingCount ?? 0} finding${r.findingCount === 1 ? "" : "s"}`
                          : r.status === "failed"
                            ? "failed"
                            : r.status === "pending"
                              ? "queued"
                              : (r.phase ?? "working")}
                      </span>
                      {r.runId && (
                        <button className="rc-mini" onClick={() => onOpenRun(r.runId!)}>
                          view
                        </button>
                      )}
                    </div>
                    <ProgressBar
                      value={r.status === "complete" ? 1 : r.status === "pending" ? 0 : pct}
                      state={r.status}
                    />
                    {r.error && <div className="jobrow-err">{r.error}</div>}
                  </div>
                );
              })}
              {j.status === "running" && j.progress.length > 0 && (
                <pre className="rc-progress">{j.progress.slice(-6).join("\n")}</pre>
              )}
              {j.error && <div className="error">{j.error}</div>}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
