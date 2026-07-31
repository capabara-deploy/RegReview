import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { z } from "zod";
import {
  categoriesForRules,
  config,
  deleteSop,
  detectFormat,
  extractRecord,
  FindingStatus,
  getDb,
  getSop,
  ingestSop,
  listSops,
  loadFindings,
  loadRulesFor,
  migrate,
  RecordType,
  runReview,
  saveRecord,
  setFindingStatus,
  updateSop,
  type Block,
  type Finding,
  type RecordDoc,
} from "@regreview/core";

/**
 * The reviewer API.
 *
 * This process is the only one that holds an Anthropic credential, and the
 * browser never talks to the model API directly. That is a deliberate boundary:
 * the documents this tool reads are among the most confidential a device company
 * owns, so the surface that can send them anywhere is kept to one place. It is
 * also why the review itself runs here: a review sends document text to the
 * model, and this process is the only one permitted to.
 */

const app = Fastify({ logger: { level: "warn" } });

await app.register(cors, { origin: true });
await app.register(multipart, {
  // Quality records are large but not enormous; this is generous headroom and a
  // guard against an accidental huge upload wedging the process.
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

migrate();

const uploadDir = join(config.uploadDir);
mkdirSync(uploadDir, { recursive: true });

interface RecordRow {
  record_id: string;
  filename: string;
  record_type: string;
  doc_id: string | null;
  revision: string | null;
  normalized_text: string;
  created_at: string;
}

interface RunRow {
  run_id: string;
  record_id: string;
  model: string;
  effort: string;
  prompt_version: string;
  corpus_version: string;
  started_at: string;
  finished_at: string | null;
  status: string;
}

interface BlockRow {
  block_id: string;
  record_id: string;
  ordinal: number;
  char_start: number;
  char_end: number;
  heading: string | null;
}

/** Documents that have at least one completed run, newest activity first. */
app.get("/api/records", () => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.record_id, r.filename, r.record_type, r.doc_id, r.revision, r.created_at,
              COUNT(DISTINCT run.run_id) AS runs,
              MAX(run.started_at)       AS last_run_at
         FROM records r
         LEFT JOIN runs run ON run.record_id = r.record_id AND run.status = 'complete'
        GROUP BY r.record_id
        ORDER BY COALESCE(MAX(run.started_at), r.created_at) DESC`,
    )
    .all() as (Omit<RecordRow, "normalized_text"> & { runs: number; last_run_at: string | null })[];

  return rows.map((r) => ({
    recordId: r.record_id,
    filename: r.filename,
    recordType: r.record_type,
    docId: r.doc_id,
    revision: r.revision,
    runs: r.runs,
    lastRunAt: r.last_run_at,
  }));
});

/** The document text, its blocks, and its runs. */
app.get("/api/records/:recordId", (request, reply) => {
  const { recordId } = request.params as { recordId: string };
  const db = getDb();

  const record = db.prepare(`SELECT * FROM records WHERE record_id = ?`).get(recordId) as
    | RecordRow
    | undefined;
  if (!record) return reply.code(404).send({ error: "record not found" });

  const blocks = db
    .prepare(
      `SELECT block_id, record_id, ordinal, char_start, char_end, heading
         FROM blocks WHERE record_id = ? ORDER BY ordinal`,
    )
    .all(recordId) as BlockRow[];

  const runs = db
    .prepare(`SELECT * FROM runs WHERE record_id = ? ORDER BY started_at DESC`)
    .all(recordId) as RunRow[];

  return {
    recordId: record.record_id,
    filename: record.filename,
    recordType: record.record_type,
    docId: record.doc_id,
    revision: record.revision,
    // The single canonical rendering. Every offset in every finding indexes
    // into this exact string, so the client must not transform it.
    normalizedText: record.normalized_text,
    blocks: blocks.map((b) => ({
      blockId: b.block_id,
      ordinal: b.ordinal,
      charStart: b.char_start,
      charEnd: b.char_end,
      heading: b.heading,
    })),
    runs: runs.map((r) => ({
      runId: r.run_id,
      model: r.model,
      effort: r.effort,
      promptVersion: r.prompt_version,
      corpusVersion: r.corpus_version,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
    })),
  };
});

app.get("/api/runs/:runId/findings", (request) => {
  const { runId } = request.params as { runId: string };
  return loadFindings(runId);
});

const PatchBody = z.object({
  status: FindingStatus,
  note: z.string().max(4000).optional(),
  actor: z.string().min(1).max(120).default("reviewer"),
});

/**
 * Record a reviewer decision.
 *
 * The status changes in place, but the decision is also appended to
 * `finding_events`, which is never updated or deleted — that append-only log is
 * the Part 11 groundwork.
 */
app.patch("/api/runs/:runId/findings/:findingId", (request, reply) => {
  const { runId, findingId } = request.params as { runId: string; findingId: string };
  const parsed = PatchBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid body", detail: parsed.error.issues });
  }

  const db = getDb();
  const exists = db
    .prepare(`SELECT 1 FROM findings WHERE run_id = ? AND finding_id = ?`)
    .get(runId, findingId);
  if (!exists) return reply.code(404).send({ error: "finding not found" });

  setFindingStatus({
    runId,
    findingId,
    status: parsed.data.status,
    actor: parsed.data.actor,
    ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
  });

  const updated = loadFindings(runId).find((f: Finding) => f.findingId === findingId);
  return updated;
});

/** The audit trail for one finding. */
app.get("/api/runs/:runId/findings/:findingId/events", (request) => {
  const { runId, findingId } = request.params as { runId: string; findingId: string };
  const db = getDb();
  return db
    .prepare(
      `SELECT event_id, event_type, actor, note, occurred_at
         FROM finding_events WHERE run_id = ? AND finding_id = ? ORDER BY event_id`,
    )
    .all(runId, findingId);
});

interface RuleRow {
  rule_id: string;
  source: string;
  citation: string;
  title: string;
  expectation: string;
  applies_to: string | null;
  harm_linked: number;
  citation_frequency: number;
  frequency_percentile: number;
}

function mapRule(row: RuleRow) {
  return {
    ruleId: row.rule_id,
    source: row.source,
    citation: row.citation,
    title: row.title,
    expectation: row.expectation,
    appliesTo: row.applies_to ? (JSON.parse(row.applies_to) as string[]) : [],
    harmLinked: row.harm_linked === 1,
    citationFrequency: row.citation_frequency,
    frequencyPercentile: row.frequency_percentile,
  };
}

/**
 * The standing rule corpus the compliance and plausibility passes check against —
 * the FDA/ISO clause rules and the logic rules. Read-only: unlike the customer's
 * own SOPs, these are the tool's authored regulatory expectations, keyed to
 * clause IDs (ISO text is copyrighted and never shipped) and carrying the real
 * FDA citation frequency inherited through each rule's CFR crosswalk. The
 * customer's editable procedures are served separately from /api/sops.
 */
app.get("/api/rules", (request) => {
  // ?include=all adds the customer's own SOP clauses. The reference library in
  // the Procedures view wants only the shipped corpus; the review rule picker
  // wants everything selectable, including the customer's procedures.
  const { include } = request.query as { include?: string };
  const withSops = include === "all";

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT rule_id, source, citation, title, expectation, applies_to,
              harm_linked, citation_frequency, frequency_percentile
         FROM rules
        ${withSops ? "" : "WHERE source != 'sop'"}
        ORDER BY source, frequency_percentile DESC, citation_frequency DESC`,
    )
    .all() as RuleRow[];
  return rows.map(mapRule);
});

