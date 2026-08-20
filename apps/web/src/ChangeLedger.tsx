import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  AuthError,
  type Baseline,
  type Change,
  type ChangeType,
  type CumulativeAssessment,
  type Determination,
  type EffectiveScore,
  type RecordSummary,
  type Stage,
  type Submission,
  type SubmissionKind,
  type SubmissionStatus,
} from "./api";

/**
 * The cumulative change ledger.
 *
 * What this replaces is a spreadsheet: one row per change since clearance, a
 * 1-10 risk number, a running total, and a threshold that trips when the total
 * gets big enough. That spreadsheet is the industry's actual practice and it is
 * wrong in three ways this surface is built to fix.
 *
 *  1. It cannot separate "changed but undocumented" from "documented but not
 *     filed". The gauge stacks those as two distinct pools, because they are two
 *     distinct exposures, and only the first is the one an investigator finds by
 *     comparing the product to the design history.
 *  2. Its numbers have no provenance. Every score here shows whether a person
 *     confirmed it, a model suggested it, or the change type's floor is standing
 *     in — and the gauge reports how much of the total is still unconfirmed.
 *  3. It never resets. Clearing a submission re-baselines the device here, which
 *     is the only correct way for accumulation to start over.
 *
 * The one thing this surface still refuses to render is a submit / don't-submit
 * determination. When the threshold trips it reports that the CUSTOMER's own
 * change-control procedure requires a determination and none has been made —
 * a conformance statement about their SOP, not a regulatory call of ours.
 */

const CHANGE_TYPES: ChangeType[] = [
  "software",
  "labeling",
  "material",
  "component",
  "geometry",
  "performance_spec",
  "risk_control",
  "manufacturing_process",
  "other",
];

/**
 * Display labels for every enum this surface renders.
 *
 * These exist so nothing is shown by munging an enum value at the call site.
 * `changeType.replace(/_/g, " ")` produces "risk_control" → "risk control" in
 * one place and an uppercased variant in another, and the two drift apart the
 * moment a value is added. One map per enum, sentence case throughout.
 */
const DETERMINATION_LABEL: Record<Determination, string> = {
  undecided: "Undecided",
  letter_to_file: "Letter to file",
  new_submission: "New submission",
};

const CHANGE_TYPE_LABEL: Record<ChangeType, string> = {
  software: "Software",
  labeling: "Labeling",
  material: "Material",
  component: "Component",
  geometry: "Geometry",
  performance_spec: "Performance spec",
  risk_control: "Risk control",
  manufacturing_process: "Manufacturing process",
  other: "Other",
};

const STAGE_LABEL: Record<Stage, string> = {
  proposed: "Proposed",
  implemented: "In product",
  documented: "Documented",
  in_submission: "On a submission",
  cleared: "Cleared",
  superseded: "Superseded",
};

const SUBMISSION_STATUS_LABEL: Record<SubmissionStatus, string> = {
  planned: "Planned",
  filed: "Filed",
  // "Additional information request" is the FDA term; the short form is what
  // regulatory staff actually say, and the full phrase does not fit a status pill.
  additional_info: "AI request",
  cleared: "Cleared",
  withdrawn: "Withdrawn",
};

const GAP_LABEL: Record<string, string> = {
  wrong_comparator: "Wrong comparator",
  no_aggregate_assessment: "No aggregate assessment",
  unscored_change: "Not scored",
  unconfirmed_score: "Score unconfirmed",
  below_floor_no_rationale: "Below floor, no rationale",
  undocumented_aging: "Undocumented and aging",
};

/**
 * The board columns, in workflow order.
 *
 * Headings come from STAGE_LABEL so a column and a status pill for the same
 * stage can never disagree; the sub-line carries the plain-English consequence,
 * because a regulatory lead scanning this should read what state the company is
 * actually in, not the schema.
 */
const COLUMNS: { stage: Stage; sub: string; pool: "a" | "b" | null }[] = [
  { stage: "proposed", sub: "Not in the product yet", pool: null },
  { stage: "implemented", sub: "No controlled document", pool: "a" },
  { stage: "documented", sub: "Not on a submission", pool: "b" },
  { stage: "in_submission", sub: "Filed or being prepared", pool: null },
  { stage: "cleared", sub: "Folded into a new baseline", pool: null },
];

