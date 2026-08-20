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

/**
 * Display label for a record type.
 *
 * Six call sites were each doing `value.replace(/_/g, " ")`, which renders
 * "risk_analysis" as "risk analysis" while the picker beside it shows
 * "Risk analysis / RMF" — the same type under two names on one screen. The
 * fallback stays for a type stored before it was in RECORD_TYPES.
 */
/** Sentence-case a lowercase engine value (a check phase or pass name). */
function sentence(v: string): string {
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function recordTypeLabel(value: string): string {
  return RECORD_TYPES.find((t) => t.value === value)?.label ?? value.replace(/_/g, " ");
}

const SOURCE_GROUPS: { key: string; label: string; sources: string[] }[] = [
  { key: "standards", label: "FDA & standards", sources: ["iso_clause", "cfr", "guidance"] },
  { key: "sop", label: "Your procedures", sources: ["sop"] },
  { key: "logic", label: "Logic & soundness", sources: ["logic"] },
];

/**
 * Second-level topics for the standards group.
 *
 * The corpus is large enough now (100+ rules) that a flat list is unusable, so
 * within "FDA & standards" the rules are grouped by regulatory area — a
 * sub-dropdown per topic. The order is the one a quality reader expects, roughly
 * the shape of a quality system from CAPA out to device-specific testing.
 */
const TOPIC_ORDER = [
  "CAPA",
  "Complaints & MDR",
  "Risk management",
  "Design controls",
  "Software, AI & connectivity",
  "Production & process",
  "Purchasing & acceptance",
  "Records, traceability & distribution",
  "Sterility, materials & biocompatibility",
  "Physical & electrical safety",
  "In-vitro diagnostics",
  "Clinical & postmarket",
  "Labeling & identification",
  "Device families",
  "Other requirements",
] as const;

/** Map a rule to its topic from its id and citation. Deterministic, no model. */
function topicFor(rule: { ruleId: string; citation: string }): string {
  const id = rule.ruleId;
  const has = (...ps: string[]) => ps.some((p) => id.includes(p));

  if (has("8.5.2", "8.5.3", "regreview-capa")) return "CAPA";
  if (has("820.198", "-803", "-806", "complaint-source", "complaint-reportability"))
    return "Complaints & MDR";
  if (has("iso14971", "risk-rating-consistency", "safety-assurance", "benefit-risk"))
    return "Risk management";
  if (
    has("820.30", "design-plan", "design-input", "human-factors", "change-assessment") &&
    !has("820.30(i)")
  )
    return "Design controls";
  if (has("software", "-ai-", "samd", "interoperability", "cybersecurity", "820.70i", "pccp", "820.30(i)"))
    return "Software, AI & connectivity";
  if (has("820.75", "820.70", "820.72", "820.25", "820.40")) return "Production & process";
  if (has("820.50", "820.80", "820.90")) return "Purchasing & acceptance";
  if (has("820.184", "820.181", "820.65", "820.160", "820.170", "820.200"))
    return "Records, traceability & distribution";
  if (has("biocompat", "chemical", "steriliz", "packaging", "reprocess", "particulate"))
    return "Sterility, materials & biocompatibility";
  if (
    has("electrical", "wireless", "mr-safety", "mechanical", "alarm", "battery", "fluid-path", "energy-device", "radiation")
  )
    return "Physical & electrical safety";
  if (has("-ivd-")) return "In-vitro diagnostics";
  if (has("clinical", "-ide-", "postmarket", "real-world")) return "Clinical & postmarket";
  if (has("-801", "-830", "labeling", "home-use", "pediatric")) return "Labeling & identification";
  if (has("cardiovascular", "orthopedic", "drug-delivery", "combination", "infusion-pump"))
    return "Device families";
  return "Other requirements";
}

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
  // Which topic sub-dropdowns are expanded, and the rule search box.
  const [openTopics, setOpenTopics] = useState<Set<string>>(new Set());
  const [ruleQuery, setRuleQuery] = useState("");

  const [uploading, setUploading] = useState(false);
  const [uploadType, setUploadType] = useState("capa");
  const fileInput = useRef<HTMLInputElement>(null);
  // Replace-in-place: a second hidden input whose file targets one record.
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null);
  // Which document-type sub-dropdowns are collapsed in the picker.
  const [collapsedTypes, setCollapsedTypes] = useState<Set<string>>(new Set());
  // Whether the "adjust cross-check targets" dropdown is open.
  const [showCrossTargets, setShowCrossTargets] = useState(false);

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
  // arrival rather than requiring a selection before anything makes sense, and
  // default cross-check to comparing against every other document — the common
  // case, and what the consistency pass is for.
  useEffect(() => {
    if (picked.size === 0 && records.length > 0) {
      const first = records[0]!.recordId;
      setPicked(new Set([first]));
      setCrossCheck(new Set(records.filter((r) => r.recordId !== first).map((r) => r.recordId)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records.length]);

  /**
   * A stable, alphabetical order — deliberately not the server's.
   *
   * `/api/records` returns most-recently-reviewed first, which re-sorts every
   * time a review finishes. This list is polled while reviews run, so rows moved
   * under the user's cursor: with a native type dropdown open, the row beneath it
   * could become a different document between opening the menu and choosing an
   * option, and the change would be applied to whatever record had moved into
   * that position. That is how a risk management file silently became a CAPA.
   *
   * A control the user selects from must not reorder itself while they are using
   * it, so the ordering here is a pure function of the document's name.
   */
  const ordered = useMemo(
    () =>
      [...records].sort((a, b) =>
        (a.docId ?? a.filename).localeCompare(b.docId ?? b.filename),
      ),
    [records],
  );

  const pickedRecords = ordered.filter((r) => picked.has(r.recordId));
  // Only documents not already under review can be cross-check targets: a record
  // compared against itself agrees with itself on everything.
  const unpicked = ordered.filter((r) => !picked.has(r.recordId));

  // Documents grouped by type, in the RECORD_TYPES order, for the collapsible
  // per-type sub-lists. A type with no documents is omitted.
  const docGroups = useMemo(() => {
    const byType = new Map<string, RecordSummary[]>();
    for (const r of ordered) {
      if (!byType.has(r.recordType)) byType.set(r.recordType, []);
      byType.get(r.recordType)!.push(r);
    }
    const known = RECORD_TYPES.map((t) => t.value);
    const order = [...known, ...[...byType.keys()].filter((t) => !known.includes(t))];
    return order
      .filter((t) => byType.has(t))
      .map((t) => ({
        type: t,
        label: recordTypeLabel(t),
        docs: byType.get(t)!,
      }));
  }, [ordered]);

  // "Compare to all" makes every other document a cross-check target and also
  // checks the selected documents against each other; "none" clears both.
  const setCompareAll = (all: boolean) => {
    setCrossCheck(all ? new Set(unpicked.map((r) => r.recordId)) : new Set());
    setCrossCheckSelected(all && pickedRecords.length > 1);
  };
  const comparingCount = crossCheck.size + (crossCheckSelected ? pickedRecords.length : 0);

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
      : `${[...types].map(recordTypeLabel).join(" / ")} record${types.size > 1 ? "s" : ""}`;

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

  const onReplace = useCallback(
    async (recordId: string, file: File) => {
      setError(null);
      setNotice(null);
      setUploading(true);
      try {
        const result = await api.replaceRecord(recordId, file);
        setNotice(
          result.warning ??
            `Replaced ${result.filename} — ${result.blocks} blocks` +
              (result.discardedFindings
                ? `, ${result.discardedFindings} finding(s) from the old version cleared.`
                : "."),
        );
        await onRefreshRecords();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading(false);
        setReplaceTarget(null);
        if (replaceInput.current) replaceInput.current.value = "";
      }
    },
    [onRefreshRecords],
  );

  const onRetype = useCallback(
    async (r: RecordSummary, recordType: string) => {
      setError(null);
      setNotice(null);
      try {
        const res = await api.setRecordType(r.recordId, recordType);
        const label = r.docId ?? r.filename;
        const parts = [
          `${label} is now a ${recordTypeLabel(recordType)} record — ` +
            `${res.applicableRules} rule(s) apply.`,
        ];
        // Past runs were produced under the old type's rules. Saying so matters:
        // the findings on screen may be measured against requirements that no
        // longer govern this document.
        if (res.priorRuns > 0) {
          parts.push(
            `Its ${res.priorRuns} existing run(s) were done as a ` +
              `${recordTypeLabel(res.previousType)} record and are unchanged — ` +
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
              Upload as
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
            <input
              ref={replaceInput}
              type="file"
              accept=".pdf,.docx,.md,.txt"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f && replaceTarget) void onReplace(replaceTarget, f);
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

        {/* Grouped by document type — a collapsible sub-list per type, so a
            growing project stays navigable and it is obvious what is present. */}
        <div className="doclist">
          {docGroups.map((g) => {
            const collapsed = collapsedTypes.has(g.type);
            const pickedInType = g.docs.filter((d) => picked.has(d.recordId)).length;
            return (
              <div key={g.type} className="doctype-group">
                <div className="doctype-head">
                  <button
                    className="doctype-toggle"
                    onClick={() =>
                      setCollapsedTypes((prev) => {
                        const next = new Set(prev);
                        next.has(g.type) ? next.delete(g.type) : next.add(g.type);
                        return next;
                      })
                    }
                  >
                    <span className="rc-chevron">{collapsed ? "▸" : "▾"}</span>
                    {g.label}
                    <span className="rc-badge">
                      {pickedInType > 0 ? `${pickedInType}/` : ""}
                      {g.docs.length}
                    </span>
                  </button>
                </div>

                {!collapsed &&
                  g.docs.map((r) => {
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
                        {/* Editable, not a badge: the type decides which rules
                            apply, and a document uploaded under the wrong one is
                            reviewed against the wrong requirements — or none. */}
                        <select
                          className="docrow-type"
                          value={r.recordType}
                          title="Document type — decides which requirements apply"
                          onChange={(e) => void onRetype(r, e.target.value)}
                        >
                          {!RECORD_TYPES.some((t) => t.value === r.recordType) && (
                            <option value={r.recordType}>
                              {recordTypeLabel(r.recordType)}
                            </option>
                          )}
                          {RECORD_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <span className="docrow-runs">
                          {r.runs === 0 ? "Never reviewed" : `${r.runs} run${r.runs === 1 ? "" : "s"}`}
                        </span>
                        <button
                          className="docrow-replace"
                          title="Replace this document's file, keeping its place and history slot"
                          disabled={uploading}
                          onClick={() => {
                            setReplaceTarget(r.recordId);
                            replaceInput.current?.click();
                          }}
                        >
                          ⟳
                        </button>
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

      {/* 2 — cross-check: compare against all other documents, or none, with a
             dropdown to deselect individual targets. */}
      {records.length > 1 && (
        <section className="rp-section">
          <div className="rp-head">
            <h2>Cross-check</h2>
            <span className="muted small">
              finds facts that disagree between documents — risk ratings, dates, thresholds
            </span>
          </div>

          <div className="cross-controls">
            <div className="seg">
              <button
                className={`seg-btn ${comparingCount > 0 ? "on" : ""}`}
                onClick={() => setCompareAll(true)}
              >
                Compare to all
              </button>
              <button
                className={`seg-btn ${comparingCount === 0 ? "on" : ""}`}
                onClick={() => setCompareAll(false)}
              >
                None
              </button>
            </div>
            <span className="muted small">
              {comparingCount === 0
                ? "Not comparing — the consistency pass will not run."
                : `Comparing each reviewed document against ${comparingCount} other${
                    comparingCount === 1 ? "" : "s"
                  }.`}
            </span>
            {(unpicked.length > 0 || pickedRecords.length > 1) && (
              <button className="rc-mini" onClick={() => setShowCrossTargets((v) => !v)}>
                {showCrossTargets ? "▾ Hide targets" : "▸ Adjust targets"}
              </button>
            )}
          </div>

          {showCrossTargets && (
            <div className="doclist cross-targets">
              {pickedRecords.length > 1 && (
                <label className="docrow">
                  <span className="docrow-main">
                    <input
                      type="checkbox"
                      checked={crossCheckSelected}
                      onChange={(e) => setCrossCheckSelected(e.target.checked)}
                    />
                    <span className="docrow-name">
                      the {pickedRecords.length} selected documents, against each other
                    </span>
                  </span>
                </label>
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
                  <span className="docrow-typeflat">{recordTypeLabel(r.recordType)}</span>
                </label>
              ))}
            </div>
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
                Scoped — runs {passesFor(selectedApplicable)} of 4 check passes
              </span>
            )}
            {noneSelected && <span className="rc-warn">Select at least one</span>}
            <button className="rc-disclose" onClick={() => setShowRules((v) => !v)}>
              {showRules ? "▾ Hide" : "▸ Choose"}
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
                        Show
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
            <input
              className="rc-rule-search"
              type="search"
              placeholder="Search rules by name or citation…"
              value={ruleQuery}
              onChange={(e) => setRuleQuery(e.target.value)}
            />
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
                      All
                    </button>
                    <button
                      className="rc-mini"
                      disabled={blocked}
                      onClick={() => setGroup(g.usable, false)}
                    >
                      None
                    </button>
                  </div>

                  {blocked && (
                    <div className="rc-blocked">
                      None of these {g.rules.length} apply to <strong>{typeLabel}</strong>
                      {g.covers.length > 0 && (
                        <>
                          {" "}
                          — they are set to apply to{" "}
                          <strong>{g.covers.map(recordTypeLabel).join(", ")}</strong>
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

                  {(() => {
                    const q = ruleQuery.trim().toLowerCase();
                    const match = (r: CorpusRule) =>
                      !q ||
                      r.title.toLowerCase().includes(q) ||
                      r.citation.toLowerCase().includes(q);

                    const visible = g.rules.filter(match);
                    if (q && visible.length === 0) return null;

                    // Partition this group's visible rules into topic sub-groups,
                    // ordered as TOPIC_ORDER. A group whose rules all fall in one
                    // topic (Your procedures, Logic) renders as a single flat list.
                    const byTopic = new Map<string, CorpusRule[]>();
                    for (const r of visible) {
                      const t = topicFor(r);
                      if (!byTopic.has(t)) byTopic.set(t, []);
                      byTopic.get(t)!.push(r);
                    }
                    const subs = [...TOPIC_ORDER, "Other requirements"]
                      .filter((t, i, a) => a.indexOf(t) === i && byTopic.has(t))
                      .map((t) => ({ topic: t, rules: byTopic.get(t)! }));
                    const flat = subs.length <= 1;

                    const renderRule = (r: CorpusRule) => {
                      const usable = g.usable.includes(r);
                      return (
                        <label
                          key={r.ruleId}
                          className={`rc-rule ${usable ? "" : "off"}`}
                          title={
                            usable ? undefined : `Applies to ${r.appliesTo.join(", ")} — not ${typeLabel}`
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
                    };

                    if (flat) return visible.map(renderRule);

                    return subs.map((sub) => {
                      // A search auto-opens matching topics; otherwise the reader
                      // opens them. Keeps a 100-rule list to one screen of headers.
                      const open = q !== "" || openTopics.has(g.key + "|" + sub.topic);
                      const usableInSub = sub.rules.filter((r) => g.usable.includes(r));
                      const onInSub = usableInSub.filter((r) => selected.has(r.ruleId)).length;
                      return (
                        <div key={sub.topic} className="rc-subgroup">
                          <div className="rc-subgroup-head">
                            <button
                              className="rc-subgroup-toggle"
                              onClick={() =>
                                setOpenTopics((prev) => {
                                  const next = new Set(prev);
                                  const k = g.key + "|" + sub.topic;
                                  next.has(k) ? next.delete(k) : next.add(k);
                                  return next;
                                })
                              }
                            >
                              <span className="rc-chevron">{open ? "▾" : "▸"}</span>
                              {sub.topic}
                              <span className="rc-badge">
                                {onInSub}/{usableInSub.length}
                              </span>
                            </button>
                            <button
                              className="rc-mini"
                              disabled={usableInSub.length === 0}
                              onClick={() => setGroup(usableInSub, true)}
                            >
                              All
                            </button>
                            <button
                              className="rc-mini"
                              disabled={usableInSub.length === 0}
                              onClick={() => setGroup(usableInSub, false)}
                            >
                              None
                            </button>
                          </div>
                          {open && <div className="rc-subgroup-rules">{sub.rules.map(renderRule)}</div>}
                        </div>
                      );
                    });
                  })()}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 4 — cost and go */}
      <section className="rp-section rp-go">
        <label className="rc-opt">
          Samples
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
          Offline (free, crude)
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
                            ? "Failed"
                            : r.status === "pending"
                              ? "Queued"
                              : sentence(r.phase ?? "working")}
                      </span>
                      {r.runId && (
                        <button className="rc-mini" onClick={() => onOpenRun(r.runId!)}>
                          View
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