/** The rule behind a finding, so the reviewer can read the requirement in full. */
app.get("/api/rules/:ruleId", (request, reply) => {
  const { ruleId } = request.params as { ruleId: string };
  const db = getDb();
  const row = db.prepare(`SELECT * FROM rules WHERE rule_id = ?`).get(ruleId) as
    | {
        rule_id: string;
        source: string;
        citation: string;
        title: string;
        expectation: string;
        harm_linked: number;
        citation_frequency: number;
        frequency_percentile: number;
      }
    | undefined;
  if (!row) return reply.code(404).send({ error: "rule not found" });
  return {
    ruleId: row.rule_id,
    source: row.source,
    citation: row.citation,
    title: row.title,
    expectation: row.expectation,
    harmLinked: row.harm_linked === 1,
    citationFrequency: row.citation_frequency,
    frequencyPercentile: row.frequency_percentile,
  };
});

// ---------------------------------------------------------------------------
// Uploading documents
// ---------------------------------------------------------------------------

/** A safe on-disk name: the original basename, prefixed to avoid collisions and
 *  stripped of anything that could escape the upload directory. */
function safeStoredName(filename: string): string {
  const base = basename(filename).replace(/[^A-Za-z0-9._-]/g, "_");
  return `${Date.now()}-${randomUUID().slice(0, 8)}-${base}`;
}

