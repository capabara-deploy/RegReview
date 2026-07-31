import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type CorpusRule, type Job, type RecordSummary } from "./api";

/**
 * Start a review of the open document.
 *
 * A review sends document text to the model and costs money, so the controls are
 * deliberate rather than a single hidden button: the estimated cost is shown
 * before the run, self-consistency sampling multiplies it visibly, and an
 * offline mode runs the crude keyword baseline for free when the user only wants
 * to see the pipeline move. Progress streams from the background job so a
 * two-minute run does not look frozen.
 *
 * The rule picker exists for the standards-transition case: when an edition of a
 * standard is revised, the question is not "review this document again" but
 * "which of my documents violate the requirements that changed". Selecting a
 * subset of rules narrows the run to the passes those rules belong to, which is
 * both far cheaper and a cleaner answer — the only findings produced are the
 * ones the selected requirements generate.
 */

const SOURCE_GROUPS: { key: string; label: string; sources: string[] }[] = [
  { key: "standards", label: "FDA & standards", sources: ["iso_clause", "cfr", "guidance"] },
  { key: "sop", label: "Your procedures", sources: ["sop"] },
  { key: "logic", label: "Logic & soundness", sources: ["logic"] },
];

/**
 * Which check passes a rule selection will actually run.
 *
 * Mirrors `categoriesForRules` in runReview.ts. Duplicated deliberately rather
 * than fetched: this drives only the cost estimate shown before the run, and a
 * round-trip to price a checkbox would make the picker feel broken. The server
 * remains the authority on what actually runs.
 */
function passesFor(rules: CorpusRule[]): number {
  let n = 0;
  if (rules.some((r) => ["iso_clause", "cfr", "guidance"].includes(r.source))) n += 1;
  if (rules.some((r) => r.source === "sop")) n += 1;
  if (rules.some((r) => r.source === "logic")) n += 2;
  return n;
}

