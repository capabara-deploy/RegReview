import { useEffect, useState } from "react";
import { api, type Finding, type PurposeLevel, type RecordDetail, type RunSummary } from "./api";
import { SEVERITY_MARK } from "./highlight";

/**
 * The top of a review's results: what the document is, the few problems that
 * matter most, and whether it appears to do its job.
 *
 * Exists because reviewers said a list of a dozen findings is hard to read as
 * a whole. Every issue here links to the findings it summarises — the summary
 * can only compress what the review found (the server drops any issue that
 * cites no real finding), so the way to check it is one click away.
 *
 * The purpose answer is deliberately worded as a reading of the review, with
 * the caveat always visible: whether the document is acceptable is the
 * manufacturer's decision, and this must never read as a compliance verdict.
 */

const PURPOSE_LABEL: Record<PurposeLevel, string> = {
  supports: "Appears to do its job",
  partly: "Does its job only in part",
  does_not: "Does not yet do its job",
  cannot_tell: "Can't tell from this review",
};

export function RunSummaryCard({
  record,
  runId,
  findings,
  onSelectFinding,
}: {
  record: RecordDetail;
  runId: string | null;
  findings: Finding[];
  onSelectFinding: (findingId: string) => void;
}) {
  const [summary, setSummary] = useState<{ runId: string; data: RunSummary } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  // Rejecting or restoring a finding changes what the summary should rest on;
  // the server rewrites it then, so re-fetch when that set changes.
  const rejectedKey = findings
    .filter((f) => f.status === "rejected")
    .map((f) => f.findingId)
    .sort()
    .join(",");
  const run = record.runs.find((r) => r.runId === runId);
  const complete = run?.status === "complete";

  useEffect(() => {
    if (!runId || !complete) return;
    let alive = true;
    setError(null);
    api
      .runSummary(runId)
      .then((data) => alive && setSummary({ runId, data }))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [runId, complete, rejectedKey]);

  const current = summary?.runId === runId ? summary.data : null;
  const numberOf = (id: string): number => findings.findIndex((f) => f.findingId === id) + 1;

  return (
    <section className="run-summary" aria-label="Review summary">
      <div className="rs-head">
        <div className="rs-about">
          {record.description ? (
            <>
              <span className="rs-kind">{record.description.label}</span>
              <span className="rs-desc">{record.description.summary}</span>
            </>
          ) : (
            <span className="rs-desc muted">No description of this document yet.</span>
          )}
        </div>
        {complete && (
          <button className="link rs-toggle" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide summary" : "Show summary"}
          </button>
        )}
      </div>

      {complete && open && (
        <div className="rs-body">
          {error && <p className="rs-note">Summary unavailable: {error}</p>}
          {!error && !current && <p className="rs-note muted">Summarising this review…</p>}
          {current && (
            <>
              <div className="rs-purpose">
                <span className={`rs-verdict v-${current.purpose}`}>{PURPOSE_LABEL[current.purpose]}</span>
                <span className="rs-reason">
                  {current.purposeReason}
                  {current.purposeCappedBy && (
                    <span className="muted"> (Capped because {current.purposeCappedBy}.)</span>
                  )}
                </span>
              </div>

              {current.issues.length > 0 ? (
                <ol className="rs-issues">
                  {current.issues.map((issue, i) => (
                    <li key={i}>
                      <strong>{issue.headline}</strong> <span className="rs-why">{issue.why}</span>
                      <span className="rs-refs">
                        {issue.findingIds.map((id) => {
                          const f = findings.find((x) => x.findingId === id);
                          if (!f) return null;
                          return (
                            <button
                              key={id}
                              className={`rs-ref sev-${f.severity}`}
                              onClick={() => onSelectFinding(id)}
                              title={f.problem}
                            >
                              <span aria-hidden="true">{SEVERITY_MARK[f.severity]}</span> Finding {numberOf(id)}
                            </button>
                          );
                        })}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="rs-note muted">No issues to summarise from this review.</p>
              )}

              <p className="rs-caveat">
                A plain-language reading of this review's findings, not a compliance determination —
                whether the document is acceptable is your decision.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