/**
 * Upload a record to review.
 *
 * The file is written to the upload directory on local disk and never leaves it;
 * only extracted text is ever sent to the model, and only when a review is
 * explicitly started. Extraction happens here so an unreadable file (a scan, a
 * legacy .doc) is rejected at upload rather than surfacing later as an empty
 * review that reads like a clean result.
 */
app.post("/api/records", async (request, reply) => {
  const uploaded = await request.file();
  if (!uploaded) return reply.code(400).send({ error: "no file in request" });

  if (!detectFormat(uploaded.filename)) {
    return reply.code(415).send({
      error: `unsupported file type: ${extname(uploaded.filename) || "(none)"}. ` +
        `Supported: .pdf, .docx, .md, .txt`,
    });
  }

  // recordType may accompany the file as a multipart field.
  const typeField = uploaded.fields["recordType"];
  const rawType =
    typeField && !Array.isArray(typeField) && "value" in typeField
      ? String(typeField.value)
      : "capa";
  const parsedType = RecordType.safeParse(rawType);
  const recordType = parsedType.success ? parsedType.data : "capa";

  const storedPath = join(uploadDir, safeStoredName(uploaded.filename));
  writeFileSync(storedPath, await uploaded.toBuffer());

  let extracted;
  try {
    extracted = await extractRecord({ path: storedPath, recordType });
  } catch (err) {
    return reply.code(422).send({
      error: err instanceof Error ? err.message : "could not read the document",
    });
  }

  // Show the original filename, not the collision-proofed on-disk name. The
  // stored path keeps the prefixed name; only the display label is cleaned.
  extracted.record.filename = basename(uploaded.filename);
  saveRecord(extracted.record, extracted.blocks);

  return reply.code(201).send({
    recordId: extracted.record.recordId,
    filename: extracted.record.filename,
    recordType: extracted.record.recordType,
    docId: extracted.record.docId,
    revision: extracted.record.revision,
    format: extracted.format,
    pageCount: extracted.pageCount ?? null,
    blocks: extracted.blocks.length,
    // Surfaced so the client can warn the user rather than let a scan look clean.
    warning: extracted.warning ?? null,
  });
});

/**
 * Delete a document and everything derived from it.
 *
 * Destructive and deliberately explicit about it: this removes the document's
 * runs, its findings, and the `finding_events` audit trail behind those
 * findings. The counts come back so the UI can say what was actually destroyed
 * rather than a bare "deleted".
 *
 * Rows are removed in dependency order rather than leaning on cascades, because
 * the cascade rules exist to protect offset integrity when a document is
 * re-blocked, not to define what deletion means.
 */
app.delete("/api/records/:recordId", (request, reply) => {
  const { recordId } = request.params as { recordId: string };
  const db = getDb();

  const exists = db.prepare(`SELECT 1 FROM records WHERE record_id = ?`).get(recordId);
  if (!exists) return reply.code(404).send({ error: "record not found" });

  const counts = {
    runs: (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE record_id = ?`).get(recordId) as { n: number }).n,
    findings: (db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE record_id = ?`).get(recordId) as { n: number }).n,
  };

  db.transaction(() => {
    db.prepare(
      `DELETE FROM finding_events WHERE run_id IN (SELECT run_id FROM runs WHERE record_id = ?)`,
    ).run(recordId);
    db.prepare(`DELETE FROM findings WHERE record_id = ?`).run(recordId);
    db.prepare(`DELETE FROM facts WHERE record_id = ?`).run(recordId);
    db.prepare(`DELETE FROM runs WHERE record_id = ?`).run(recordId);
    db.prepare(`DELETE FROM blocks WHERE record_id = ?`).run(recordId);
    db.prepare(`DELETE FROM records WHERE record_id = ?`).run(recordId);
  })();

  // The uploaded file itself is left on disk. It is the customer's document and
  // may be the only copy they handed us; removing the database rows is what the
  // user asked for, silently destroying their file is not.
  return { recordId, ...counts };
});

