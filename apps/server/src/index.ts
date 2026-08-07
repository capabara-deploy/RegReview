import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import {
  AUTH_ENABLED,
  createSession,
  deleteSession,
  ensureAuthIndexes,
  getMongoDb,
  resolveSession,
  verifyLogin,
} from "./auth.js";
import { consumeQuota, ensureQuotaIndexes, initQuota, peekQuota, resetQuota } from "./quota.js";
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
 *
 * This process is a pure JSON API. It does not serve the reviewer UI — that is
 * a separately deployed static site (apps/web), which talks to this process
 * across origins. See REGREVIEW_SITE_ORIGIN below for the CORS boundary that
 * implies.
 */

// The logged-in username, once the auth middleware below has run.
declare global {
  namespace Express {
    interface Request {
      username?: string;
    }
  }
}

const HOST = process.env["HOST"] ?? "127.0.0.1";
const PORT = config.port;

/**
 * Refuse to serve customer documents to the internet without accounts configured.
 *
 * This instance holds uploaded quality records — among the most confidential
 * documents a device company owns — and a button that spends money per click.
 * Defaulting to open when MONGODB_URI is merely absent is how that happens by
 * accident, so binding to anything other than loopback requires it.
 */
const PUBLIC = HOST !== "127.0.0.1" && HOST !== "localhost";
if (PUBLIC && !AUTH_ENABLED) {
  console.error(
    `Refusing to start: HOST is ${HOST}, which accepts connections from outside\n` +
      `this machine, but MONGODB_URI is not set. This process serves uploaded\n` +
      `customer documents and can spend money on the model API.\n\n` +
      `Set MONGODB_URI and create a reviewer account with "npm run user:create", or\n` +
      `bind to 127.0.0.1.`,
  );
  process.exit(1);
}

await ensureAuthIndexes();
if (AUTH_ENABLED) {
  initQuota(await getMongoDb());
  await ensureQuotaIndexes();
}
migrate();

/**
 * Reconcile runs left mid-flight by a previous process.
 *
 * A run row is written when a review starts and updated when it ends, so a
 * process that dies in between leaves it stuck at 'running' forever. Nothing
 * else ever reconciles it: the job that owned it lived in memory and died with
 * the process, and the reviewer UI skips non-complete runs when choosing which
 * one to show — so the work looks simply lost rather than failed.
 *
 * Anything still 'running' at startup cannot be in flight, because the only
 * process that could be advancing it is the one that just booted.
 */
{
  const db = getDb();
  const stranded = db
    .prepare(`SELECT run_id FROM runs WHERE status = 'running'`)
    .all() as { run_id: string }[];
  if (stranded.length > 0) {
    db.prepare(
      `UPDATE runs SET status = 'failed', finished_at = ?,
         error = 'interrupted: the server process ended before this review finished'
       WHERE status = 'running'`,
    ).run(new Date().toISOString());
    console.warn(
      `Marked ${stranded.length} interrupted run(s) as failed (left 'running' by a previous process).`,
    );
  }
}

const uploadDir = join(config.uploadDir);
mkdirSync(uploadDir, { recursive: true });

const app = express();

// Behind a reverse proxy (Caddy/nginx on the droplet, or a DO load balancer),
// the client address arrives in X-Forwarded-For. Without this, every request
// looks like it comes from the proxy and the rate limiter buckets the whole
// world together, and `secure` cookies can't tell the connection was really TLS.
if (PUBLIC) app.set("trust proxy", 1);

/**
 * The site (apps/web) and this API are always two origins now — there is no
 * mode where this process serves the frontend. `credentials: true` plus an
 * explicit origin (not "*") is what lets the browser attach the session
 * cookie to a cross-origin request; a wildcard origin cannot be combined with
 * credentials at all, by design of the CORS spec.
 */
const SITE_ORIGINS = (process.env["REGREVIEW_SITE_ORIGIN"] ?? "http://localhost:5174")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: SITE_ORIGINS,
    credentials: true,
  }),
);

/**
 * A leaked password on a public URL is a bill, not just an intrusion: a review
 * costs roughly $0.65 and the button is right there on the page. This bounds
 * the damage. Set a spend cap on the Anthropic key as well — this limits
 * request rate, not total spend.
 */
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env["REGREVIEW_RATE_LIMIT"] ?? 120),
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Tighter than the general limit: nothing else should let an attacker spend
// this many guesses per minute against an account's password.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !AUTH_ENABLED,
});

app.use(express.json());
app.use(cookieParser());

