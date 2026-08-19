-- RegReview customer database schema (Postgres/Neon).
--
-- Uploaded records, extracted blocks/facts, and every run and finding
-- derived from them. Findings embed verbatim quotes from the customer's
-- document (see consistency.ts / claudeEngine.ts), so this is customer
-- content exactly like records — kept separate from both the corpus
-- database and the sops database. See db/index.ts for the full split
-- rationale.
--
-- Design notes carried over from the original single-file schema:
--
--  * Findings are immutable facts about a run; reviewer decisions live in
--    `findings.status` plus an append-only `finding_events` log. Nothing is
--    ever deleted. This is Part 11 groundwork: when the tool eventually sits
--    on the official record we will already have the audit trail, and until
--    then we sit beside the record and do not inherit the obligation.
--
--  * Offsets (`char_start`, `char_end`) are into `records.normalized_text`,
--    a single plain-text rendering per record. One coordinate system for the
--    whole app means a highlight computed by the engine is the same highlight
--    the viewer draws.

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  record_id       TEXT PRIMARY KEY,
  filename        TEXT NOT NULL,
  stored_path     TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  record_type     TEXT NOT NULL DEFAULT 'unknown',
  doc_id          TEXT,
  revision        TEXT,
  normalized_text TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_type ON records(record_type);
CREATE INDEX IF NOT EXISTS idx_records_docid ON records(doc_id);

CREATE TABLE IF NOT EXISTS blocks (
  block_id   TEXT PRIMARY KEY,
  record_id  TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL,
  text       TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end   INTEGER NOT NULL,
  page       INTEGER,
  -- JSON [x0,y0,x1,y1] in PDF user space; null for non-paginated formats.
  bbox       TEXT,
  heading    TEXT
);

CREATE INDEX IF NOT EXISTS idx_blocks_record ON blocks(record_id, ordinal);