// ---------------------------------------------------------------------------
// Running a review (background job)
// ---------------------------------------------------------------------------

/**
 * A review takes minutes and costs money, so it runs as a background job and the
 * client polls for status. Jobs live in memory: they are progress for a
 * long-running request, not durable state — the durable result is the run and
 * its findings in the database.
 */
/** One document's slot in a job. Always present, length 1 for a single review. */
interface JobResult {
  recordId: string;
  filename: string;
  docId: string | null;
  status: "pending" | "running" | "complete" | "failed";
  /** Completed engine steps and the number expected, for a progress bar. */
  stepsDone: number;
  stepsTotal: number;
  /** Human label for the step in flight, e.g. "compliance". */
  phase: string | null;
  runId?: string;
  findingCount?: number;
  error?: string;
}

interface Job {
  jobId: string;
  /** The record under review, or the first of them for a batch. */
  recordId: string;
  status: "running" | "complete" | "failed";
  progress: string[];
  runId?: string;
  findingCount?: number;
  error?: string;
  startedAt: string;
  results: JobResult[];
}
const jobs = new Map<string, Job>();

/**
 * How many engine steps a review will report: one per check pass, plus the
 * verifier and the anchoring stage.
 */
function expectedSteps(categories: number): number {
  return categories + 2;
}

/**
 * How many check passes a review will run — four unless it is scoped, in which
 * case only the passes the selected rules belong to. Mirrors the decision
 * `runReview` actually makes, so the bar is scaled to the work being done rather
 * than to a full review that is not happening.
 */
function passCountFor(recordType: RecordType, ruleIds: string[]): number {
  if (ruleIds.length === 0) return 4;
  const applicable = loadRulesFor(recordType);
  const scoped = applicable.filter((r) => ruleIds.includes(r.ruleId));
  return Math.max(1, categoriesForRules(scoped).length);
}

/**
 * Advance a document's progress from the engine's own progress lines.
 *
 * This reads the engine's human-readable output rather than a structured
 * channel, which is a deliberate tradeoff: a typed progress event would have to
 * thread through ReviewEngine and both implementations, and the only consumer is
 * a progress bar. The failure mode if a message is reworded is that the bar
 * advances less smoothly — it still reaches completion, because completion is
 * driven by the job, not by the parsing. Keep it that way.
 */
function advance(slot: JobResult, message: string): void {
  const category = /^(compliance|conformance|completeness|plausibility):/.exec(message);
  if (category) {
    slot.phase = category[1]!;
    slot.stepsDone = Math.min(slot.stepsDone + 1, slot.stepsTotal);
    return;
  }
  if (message.startsWith("verifier dropped")) {
    slot.phase = "verifying";
    slot.stepsDone = Math.min(slot.stepsDone + 1, slot.stepsTotal);
    return;
  }
  if (message.startsWith("anchored ")) {
    slot.phase = "anchoring";
    slot.stepsDone = Math.min(slot.stepsDone + 1, slot.stepsTotal);
    return;
  }
  if (message.startsWith("consistency:")) slot.phase = "cross-checking";
}

const StartReviewBody = z.object({
  /** Other record IDs to check cross-document consistency against. */
  related: z.array(z.string()).default([]),
  /** Self-consistency samples per check. 3 is the defensible-consistency setting. */
  samples: z.number().int().min(1).max(5).default(1),
  /** Offline keyword baseline — free, crude, for smoke-testing the pipeline. */
  offline: z.boolean().default(false),
  /**
   * Restrict the review to these rules. Empty means every applicable rule.
   *
   * This is what a standards-transition scan uses: pick the requirements that
   * changed, run only those, across as many documents as needed.
   */
  ruleIds: z.array(z.string()).default([]),
});