export function ReviewControls({
  recordId,
  records,
  onComplete,
}: {
  recordId: string;
  records: RecordSummary[];
  onComplete: (runId: string) => void;
}) {
  const [samples, setSamples] = useState(1);
  const [offline, setOffline] = useState(false);
  const [related, setRelated] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const pollTimer = useRef<number | null>(null);

  const [allRules, setAllRules] = useState<CorpusRule[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showRules, setShowRules] = useState(false);
  const [batch, setBatch] = useState<Set<string>>(new Set());
  const [showBatch, setShowBatch] = useState(false);

  const record = records.find((r) => r.recordId === recordId);
  const recordType = record?.recordType ?? "capa";
  const otherRecords = records.filter((r) => r.recordId !== recordId);

  // Only rules that apply to this record type are selectable. An empty
  // appliesTo means the rule applies to everything — that is how the
  // cross-cutting soundness checks are expressed, so it must not read as
  // "applies to nothing".
  const applicable = useMemo(
    () =>
      allRules.filter((r) => r.appliesTo.length === 0 || r.appliesTo.includes(recordType)),
    [allRules, recordType],
  );

  useEffect(() => {
    api
      .allRules()
      .then((rules) => {
        setAllRules(rules);
        // Default to everything selected, which is the pre-existing behaviour:
        // an unscoped review of the whole applicable corpus.
        setSelected(new Set(rules.map((r) => r.ruleId)));
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const selectedApplicable = useMemo(
    () => applicable.filter((r) => selected.has(r.ruleId)),
    [applicable, selected],
  );
  const isAll = selectedApplicable.length === applicable.length && applicable.length > 0;

  // Four passes plus a verifier is ~$0.65. Scoping drops whole passes, so price
  // by the passes the selection will actually run.
  const perDoc = offline ? 0 : (0.13 * passesFor(selectedApplicable) + 0.1) * samples;
  const docCount = 1 + batch.size;
  const estCost = perDoc * docCount;

  const groups = useMemo(
    () =>
      SOURCE_GROUPS.map((g) => ({
        ...g,
        rules: applicable.filter((r) => g.sources.includes(r.source)),
      })).filter((g) => g.rules.length > 0),
    [applicable],
  );

  const toggleRule = (ruleId: string) => {
    const next = new Set(selected);
    if (next.has(ruleId)) next.delete(ruleId);
    else next.add(ruleId);
    setSelected(next);
  };

  const setGroup = (rules: CorpusRule[], on: boolean) => {
    const next = new Set(selected);
    for (const r of rules) {
      if (on) next.add(r.ruleId);
      else next.delete(r.ruleId);
    }
    setSelected(next);
  };

  const toggleRelated = (id: string) => {
    const next = new Set(related);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setRelated(next);
  };

  const toggleBatch = (id: string) => {
    const next = new Set(batch);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setBatch(next);
  };

  const stop = () => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const poll = useCallback(
    (jobId: string, isBatch: boolean) => {
      pollTimer.current = window.setInterval(async () => {
        try {
          const j = await api.job(jobId);
          setJob(j);
          setProgress(j.progress.slice(-10));
          if (j.status === "complete") {
            stop();
            setRunning(false);
            // A batch has no single run to open; the per-document results stay
            // on screen instead. A single review jumps straight to its findings.
            if (!isBatch && j.runId) onComplete(j.runId);
          } else if (j.status === "failed") {
            stop();
            setRunning(false);
            setError(j.error ?? "the review failed");
          }
        } catch (e) {
          stop();
          setRunning(false);
          setError((e as Error).message);
        }
      }, 1500);
    },
    [onComplete],
  );

  useEffect(() => stop, []);

  const start = useCallback(async () => {
    setError(null);
    setProgress([]);
    setJob(null);
    setRunning(true);
    // Sending no ruleIds means "every applicable rule", which keeps an unscoped
    // review byte-identical to how it behaved before the picker existed.
    const ruleIds = isAll ? undefined : selectedApplicable.map((r) => r.ruleId);
    try {
      if (batch.size > 0) {
        const { jobId } = await api.startBatchReview({
          recordIds: [recordId, ...batch],
          samples,
          offline,
          ...(ruleIds ? { ruleIds } : {}),
        });
        poll(jobId, true);
      } else {
        const { jobId } = await api.startReview(recordId, {
          samples,
          offline,
          related: [...related],
          ...(ruleIds ? { ruleIds } : {}),
        });
        poll(jobId, false);
      }
    } catch (e) {
      setRunning(false);
      setError((e as Error).message);
    }
  }, [recordId, samples, offline, related, batch, isAll, selectedApplicable, poll]);

  const noneSelected = selectedApplicable.length === 0;

  return (
    <div className="review-controls">
      <div className="rc-row">
        <strong>Run a review</strong>
        <label className="rc-opt">
          samples
          <select
            value={samples}
            disabled={running || offline}
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
            disabled={running}
            onChange={(e) => setOffline(e.target.checked)}
          />
          offline (free, crude)
        </label>
        <span className="rc-cost">
          {offline
            ? "no API cost"
            : `est. ~$${estCost.toFixed(2)}${docCount > 1 ? ` (${docCount} docs)` : ""}`}
        </span>
        <button
          className="act accept on"
          disabled={running || noneSelected}
          onClick={() => void start()}
        >
          {running ? "Reviewing…" : batch.size > 0 ? `Scan ${docCount} documents` : "Start review"}
        </button>
      </div>

      <div className="rc-row">
        <button className="rc-disclose" onClick={() => setShowRules((v) => !v)}>
          {showRules ? "▾" : "▸"} Rules to evaluate
          <span className="rc-badge">
            {isAll ? `all ${applicable.length}` : `${selectedApplicable.length} of ${applicable.length}`}
          </span>
        </button>
        {!isAll && !noneSelected && (
          <span className="muted small">
            scoped — runs {passesFor(selectedApplicable)} of 4 check passes
          </span>
        )}
        {noneSelected && <span className="rc-warn">select at least one rule</span>}
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
                      disabled={running}
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

      {otherRecords.length > 0 && (
        <div className="rc-row">
          <button className="rc-disclose" onClick={() => setShowBatch((v) => !v)}>
            {showBatch ? "▾" : "▸"} Also scan other documents
            {batch.size > 0 && <span className="rc-badge">{batch.size}</span>}
          </button>
          <span className="muted small">
            same rules, one run each — for checking a document base against a changed requirement
          </span>
        </div>
      )}

      {showBatch && otherRecords.length > 0 && (
        <div className="rc-row rc-related">
          {otherRecords.map((r) => (
            <label key={r.recordId} className="applies-chip">
              <input
                type="checkbox"
                checked={batch.has(r.recordId)}
                disabled={running}
                onChange={() => toggleBatch(r.recordId)}
              />
              {r.docId ?? r.filename}
            </label>
          ))}
        </div>
      )}

      {otherRecords.length > 0 && batch.size === 0 && (
        <div className="rc-row rc-related">
          <span className="filter-label">Cross-check against</span>
          {otherRecords.map((r) => (
            <label key={r.recordId} className="applies-chip">
              <input
                type="checkbox"
                checked={related.has(r.recordId)}
                disabled={running}
                onChange={() => toggleRelated(r.recordId)}
              />
              {r.docId ?? r.filename}
            </label>
          ))}
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {running && progress.length > 0 && <pre className="rc-progress">{progress.join("\n")}</pre>}

      {job?.results && job.status === "complete" && (
        <div className="rc-results">
          <h4>
            {job.results.filter((r) => (r.findingCount ?? 0) > 0).length} of {job.results.length}{" "}
            documents have findings against the selected rules
          </h4>
          {job.results.map((r) => (
            <button
              key={r.recordId}
              className="rc-result"
              disabled={!r.runId}
              onClick={() => r.runId && onComplete(r.runId)}
            >
              <span className="rc-result-name">{r.docId ?? r.filename}</span>
              {r.error ? (
                <span className="rc-result-err">failed: {r.error}</span>
              ) : (
                <span className={`rc-result-count ${(r.findingCount ?? 0) > 0 ? "hit" : ""}`}>
                  {r.findingCount ?? 0} finding{r.findingCount === 1 ? "" : "s"}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
