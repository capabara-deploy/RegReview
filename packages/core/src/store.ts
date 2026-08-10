import { randomUUID } from "node:crypto";
import { CORPUS_VERSION, PROMPT_VERSION } from "./config.js";
import { getCorpusDb, getCustomerDb, getSopsDb, type Db } from "./db/index.js";
import type {
  Block,
  Finding,
  RecordDoc,
  RecordType,
  Rule,
  Run,
  SeverityBasis,
} from "./types.js";
import { RecordType as RecordTypeSchema } from "./types.js";

/** Reading the rule corpus. */

interface RuleRow {
  rule_id: string;
  source: string;
  citation: string;
  title: string;
  expectation: string;
  applies_to: string;
  harm_linked: number;
  citation_frequency: number;
  frequency_percentile: number;
  corpus_version: string;
}

function toRule(row: RuleRow): Rule {
  let appliesTo: RecordType[] = [];
  try {
    const parsed: unknown = JSON.parse(row.applies_to);
    if (Array.isArray(parsed)) {
      appliesTo = parsed.filter(
        (v): v is RecordType => RecordTypeSchema.safeParse(v).success,
      );
    }
  } catch {
    // A corrupt applies_to means "all record types" rather than "no rules",
    // because silently dropping a requirement is the worse failure here.
  }

  return {
    ruleId: row.rule_id,
    source: row.source as Rule["source"],
    citation: row.citation,
    title: row.title,
    expectation: row.expectation,
    appliesTo,
    harmLinked: row.harm_linked === 1,
    citationFrequency: row.citation_frequency,
    frequencyPercentile: row.frequency_percentile,
    corpusVersion: row.corpus_version,
  };
}

/**
 * The full rule corpus: the public/authored set (corpus database) plus any
 * SOP-derived rules (sops database). Two databases, one merged result — the
 * only place in the app that needs to query both at once. See db/index.ts
 * for why they're split.
 */
export async function loadAllRules(): Promise<Rule[]> {
  const [corpusRows, sopRows] = await Promise.all([
    getCorpusDb().prepare(`SELECT * FROM rules`).all<RuleRow>(),
    getSopsDb().prepare(`SELECT * FROM rules`).all<RuleRow>(),
  ]);
  return [...corpusRows, ...sopRows].map(toRule);
}

/**
 * Rules applicable to a record type.
 *
 * An empty `applies_to` means the rule applies to everything — that is how the
 * cross-cutting soundness checks are expressed, so it must not be read as
 * "applies to nothing".
 */
export async function loadRulesFor(recordType: RecordType): Promise<Rule[]> {
  const rules = await loadAllRules();
  return rules.filter(
    (rule) => rule.appliesTo.length === 0 || rule.appliesTo.includes(recordType),
  );
}

/** Writing records, runs and findings. */

/**
 * Persist a record and its blocks.
 *
 * The `sha256` check is not an optimisation — it prevents data loss.
 *
 * `findings.block_id` carries ON DELETE CASCADE, so deleting a record's blocks
 * deletes every finding anchored to them. Re-blocking unconditionally on each
 * run therefore wiped the previous run's findings before the new ones were
 * written, leaving only the most recent run in the database while the CLI
 * cheerfully reported findings for all of them. Run-to-run comparison — the
 * whole point of stable finding ids — was silently impossible.
 *
 * So: if the normalized text is byte-identical, leave the blocks alone. If it
 * genuinely changed, the old findings *should* go, because they are anchored to
 * character offsets that no longer refer to the same text — but that is now an
 * explicit, reported consequence rather than an invisible side effect.
 */
export async function saveRecord(
  record: RecordDoc,
  blocks: Block[],
  db: Db = getCustomerDb(),
): Promise<{ reblocked: boolean; discardedFindings: number }> {
  const existing = await db
    .prepare(`SELECT sha256 FROM records WHERE record_id = ?`)
    .get<{ sha256: string }>(record.recordId);

  // Same bytes, same blocks. Nothing to re-block, so nothing to cascade.
  const unchanged = existing?.sha256 === record.sha256;

  const discardedFindings = unchanged
    ? 0
    : (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM findings WHERE record_id = ?`)
          .get<{ n: number }>(record.recordId)
      )?.n ?? 0;

  await db.transaction(async () => {
    await db
      .prepare(
        `INSERT INTO records
           (record_id, filename, stored_path, sha256, record_type, doc_id, revision,
            normalized_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(record_id) DO UPDATE SET
           filename        = excluded.filename,
           stored_path     = excluded.stored_path,
           sha256          = excluded.sha256,
           record_type     = excluded.record_type,
           doc_id          = excluded.doc_id,
           revision        = excluded.revision,
           normalized_text = excluded.normalized_text`,
      )
      .run(
        record.recordId,
        record.filename,
        record.storedPath,
        record.sha256,
        record.recordType,
        record.docId,
        record.revision,
        record.normalizedText,
        record.createdAt,
      );

    if (!unchanged) {
      // Replaces wholesale: a partially updated block set would leave findings
      // anchored to offsets that no longer exist. This cascades away findings
      // from earlier runs, which is correct when the text really changed.
      await db.prepare(`DELETE FROM blocks WHERE record_id = ?`).run(record.recordId);
      for (const b of blocks) {
        await db
          .prepare(
            `INSERT INTO blocks
               (block_id, record_id, ordinal, text, char_start, char_end, page, bbox, heading)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            b.blockId,
            b.recordId,
            b.ordinal,
            b.text,
            b.charStart,
            b.charEnd,
            b.page,
            b.bbox ? JSON.stringify(b.bbox) : null,
            b.heading,
          );
      }
    }
  })();

  return { reblocked: !unchanged, discardedFindings };
}