app.post("/api/records/:recordId/review", async (request, reply) => {
  const { recordId } = request.params as { recordId: string };
  const parsed = StartReviewBody.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid body", detail: parsed.error.issues });
  }

  const db = getDb();
  const record = loadRecord(db, recordId);
  if (!record) return reply.code(404).send({ error: "record not found" });

  // A model review with no credential fails deep in the engine with a confusing
  // error; catch it at the door.
  if (!parsed.data.offline && !process.env["ANTHROPIC_API_KEY"] && !process.env["ANTHROPIC_AUTH_TOKEN"]) {
    return reply.code(412).send({
      error:
        "no Anthropic credential configured on the server. Set ANTHROPIC_API_KEY " +
        "in the server's environment, or run an offline review.",
    });
  }

  const related = [];
  for (const id of parsed.data.related) {
    const r = loadRecord(db, id);
    if (r) related.push(r);
  }

  const slot: JobResult = {
    recordId,
    filename: record.record.filename,
    docId: record.record.docId,
    status: "running",
    stepsDone: 0,
    stepsTotal: expectedSteps(passCountFor(record.record.recordType, parsed.data.ruleIds)),
    phase: "starting",
  };

  const job: Job = {
    jobId: randomUUID(),
    recordId,
    status: "running",
    progress: [],
    startedAt: new Date().toISOString(),
    results: [slot],
  };
  jobs.set(job.jobId, job);

  // Fire and forget; the client polls GET /api/jobs/:id.
  void (async () => {
    try {
      const result = await runReview({
        record: record.record,
        blocks: record.blocks,
        related,
        samples: parsed.data.samples,
        offline: parsed.data.offline,
        ...(parsed.data.ruleIds.length > 0 ? { ruleIds: parsed.data.ruleIds } : {}),
        onProgress: (m) => {
          job.progress.push(m);
          advance(slot, m);
          // Bound the log so a long run can't grow it without limit.
          if (job.progress.length > 200) job.progress.splice(0, job.progress.length - 200);
        },
      });
      job.status = "complete";
      job.runId = result.run.runId;
      job.findingCount = result.findings.length;
      slot.status = "complete";
      slot.stepsDone = slot.stepsTotal;
      slot.phase = null;
      slot.runId = result.run.runId;
      slot.findingCount = result.findings.length;
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      slot.status = "failed";
      slot.phase = null;
      slot.error = job.error;
    }
  })();

  return reply.code(202).send({ jobId: job.jobId });
});

const BatchReviewBody = z.object({
  recordIds: z.array(z.string()).min(1).max(500),
  ruleIds: z.array(z.string()).default([]),
  samples: z.number().int().min(1).max(5).default(1),
  offline: z.boolean().default(false),
});

/**
 * Review many documents against the same rule set.
 *
 * This is the standards-transition workflow: a requirement changed, and the
 * question is which documents in the quality system now violate it. Documents
 * are reviewed one at a time rather than concurrently — the engine already runs
 * its own check passes concurrently and is bounded internally, so stacking a
 * second layer of concurrency here would just trip rate limits and lose the
 * whole batch to a capacity blip.
 *
 * One document failing must not abort the rest. Each result carries its own
 * error, and the job completes with a mix of successes and failures rather than
 * discarding work already paid for.
 */