-- Structured values extracted per record. The consistency check diffs these
-- rows deterministically; a model is only asked to explain discrepancies that
-- the diff has already found.
CREATE TABLE IF NOT EXISTS facts (
  fact_id    TEXT PRIMARY KEY,
  record_id  TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
  block_id   TEXT NOT NULL REFERENCES blocks(block_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  value      TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facts_kind_subject ON facts(kind, subject);
CREATE INDEX IF NOT EXISTS idx_facts_record ON facts(record_id);

CREATE TABLE IF NOT EXISTS runs (
  run_id         TEXT PRIMARY KEY,
  record_id      TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
  -- All four of the next fields are part of the run's identity: two findings
  -- are only comparable if they were produced under the same ones.
  model          TEXT NOT NULL,
  effort         TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  corpus_version TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  status         TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','complete','failed')),
  error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_record ON runs(record_id, started_at DESC);

CREATE TABLE IF NOT EXISTS findings (
  -- Deterministic: hash(rule_id + normalized quote + block_id). The same
  -- finding produced by two different runs gets the same id here, which is
  -- what makes run-to-run agreement measurable rather than eyeballed.
  finding_id     TEXT NOT NULL,
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  record_id      TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
  block_id       TEXT NOT NULL REFERENCES blocks(block_id) ON DELETE CASCADE,
  char_start     INTEGER NOT NULL,
  char_end       INTEGER NOT NULL,
  category       TEXT NOT NULL
                   CHECK (category IN ('compliance','conformance','consistency',
                                       'completeness','plausibility')),
  severity       TEXT NOT NULL CHECK (severity IN ('high','medium','low')),
  -- JSON SeverityBasis: the inputs that produced `severity`, so the UI can
  -- explain the rating and we can retune the formula without losing history.
  severity_basis TEXT NOT NULL,
  -- No REFERENCES here: a rule may live in the corpus database (public) or
  -- the sops database (SOP-derived), and Postgres can't enforce a foreign
  -- key across databases. `citation` below is denormalized onto the row
  -- specifically so reading a finding never needs to join back to `rules`.
  rule_id        TEXT NOT NULL,
  citation       TEXT NOT NULL,
  quote          TEXT NOT NULL,
  problem        TEXT NOT NULL,
  rationale      TEXT NOT NULL,
  suggestion     TEXT NOT NULL,
  confidence     TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','accepted','rejected')),
  reviewer_note  TEXT,
  PRIMARY KEY (run_id, finding_id)
);

CREATE INDEX IF NOT EXISTS idx_findings_record ON findings(record_id);
CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
-- Cross-run lookup of "the same finding" for agreement measurement.
CREATE INDEX IF NOT EXISTS idx_findings_stable_id ON findings(finding_id);

-- Append-only. Never UPDATE or DELETE a row in this table.
CREATE TABLE IF NOT EXISTS finding_events (
  event_id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id      TEXT NOT NULL,
  finding_id  TEXT NOT NULL,
  -- 'created' | 'accepted' | 'rejected' | 'reopened' | 'note'
  event_type  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  note        TEXT,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (run_id, finding_id) REFERENCES findings(run_id, finding_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_finding ON finding_events(run_id, finding_id, event_id);

-- ---------------------------------------------------------------------------
-- Cumulative change ledger (Phase 2).
--
-- The reshaped form of the "informal submission" feature. An engineer records a
-- proposed change in free text; the tool computes DETERMINISTIC gaps and which
-- decision-flowchart branches are implicated, and it NEVER renders the
-- submit / don't-submit determination — that is the manufacturer's statutory
-- responsibility (21 CFR 807.81(a)(3)). The regulatory determination is a
-- human-owned column that defaults to undecided and is never set by the tool.
-- ---------------------------------------------------------------------------

-- The cleared-device comparator. A change assessment must compare against the
-- most-recently-cleared configuration (its 510(k) number), not an intervening
-- internal revision; that wrong-comparator error is deterministically checkable.
CREATE TABLE IF NOT EXISTS baselines (
  baseline_id   TEXT PRIMARY KEY,
  device        TEXT NOT NULL,
  clearance_id  TEXT NOT NULL,
  cleared_at    TEXT,
  -- Cleared configuration attributes as JSON, e.g. {"software":"3.1.4"}.
  configuration TEXT NOT NULL DEFAULT '{}',
  note          TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_baselines_device ON baselines(device);

-- A proposed or recorded change against a baseline.
CREATE TABLE IF NOT EXISTS changes (
  change_id     TEXT PRIMARY KEY,
  baseline_id   TEXT NOT NULL REFERENCES baselines(baseline_id) ON DELETE CASCADE,
  -- Free text as the engineer typed it. Provenance for extracted change-facts,
  -- NOT a grounded controlled-document quote (see change_gaps).
  proposal      TEXT NOT NULL,
  -- What the change was compared against, as written ("v4.1", "K192214").
  comparator    TEXT,
  change_type   TEXT NOT NULL DEFAULT 'other',
  -- Subsystem/function touched, for cumulative clustering.
  subsystem     TEXT,
  -- Human-owned regulatory determination. NEVER set by the tool.
  determination TEXT NOT NULL DEFAULT 'undecided'
                  CHECK (determination IN ('undecided','letter_to_file','new_submission')),
  status        TEXT NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed','implemented','superseded')),
  -- Link to a real record once the change graduates to a drafted document.
  record_id     TEXT,
  changed_at    TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_changes_baseline ON changes(baseline_id, changed_at);

-- Gaps found on a change. Deterministic gaps are code-computed and citable;
-- inferred gaps are model suggestions requiring human acceptance. Kept OUT of
-- `findings` on purpose: a proposed change has no controlled-document text to
-- quote, so these are not protected by the hallucination guard, must never
-- carry a severity tier, and must never enter the findings surface.
CREATE TABLE IF NOT EXISTS change_gaps (
  gap_id     TEXT PRIMARY KEY,
  change_id  TEXT NOT NULL REFERENCES changes(change_id) ON DELETE CASCADE,
  origin     TEXT NOT NULL CHECK (origin IN ('deterministic','inferred')),
  kind       TEXT NOT NULL,
  detail     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','accepted','dismissed')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_change_gaps_change ON change_gaps(change_id);
