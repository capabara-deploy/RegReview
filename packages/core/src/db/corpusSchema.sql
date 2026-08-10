-- RegReview corpus database schema (Postgres/Neon).
--
-- Public regulatory reference data only — never customer content. See
-- db/index.ts for the full split rationale. This is one of three live
-- schemas split out of the original single-SQLite-file schema; see
-- sopsSchema.sql, customerSchema.sql, and (for the pre-split shape)
-- archiveSchema.sql.

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The hand-authored/public rule corpus: FDA regulation crosswalks, ISO
-- clause prose (ours, never the standard's own text), and cross-cutting
-- logic checks. SOP-derived rules (source='sop') live in the sops database
-- instead, alongside the sop_documents they were extracted from.
CREATE TABLE IF NOT EXISTS rules (
  rule_id            TEXT PRIMARY KEY,
  source             TEXT NOT NULL
                       CHECK (source IN ('cfr','iso_clause','guidance','logic')),
  citation           TEXT NOT NULL,
  title              TEXT NOT NULL,
  expectation        TEXT NOT NULL,
  -- JSON array of RecordType. Empty array means "applies to all record types".
  applies_to         TEXT NOT NULL DEFAULT '[]',
  harm_linked        INTEGER NOT NULL DEFAULT 0 CHECK (harm_linked IN (0,1)),
  -- Summed FDA citation count across ingested fiscal years. Empirical, not opinion.
  citation_frequency INTEGER NOT NULL DEFAULT 0,
  -- citation_frequency as a percentile rank (0..1) within the corpus. Severity
  -- keys off this rather than the raw count. See packages/core/src/severity.ts.
  frequency_percentile REAL NOT NULL DEFAULT 0,
  corpus_version     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rules_source ON rules(source);
CREATE INDEX IF NOT EXISTS idx_rules_freq ON rules(citation_frequency DESC);

-- The raw FDA Inspectional Observation ("Turbo EIR") rows: a citation
-- string, the canonical sentence FDA writes when citing it, and how often it
-- was cited in a given fiscal year. Feeds severity weighting and eval labels.
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

-- Verbatim regulation text, addressable by date so both the legacy QSR
-- (which still governs historical records and every historical 483
-- citation) and the post-2026-02-02 QMSR text can coexist.
--
-- `reserved` is BOOLEAN here (not the INTEGER-0/1-CHECK convention used
-- elsewhere in this file) because this table was first created ad hoc by
-- packages/corpus/src/cli/ingestCfrSubchapterH.ts before this shared schema
-- existed; matching that shape avoids a churny type change on a table nothing
-- in the review pipeline reads (see loadRulesFor in store.ts, which never
-- queries this table — it exists for lookup by a reviewer or rule author).
CREATE TABLE IF NOT EXISTS cfr_sections (
  cfr_section_id TEXT PRIMARY KEY,
  as_of_date     TEXT NOT NULL,
  part           TEXT NOT NULL,
  subpart        TEXT,
  section        TEXT NOT NULL,
  heading        TEXT NOT NULL,
  body           TEXT NOT NULL,
  reserved       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cfr_unique
  ON cfr_sections(as_of_date, section);