app.post("/api/reviews/batch", async (request, reply) => {
  const parsed = BatchReviewBody.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid body", detail: parsed.error.issues });
  }

  if (!parsed.data.offline && !process.env["ANTHROPIC_API_KEY"] && !process.env["ANTHROPIC_AUTH_TOKEN"]) {
    return reply.code(412).send({
      error:
        "no Anthropic credential configured on the server. Set ANTHROPIC_API_KEY " +
        "in the server's environment, or run an offline review.",
    });
  }

  const db = getDb();
  const loaded = [];
  for (const id of parsed.data.recordIds) {
    const r = loadRecord(db, id);
    if (r) loaded.push(r);
  }
  if (loaded.length === 0) {
    return reply.code(404).send({ error: "none of the requested records were found" });
  }

  const job: Job = {
    jobId: randomUUID(),
    recordId: loaded[0]!.record.recordId,
    status: "running",
    progress: [],
    startedAt: new Date().toISOString(),
    results: loaded.map((r) => ({
      recordId: r.record.recordId,
      filename: r.record.filename,
      docId: r.record.docId,
      status: "pending" as const,
      stepsDone: 0,
      stepsTotal: expectedSteps(passCountFor(r.record.recordType, parsed.data.ruleIds)),
      phase: null,
    })),
  };
  jobs.set(job.jobId, job);

  void (async () => {
    let totalFindings = 0;
    for (const [i, doc] of loaded.entries()) {
      const label = doc.record.docId ?? doc.record.filename;
      const slot = job.results[i]!;
      slot.status = "running";
      slot.phase = "starting";
      job.progress.push(`[${i + 1}/${loaded.length}] ${label}`);
      try {
        const result = await runReview({
          record: doc.record,
          blocks: doc.blocks,
          samples: parsed.data.samples,
          offline: parsed.data.offline,
          ...(parsed.data.ruleIds.length > 0 ? { ruleIds: parsed.data.ruleIds } : {}),
          onProgress: (m) => {
            job.progress.push(`    ${m}`);
            advance(slot, m);
            if (job.progress.length > 400) job.progress.splice(0, job.progress.length - 400);
          },
        });
        slot.status = "complete";
        slot.stepsDone = slot.stepsTotal;
        slot.phase = null;
        slot.runId = result.run.runId;
        slot.findingCount = result.findings.length;
        totalFindings += result.findings.length;
        job.progress.push(`    -> ${result.findings.length} finding(s)`);
      } catch (err) {
        slot.status = "failed";
        slot.phase = null;
        slot.error = err instanceof Error ? err.message : String(err);
        job.progress.push(`    -> FAILED: ${slot.error}`);
      }
    }
    job.status = "complete";
    job.findingCount = totalFindings;
  })();

  return reply.code(202).send({ jobId: job.jobId, records: loaded.length });
});

app.get("/api/jobs/:jobId", (request, reply) => {
  const { jobId } = request.params as { jobId: string };
  const job = jobs.get(jobId);
  if (!job) return reply.code(404).send({ error: "job not found" });
  return job;
});

// ---------------------------------------------------------------------------
// Managing the customer's procedures (SOPs)
// ---------------------------------------------------------------------------

app.get("/api/sops", () => listSops());

app.get("/api/sops/:sopId", (request, reply) => {
  const { sopId } = request.params as { sopId: string };
  const sop = getSop(sopId);
  if (!sop) return reply.code(404).send({ error: "procedure not found" });
  return sop;
});

const SopTextBody = z.object({
  filename: z.string().min(1).max(200),
  text: z.string().min(1),
  appliesTo: z.array(RecordType).default(["capa"]),
});

/**
 * Create a procedure, from an uploaded file or from pasted text.
 *
 * Clause extraction is deterministic — no model — so the conformance rules a
 * review checks against are a pure function of the procedure text. Editing that
 * text (below) immediately changes what conformance means, which is the point of
 * making it editable in the first place.
 */
app.post("/api/sops", async (request, reply) => {
  const contentType = request.headers["content-type"] ?? "";

  if (contentType.startsWith("multipart/")) {
    const uploaded = await request.file();
    if (!uploaded) return reply.code(400).send({ error: "no file in request" });
    if (!detectFormat(uploaded.filename)) {
      return reply.code(415).send({ error: "unsupported file type for a procedure" });
    }
    const appliesField = uploaded.fields["appliesTo"];
    const appliesRaw =
      appliesField && !Array.isArray(appliesField) && "value" in appliesField
        ? String(appliesField.value)
        : "capa";
    const appliesTo = parseAppliesTo(appliesRaw);

    const storedPath = join(uploadDir, safeStoredName(uploaded.filename));
    writeFileSync(storedPath, await uploaded.toBuffer());
    // Reuse format parsing so a .docx procedure becomes text before clause
    // extraction runs on it.
    const extracted = await extractRecord({ path: storedPath, recordType: "unknown" });
    const result = ingestSop({
      filename: basename(uploaded.filename),
      storedPath,
      raw: extracted.record.normalizedText,
      appliesTo,
    });
    return reply.code(201).send(summarizeIngest(result));
  }

  const parsed = SopTextBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid body", detail: parsed.error.issues });
  }
  const storedPath = join(uploadDir, safeStoredName(parsed.data.filename));
  writeFileSync(storedPath, parsed.data.text, "utf8");
  const result = ingestSop({
    filename: parsed.data.filename,
    storedPath,
    raw: parsed.data.text,
    appliesTo: parsed.data.appliesTo,
  });
  return reply.code(201).send(summarizeIngest(result));
});