const SUBMISSION_KINDS: { value: SubmissionKind; label: string }[] = [
  { value: "special_510k", label: "Special 510(k)" },
  { value: "traditional_510k", label: "Traditional 510(k)" },
  { value: "abbreviated_510k", label: "Abbreviated 510(k)" },
  { value: "letter_to_file", label: "Letter to file" },
  { value: "pma_supplement", label: "PMA supplement" },
  { value: "other", label: "Other" },
];

const SCORE_SOURCE_LABEL: Record<EffectiveScore["source"], string> = {
  confirmed: "Confirmed",
  confirmed_below_floor: "Below floor, rationale on file",
  suggested: "Suggested, unconfirmed",
  floor: "Type floor — not scored",
};

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
}

export function ChangeLedger({ onAuthError }: { onAuthError: () => void }) {
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [assessment, setAssessment] = useState<CumulativeAssessment | null>(null);
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openChange, setOpenChange] = useState<string | null>(null);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) return onAuthError();
      setError((e as Error).message);
    },
    [onAuthError],
  );

  const refreshBaselines = useCallback(async () => {
    try {
      const list = await api.baselines();
      setBaselines(list);
      // Prefer a baseline nothing has superseded — that is the configuration
      // changes are currently accumulating against.
      setSelected((cur) => cur ?? (list.find((b) => !b.supersededBy) ?? list[0])?.baselineId ?? null);
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  useEffect(() => {
    void refreshBaselines();
    // Records are the documents a change can be marked documented against.
    api.records().then(setRecords).catch(() => setRecords([]));
  }, [refreshBaselines]);

  const loadAssessment = useCallback(
    async (baselineId: string) => {
      setError(null);
      try {
        setAssessment(await api.assessment(baselineId));
      } catch (e) {
        fail(e);
      }
    },
    [fail],
  );

  useEffect(() => {
    if (selected) void loadAssessment(selected);
  }, [selected, loadAssessment]);

  const reload = useCallback(async () => {
    if (selected) await loadAssessment(selected);
  }, [selected, loadAssessment]);

  const gapsByChange = useMemo(() => {
    const m = new Map<string, CumulativeAssessment["gaps"]>();
    for (const g of assessment?.gaps ?? []) {
      if (!m.has(g.changeId)) m.set(g.changeId, []);
      m.get(g.changeId)!.push(g);
    }
    return m;
  }, [assessment]);

  if (baselines.length === 0) {
    return (
      <div className="ledger">
        {error && <div className="error">{error}</div>}
        <CreateBaseline onCreated={refreshBaselines} onError={fail} />
      </div>
    );
  }

  const active = assessment?.changes.find((c) => c.changeId === openChange) ?? null;

  // An API process running code older than this tab returns an assessment with
  // no `pools`/`escalation`, and every risk surface below would throw on it —
  // turning a stale dev server into a blank tab with a console stack trace. The
  // tsx dev server does not hot-reload server code, so this is the single most
  // likely way this screen breaks. Say so, instead of dying.
  const staleApi = assessment !== null && assessment.pools === undefined;

  return (
    <div className="ledger">
      {error && <div className="error">{error}</div>}

      <div className="ledger-bar">
        <select value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
          {baselines.map((b) => (
            <option key={b.baselineId} value={b.baselineId}>
              {b.device} — cleared {b.clearanceId}
              {b.supersededBy ? " (superseded)" : ""}
            </option>
          ))}
        </select>
      </div>

      {staleApi && (
        <div className="error">
          This API is running an older build: it returned a change assessment with no
          risk totals. Restart the API server — the tsx dev server does not reload
          server code on edit (<code>npm run dev:server</code>).
        </div>
      )}

      {assessment && !staleApi && (
        <>
          <RiskGauge assessment={assessment} onThresholdSaved={reload} onError={fail} />

          <StageBoard
            assessment={assessment}
            gapsByChange={gapsByChange}
            openChange={openChange}
            onOpen={(id) => setOpenChange((cur) => (cur === id ? null : id))}
          />

          {active && (
            <ChangeDetail
              change={active}
              gaps={gapsByChange.get(active.changeId) ?? []}
              records={records}
              onChanged={reload}
              onClose={() => setOpenChange(null)}
              onError={fail}
            />
          )}

          <Submissions
            assessment={assessment}
            onChanged={async () => {
              await refreshBaselines();
              await reload();
            }}
            onError={fail}
          />

          <AddChange
            baselineId={assessment.baseline.baselineId}
            onAdded={reload}
            onError={fail}
          />

          <p className="muted ledger-disclaimer">
            This ledger totals risk against the threshold in <em>your</em> change-control
            procedure and flags gaps in how changes were assessed. It does not
            determine whether a change requires a new submission — that is the
            manufacturer's call under 21 CFR 807.81(a)(3), recorded per change above.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The hero: accumulated risk, stacked by stage, against the customer's threshold.
 *
 * The two solid segments are exposure. The hatched one is the pipeline — changes
 * proposed but not yet in the product — drawn past the exposure so the question
 * "where does this land if everything we have planned ships?" is answered in the
 * same glance as "where are we now". That forward view is the one thing a
 * running total in a spreadsheet can never show.
 */
function RiskGauge({
  assessment,
  onThresholdSaved,
  onError,
}: {
  assessment: CumulativeAssessment;
  onThresholdSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const { pools, escalation, baseline } = assessment;
  const [editing, setEditing] = useState(false);

  // Scale so the threshold sits at ~70% of the track. A crossed threshold then
  // has visible room to overflow into instead of pinning at the end, which is
  // exactly the state the reader most needs to judge the size of.
  const scaleMax = Math.max(pools.projected, baseline.threshold * 1.4, 1);
  const pct = (v: number) => `${(v / scaleMax) * 100}%`;
  const thresholdAt = (baseline.threshold / scaleMax) * 100;

  return (
    <div className={`gauge-panel ${escalation.crossed ? "crossed" : ""}`}>
      <div className="gauge-head">
        <div className="gauge-headline">
          <span className="gauge-value">{pools.exposure}</span>
          <span className="gauge-of">of {baseline.threshold}</span>
          <span className="gauge-caption">
            accumulated risk since {baseline.clearanceId}
          </span>
        </div>
        <button className="link-btn" onClick={() => setEditing((v) => !v)}>
          {editing ? "Cancel" : "Threshold settings"}
        </button>
      </div>

      {editing && (
        <ThresholdEditor
          baseline={baseline}
          onSaved={() => {
            setEditing(false);
            onThresholdSaved();
          }}
          onError={onError}
        />
      )}

      <div className="gauge-track">
        <div className="gauge-seg seg-undoc" style={{ width: pct(pools.undocumented) }} />
        <div className="gauge-seg seg-unsub" style={{ width: pct(pools.unsubmitted) }} />
        <div className="gauge-seg seg-pipe" style={{ width: pct(pools.pipeline) }} />
        <div
          // Near the right edge the label would run off the panel, so it flips
          // to the inside of the marker instead of being clipped.
          className={`gauge-threshold ${thresholdAt > 80 ? "near-end" : ""}`}
          style={{ left: `${thresholdAt}%` }}
        >
          <span className="gauge-threshold-label">Threshold {baseline.threshold}</span>
        </div>
      </div>

      <div className="gauge-legend">
        <span className="legend-item">
          <i className="swatch seg-undoc" /> {pools.undocumented} in product, undocumented
        </span>
        <span className="legend-item">
          <i className="swatch seg-unsub" /> {pools.unsubmitted} documented, not filed
        </span>
        {pools.pipeline > 0 && (
          <span className="legend-item">
            <i className="swatch seg-pipe" /> {pools.pipeline} proposed → would reach{" "}
            {pools.projected}
          </span>
        )}
      </div>

      <div className={`gauge-message ${escalation.crossed ? "crossed" : ""}`}>
        {escalation.message}
      </div>

      {/* The credibility check. A total resting largely on unconfirmed model
          suggestions should say so next to itself, not in a footnote. */}
      {pools.unconfirmed > 0 && (
        <div className="gauge-unconfirmed">
          {pools.unconfirmed} of those {pools.exposure} points come from scores no reviewer
          has confirmed.
        </div>
      )}
    </div>
  );
}

function ThresholdEditor({
  baseline,
  onSaved,
  onError,
}: {
  baseline: Baseline;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [threshold, setThreshold] = useState(String(baseline.threshold));
  const [source, setSource] = useState(baseline.thresholdSource ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.setThreshold(baseline.baselineId, Number(threshold), source.trim() || null);
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="threshold-editor">
      <p className="muted">
        This threshold is <strong>yours</strong>, not ours and not FDA's. Set it to the
        escalation point in your change-control procedure, and cite the procedure —
        the citation is what makes the escalation defensible when someone asks
        where the number came from.
      </p>
      <div className="threshold-fields">
        <label className="field">
          Escalate at
          <input
            type="number"
            min={1}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </label>
        <label className="field grow">
          Procedure citation
          <input
            placeholder="e.g. QSP-0031 §5.4"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
        </label>
        <button className="primary" disabled={busy || !threshold} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function StageBoard({
  assessment,
  gapsByChange,
  openChange,
  onOpen,
}: {
  assessment: CumulativeAssessment;
  gapsByChange: Map<string, CumulativeAssessment["gaps"]>;
  openChange: string | null;
  onOpen: (id: string) => void;
}) {
  const byStage = useMemo(() => {
    const m = new Map<Stage, Change[]>();
    for (const c of assessment.changes) {
      if (!m.has(c.stage)) m.set(c.stage, []);
      m.get(c.stage)!.push(c);
    }
    return m;
  }, [assessment]);

  return (
    <div className="stage-board">
      {COLUMNS.map((col) => {
        const list = byStage.get(col.stage) ?? [];
        const points = list.reduce((t, c) => t + (c.effective?.value ?? 0), 0);
        return (
          <div key={col.stage} className={`stage-col pool-${col.pool ?? "none"}`}>
            <div className="stage-col-head">
              <span className="stage-col-label">{STAGE_LABEL[col.stage]}</span>
              <span className="stage-col-count">
                {list.length}
                {col.pool && points > 0 ? ` · ${points} pts` : ""}
              </span>
            </div>
            <div className="stage-col-sub">{col.sub}</div>
            <div className="stage-col-body">
              {list.length === 0 && <div className="stage-empty">—</div>}
              {list.map((c) => (
                <ChangeCard
                  key={c.changeId}
                  change={c}
                  gapCount={(gapsByChange.get(c.changeId) ?? []).length}
                  open={openChange === c.changeId}
                  onOpen={() => onOpen(c.changeId)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChangeCard({
  change,
  gapCount,
  open,
  onOpen,
}: {
  change: Change;
  gapCount: number;
  open: boolean;
  onOpen: () => void;
}) {
  const eff = change.effective;
  const source = eff?.source ?? "floor";
  const age = change.stage === "implemented" ? daysSince(change.implementedAt ?? change.changedAt) : null;

  return (
    <button className={`change-card ${open ? "open" : ""}`} onClick={onOpen}>
      <div className="cc-top">
        <span className={`cc-score src-${source}`} title={SCORE_SOURCE_LABEL[source]}>
          {eff?.value ?? "?"}
        </span>
        <span className="cc-type">{CHANGE_TYPE_LABEL[change.changeType]}</span>
        {gapCount > 0 && <span className="cc-gaps">{gapCount}</span>}
      </div>
      <div className="cc-proposal">{change.proposal}</div>
      <div className="cc-foot">
        {change.subsystem && <span className="cc-sub">{change.subsystem}</span>}
        {/* Age only shows where it means something: a change sitting in the
            product without a document is the one that gets worse with time. */}
        {age !== null && age > 0 && (
          <span className={`cc-age ${age >= 90 ? "hot" : ""}`}>{age}d undocumented</span>
        )}
      </div>
    </button>
  );
}

/**
 * The detail panel: everything about one change, and every action on it.
 *
 * Kept as a panel below the board rather than a modal so the gauge and the
 * board stay visible while a score is edited — the point of editing a score is
 * to watch what it does to the total.
 */
function ChangeDetail({
  change,
  gaps,
  records,
  onChanged,
  onClose,
  onError,
}: {
  change: Change;
  gaps: CumulativeAssessment["gaps"];
  records: RecordSummary[];
  onChanged: () => void;
  onClose: () => void;
  onError: (e: unknown) => void;
}) {
  const eff = change.effective;
  const floor = eff?.floor ?? 1;

  const [score, setScore] = useState(String(change.score ?? eff?.value ?? floor));
  const [rationale, setRationale] = useState(change.belowFloorRationale ?? "");
  const [recordId, setRecordId] = useState(change.recordId ?? "");
  const [busy, setBusy] = useState<string | null>(null);

  // Re-seed when a different change is opened.
  useEffect(() => {
    setScore(String(change.score ?? change.effective?.value ?? floor));
    setRationale(change.belowFloorRationale ?? "");
    setRecordId(change.recordId ?? "");
  }, [change.changeId, change.score, change.effective?.value, change.belowFloorRationale, change.recordId, floor]);

  const numeric = Number(score);
  const belowFloor = Number.isFinite(numeric) && numeric < floor;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="change-detail">
      <div className="cd-head">
        <span className="chip cat">{CHANGE_TYPE_LABEL[change.changeType]}</span>
        {change.subsystem && <span className="cd-sub">{change.subsystem}</span>}
        <span className="cd-date">{change.changedAt ?? change.createdAt.slice(0, 10)}</span>
        <button className="link-btn" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="cd-proposal">{change.proposal}</div>
      {change.comparator && (
        <div className="change-comparator">Compared against {change.comparator}</div>
      )}

      {/* --- Scoring --- */}
      <div className="cd-section">
        <h4>Risk score</h4>
        <div className="cd-score-row">
          <input
            type="number"
            min={1}
            max={10}
            value={score}
            onChange={(e) => setScore(e.target.value)}
          />
          <span className={`cd-src src-${eff?.source ?? "floor"}`}>
            {SCORE_SOURCE_LABEL[eff?.source ?? "floor"]}
          </span>
          <button
            disabled={busy !== null || (belowFloor && !rationale.trim())}
            onClick={() =>
              void run("score", () =>
                api.setScore(change.changeId, numeric, belowFloor ? rationale : undefined),
              )
            }
          >
            {busy === "score" ? "Saving…" : "Confirm score"}
          </button>
          <button
            className="secondary"
            disabled={busy !== null}
            onClick={() => void run("suggest", () => api.suggestScore(change.changeId))}
            title="Ask the model to read the proposal and suggest a score. It cannot set the score."
          >
            {busy === "suggest" ? "Thinking…" : "Suggest a score"}
          </button>
        </div>

        <div className="cd-floor">
          Floor for this change type: <strong>{floor}</strong>. {eff?.floorReason}
        </div>

        {belowFloor && (
          <div className="cd-below-floor">
            <label>
              Going below the floor requires a documented rationale — the FDA change
              guidance rebuts its own presumption only on the record. Without one the
              floor of {floor} is what counts toward the total.
              <textarea
                rows={3}
                placeholder="Why is this change less significant than its type presumes?"
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
              />
            </label>
          </div>
        )}

        {change.suggestedScore !== null && (
          <div className="cd-suggestion">
            <div className="cd-suggestion-head">
              Model suggested <strong>{change.suggestedScore}</strong>
              {change.score !== null && " — superseded by your confirmed score"}
            </div>
            {change.suggestedRationale && (
              <div className="cd-suggestion-body">{change.suggestedRationale}</div>
            )}
            <div className="muted cd-suggestion-note">
              A suggestion, not a finding: a typed change has no controlled document to
              quote, so this is not held to the same evidence bar as a review finding.
              Confirm or correct it.
            </div>
          </div>
        )}

        {change.scoredBy && (
          <div className="muted">
            Confirmed by {change.scoredBy}
            {change.scoredAt ? ` on ${change.scoredAt.slice(0, 10)}` : ""}.
          </div>
        )}
      </div>

      {/* --- Workflow --- */}
      <div className="cd-section">
        <h4>Workflow</h4>
        {change.stage === "proposed" && (
          <button
            disabled={busy !== null}
            onClick={() => void run("stage", () => api.advanceStage(change.changeId, "implemented"))}
          >
            {busy === "stage" ? "Working…" : "Mark implemented (it is in the product)"}
          </button>
        )}

        {change.stage === "implemented" && (
          <div className="cd-document">
            <p className="muted">
              Mark this documented by pointing at the controlled document that captures
              it. Upload the document in the Documents tab first if it is not listed.
            </p>
            <div className="cd-document-row">
              <select value={recordId} onChange={(e) => setRecordId(e.target.value)}>
                <option value="">Select the document…</option>
                {records.map((r) => (
                  <option key={r.recordId} value={r.recordId}>
                    {r.docId ? `${r.docId} — ` : ""}
                    {r.filename}
                  </option>
                ))}
              </select>
              <button
                disabled={busy !== null || !recordId}
                onClick={() =>
                  void run("stage", () =>
                    api.advanceStage(change.changeId, "documented", recordId),
                  )
                }
              >
                {busy === "stage" ? "Working…" : "Mark documented"}
              </button>
            </div>
          </div>
        )}

        {change.stage === "documented" && (
          <p className="muted">
            Ready for a submission. Add it to one in the Submissions section below.
          </p>
        )}

        {change.stage === "in_submission" && (
          <p className="muted">
            Carried on a submission. It leaves the accumulated total when that
            submission is recorded as cleared.
          </p>
        )}

        {change.stage === "cleared" && (
          <p className="muted">Cleared. This change is part of the current baseline.</p>
        )}

        <div className="cd-determination">
          <label className="field">
            Regulatory determination
            <select
              value={change.determination}
              onChange={(e) =>
                void run("det", () =>
                  api.setDetermination(change.changeId, e.target.value as Determination),
                )
              }
              title="The manufacturer's determination — set by you, never by the tool"
            >
              {(["undecided", "letter_to_file", "new_submission"] as Determination[]).map((d) => (
                <option key={d} value={d}>
                  {DETERMINATION_LABEL[d]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* --- Gaps --- */}
      {gaps.length > 0 && (
        <div className="cd-section">
          <h4>Gaps ({gaps.length})</h4>
          {gaps.map((g) => (
            <div key={g.gapId} className="gap-row">
              <span className="gap-kind">{GAP_LABEL[g.kind] ?? g.kind}</span>
              <span>{g.detail}</span>
            </div>
          ))}
        </div>
      )}

      {/* --- Flowchart branches --- */}
      {change.branches && change.branches.length > 0 && (
        <div className="cd-section">
          <h4>Questions the FDA change flowcharts raise</h4>
          <p className="muted">
            Listed, not answered. Answering them is the determination above.
          </p>
          {change.branches.map((b, i) => (
            <div key={i} className="branch-row">
              <code>
                {b.chart}/{b.step}
              </code>
              <span>{b.consider}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Submissions: the loop that lets the total come back down.
 *
 * Recording a clearance is the only thing in this product that resets
 * accumulated risk, and it does it the correct way — by minting a successor
 * baseline that later changes are compared against, rather than by zeroing a
 * counter and leaving every future comparison pointed at a stale clearance.
 */
function Submissions({
  assessment,
  onChanged,
  onError,
}: {
  assessment: CumulativeAssessment;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<SubmissionKind>("special_510k");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const eligible = assessment.changes.filter((c) => c.stage === "documented");
  const pickedPoints = eligible
    .filter((c) => picked.has(c.changeId))
    .reduce((t, c) => t + (c.effective?.value ?? 0), 0);

  const create = async () => {
    setBusy(true);
    try {
      await api.createSubmission(assessment.baseline.baselineId, {
        title,
        kind,
        changeIds: [...picked],
      });
      setTitle("");
      setPicked(new Set());
      setOpen(false);
      onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="submissions">
      <div className="submissions-head">
        <h3>Submissions</h3>
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "+ New submission"}
        </button>
      </div>

      {assessment.submissions.length === 0 && !open && (
        <p className="muted">
          Nothing filed against this baseline yet. Changes leave the accumulated total
          only when a submission carrying them is recorded as cleared.
        </p>
      )}

      {assessment.submissions.map((s) => (
        <SubmissionRow
          key={s.submissionId}
          submission={s}
          carried={assessment.changes.filter((c) => c.submissionId === s.submissionId)}
          onChanged={onChanged}
          onError={onError}
        />
      ))}

      {open && (
        <div className="new-submission">
          <div className="ns-fields">
            <input
              className="grow"
              placeholder="Title (e.g. VP-400 occlusion-detection changes 2021-2026)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <select value={kind} onChange={(e) => setKind(e.target.value as SubmissionKind)}>
              {SUBMISSION_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
          <p className="muted">
            Choose which documented changes this carries. Only documented changes are
            eligible — putting an undocumented change on a submission would take it out
            of the total on a promise.
          </p>
          {eligible.length === 0 && (
            <p className="muted">No documented changes are waiting.</p>
          )}
          {eligible.map((c) => (
            <label key={c.changeId} className="ns-change">
              <input
                type="checkbox"
                checked={picked.has(c.changeId)}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(c.changeId);
                    else next.delete(c.changeId);
                    return next;
                  })
                }
              />
              <span className={`cc-score src-${c.effective?.source ?? "floor"}`}>
                {c.effective?.value ?? "?"}
              </span>
              <span>{c.proposal}</span>
            </label>
          ))}
          <div className="ns-actions">
            <button className="primary" disabled={busy || !title || picked.size === 0} onClick={() => void create()}>
              {busy ? "Creating…" : `Create submission (${picked.size} changes, ${pickedPoints} pts)`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SubmissionRow({
  submission,
  carried,
  onChanged,
  onError,
}: {
  submission: Submission;
  carried: Change[];
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [clearanceId, setClearanceId] = useState("");
  const [busy, setBusy] = useState(false);
  const points = carried.reduce((t, c) => t + (c.effective?.value ?? 0), 0);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`submission-row st-${submission.status}`}>
      <div className="sr-head">
        <span className="sr-title">{submission.title}</span>
        <span className="chip">{SUBMISSION_KINDS.find((k) => k.value === submission.kind)?.label}</span>
        <span className={`sr-status st-${submission.status}`}>
          {SUBMISSION_STATUS_LABEL[submission.status]}
        </span>
      </div>
      <div className="sr-meta">
        {carried.length} change{carried.length === 1 ? "" : "s"} · {points} pts
        {submission.filedAt ? ` · filed ${submission.filedAt.slice(0, 10)}` : ""}
        {submission.clearanceId ? ` · cleared as ${submission.clearanceId}` : ""}
      </div>

      {submission.status === "planned" && (
        <button
          className="primary"
          disabled={busy}
          onClick={() => void act(() => api.setSubmissionStatus(submission.submissionId, { status: "filed" }))}
        >
          Record as filed
        </button>
      )}

      {(submission.status === "filed" || submission.status === "additional_info") && (
        <div className="sr-clear">
          <input
            placeholder="Clearance number from the FDA letter (e.g. K261188)"
            value={clearanceId}
            onChange={(e) => setClearanceId(e.target.value)}
          />
          <button
            disabled={busy || !clearanceId.trim()}
            onClick={() =>
              void act(() =>
                api.setSubmissionStatus(submission.submissionId, {
                  status: "cleared",
                  clearanceId: clearanceId.trim(),
                }),
              )
            }
            title="Records the clearance and establishes a new baseline. Entered from the letter, never assumed."
          >
            Record clearance
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void act(() =>
                api.setSubmissionStatus(submission.submissionId, { status: "additional_info" }),
              )
            }
          >
            Record AI request
          </button>
        </div>
      )}

      {submission.status === "cleared" && (
        <p className="muted">
          These changes are now part of the cleared configuration. Accumulation restarts
          against {submission.clearanceId}.
        </p>
      )}
    </div>
  );
}

function CreateBaseline({
  onCreated,
  onError,
}: {
  onCreated: () => void;
  onError: (e: unknown) => void;
}) {
  const [device, setDevice] = useState("");
  const [clearanceId, setClearanceId] = useState("");
  const [clearedAt, setClearedAt] = useState("");
  const [threshold, setThreshold] = useState("30");
  const [thresholdSource, setThresholdSource] = useState("");

  const submit = async () => {
    try {
      await api.createBaseline({
        device,
        clearanceId,
        ...(clearedAt ? { clearedAt } : {}),
        ...(threshold ? { threshold: Number(threshold) } : {}),
        ...(thresholdSource ? { thresholdSource } : {}),
      });
      setDevice("");
      setClearanceId("");
      setClearedAt("");
      onCreated();
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="create-baseline">
      <h2>Establish a cleared baseline</h2>
      <p className="muted">
        The change ledger accumulates every change against a device's cleared
        configuration — its 510(k) number — and totals the risk against the escalation
        threshold in your own change-control procedure. Enter both to begin.
      </p>
      <input placeholder="Device (e.g. VP-400 Volumetric Infusion Pump)" value={device} onChange={(e) => setDevice(e.target.value)} />
      <input placeholder="Clearance number (e.g. K192214)" value={clearanceId} onChange={(e) => setClearanceId(e.target.value)} />
      <input placeholder="Cleared date (optional, YYYY-MM-DD)" value={clearedAt} onChange={(e) => setClearedAt(e.target.value)} />
      <input placeholder="Escalation threshold (your procedure's number)" type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
      <input placeholder="Procedure citation (e.g. QSP-0031 §5.4)" value={thresholdSource} onChange={(e) => setThresholdSource(e.target.value)} />
      <button className="primary" disabled={!device || !clearanceId} onClick={() => void submit()}>
        Create baseline
      </button>
    </div>
  );
}

function AddChange({
  baselineId,
  onAdded,
  onError,
}: {
  baselineId: string;
  onAdded: () => void;
  onError: (e: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [proposal, setProposal] = useState("");
  const [comparator, setComparator] = useState("");
  const [subsystem, setSubsystem] = useState("");
  const [changeType, setChangeType] = useState<ChangeType>("other");
  const [changedAt, setChangedAt] = useState("");
  const [stage, setStage] = useState<Stage>("implemented");

  if (!open) {
    return (
      <button className="add-change-btn" onClick={() => setOpen(true)}>
        + Record a change
      </button>
    );
  }

  const submit = async () => {
    try {
      await api.addChange(baselineId, {
        proposal,
        changeType,
        stage,
        ...(comparator ? { comparator } : {}),
        ...(subsystem ? { subsystem } : {}),
        ...(changedAt ? { changedAt } : {}),
      });
      setProposal("");
      setComparator("");
      setSubsystem("");
      setChangedAt("");
      setChangeType("other");
      setOpen(false);
      onAdded();
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="add-change">
      <h3>Record a change</h3>
      <p className="muted">
        Describe the change as you would to a colleague. The tool will flag gaps
        deterministically and can suggest a risk score; it will not decide whether
        the change needs a submission.
      </p>
      <textarea placeholder="What is changing, and why?" value={proposal} onChange={(e) => setProposal(e.target.value)} rows={3} />
      <div className="add-change-fields">
        <select value={changeType} onChange={(e) => setChangeType(e.target.value as ChangeType)}>
          {CHANGE_TYPES.map((t) => (
            <option key={t} value={t}>
              {CHANGE_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        {/* Which of the two it is decides which risk pool it lands in, so it is
            asked up front rather than defaulted and corrected later. */}
        <select value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
          <option value="proposed">Proposed — not in the product yet</option>
          <option value="implemented">Already in the product</option>
        </select>
        <input placeholder="Subsystem (e.g. occlusion detection)" value={subsystem} onChange={(e) => setSubsystem(e.target.value)} />
        <input placeholder="Compared against (e.g. K192214)" value={comparator} onChange={(e) => setComparator(e.target.value)} />
        <input placeholder="Date (YYYY-MM-DD)" value={changedAt} onChange={(e) => setChangedAt(e.target.value)} />
      </div>
      <div className="add-change-actions">
        <button className="primary" disabled={!proposal} onClick={() => void submit()}>
          Add change
        </button>
        <button className="secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