const SESSION_COOKIE = "rr_session";

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    // Secure cookies are dropped by the browser over plain HTTP, so this can
    // only be true where TLS is guaranteed — which PUBLIC (an intentionally
    // non-loopback HOST) is standing in for. SameSite=None is required for a
    // cross-site cookie at all, but only browsers will honor it over HTTPS.
    secure: PUBLIC,
    sameSite: PUBLIC ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

const LoginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

if (AUTH_ENABLED) {
  app.post("/api/login", loginLimiter, async (req, res) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "username and password are required" });
    }
    const username = await verifyLogin(parsed.data.username, parsed.data.password);
    if (!username) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    const token = await createSession(username);
    setSessionCookie(res, token);
    return res.json({ ok: true, username });
  });

  app.post("/api/logout", async (req: Request, res: Response) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await deleteSession(token);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return res.json({ ok: true });
  });

  app.get("/api/me", async (req: Request, res: Response) => {
    // Not behind the auth middleware (registered below), so check directly.
    const token = req.cookies?.[SESSION_COOKIE];
    const username = token ? await resolveSession(token) : null;
    if (!username) return res.status(401).json({ error: "unauthorized" });
    const quota = await peekQuota(username);
    return res.json({ username, reviewsRemainingThisHour: quota.remaining });
  });

  /**
   * Reset a user's hourly quota, for testing. Guarded by a separate env
   * password rather than a logged-in session — this exists to unstick a demo
   * or test account, not to be part of the reviewer-facing product, so it
   * intentionally doesn't need a DB-backed admin account of its own.
   */
  const ADMIN_PASSWORD = process.env["REGREVIEW_ADMIN_PASSWORD"] ?? "";
  const ResetLimitBody = z.object({ username: z.string().min(1) });
  app.post("/api/admin/reset-limit", async (req: Request, res: Response) => {
    if (!ADMIN_PASSWORD) return res.status(404).json({ error: "not found" });

    const authHeader = req.header("authorization") ?? "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
    const expected = Buffer.from(ADMIN_PASSWORD);
    const actual = Buffer.from(provided);
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!ok) return res.status(401).json({ error: "unauthorized" });

    const parsed = ResetLimitBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "username is required" });

    await resetQuota(parsed.data.username);
    return res.json({ ok: true });
  });

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    const username = token ? await resolveSession(token) : null;
    if (!username) {
      return res.status(401).json({ error: "unauthorized" });
    }
    req.username = username;
    next();
  });
}

/** Record who acted, now that a real login means "who" is always known. */
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.username && req.method !== "GET") {
    console.log(`[access] ${req.username} ${req.method} ${req.originalUrl}`);
  }
  next();
});

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
  error: string | null;
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
app.get("/api/records", (_req, res) => {
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

  res.json(
    rows.map((r) => ({
      recordId: r.record_id,
      filename: r.filename,
      recordType: r.record_type,
      docId: r.doc_id,
      revision: r.revision,
      runs: r.runs,
      lastRunAt: r.last_run_at,
    })),
  );
});

/** The document text, its blocks, and its runs. */
app.get("/api/records/:recordId", (req, res) => {
  const { recordId } = req.params;
  const db = getDb();

  const record = db.prepare(`SELECT * FROM records WHERE record_id = ?`).get(recordId) as
    | RecordRow
    | undefined;
  if (!record) return res.status(404).json({ error: "record not found" });

  const blocks = db
    .prepare(
      `SELECT block_id, record_id, ordinal, char_start, char_end, heading
         FROM blocks WHERE record_id = ? ORDER BY ordinal`,
    )
    .all(recordId) as BlockRow[];

  const runs = db
    .prepare(`SELECT * FROM runs WHERE record_id = ? ORDER BY started_at DESC`)
    .all(recordId) as RunRow[];

  res.json({
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
      // Surfaced so a failed run can say why. Without it a review that died
      // renders exactly like a document with nothing wrong in it.
      error: r.error,
    })),
  });
});

