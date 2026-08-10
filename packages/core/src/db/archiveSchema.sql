-- RegReview archive database schema (Postgres/Neon).
--
-- A frozen, unmodified port of the original pre-migration schema (single
-- SQLite file, single `rules` table mixing public/authored/SOP sources).
-- Not read by the running app — used once by
-- packages/core/src/cli/archiveSqlite.ts to preserve the exact contents of
-- data/regreview.db before the live app moved onto the split
-- corpus/customer/sops databases (see corpusSchema.sql, customerSchema.sql,
-- sopsSchema.sql, and the split rationale in db/index.ts).

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS rules (
  rule_id            TEXT PRIMARY KEY,
  source             TEXT NOT NULL
                       CHECK (source IN ('cfr','iso_clause','guidance','sop','logic')),
  citation           TEXT NOT NULL,
  title              TEXT NOT NULL,
  expectation        TEXT NOT NULL,
  applies_to         TEXT NOT NULL DEFAULT '[]',
  harm_linked        INTEGER NOT NULL DEFAULT 0 CHECK (harm_linked IN (0,1)),
  citation_frequency INTEGER NOT NULL DEFAULT 0,
  frequency_percentile REAL NOT NULL DEFAULT 0,
  corpus_version     TEXT NOT NULL,
  sop_document_id    TEXT REFERENCES sop_documents(sop_document_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rules_source ON rules(source);
CREATE INDEX IF NOT EXISTS idx_rules_freq ON rules(citation_frequency DESC);

CREATE TABLE IF NOT EXISTS fda_observations (
  observation_id    TEXT PRIMARY KEY,
  fiscal_year       INTEGER NOT NULL,
  program_area      TEXT NOT NULL,
  citation           TEXT NOT NULL,
  short_description TEXT NOT NULL,
  long_description  TEXT,
  frequency          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_citation ON fda_observations(citation);
CREATE INDEX IF NOT EXISTS idx_obs_year ON fda_observations(fiscal_year);

CREATE TABLE IF NOT EXISTS cfr_sections (
  cfr_section_id TEXT PRIMARY KEY,
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
  bbox       TEXT,
  heading    TEXT
);

CREATE INDEX IF NOT EXISTS idx_blocks_record ON blocks(record_id, ordinal);

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
CREATE INDEX IF NOT EXISTS idx_findings_stable_id ON findings(finding_id);

CREATE TABLE IF NOT EXISTS finding_events (
  -- BY DEFAULT, not ALWAYS: the one-time archive copy inserts the original
  -- SQLite AUTOINCREMENT event_id values explicitly, to preserve exact
  -- chronological order without relying on insertion order alone.
  event_id    INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  run_id      TEXT NOT NULL,
  finding_id  TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  note        TEXT,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (run_id, finding_id) REFERENCES findings(run_id, finding_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_finding ON finding_events(run_id, finding_id, event_id);
