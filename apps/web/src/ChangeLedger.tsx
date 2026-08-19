import { useCallback, useEffect, useState } from "react";
import {
  api,
  AuthError,
  type Baseline,
  type Change,
  type ChangeType,
  type CumulativeAssessment,
  type Determination,
} from "./api";

/**
 * The cumulative change ledger.
 *
 * Ben Cass's "informal submission" ask, reshaped so it cannot emit the one
 * output that would sink it: the submit / don't-submit determination is the
 * manufacturer's statutory call, so this surface never renders it. It shows the
 * accumulation of changes since a device's clearance, the deterministic gaps in
 * their justification, and the decision-flowchart questions each change raises —
 * and leaves the determination to a person, one change at a time.
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

const DETERMINATION_LABEL: Record<Determination, string> = {
  undecided: "Undecided",
  letter_to_file: "Letter to file",
  new_submission: "New submission",
};

const GAP_LABEL: Record<string, string> = {
  wrong_comparator: "Wrong comparator",
  no_aggregate_assessment: "No aggregate assessment",
};

export function ChangeLedger({ onAuthError }: { onAuthError: () => void }) {
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [assessment, setAssessment] = useState<CumulativeAssessment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
      setSelected((cur) => cur ?? list[0]?.baselineId ?? null);
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  useEffect(() => {
    void refreshBaselines();
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

  const setDetermination = async (changeId: string, determination: Determination) => {
    try {
      await api.setDetermination(changeId, determination);
      if (selected) await loadAssessment(selected);
    } catch (e) {
      fail(e);
    }
  };

  if (baselines.length === 0) {
    return (
      <div className="ledger">
        {error && <div className="error">{error}</div>}
        <CreateBaseline onCreated={refreshBaselines} onError={fail} />
      </div>
    );
  }

  const gapsByChange = new Map<string, CumulativeAssessment["gaps"]>();
  for (const g of assessment?.gaps ?? []) {
    if (!gapsByChange.has(g.changeId)) gapsByChange.set(g.changeId, []);
    gapsByChange.get(g.changeId)!.push(g);
  }

  return (
    <div className="ledger">
      {error && <div className="error">{error}</div>}

      <div className="ledger-bar">
        <select value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
          {baselines.map((b) => (
            <option key={b.baselineId} value={b.baselineId}>
              {b.device} — cleared {b.clearanceId}
            </option>
          ))}
        </select>
      </div>

      {assessment && (
        <>
          <div className="ledger-summary">
            <div>
              <span className="ls-num">{assessment.totalChanges}</span> changes since clearance{" "}
              <code>{assessment.baseline.clearanceId}</code>
              {assessment.baseline.clearedAt ? ` (${assessment.baseline.clearedAt})` : ""}
            </div>
            <div>
              <span className="ls-num">{assessment.undecided}</span> undecided
            </div>
            <div>
              <span className="ls-num">{assessment.gaps.length}</span> deterministic gap(s)
            </div>
          </div>

          {/* The whole point: individually benign, collectively significant. */}
          {assessment.clusters.length > 0 && (
            <div className="ledger-clusters">
              <span className="filter-label">Subsystems touched</span>
              {assessment.clusters.map((c) => (
                <span key={c.subsystem} className={`chip ${c.count > 1 ? "cluster-hot" : ""}`}>
                  {c.subsystem} · {c.count}
                </span>
              ))}
            </div>
          )}

          {/* Ledger-level gaps (the aggregate-assessment condition). */}
          {assessment.gaps.some((g) => g.kind === "no_aggregate_assessment") && (
            <div className="ledger-gaps">
              {assessment.gaps
                .filter((g) => g.kind === "no_aggregate_assessment")
                .map((g) => (
                  <div key={g.gapId} className="gap-row gap-aggregate">
                    <span className="gap-kind">{GAP_LABEL[g.kind] ?? g.kind}</span>
                    <span>{g.detail}</span>
                  </div>
                ))}
            </div>
          )}

          <div className="ledger-changes">
            {assessment.changes.map((c) => (
              <ChangeRow
                key={c.changeId}
                change={c}
                gaps={gapsByChange.get(c.changeId)?.filter((g) => g.kind !== "no_aggregate_assessment") ?? []}
                expanded={expanded.has(c.changeId)}
                onToggle={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(c.changeId)) next.delete(c.changeId);
                    else next.add(c.changeId);
                    return next;
                  })
                }
                onDetermination={(d) => void setDetermination(c.changeId, d)}
              />
            ))}
          </div>

          <p className="muted ledger-disclaimer">
            This ledger flags gaps and lists the questions the FDA change-decision
            flowcharts would ask. It does not answer them: whether a change needs a
            new submission is the manufacturer's determination, set per change above.
          </p>

          <AddChange
            baselineId={assessment.baseline.baselineId}
            onAdded={() => void loadAssessment(assessment.baseline.baselineId)}
            onError={fail}
          />
        </>
      )}
    </div>
  );
}

