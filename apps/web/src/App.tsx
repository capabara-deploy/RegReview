import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  AuthError,
  type Finding,
  type FindingStatus,
  type Job,
  type RecordDetail,
  type RecordSummary,
} from "./api";
import { Findings } from "./Findings";
import { Login } from "./Login";
import { Procedures } from "./Procedures";
import { RunReview } from "./RunReview";

type Page = "run" | "findings" | "procedures";

/**
 * The shell: navigation, the record/run the findings view is showing, and the
 * set of review jobs being watched.
 *
 * Jobs are tracked here rather than inside the run page so that navigating to
 * the findings while a review is in flight does not abandon it. Polling is
 * centralised for the same reason — one timer for all jobs, stopping only when
 * none are running.
 */
export function App() {
  // undefined while the initial /api/me check is in flight, null when signed
  // out — kept distinct so the login screen doesn't flash before that check
  // resolves.
  const [username, setUsername] = useState<string | null | undefined>(undefined);
  const [page, setPage] = useState<Page>("run");
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [jobs, setJobs] = useState<Job[]>([]);
  const watched = useRef<Set<string>>(new Set());
  const timer = useRef<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const me = await api.me();
        setUsername(me.username);
      } catch {
        setUsername(null);
      }
    })();
  }, []);

  const refreshRecords = useCallback(async () => {
    try {
      setRecords(await api.records());
    } catch (e) {
      if (e instanceof AuthError) return setUsername(null);
      setError((e as Error).message);
    }
  }, []);

  const openRecord = useCallback(async (recordId: string) => {
    setError(null);
    try {
      const detail = await api.record(recordId);
      setRecord(detail);
      // Prefer the newest real review. The offline keyword baseline is a
      // development diagnostic whose findings are deliberately crude, and
      // defaulting to it would show a reviewer output the product never
      // produces.
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
      if (e instanceof AuthError) return setUsername(null);
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (username) void refreshRecords();
  }, [username, refreshRecords]);

  /**
   * Re-attach to the server's reviews on load.
   *
   * Job ids lived only in this component's state, so a reload orphaned them: a
   * running review carried on server-side and finished, but the page had no id
   * left to poll and showed nothing — which reads as the work having been lost.
   *
   * Finished jobs are adopted too, not just running ones. A review that completed
   * while the page was away is exactly the case where the user wants to see what
   * it found, and dropping it would leave them to hunt for the run by hand. The
   * server keeps a bounded number of recent jobs; only running ones are polled.
   */
  useEffect(() => {
    if (!username) return;
    void (async () => {
      try {
        const existing = await api.jobs();
        if (existing.length === 0) return;
        for (const j of existing) {
          if (j.status === "running") watched.current.add(j.jobId);
        }
        setJobs(existing);
      } catch (e) {
        if (e instanceof AuthError) setUsername(null);
        // Otherwise: a server that cannot list jobs is not a reason to block the page.
      }
    })();
  }, [username]);

  const selectRun = useCallback(async (id: string) => {
    setError(null);
    setRunId(id);
    try {
      setFindings(await api.findings(id));
    } catch (e) {
      if (e instanceof AuthError) return setUsername(null);
      setError((e as Error).message);
    }
  }, []);

  /** Open a run's findings, pulling the record fresh so the new run is listed. */
  const openRun = useCallback(
    async (newRunId: string) => {
      try {
        const findingRows = await api.findings(newRunId);
        const recordId = findingRows[0]?.recordId;
        // A run with zero findings carries no record id in its findings, so fall
        // back to re-reading whatever document is open. Showing nothing would be
        // indistinguishable from a failure.
        if (recordId) {
          setRecord(await api.record(recordId));
        } else if (record) {
          setRecord(await api.record(record.recordId));
        }
        setRunId(newRunId);
        setFindings(findingRows);
        setPage("findings");
      } catch (e) {
        if (e instanceof AuthError) return setUsername(null);
        setError((e as Error).message);
      }
    },
    [record],
  );

  const updateStatus = useCallback(
    async (finding: Finding, status: FindingStatus, note?: string) => {
      try {
        const updated = await api.setStatus(finding.runId, finding.findingId, status, note);
        setFindings((prev) => prev.map((f) => (f.findingId === updated.findingId ? updated : f)));
      } catch (e) {
        if (e instanceof AuthError) return setUsername(null);
        setError((e as Error).message);
      }
    },
    [],
  );

  const trackJob = useCallback((jobId: string) => {
    watched.current.add(jobId);
    setJobs((prev) => [
      {
        jobId,
        recordId: "",
        status: "running",
        progress: [],
        results: [],
      },
      ...prev,
    ]);
  }, []);

  // One poll loop for every watched job. It stops when nothing is running, so an
  // idle page makes no requests.
  useEffect(() => {
    const anyRunning = jobs.some((j) => j.status === "running");
    if (!anyRunning) {
      if (timer.current !== null) {
        window.clearInterval(timer.current);
        timer.current = null;
      }
      return;
    }
    if (timer.current !== null) return;

    timer.current = window.setInterval(() => {
      void (async () => {
        const ids = [...watched.current];
        const fetched = await Promise.all(
          ids.map((id) => api.job(id).catch(() => null)),
        );
        const alive = fetched.filter((j): j is Job => j !== null);
        setJobs((prev) =>
          prev.map((p) => alive.find((a) => a.jobId === p.jobId) ?? p),
        );
        // A finished job's document gained a run, so the record list is stale.
        if (alive.some((j) => j.status !== "running")) {
          for (const j of alive.filter((x) => x.status !== "running")) {
            watched.current.delete(j.jobId);
          }
          void refreshRecords();
        }
      })();
    }, 1500);

    return () => {
      if (timer.current !== null) {
        window.clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [jobs, refreshRecords]);

  const runningCount = jobs.filter((j) => j.status === "running").length;

  if (username === undefined) return null;
  if (username === null) return <Login onSignedIn={setUsername} />;

  const signOut = async () => {
    try {
      await api.logout();
    } finally {
      setUsername(null);
    }
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
            className={`viewtab ${page === "run" ? "on" : ""}`}
            onClick={() => setPage("run")}
          >
            Run a review
            {runningCount > 0 && <span className="nav-dot">{runningCount}</span>}
          </button>
          <button
            className={`viewtab ${page === "findings" ? "on" : ""}`}
            onClick={() => setPage("findings")}
          >
            Findings
          </button>
          <button
            className={`viewtab ${page === "procedures" ? "on" : ""}`}
            onClick={() => setPage("procedures")}
          >
            Procedures
          </button>
        </nav>

        <button className="signout-btn" onClick={() => void signOut()}>
          Sign out ({username})
        </button>
      </header>

      {error && <div className="error">{error}</div>}

      {page === "run" && (
        <RunReview
          records={records}
          jobs={jobs}
          onStartJob={trackJob}
          onRefreshRecords={refreshRecords}
          onOpenRun={(id) => void openRun(id)}
        />
      )}

      {page === "findings" && (
        <Findings
          records={records}
          record={record}
          runId={runId}
          findings={findings}
          onOpenRecord={(id) => void openRecord(id)}
          onSelectRun={(id) => void selectRun(id)}
          onStatus={updateStatus}
        />
      )}

      {page === "procedures" && <Procedures onChanged={refreshRecords} />}
    </div>
  );
}