const SopEditBody = z.object({
  text: z.string().min(1).optional(),
  appliesTo: z.array(RecordType).optional(),
});

/** Edit a procedure in place — new text and/or which record types it governs. */
app.put("/api/sops/:sopId", (request, reply) => {
  const { sopId } = request.params as { sopId: string };
  const parsed = SopEditBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid body", detail: parsed.error.issues });
  }
  if (parsed.data.text === undefined && parsed.data.appliesTo === undefined) {
    return reply.code(400).send({ error: "nothing to update: provide text and/or appliesTo" });
  }
  if (!getSop(sopId)) return reply.code(404).send({ error: "procedure not found" });

  const result = updateSop({
    sopDocumentId: sopId,
    ...(parsed.data.text !== undefined ? { raw: parsed.data.text } : {}),
    ...(parsed.data.appliesTo !== undefined ? { appliesTo: parsed.data.appliesTo } : {}),
  });
  return summarizeIngest(result);
});

app.delete("/api/sops/:sopId", (request, reply) => {
  const { sopId } = request.params as { sopId: string };
  const removed = deleteSop(sopId);
  if (!removed) return reply.code(404).send({ error: "procedure not found" });
  return reply.code(204).send();
});

function parseAppliesTo(raw: string): RecordType[] {
  const out: RecordType[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const parsed = RecordType.safeParse(part);
    if (parsed.success) out.push(parsed.data);
  }
  return out.length > 0 ? out : ["capa"];
}

function summarizeIngest(result: ReturnType<typeof ingestSop>) {
  return {
    sopDocumentId: result.document.sopDocumentId,
    filename: result.document.filename,
    docId: result.document.docId,
    revision: result.document.revision,
    title: result.document.title,
    clauses: result.rulesWritten,
  };
}

/** Load a record and its blocks for review. */
function loadRecord(
  db: ReturnType<typeof getDb>,
  recordId: string,
): { record: RecordDoc; blocks: Block[] } | null {
  const row = db.prepare(`SELECT * FROM records WHERE record_id = ?`).get(recordId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const blockRows = db
    .prepare(`SELECT * FROM blocks WHERE record_id = ? ORDER BY ordinal`)
    .all(recordId) as Record<string, unknown>[];

  const record: RecordDoc = {
    recordId: row["record_id"] as string,
    filename: row["filename"] as string,
    storedPath: row["stored_path"] as string,
    sha256: row["sha256"] as string,
    recordType: row["record_type"] as RecordDoc["recordType"],
    docId: (row["doc_id"] as string | null) ?? null,
    revision: (row["revision"] as string | null) ?? null,
    normalizedText: row["normalized_text"] as string,
    createdAt: row["created_at"] as string,
  };

  const blocks: Block[] = blockRows.map((b) => ({
    blockId: b["block_id"] as string,
    recordId: b["record_id"] as string,
    ordinal: b["ordinal"] as number,
    text: b["text"] as string,
    charStart: b["char_start"] as number,
    charEnd: b["char_end"] as number,
    page: (b["page"] as number | null) ?? null,
    bbox: b["bbox"] ? (JSON.parse(b["bbox"] as string) as [number, number, number, number]) : null,
    heading: (b["heading"] as string | null) ?? null,
  }));

  return { record, blocks };
}

const port = config.port;
await app.listen({ port, host: "127.0.0.1" });
console.log(`RegReview API on http://127.0.0.1:${port}`);
console.log(`  POST /api/records            upload a document`);
console.log(`  POST /api/records/:id/review start a review`);
console.log(`  GET/POST/PUT/DELETE /api/sops manage procedures`);