function ChangeRow({
  change,
  gaps,
  expanded,
  onToggle,
  onDetermination,
}: {
  change: Change;
  gaps: CumulativeAssessment["gaps"];
  expanded: boolean;
  onToggle: () => void;
  onDetermination: (d: Determination) => void;
}) {
  return (
    <div className={`change-row ${gaps.length > 0 ? "has-gap" : ""}`}>
      <div className="change-head">
        <span className="change-date">{change.changedAt ?? change.createdAt.slice(0, 10)}</span>
        <span className="chip cat">{change.changeType}</span>
        {change.subsystem && <span className="change-subsystem">{change.subsystem}</span>}
        <select
          className="determination"
          value={change.determination}
          onChange={(e) => onDetermination(e.target.value as Determination)}
          title="The manufacturer's determination — set by you, never by the tool"
        >
          {(["undecided", "letter_to_file", "new_submission"] as Determination[]).map((d) => (
            <option key={d} value={d}>
              {DETERMINATION_LABEL[d]}
            </option>
          ))}
        </select>
      </div>
      <div className="change-proposal">{change.proposal}</div>
      {change.comparator && (
        <div className="change-comparator">compared against: {change.comparator}</div>
      )}

      {gaps.map((g) => (
        <div key={g.gapId} className="gap-row">
          <span className="gap-kind">{GAP_LABEL[g.kind] ?? g.kind}</span>
          <span>{g.detail}</span>
        </div>
      ))}

      {change.branches && change.branches.length > 0 && (
        <button className="branch-toggle" onClick={onToggle}>
          {expanded ? "Hide" : "Show"} {change.branches.length} question(s) to consider
        </button>
      )}
      {expanded &&
        change.branches?.map((b, i) => (
          <div key={i} className="branch-row">
            <code>
              {b.chart}/{b.step}
            </code>{" "}
            {b.consider}
          </div>
        ))}
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

  const submit = async () => {
    try {
      await api.createBaseline({
        device,
        clearanceId,
        ...(clearedAt ? { clearedAt } : {}),
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
        The change ledger compares every change against a device's cleared
        configuration — its 510(k) number. Enter that baseline to begin.
      </p>
      <input placeholder="Device (e.g. VP-400 Volumetric Infusion Pump)" value={device} onChange={(e) => setDevice(e.target.value)} />
      <input placeholder="Clearance number (e.g. K192214)" value={clearanceId} onChange={(e) => setClearanceId(e.target.value)} />
      <input placeholder="Cleared date (optional, YYYY-MM-DD)" value={clearedAt} onChange={(e) => setClearedAt(e.target.value)} />
      <button disabled={!device || !clearanceId} onClick={() => void submit()}>
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

  if (!open) {
    return (
      <button className="add-change-btn" onClick={() => setOpen(true)}>
        + Record a proposed change
      </button>
    );
  }

  const submit = async () => {
    try {
      await api.addChange(baselineId, {
        proposal,
        changeType,
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
      <h3>Record a proposed change</h3>
      <p className="muted">
        Describe the change as you would to a colleague. The tool will flag gaps
        deterministically; it will not decide whether it needs a submission.
      </p>
      <textarea placeholder="What is changing, and why?" value={proposal} onChange={(e) => setProposal(e.target.value)} rows={3} />
      <div className="add-change-fields">
        <select value={changeType} onChange={(e) => setChangeType(e.target.value as ChangeType)}>
          {CHANGE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input placeholder="Subsystem (e.g. occlusion detection)" value={subsystem} onChange={(e) => setSubsystem(e.target.value)} />
        <input placeholder="Compared against (e.g. K192214)" value={comparator} onChange={(e) => setComparator(e.target.value)} />
        <input placeholder="Date (YYYY-MM-DD)" value={changedAt} onChange={(e) => setChangedAt(e.target.value)} />
      </div>
      <div className="add-change-actions">
        <button disabled={!proposal} onClick={() => void submit()}>
          Add change
        </button>
        <button className="secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
