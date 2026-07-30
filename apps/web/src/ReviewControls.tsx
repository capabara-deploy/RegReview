import { useCallback, useRef, useState } from "react";
import { api, type RecordSummary } from "./api";

/**
 * Start a review of the open document.
 *
 * A review sends document text to the model and costs money, so the controls are
 * deliberate rather than a single hidden button: the estimated cost is shown
 * before the run, self-consistency sampling multiplies it visibly, and an
 * offline mode runs the crude keyword baseline for free when the user only wants
 * to see the pipeline move. Progress streams from the background job so a
 * two-minute run does not look frozen.
 */
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
  const pollTimer = useRef<number | null>(null);

  // A single sample is ~$0.65; sampling multiplies the model passes. Rough, and
  // labelled as such, but enough to make the sampling tradeoff visible.
  const estCost = offline ? 0 : 0.65 * samples;

  const otherRecords = records.filter((r) => r.recordId !== recordId);

  const toggleRelated = (id: string) => {
    const next = new Set(related);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setRelated(next);
  };

  const poll = useCallback(
    (jobId: string) => {
      pollTimer.current = window.setInterval(async () => {
        try {
          const job = await api.job(jobId);
          setProgress(job.progress.slice(-8));
          if (job.status === "complete" && job.runId) {
            stop();
            setRunning(false);
            onComplete(job.runId);
          } else if (job.status === "failed") {
            stop();
            setRunning(false);
            setError(job.error ?? "the review failed");
          }
        } catch (e) {
          stop();
          setRunning(false);
          setError((e as Error).message);
        }
      }, 1500);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onComplete],
  );

  const stop = () => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const start = useCallback(async () => {
    setError(null);
    setProgress([]);
    setRunning(true);
    try {
      const { jobId } = await api.startReview(recordId, {
        samples,
        offline,
        related: [...related],
      });
      poll(jobId);
    } catch (e) {
      setRunning(false);
      setError((e as Error).message);
    }
  }, [recordId, samples, offline, related, poll]);

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
          {offline ? "no API cost" : `est. ~$${estCost.toFixed(2)}`}
        </span>
        <button className="act accept on" disabled={running} onClick={() => void start()}>
          {running ? "Reviewing…" : "Start review"}
        </button>
      </div>

      {otherRecords.length > 0 && (
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
      {running && progress.length > 0 && (
        <pre className="rc-progress">{progress.join("\n")}</pre>
      )}
    </div>
  );
}
