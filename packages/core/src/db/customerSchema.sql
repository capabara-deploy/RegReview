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

-- ---------------------------------------------------------------------------
-- Change workflow, risk accumulation, and submission tracking.
--
-- What device companies actually do today is keep a spreadsheet: one row per
-- change, a 1-10 risk number, and a running total that trips a threshold. The
-- spreadsheet is wrong in three specific ways, and these columns exist to fix
-- exactly those three:
--
--  1. It cannot tell "changed but not yet documented" from "documented but not
--     yet submitted". Those are different exposures — the first is the one that
--     draws a 483 — so a change carries a STAGE, and risk is pooled by stage.
--  2. Its scores have nothing behind them. Here a score carries a floor derived
--     from the FDA change-decision flowcharts, the rationale for going below
--     that floor, and a record of whether a human ever confirmed the number.
--  3. It never resets. A cleared submission re-baselines the device, which is
--     the whole point of accumulating in the first place — so submissions are
--     first-class rows, and clearing one retires the changes it carried.
--
-- None of this computes a determination. The threshold is the CUSTOMER's, read
-- from their own change-control procedure; crossing it says "your procedure
-- requires a determination and none has been made", never "submit to FDA".
-- ---------------------------------------------------------------------------

-- The escalation threshold is a property of the customer's procedure, not of
-- this tool and not of FDA. `threshold_source` is the citation that makes the
-- escalation message defensible in an audit ("QSP-0031 §5.4"); without it the
-- number is just as arbitrary as the spreadsheet's.
ALTER TABLE baselines ADD COLUMN IF NOT EXISTS threshold INTEGER NOT NULL DEFAULT 30;
ALTER TABLE baselines ADD COLUMN IF NOT EXISTS threshold_source TEXT;
-- Set when a cleared submission supersedes this baseline, so the ledger can
-- show the lineage of clearances rather than orphaning the old row.
ALTER TABLE baselines ADD COLUMN IF NOT EXISTS superseded_by TEXT;

-- Where the change sits in the workflow. `status` above is superseded by this
-- and is no longer read; it keeps its default so old inserts still satisfy its
-- CHECK. Stages only move forward, which is what makes the backfill below safe
-- to leave in an idempotent migration.
ALTER TABLE changes ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'proposed';
UPDATE changes SET stage = status WHERE stage = 'proposed' AND status <> 'proposed';

DO $$ BEGIN
  ALTER TABLE changes ADD CONSTRAINT changes_stage_check
    CHECK (stage IN ('proposed','implemented','documented','in_submission','cleared','superseded'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Risk score, 1-10, in the units the industry already uses.
--
-- Three columns rather than one because the provenance of the number is the
-- product. `suggested_score` is the model's read of the typed proposal and is
-- NOT protected by the hallucination guard (a typed change has no controlled
-- document to quote), so it stays visibly distinct from `score`, which only a
-- human writes. `score_floor` is deterministic: it comes from the change type's
-- FDA flowchart branch, and the effective score is clamped up to it.
ALTER TABLE changes ADD COLUMN IF NOT EXISTS score INTEGER
  CHECK (score IS NULL OR (score BETWEEN 1 AND 10));
ALTER TABLE changes ADD COLUMN IF NOT EXISTS suggested_score INTEGER
  CHECK (suggested_score IS NULL OR (suggested_score BETWEEN 1 AND 10));
ALTER TABLE changes ADD COLUMN IF NOT EXISTS suggested_rationale TEXT;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS suggested_at TEXT;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS scored_by TEXT;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS scored_at TEXT;
-- The FDA change guidance repeatedly says a change of some kind is significant
-- "unless a documented rationale establishes otherwise". This column IS that
-- documented rationale, captured at the moment the human overrides the floor —
-- which is the artifact no spreadsheet has when an investigator asks for it.
ALTER TABLE changes ADD COLUMN IF NOT EXISTS below_floor_rationale TEXT;

-- Stage transitions. `record_id` (above) is the controlled document that
-- captures the change; it is what moves a change from implemented to documented.
ALTER TABLE changes ADD COLUMN IF NOT EXISTS implemented_at TEXT;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS documented_at TEXT;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS documented_by TEXT;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS submission_id TEXT;

CREATE INDEX IF NOT EXISTS idx_changes_stage ON changes(baseline_id, stage);
CREATE INDEX IF NOT EXISTS idx_changes_submission ON changes(submission_id);

-- A regulatory submission bundling one or more accumulated changes.
--
-- Deliberately a plain tracking record: the tool never decides that a
-- submission is needed, never picks its kind, and never files it. It tracks
-- what a human decided, so the ledger can answer "is this change actually out
-- the door yet?" — the question the spreadsheet cannot answer at all.
CREATE TABLE IF NOT EXISTS submissions (
  submission_id TEXT PRIMARY KEY,
  baseline_id   TEXT NOT NULL REFERENCES baselines(baseline_id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  -- Chosen by the human. 'letter_to_file' is included because deciding NOT to
  -- submit is equally a decision that needs a dated, reviewable artifact.
  kind          TEXT NOT NULL DEFAULT 'special_510k'
                  CHECK (kind IN ('special_510k','traditional_510k','abbreviated_510k',
                                  'letter_to_file','pma_supplement','other')),
  status        TEXT NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned','filed','additional_info','cleared','withdrawn')),
  filed_at      TEXT,
  decision_at   TEXT,
  -- The clearance number FDA assigns, which becomes the next baseline's comparator.
  clearance_id  TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_baseline ON submissions(baseline_id, created_at);
