import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type CorpusRule, type SopDetail, type SopSummary } from "./api";

const RECORD_TYPES = ["capa", "complaint", "change_package", "risk_analysis"];

const SOURCE_LABELS: Record<string, string> = {
  iso_clause: "FDA / ISO 13485 requirements",
  logic: "Logic & scientific soundness",
  cfr: "21 CFR (regulation text)",
  guidance: "FDA guidance",
};

function tierFor(percentile: number): "high" | "medium" | "low" {
  if (percentile >= 0.75) return "high";
  if (percentile >= 0.5) return "medium";
  return "low";
}

/**
 * Manage the customer's own procedures.
 *
 * This is the "upload and edit your own rules" surface. It matters more than it
 * looks: the conformance pass — half the product's value — checks a record
 * against these procedures, and until one is loaded that pass has nothing to do
 * and skips itself. Clause extraction is deterministic, so editing a procedure's
 * text here immediately and predictably changes what conformance means.
 */
export function Procedures({ onChanged }: { onChanged?: () => void }) {
  const [tab, setTab] = useState<"sops" | "corpus">("sops");
  const [sops, setSops] = useState<SopSummary[]>([]);
  const [selected, setSelected] = useState<SopDetail | null>(null);
  const [text, setText] = useState("");
  const [appliesTo, setAppliesTo] = useState<Set<string>>(new Set(["capa"]));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const refresh = useCallback(async () => {
    try {
      setSops(await api.sops());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The standing FDA/ISO/logic corpus — read-only, loaded once.
  const [corpus, setCorpus] = useState<CorpusRule[]>([]);
  const [selectedRule, setSelectedRule] = useState<string | null>(null);
  useEffect(() => {
    api.rules().then(setCorpus).catch((e) => setError((e as Error).message));
  }, []);

  const corpusGroups = useMemo(() => {
    const by = new Map<string, CorpusRule[]>();
    for (const r of corpus) {
      const list = by.get(r.source) ?? [];
      list.push(r);
      by.set(r.source, list);
    }
    return [...by.entries()];
  }, [corpus]);

  const activeRule = corpus.find((r) => r.ruleId === selectedRule) ?? null;

  const open = useCallback(async (sopId: string) => {
    setError(null);
    setNotice(null);
    setCreating(false);
    try {
      const detail = await api.sop(sopId);
      setSelected(detail);
      setText(detail.normalizedText);
      setAppliesTo(new Set(detail.appliesTo.length > 0 ? detail.appliesTo : ["capa"]));
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const save = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateSop(selected.sopDocumentId, {
        text,
        appliesTo: [...appliesTo],
      });
      setNotice(`Saved — re-extracted ${result.clauses} obligation clause(s).`);
      setDirty(false);
      await refresh();
      await open(selected.sopDocumentId);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [selected, text, appliesTo, refresh, open, onChanged]);

  const remove = useCallback(async () => {
    if (!selected) return;
    if (!confirm(`Delete ${selected.docId ?? selected.filename} and all its conformance rules?`))
      return;
    setBusy(true);
    try {
      await api.deleteSop(selected.sopDocumentId);
      setSelected(null);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [selected, refresh, onChanged]);

  const createNew = useCallback(async () => {
    if (!newName.trim() || !text.trim()) {
      setError("A filename and some text are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.createSopFromText(newName.trim(), text, [...appliesTo]);
      setNotice(`Created — extracted ${result.clauses} obligation clause(s).`);
      setCreating(false);
      setNewName("");
      await refresh();
      await open(result.sopDocumentId);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [newName, text, appliesTo, refresh, open, onChanged]);

  const startNew = () => {
    setCreating(true);
    setSelected(null);
    setText("");
    setNewName("");
    setAppliesTo(new Set(["capa"]));
    setNotice(null);
    setError(null);
  };

  // Functional updater: reading appliesTo from the closure means two toggles
  // dispatched before a re-render both start from the same stale set, and the
  // second silently discards the first.
  const toggleType = (t: string) => {
    setAppliesTo((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
    setDirty(true);
  };

  return (
    <div className="procedures-wrap">
      <div className="proc-tabs">
        <button
          className={`proc-tab ${tab === "sops" ? "on" : ""}`}
          onClick={() => setTab("sops")}
        >
          Your procedures
          <span className="proc-tab-count">{sops.length}</span>
        </button>
        <button
          className={`proc-tab ${tab === "corpus" ? "on" : ""}`}
          onClick={() => setTab("corpus")}
        >
          FDA &amp; standards
          <span className="proc-tab-count">{corpus.length}</span>
        </button>
        <p className="muted small proc-tabs-note">
          {tab === "sops"
            ? "Your own SOPs. Editable — the conformance pass checks records against these."
            : "The built-in requirements the compliance and logic passes check every record against. Read-only reference."}
        </p>
      </div>

      {tab === "corpus" ? (
        <div className="procedures">
          <aside className="sop-list">
            {corpusGroups.map(([source, rules]) => (
              <div key={source} className="corpus-group">
                <div className="corpus-group-head">{SOURCE_LABELS[source] ?? source}</div>
                {rules.map((r) => (
                  <button
                    key={r.ruleId}
                    className={`sop-item ${selectedRule === r.ruleId ? "on" : ""}`}
                    onClick={() => setSelectedRule(r.ruleId)}
                  >
                    <div className="sop-item-title">
                      <span className={`sev-dot ${tierFor(r.frequencyPercentile)}`} />
                      {r.title}
                    </div>
                    <div className="sop-item-sub">{r.citation}</div>
                  </button>
                ))}
              </div>
            ))}
          </aside>

          <section className="sop-editor">
            {!activeRule && (
              <p className="muted">
                Select a requirement to read the full expectation, its citation, and why it
                carries the risk tier it does. These rules ship with the tool — the customer's
                own procedures are on the “Your procedures” tab.
              </p>
            )}
            {activeRule && (
              <div className="rule-detail">
                <div className="rule-detail-cite">{activeRule.citation}</div>
                <h3>{activeRule.title}</h3>
                <div className="rule-badges">
                  <span className={`sev-badge ${tierFor(activeRule.frequencyPercentile)}`}>
                    {tierFor(activeRule.frequencyPercentile)} baseline risk
                  </span>
                  {activeRule.harmLinked && <span className="rule-badge harm">patient-harm linked</span>}
                  <span className="rule-badge">
                    cited {activeRule.citationFrequency.toLocaleString()}× in FDA data
                  </span>
                  {activeRule.appliesTo.length > 0 && (
                    <span className="rule-badge">applies to {activeRule.appliesTo.join(", ")}</span>
                  )}
                </div>
                <h4>What this tool expects</h4>
                <p className="rule-expectation">{activeRule.expectation}</p>
                <p className="muted small rule-id">{activeRule.ruleId}</p>
              </div>
            )}
          </section>
        </div>
      ) : (
        <div className="procedures">
      <aside className="sop-list">
        <div className="sop-list-head">
          <h2>Procedures</h2>
          <button className="act accept" onClick={startNew}>
            + New
          </button>
        </div>
        {sops.length === 0 && (
          <p className="muted small">
            None loaded. The conformance pass will be skipped until you add one.
          </p>
        )}
        {sops.map((s) => (
          <button
            key={s.sopDocumentId}
            className={`sop-item ${selected?.sopDocumentId === s.sopDocumentId ? "on" : ""}`}
            onClick={() => void open(s.sopDocumentId)}
          >
            <div className="sop-item-title">{s.docId ?? s.filename}</div>
            <div className="sop-item-sub">
              {s.title ?? ""} · {s.ruleCount} clause{s.ruleCount === 1 ? "" : "s"}
            </div>
          </button>
        ))}
      </aside>

      <section className="sop-editor">
        {error && <div className="error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}

        {!selected && !creating && (
          <p className="muted">Select a procedure to view and edit it, or add a new one.</p>
        )}

        {(selected || creating) && (
          <>
            <div className="sop-editor-head">
              {creating ? (
                <input
                  className="sop-name"
                  placeholder="Procedure filename, e.g. QSP-0012.md"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              ) : (
                <h3>
                  {selected!.docId ?? selected!.filename}
                  {selected!.revision ? ` · Rev ${selected!.revision}` : ""}
                </h3>
              )}
            </div>

            <div className="applies-row">
              <span className="filter-label">Applies to</span>
              {RECORD_TYPES.map((t) => (
                <label key={t} className="applies-chip">
                  <input
                    type="checkbox"
                    checked={appliesTo.has(t)}
                    onChange={() => toggleType(t)}
                  />
                  {t}
                </label>
              ))}
            </div>

            <textarea
              className="sop-text"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setDirty(true);
              }}
              placeholder="Paste the procedure text. Numbered clauses that state an obligation (shall / must / responsible for) become conformance rules; purpose, scope and definitions are skipped."
              spellCheck={false}
            />

            <div className="sop-actions">
              {creating ? (
                <button className="act accept on" disabled={busy} onClick={() => void createNew()}>
                  {busy ? "Extracting…" : "Create procedure"}
                </button>
              ) : (
                <>
                  <button
                    className={`act accept ${dirty ? "on" : ""}`}
                    disabled={busy || !dirty}
                    onClick={() => void save()}
                  >
                    {busy ? "Re-extracting…" : dirty ? "Save & re-extract" : "Saved"}
                  </button>
                  <button className="act reject" disabled={busy} onClick={() => void remove()}>
                    Delete
                  </button>
                </>
              )}
            </div>

            {selected && !creating && (
              <div className="clause-preview">
                <h4>
                  {selected.clauses.length} obligation clause
                  {selected.clauses.length === 1 ? "" : "s"} the conformance pass will check
                </h4>
                {selected.clauses.map((c) => (
                  <div key={c.number} className="clause">
                    <div className="clause-cite">{c.citation}</div>
                    <div className="clause-text">{c.expectation}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>
        </div>
      )}
    </div>
  );
}