app.get("/api/runs/:runId/findings", (req, res) => {
  res.json(loadFindings(req.params.runId));
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
app.patch("/api/runs/:runId/findings/:findingId", (req, res) => {
  const { runId, findingId } = req.params;
  const parsed = PatchBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body", detail: parsed.error.issues });
  }

  const db = getDb();
  const exists = db
    .prepare(`SELECT 1 FROM findings WHERE run_id = ? AND finding_id = ?`)
    .get(runId, findingId);
  if (!exists) return res.status(404).json({ error: "finding not found" });

  setFindingStatus({
    runId,
    findingId,
    status: parsed.data.status,
    actor: parsed.data.actor,
    ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
  });

  const updated = loadFindings(runId).find((f: Finding) => f.findingId === findingId);
  res.json(updated);
});

/** The audit trail for one finding. */
app.get("/api/runs/:runId/findings/:findingId/events", (req, res) => {
  const { runId, findingId } = req.params;
  const db = getDb();
  res.json(
    db
      .prepare(
        `SELECT event_id, event_type, actor, note, occurred_at
           FROM finding_events WHERE run_id = ? AND finding_id = ? ORDER BY event_id`,
      )
      .all(runId, findingId),
  );
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
app.get("/api/rules", (req, res) => {
  // ?include=all adds the customer's own SOP clauses. The reference library in
  // the Procedures view wants only the shipped corpus; the review rule picker
  // wants everything selectable, including the customer's procedures.
  const withSops = req.query["include"] === "all";

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
  res.json(rows.map(mapRule));
});

/** The rule behind a finding, so the reviewer can read the requirement in full. */
app.get("/api/rules/:ruleId", (req, res) => {
  const { ruleId } = req.params;
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
  if (!row) return res.status(404).json({ error: "rule not found" });
  res.json({
    ruleId: row.rule_id,
    source: row.source,
    citation: row.citation,
    title: row.title,
    expectation: row.expectation,
    harmLinked: row.harm_linked === 1,
    citationFrequency: row.citation_frequency,
    frequencyPercentile: row.frequency_percentile,
  });
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

// Files are buffered in memory before being written under `uploadDir` by hand
// (rather than using multer's disk storage) so the on-disk name stays under
// our control — see safeStoredName.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

/**
 * Upload a record to review.
 *
 * The file is written to the upload directory on local disk and never leaves it;
 * only extracted text is ever sent to the model, and only when a review is
 * explicitly started. Extraction happens here so an unreadable file (a scan, a
 * legacy .doc) is rejected at upload rather than surfacing later as an empty
 * review that reads like a clean result.
 */
app.post("/api/records", upload.single("file"), async (req, res) => {
  const uploaded = req.file;
  if (!uploaded) return res.status(400).json({ error: "no file in request" });

  if (!detectFormat(uploaded.originalname)) {
    return res.status(415).json({
      error: `unsupported file type: ${extname(uploaded.originalname) || "(none)"}. ` +
        `Supported: .pdf, .docx, .md, .txt`,
    });
  }

  const parsedType = RecordType.safeParse(req.body["recordType"] ?? "capa");
  const recordType = parsedType.success ? parsedType.data : "capa";

  const storedPath = join(uploadDir, safeStoredName(uploaded.originalname));
  writeFileSync(storedPath, uploaded.buffer);

  let extracted;
  try {
    extracted = await extractRecord({ path: storedPath, recordType });
  } catch (err) {
    return res.status(422).json({
      error: err instanceof Error ? err.message : "could not read the document",
    });
  }

  // Show the original filename, not the collision-proofed on-disk name. The
  // stored path keeps the prefixed name; only the display label is cleaned.
  extracted.record.filename = basename(uploaded.originalname);
  saveRecord(extracted.record, extracted.blocks);

  res.status(201).json({
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

const RecordPatchBody = z.object({ recordType: RecordType });

/**
 * Change a document's record type.
 *
 * The type decides which rules apply, so getting it wrong means reviewing a risk
 * management file against CAPA requirements — or, more quietly, against nothing
 * at all. It is set at upload from a dropdown that is easy to leave on its
 * default, so it has to be correctable afterwards without deleting the document
 * and losing its findings.
 *
 * Existing runs are left alone. They were produced under whatever rules applied
 * at the time, and rewriting history to match a later reclassification would
 * make `runs.corpus_version` a lie. The count is returned so the caller can say
 * that past runs used the old rule set.
 */
app.patch("/api/records/:recordId", (req, res) => {
  const { recordId } = req.params;
  const parsed = RecordPatchBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: `recordType must be one of: ${RecordType.options.join(", ")}`,
    });
  }

  const db = getDb();
  const row = db
    .prepare(`SELECT record_type FROM records WHERE record_id = ?`)
    .get(recordId) as { record_type: string } | undefined;
  if (!row) return res.status(404).json({ error: "record not found" });

  db.prepare(`UPDATE records SET record_type = ? WHERE record_id = ?`).run(
    parsed.data.recordType,
    recordId,
  );

  const runs = (
    db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE record_id = ?`).get(recordId) as {
      n: number;
    }
  ).n;

  res.json({
    recordId,
    previousType: row.record_type,
    recordType: parsed.data.recordType,
    // How many rules the new type actually brings, so the UI can warn when a
    // reclassification leaves a document with nothing to check it against.
    applicableRules: loadRulesFor(parsed.data.recordType).length,
    priorRuns: runs,
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
app.delete("/api/records/:recordId", (req, res) => {
  const { recordId } = req.params;
  const db = getDb();

  const exists = db.prepare(`SELECT 1 FROM records WHERE record_id = ?`).get(recordId);
  if (!exists) return res.status(404).json({ error: "record not found" });

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
  res.json({ recordId, ...counts });
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

app.post("/api/records/:recordId/review", async (req, res) => {
  const { recordId } = req.params;
  const parsed = StartReviewBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body", detail: parsed.error.issues });
  }

  const db = getDb();
  const record = loadRecord(db, recordId);
  if (!record) return res.status(404).json({ error: "record not found" });

  // A model review with no credential fails deep in the engine with a confusing
  // error; catch it at the door.
  if (!parsed.data.offline && !process.env["ANTHROPIC_API_KEY"] && !process.env["ANTHROPIC_AUTH_TOKEN"]) {
    return res.status(412).json({
      error:
        "no Anthropic credential configured on the server. Set ANTHROPIC_API_KEY " +
        "in the server's environment, or run an offline review.",
    });
  }

  if (AUTH_ENABLED && !parsed.data.offline) {
    const quota = await consumeQuota(req.username!, 1);
    if (!quota.ok) {
      return res.status(429).json({
        error: `hourly review limit reached (${quota.limit}/hour). Try again after ${quota.resetAt}.`,
        limit: quota.limit,
        remaining: quota.remaining,
        resetAt: quota.resetAt,
      });
    }
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
  pruneJobs();

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

  res.status(202).json({ jobId: job.jobId });
});

const BatchReviewBody = z.object({
  recordIds: z.array(z.string()).min(1).max(500),
  ruleIds: z.array(z.string()).default([]),
  samples: z.number().int().min(1).max(5).default(1),
  offline: z.boolean().default(false),
  /** Documents every reviewed record is checked for consistency against. */
  related: z.array(z.string()).default([]),
  /**
   * Also check the reviewed documents against each other.
   *
   * Cheap, because facts are extracted once per document and cached: N documents
   * cost N extractions and the comparison itself is a join, not N-squared model
   * calls. That is what makes "are these five CAPAs consistent with each other"
   * a question worth asking at all.
   */
  crossCheckSelected: z.boolean().default(false),
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
app.post("/api/reviews/batch", async (req, res) => {
  const parsed = BatchReviewBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body", detail: parsed.error.issues });
  }

  if (!parsed.data.offline && !process.env["ANTHROPIC_API_KEY"] && !process.env["ANTHROPIC_AUTH_TOKEN"]) {
    return res.status(412).json({
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
    return res.status(404).json({ error: "none of the requested records were found" });
  }

  if (AUTH_ENABLED && !parsed.data.offline) {
    const quota = await consumeQuota(req.username!, loaded.length);
    if (!quota.ok) {
      return res.status(429).json({
        error: `hourly review limit reached (${quota.limit}/hour): this batch of ${loaded.length} would exceed it. Try again after ${quota.resetAt}.`,
        limit: quota.limit,
        remaining: quota.remaining,
        resetAt: quota.resetAt,
      });
    }
  }

  // Documents to check every reviewed record against. A record is never its own
  // cross-check target, so the selected set is filtered per document below.
  const relatedDocs = [];
  for (const id of parsed.data.related) {
    if (parsed.data.recordIds.includes(id)) continue;
    const r = loadRecord(db, id);
    if (r) relatedDocs.push(r);
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
  pruneJobs();

  void (async () => {
    let totalFindings = 0;
    for (const [i, doc] of loaded.entries()) {
      const label = doc.record.docId ?? doc.record.filename;
      const slot = job.results[i]!;
      slot.status = "running";
      slot.phase = "starting";
      job.progress.push(`[${i + 1}/${loaded.length}] ${label}`);

      // Explicit cross-check targets, plus the other documents in this batch
      // when asked. Excluding this document keeps a record from being compared
      // against itself, which would report every value as agreeing with itself.
      const related = [
        ...relatedDocs,
        ...(parsed.data.crossCheckSelected
          ? loaded.filter((d) => d.record.recordId !== doc.record.recordId)
          : []),
      ];

      try {
        const result = await runReview({
          record: doc.record,
          blocks: doc.blocks,
          samples: parsed.data.samples,
          offline: parsed.data.offline,
          ...(related.length > 0 ? { related } : {}),
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

  res.status(202).json({ jobId: job.jobId, records: loaded.length });
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json(job);
});

/**
 * Every job this process knows about, newest first.
 *
 * The browser holds job ids in memory, so a reload used to orphan a review that
 * was still running: the work continued here and finished, but the page had no
 * id left to poll and showed nothing. Listing them lets a fresh page re-attach
 * to whatever is in flight — which also means a second tab, or a different
 * browser, sees the same running reviews.
 *
 * Jobs are progress for a long-running request, not durable state. They die with
 * the process; the durable result is the run and its findings in the database.
 */
app.get("/api/jobs", (_req, res) => {
  res.json([...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
});

/**
 * Keep the job map from growing without bound over a long-lived server. Running
 * jobs are never evicted — only finished ones, oldest first.
 */
const MAX_REMEMBERED_JOBS = 50;
function pruneJobs(): void {
  const finished = [...jobs.values()]
    .filter((j) => j.status !== "running")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const j of finished.slice(0, Math.max(0, jobs.size - MAX_REMEMBERED_JOBS))) {
    jobs.delete(j.jobId);
  }
}

// ---------------------------------------------------------------------------
// Managing the customer's procedures (SOPs)
// ---------------------------------------------------------------------------

app.get("/api/sops", (_req, res) => res.json(listSops()));

app.get("/api/sops/:sopId", (req, res) => {
  const sop = getSop(req.params.sopId);
  if (!sop) return res.status(404).json({ error: "procedure not found" });
  res.json(sop);
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
app.post("/api/sops", upload.single("file"), async (req, res) => {
  if (req.file) {
    const uploaded = req.file;
    if (!detectFormat(uploaded.originalname)) {
      return res.status(415).json({ error: "unsupported file type for a procedure" });
    }
    const appliesTo = parseAppliesTo(String(req.body["appliesTo"] ?? "capa"));

    const storedPath = join(uploadDir, safeStoredName(uploaded.originalname));
    writeFileSync(storedPath, uploaded.buffer);
    // Reuse format parsing so a .docx procedure becomes text before clause
    // extraction runs on it.
    const extracted = await extractRecord({ path: storedPath, recordType: "unknown" });
    const result = ingestSop({
      filename: basename(uploaded.originalname),
      storedPath,
      raw: extracted.record.normalizedText,
      appliesTo,
    });
    return res.status(201).json(summarizeIngest(result));
  }

  const parsed = SopTextBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body", detail: parsed.error.issues });
  }
  const storedPath = join(uploadDir, safeStoredName(parsed.data.filename));
  writeFileSync(storedPath, parsed.data.text, "utf8");
  const result = ingestSop({
    filename: parsed.data.filename,
    storedPath,
    raw: parsed.data.text,
    appliesTo: parsed.data.appliesTo,
  });
  res.status(201).json(summarizeIngest(result));
});

const SopEditBody = z.object({
  text: z.string().min(1).optional(),
  appliesTo: z.array(RecordType).optional(),
});

/** Edit a procedure in place — new text and/or which record types it governs. */
app.put("/api/sops/:sopId", (req, res) => {
  const { sopId } = req.params;
  const parsed = SopEditBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body", detail: parsed.error.issues });
  }
  if (parsed.data.text === undefined && parsed.data.appliesTo === undefined) {
    return res.status(400).json({ error: "nothing to update: provide text and/or appliesTo" });
  }
  if (!getSop(sopId)) return res.status(404).json({ error: "procedure not found" });

  const result = updateSop({
    sopDocumentId: sopId,
    ...(parsed.data.text !== undefined ? { raw: parsed.data.text } : {}),
    ...(parsed.data.appliesTo !== undefined ? { appliesTo: parsed.data.appliesTo } : {}),
  });
  res.json(summarizeIngest(result));
});

app.delete("/api/sops/:sopId", (req, res) => {
  const removed = deleteSop(req.params.sopId);
  if (!removed) return res.status(404).json({ error: "procedure not found" });
  res.status(204).end();
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

// Pure API: an unmatched path is just a 404, never HTML — there is no SPA
// fallback to hand back, because this process never serves the frontend.
app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ error: err.message });
  }
  res.status(500).json({ error: "internal error" });
});

app.listen(PORT, HOST, () => {
  console.log(`RegReview API on http://${HOST}:${PORT}`);
  console.log(`  auth      : ${AUTH_ENABLED ? "Mongo accounts" : "DISABLED (loopback only)"}`);
  console.log(`  site      : ${SITE_ORIGINS.join(", ")}`);
  console.log(`  database  : ${config.dbPath}`);
  console.log(`  uploads   : ${config.uploadDir}`);
});
