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
  const [crossCheckSelected, setCrossCheckSelected] = useState(false);
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
  // Only documents not already under review can be cross-check targets: a record
  // compared against itself agrees with itself on everything.
  const unpicked = records.filter((r) => !picked.has(r.recordId));

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

  /**
   * Groups are built from the whole corpus, not from the applicable subset.
   *
   * Filtering to applicable rules first made a group vanish when nothing in it
   * governed the selected document — most visibly the customer's own procedures,
   * which ship scoped to the record types they were loaded for. A disappearing
   * group is the same failure as a silently skipped check pass: half the review
   * is missing and the screen still looks complete. So the group always renders,
   * inapplicable rules render disabled, and the reason is stated.
   */
  const groups = useMemo(
    () =>
      SOURCE_GROUPS.map((g) => {
        const inGroup = allRules.filter((r) => g.sources.includes(r.source));
        const usable = inGroup.filter(
          (r) => r.appliesTo.length === 0 || r.appliesTo.some((t) => types.has(t)),
        );
        // Which record types this group's rules DO cover, so the explanation can
        // name them instead of just saying "not applicable".
        const covers = [
          ...new Set(inGroup.flatMap((r) => r.appliesTo)),
        ].sort();
        return { ...g, rules: inGroup, usable, covers };
      }).filter((g) => g.rules.length > 0),
    [allRules, types],
  );

  // A complete noun phrase, so callers never have to append "record" and end up
  // with "a this record record" when nothing is selected.
  const typeLabel =
    types.size === 0
      ? "the selected documents"
      : `${[...types].map((t) => t.replace(/_/g, " ")).join(" / ")} record${types.size > 1 ? "s" : ""}`;

  /**
   * Check passes that will not run, and why.
   *
   * A skipped pass is the most dangerous thing this tool can hide: the review
   * comes back looking complete while a whole category was never checked. The
   * distinction between "nothing of this kind governs this document" and "you
   * turned it off" matters — the first is a configuration problem the user can
   * fix, the second is a choice they already made.
   */
  const skipped = useMemo(() => {
    const out: { pass: string; reason: string; fixable: boolean }[] = [];
    const check = (
      pass: string,
      sources: string[],
      hint: string,
    ) => {
      const inCorpus = allRules.filter((r) => sources.includes(r.source));
      if (inCorpus.length === 0) return; // nothing of this kind exists at all
      const usable = applicable.filter((r) => sources.includes(r.source));
      const chosen = selectedApplicable.filter((r) => sources.includes(r.source));
      if (usable.length === 0) {
        out.push({ pass, reason: `nothing applies to ${typeLabel} — ${hint}`, fixable: true });
      } else if (chosen.length === 0) {
        out.push({ pass, reason: "deselected above", fixable: false });
      }
    };
    check("conformance", ["sop"], "your procedures are scoped to other record types");
    check("compliance", ["iso_clause", "cfr", "guidance"], "no standards rules cover it yet");
    check("completeness / plausibility", ["logic"], "no logic rules cover it");
    return out;
  }, [allRules, applicable, selectedApplicable, typeLabel]);

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

  const onRetype = useCallback(
    async (r: RecordSummary, recordType: string) => {
      setError(null);
      setNotice(null);
      try {
        const res = await api.setRecordType(r.recordId, recordType);
        const label = r.docId ?? r.filename;
        const parts = [
          `${label} is now a ${recordType.replace(/_/g, " ")} record — ` +
            `${res.applicableRules} rule(s) apply.`,
        ];
        // Past runs were produced under the old type's rules. Saying so matters:
        // the findings on screen may be measured against requirements that no
        // longer govern this document.
        if (res.priorRuns > 0) {
          parts.push(
            `Its ${res.priorRuns} existing run(s) were done as a ` +
              `${res.previousType.replace(/_/g, " ")} record and are unchanged — ` +
              `re-run to check it against the new rule set.`,
          );
        }
        setNotice(parts.join(" "));
        await onRefreshRecords();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [onRefreshRecords],
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
          related: [...crossCheck],
          crossCheckSelected,
          ...(ruleIds ? { ruleIds } : {}),
        });
        onStartJob(jobId);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [
    pickedRecords,
    samples,
    offline,
    crossCheck,
    crossCheckSelected,
    isAll,
    selectedApplicable,
    onStartJob,
  ]);

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
            <label className="rp-uploadtype">
              upload as
              <select
                className="rp-type"
                value={uploadType}
                onChange={(e) => setUploadType(e.target.value)}
              >
                {RECORD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
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
                </label>
                {/* Editable, not a badge: the type decides which rules apply, and
                    a document uploaded under the wrong one is reviewed against
                    the wrong requirements — or against none. */}
                <select
                  className="docrow-type"
                  value={r.recordType}
                  title="Document type — decides which requirements apply"
                  onChange={(e) => void onRetype(r, e.target.value)}
                >
                  {/* A controlled select whose value is not among its options
                      displays the first option instead, so the row would claim a
                      type the document does not have and the next interaction
                      would silently commit it. Keep an escape hatch for any
                      record type this list does not know about. */}
                  {!RECORD_TYPES.some((t) => t.value === r.recordType) && (
                    <option value={r.recordType}>{r.recordType.replace(/_/g, " ")}</option>
                  )}
                  {RECORD_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <span className="docrow-runs">
                  {r.runs === 0 ? "never reviewed" : `${r.runs} run${r.runs === 1 ? "" : "s"}`}
                </span>
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

      {/* 2 — cross-check. Available regardless of how many documents are under
             review: each reviewed document is checked against the same targets. */}
      {records.length > 1 && (
        <section className="rp-section">
          <div className="rp-head">
            <h2>Cross-check against</h2>
            <span className="muted small">
              finds facts that disagree between documents — risk ratings, dates, thresholds
            </span>
          </div>

          {pickedRecords.length > 1 && (
            <label className="rc-opt rp-eachother">
              <input
                type="checkbox"
                checked={crossCheckSelected}
                onChange={(e) => setCrossCheckSelected(e.target.checked)}
              />
              also check the {pickedRecords.length} selected documents against{" "}
              <strong>each other</strong>
              <span className="muted small">
                {" "}
                — facts are extracted once per document and cached, so this costs
                little beyond the first pass
              </span>
            </label>
          )}

          <div className="doclist">
            {unpicked.length === 0 && (
              <p className="muted small">
                Every document is selected for review. Untick one to use it as a
                cross-check target instead
                {pickedRecords.length > 1 ? ", or use the option above." : "."}
              </p>
            )}
            {unpicked.map((r) => (
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
                </span>
                <span className="docrow-typeflat">{r.recordType.replace(/_/g, " ")}</span>
              </label>
            ))}
          </div>

          {crossCheck.size === 0 && !crossCheckSelected && (
            <p className="muted small rp-foot">
              Nothing to compare against — the consistency pass will not run.
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

        {/* A skipped pass must never be silent. A review that never ran a whole
            category comes back looking exactly like a clean one. */}
        {skipped.length > 0 && (
          <div className="rc-skipwarn">
            <strong>
              {skipped.length === 1 ? "One check pass" : `${skipped.length} check passes`} will
              not run:
            </strong>
            <ul>
              {skipped.map((s) => (
                <li key={s.pass}>
                  <span className="rc-skip-pass">{s.pass}</span> — {s.reason}
                  {s.fixable && s.pass === "conformance" && (
                    <>
                      {" "}
                      <button className="rc-mini" onClick={() => setShowRules(true)}>
                        show
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {showRules && (
          <div className="rc-rules">
            {groups.map((g) => {
              const on = g.usable.filter((r) => selected.has(r.ruleId)).length;
              const blocked = g.usable.length === 0;
              return (
                <div key={g.key} className="rc-rule-group">
                  <div className="rc-rule-group-head">
                    <span className="rc-rule-group-title">
                      {g.label}
                      <span className="rc-badge">
                        {on}/{g.usable.length}
                      </span>
                    </span>
                    <button
                      className="rc-mini"
                      disabled={blocked}
                      onClick={() => setGroup(g.usable, true)}
                    >
                      all
                    </button>
                    <button
                      className="rc-mini"
                      disabled={blocked}
                      onClick={() => setGroup(g.usable, false)}
                    >
                      none
                    </button>
                  </div>

                  {blocked && (
                    <div className="rc-blocked">
                      None of these {g.rules.length} apply to <strong>{typeLabel}</strong>
                      {g.covers.length > 0 && (
                        <>
                          {" "}
                          — they are set to apply to{" "}
                          <strong>{g.covers.map((c) => c.replace(/_/g, " ")).join(", ")}</strong>
                        </>
                      )}
                      .
                      {g.key === "sop" && (
                        <>
                          {" "}
                          Change that under <strong>Procedures → Applies to</strong>, or this
                          document will be reviewed with no conformance check at all.
                        </>
                      )}
                    </div>
                  )}

                  {g.rules.map((r) => {
                    const usable = g.usable.includes(r);
                    return (
                      <label
                        key={r.ruleId}
                        className={`rc-rule ${usable ? "" : "off"}`}
                        title={
                          usable
                            ? undefined
                            : `Applies to ${r.appliesTo.join(", ")} — not ${typeLabel}`
                        }
                      >
                        <input
                          type="checkbox"
                          checked={usable && selected.has(r.ruleId)}
                          disabled={!usable}
                          onChange={() => toggleRule(r.ruleId)}
                        />
                        <span className="rc-rule-body">
                          <span className="rc-rule-title">{r.title}</span>
                          <span className="rc-rule-cite">{r.citation}</span>
                        </span>
                      </label>
                    );
                  })}
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