/**
 * Open a run.
 *
 * The model, effort, prompt version and corpus version are captured at start.
 * All four are part of the run's identity: two findings are only comparable if
 * they were produced under the same ones, and recording them is what lets a
 * repeat-run agreement number mean anything.
 */
export async function startRun(
  args: { recordId: string; model: string; effort: string },
  db: Db = getCustomerDb(),
): Promise<Run> {
  const run: Run = {
    runId: randomUUID(),
    recordId: args.recordId,
    model: args.model,
    effort: args.effort,
    promptVersion: PROMPT_VERSION,
    corpusVersion: CORPUS_VERSION,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    error: null,
  };

  await db
    .prepare(
      `INSERT INTO runs
         (run_id, record_id, model, effort, prompt_version, corpus_version,
          started_at, finished_at, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'running', NULL)`,
    )
    .run(
      run.runId,
      run.recordId,
      run.model,
      run.effort,
      run.promptVersion,
      run.corpusVersion,
      run.startedAt,
    );

  return run;
}

export async function finishRun(
  runId: string,
  status: "complete" | "failed",
  error: string | null = null,
  db: Db = getCustomerDb(),
): Promise<void> {
  await db
    .prepare(`UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE run_id = ?`)
    .run(status, error, new Date().toISOString(), runId);
}

export async function saveFindings(findings: Finding[], db: Db = getCustomerDb()): Promise<void> {
  const now = new Date().toISOString();

  await db.transaction(async () => {
    for (const f of findings) {
      await db
        .prepare(
          `INSERT INTO findings
             (finding_id, run_id, record_id, block_id, char_start, char_end, category,
              severity, severity_basis, rule_id, citation, quote, problem, rationale,
              suggestion, confidence, status, reviewer_note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          f.findingId,
          f.runId,
          f.recordId,
          f.blockId,
          f.charStart,
          f.charEnd,
          f.category,
          f.severity,
          JSON.stringify(f.severityBasis),
          f.ruleId,
          f.citation,
          f.quote,
          f.problem,
          f.rationale,
          f.suggestion,
          f.confidence,
          f.status,
        );
      await db
        .prepare(
          `INSERT INTO finding_events (run_id, finding_id, event_type, actor, note, occurred_at)
           VALUES (?, ?, 'created', 'engine', NULL, ?)`,
        )
        .run(f.runId, f.findingId, now);
    }
  })();
}

interface FindingRow {
  finding_id: string;
  run_id: string;
  record_id: string;
  block_id: string;
  char_start: number;
  char_end: number;
  category: string;
  severity: string;
  severity_basis: string;
  rule_id: string;
  citation: string;
  quote: string;
  problem: string;
  rationale: string;
  suggestion: string;
  confidence: string;
  status: string;
  reviewer_note: string | null;
}

export async function loadFindings(runId: string, db: Db = getCustomerDb()): Promise<Finding[]> {
  const rows = await db
    .prepare(`SELECT * FROM findings WHERE run_id = ? ORDER BY char_start`)
    .all<FindingRow>(runId);

  return rows.map((r) => ({
    findingId: r.finding_id,
    runId: r.run_id,
    recordId: r.record_id,
    blockId: r.block_id,
    charStart: r.char_start,
    charEnd: r.char_end,
    category: r.category as Finding["category"],
    severity: r.severity as Finding["severity"],
    severityBasis: JSON.parse(r.severity_basis) as SeverityBasis,
    ruleId: r.rule_id,
    citation: r.citation,
    quote: r.quote,
    problem: r.problem,
    rationale: r.rationale,
    suggestion: r.suggestion,
    confidence: r.confidence as Finding["confidence"],
    status: r.status as Finding["status"],
    reviewerNote: r.reviewer_note,
  }));
}

/**
 * Record a reviewer decision.
 *
 * The status is updated in place but the decision is also appended to
 * `finding_events`, which is never updated or deleted. That append-only log is
 * Part 11 groundwork: while the tool sits beside the official record we do not
 * inherit audit-trail and electronic-signature obligations, but when it
 * eventually touches the record we will not be retrofitting them.
 */
export async function setFindingStatus(
  args: {
    runId: string;
    findingId: string;
    status: Finding["status"];
    actor: string;
    note?: string;
  },
  db: Db = getCustomerDb(),
): Promise<void> {
  await db.transaction(async () => {
    await db
      .prepare(
        `UPDATE findings SET status = ?, reviewer_note = COALESCE(?, reviewer_note)
          WHERE run_id = ? AND finding_id = ?`,
      )
      .run(args.status, args.note ?? null, args.runId, args.findingId);

    await db
      .prepare(
        `INSERT INTO finding_events (run_id, finding_id, event_type, actor, note, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.runId,
        args.findingId,
        args.status === "open" ? "reopened" : args.status,
        args.actor,
        args.note ?? null,
        new Date().toISOString(),
      );
  })();
}

export async function latestRunFor(
  recordId: string,
  db: Db = getCustomerDb(),
): Promise<Run | undefined> {
  const row = await db
    .prepare(
      `SELECT * FROM runs WHERE record_id = ? AND status = 'complete'
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get<{
      run_id: string;
      record_id: string;
      model: string;
      effort: string;
      prompt_version: string;
      corpus_version: string;
      started_at: string;
      finished_at: string | null;
      status: string;
      error: string | null;
    }>(recordId);
  if (!row) return undefined;
  return {
    runId: row.run_id,
    recordId: row.record_id,
    model: row.model,
    effort: row.effort,
    promptVersion: row.prompt_version,
    corpusVersion: row.corpus_version,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as Run["status"],
    error: row.error,
  };
}
