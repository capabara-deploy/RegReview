-- RegReview SOPs database schema (Postgres/Neon).
--
-- Uploaded customer procedures and the rules derived from them. Kept out of
-- both the corpus database (not public regulation) and the customer
-- database (a separate concern from records/runs/findings). See
-- db/index.ts for the full split rationale.

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

-- Rules extracted from an uploaded SOP's clauses. `expectation` is the
-- customer's own procedure text, not public regulation — that's exactly why
-- this table lives here and not in the corpus database.
CREATE TABLE IF NOT EXISTS rules (
  rule_id            TEXT PRIMARY KEY,
  source             TEXT NOT NULL CHECK (source = 'sop'),
  citation           TEXT NOT NULL,
  title              TEXT NOT NULL,
  expectation        TEXT NOT NULL,
  applies_to         TEXT NOT NULL DEFAULT '[]',
  harm_linked        INTEGER NOT NULL DEFAULT 0 CHECK (harm_linked IN (0,1)),
  citation_frequency INTEGER NOT NULL DEFAULT 0,
  frequency_percentile REAL NOT NULL DEFAULT 0,
  corpus_version     TEXT NOT NULL,
  sop_document_id    TEXT NOT NULL REFERENCES sop_documents(sop_document_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rules_source ON rules(source);
CREATE INDEX IF NOT EXISTS idx_rules_freq ON rules(citation_frequency DESC);
