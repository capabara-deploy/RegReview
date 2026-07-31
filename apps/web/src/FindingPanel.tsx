import { useEffect, useState } from "react";
import { api, type Finding, type FindingStatus, type FindingEvent, type Rule } from "./api";
import { SEVERITY_MARK } from "./highlight";

/**
 * The detail panel for one finding.
 *
 * Layout follows the product's core promise: flag, explain, suggest — and let a
 * human decide. So the order is what's wrong, why it matters in inspection
 * terms, a direction for the fix, and then the accept/reject controls. The
 * suggestion is deliberately presented as a direction rather than as copyable
 * replacement text: both discovery interviews warned that engineers paste AI
 * output into records unread, and a fix that introduces a new error is worse
 * than the original problem.
 */
export function FindingPanel({
  finding,
  onClose,
  onStatus,
}: {
  finding: Finding;
  onClose: () => void;
  onStatus: (f: Finding, status: FindingStatus, note?: string) => Promise<void>;
}) {
  const [note, setNote] = useState(finding.reviewerNote ?? "");
  const [rule, setRule] = useState<Rule | null>(null);
  const [events, setEvents] = useState<FindingEvent[]>([]);
  const [showRule, setShowRule] = useState(false);
  const [showAudit, setShowAudit] = useState(false);

  useEffect(() => {
    setNote(finding.reviewerNote ?? "");
    setRule(null);
    setEvents([]);
    setShowRule(false);
    setShowAudit(false);
  }, [finding.findingId, finding.reviewerNote]);

  const loadRule = async () => {
    setShowRule((v) => !v);
    if (!rule) setRule(await api.rule(finding.ruleId).catch(() => null));
  };

  const loadEvents = async () => {
    setShowAudit((v) => !v);
    if (events.length === 0) {
      setEvents(await api.events(finding.runId, finding.findingId).catch(() => []));
    }
  };

  return (
    <div className="panel">
      <div className="panel-top">
        <span className={`badge sev-${finding.severity}`}>
          <span aria-hidden="true">{SEVERITY_MARK[finding.severity]}</span> {finding.severity}
        </span>
        <span className="panel-cat">{finding.category}</span>
        <button className="close" onClick={onClose} aria-label="Back to list">
          ×
        </button>
      </div>

      <h2 className="panel-problem">{finding.problem}</h2>

      <section>
        <h3>Quoted text</h3>
        <blockquote className="quote">{finding.quote}</blockquote>
      </section>

      <section>
        <h3>Why it matters</h3>
        <p>{finding.rationale}</p>
      </section>

      <section>
        <h3>A direction for the fix</h3>
        <p className="suggestion">{finding.suggestion}</p>
        <p className="disclaimer">
          A direction, not replacement text. The wording is yours to write — and to
          verify.
        </p>
      </section>

      <section>
        <h3>Requirement</h3>
        <p className="citation">{finding.citation}</p>
        <button className="link" onClick={() => void loadRule()}>
          {showRule ? "Hide" : "Show"} the full requirement
        </button>
        {showRule && rule && (
          <div className="rule-box">
            <strong>{rule.title}</strong>
            <p>{rule.expectation}</p>
            <p className="muted small">
              Cited by FDA {rule.citationFrequency} times in the ingested inspection record
              ({(rule.frequencyPercentile * 100).toFixed(0)}th percentile of the corpus)
              {rule.harmLinked ? " · failure can connect to patient harm" : ""}
            </p>
          </div>
        )}
      </section>

      {/* Why this tier, spelled out. A risk rating a reviewer cannot interrogate
          is a rating they will eventually stop believing. */}
      <section>
        <h3>Why {finding.severity} risk</h3>
        <p className="basis">{finding.severityBasis.reason}</p>
        <ul className="basis-inputs">
          <li>Model confidence: {finding.severityBasis.confidence}</li>
          <li>
            FDA citation frequency: {finding.severityBasis.citationFrequency} (
            {(finding.severityBasis.frequencyPercentile * 100).toFixed(0)}th percentile)
          </li>
          <li>Requirement tied to patient harm: {finding.severityBasis.harmLinked ? "yes" : "no"}</li>
          <li>This passage harm-relevant: {finding.severityBasis.harmRelevant ? "yes" : "no"}</li>
        </ul>
      </section>

      <section className="decide">
        <h3>Your decision</h3>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note — why you accepted or rejected this."
          rows={3}
        />
        <div className="actions">
          <button
            className={`act accept ${finding.status === "accepted" ? "on" : ""}`}
            onClick={() => void onStatus(finding, "accepted", note || undefined)}
          >
            Accept
          </button>
          <button
            className={`act reject ${finding.status === "rejected" ? "on" : ""}`}
            onClick={() => void onStatus(finding, "rejected", note || undefined)}
          >
            Reject
          </button>
          {finding.status !== "open" && (
            <button
              className="act reopen"
              onClick={() => void onStatus(finding, "open", note || undefined)}
            >
              Reopen
            </button>
          )}
        </div>
        <p className="muted small">
          Current status: <strong>{finding.status}</strong>. Decisions are appended to an
          audit log; nothing is overwritten or deleted.
        </p>
        <button className="link" onClick={() => void loadEvents()}>
          {showAudit ? "Hide" : "Show"} audit trail
        </button>
        {showAudit && (
          <ul className="audit">
            {events.length === 0 && <li className="muted">No events.</li>}
            {events.map((e) => (
              <li key={e.event_id}>
                <code>{new Date(e.occurred_at).toLocaleString()}</code> {e.event_type} by{" "}
                {e.actor}
                {e.note ? ` — "${e.note}"` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="muted small ids">
        finding <code>{finding.findingId}</code> · rule <code>{finding.ruleId}</code> · chars{" "}
        {finding.charStart}–{finding.charEnd}
      </p>
    </div>
  );
}
