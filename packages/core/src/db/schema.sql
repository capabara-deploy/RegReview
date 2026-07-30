-- RegReview schema, v1.
--
-- Design notes that are not obvious from the DDL:
--
--  * Findings are immutable facts about a run; reviewer decisions live in
--    `findings.status` plus an append-only `finding_events` log. Nothing is
--    ever deleted. This is Part 11 groundwork: when the tool eventually sits
--    on the official record we will already have the audit trail, and until
--    then we sit beside the record and do not inherit the obligation.
--
--  * `rules` mixes public regulation, our own authored prose for copyrighted
--    standards, and the customer's own SOPs. `source` is what tells them
--    apart, and it governs what may be displayed and redistributed. Do not
--    collapse it.
--
--  * Offsets (`char_start`, `char_end`) are into `records.normalized_text`,
--    a single plain-text rendering per record. One coordinate system for the
--    whole app means a highlight computed by the engine is the same highlight
--    the viewer draws.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Rule corpus
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rules (
  rule_id            TEXT PRIMARY KEY,
  source             TEXT NOT NULL
                       CHECK (source IN ('cfr','iso_clause','guidance','sop','logic')),
  citation           TEXT NOT NULL,
  title              TEXT NOT NULL,
  -- For source='iso_clause' this is OUR prose. Never the standard's text.
  expectation        TEXT NOT NULL,
  -- JSON array of RecordType. Empty array means "applies to all record types".
  applies_to         TEXT NOT NULL DEFAULT '[]',
  harm_linked        INTEGER NOT NULL DEFAULT 0 CHECK (harm_linked IN (0,1)),
  -- Summed FDA citation count across ingested fiscal years. Empirical, not opinion.
  citation_frequency INTEGER NOT NULL DEFAULT 0,
  -- citation_frequency as a percentile rank (0..1) within the corpus. Severity
  -- keys off this rather than the raw count: sub-paragraph rules inherit their
  -- parent paragraph's count, so an absolute threshold rated every CAPA rule
  -- high. See packages/core/src/severity.ts.
  frequency_percentile REAL NOT NULL DEFAULT 0,
  corpus_version     TEXT NOT NULL,
  -- Set when source='sop': which uploaded procedure this clause came from.
  sop_document_id    TEXT REFERENCES sop_documents(sop_document_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rules_source ON rules(source);
CREATE INDEX IF NOT EXISTS idx_rules_freq ON rules(citation_frequency DESC);

-- The raw FDA Inspectional Observation ("Turbo EIR") rows, kept separate from
-- `rules` because they are evidence, not requirements: a citation string, the
-- canonical sentence FDA writes when citing it, and how often it was cited in
-- a given fiscal year. Feeds severity weighting and eval labels.
CREATE TABLE IF NOT EXISTS fda_observations (
  observation_id    TEXT PRIMARY KEY,
  fiscal_year       INTEGER NOT NULL,
  program_area      TEXT NOT NULL,
  citation          TEXT NOT NULL,
  short_description TEXT NOT NULL,
  long_description  TEXT,
  frequency         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_citation ON fda_observations(citation);
CREATE INDEX IF NOT EXISTS idx_obs_year ON fda_observations(fiscal_year);

-- Verbatim regulation text, addressable by date so we hold both the legacy QSR
-- (which still governs historical records and every historical 483 citation)
-- and the post-2026-02-02 QMSR.
CREATE TABLE IF NOT EXISTS cfr_sections (
  cfr_section_id TEXT PRIMARY KEY,
  -- eCFR is date-addressable; this is the date the text was fetched as of.
  as_of_date     TEXT NOT NULL,
  part           TEXT NOT NULL,
  subpart        TEXT,
  section        TEXT NOT NULL,
  heading        TEXT NOT NULL,
  body           TEXT NOT NULL,
  reserved       INTEGER NOT NULL DEFAULT 0 CHECK (reserved IN (0,1))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cfr_unique
  ON cfr_sections(as_of_date, section);

-- ---------------------------------------------------------------------------
-- Customer content: the SOP upload space, and the records under review
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sop_documents (
  sop_document_id TEXT PRIMARY KEY,
  filename        TEXT NOT NULL,
  stored_path     TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  title           TEXT,
  doc_id          TEXT,
  revision        TEXT,
  effective_date  TEXT,
  normalized_text TEXT NOT NULL,
  uploaded_at     TEXT NOT NULL
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

-- The diff joins facts across records on (kind, subject), so index that pair.
CREATE INDEX IF NOT EXISTS idx_facts_kind_subject ON facts(kind, subject);
CREATE INDEX IF NOT EXISTS idx_facts_record ON facts(record_id);

-- ---------------------------------------------------------------------------
-- Runs and findings
-- ---------------------------------------------------------------------------

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
  rule_id        TEXT NOT NULL REFERENCES rules(rule_id),
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
  event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
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
