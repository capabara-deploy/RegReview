import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
  addChange,
  createProject,
  DEFAULT_PROJECT_ID,
  listProjects,
  projectExists,
  ensureDescription,
  getRunSummary,
  recordsNeedingDescription,
  summariesAvailable,
  type DocumentDescription,
  buildPreview,
  advanceStage,
  attachChanges,
  categoriesForRules,
  ChangeType,
  clearSubmission,
  config,
  createBaseline,
  createSubmission,
  cumulativeAssessment,
  deleteSop,
  Determination,
  effectiveScore,
  extractRecord,
  fileSubmission,
  FindingStatus,
  formatRationale,
  getBaseline,
  getChange,
  getCorpusDb,
  getCustomerDb,
  getSopsDb,
  getSop,
  implicatedBranches,
  loadGraph,
  ingestSop,
  listBaselines,
  listChanges,
  listSops,
  listSubmissions,
  loadFindings,
  loadRulesFor,
  migrateCorpus,
  migrateCustomer,
  migrateSops,
  RecordType,
  runReview,
  saveRecord,
  saveSuggestedScore,
  UnsupportedFormatError,
  scoreChange,
  setDetermination,
  setFindingStatus,
  setScore,
  setSubmissionStatus,
  setThreshold,
  Stage,
  SubmissionKind,
  SubmissionStatus,
  updateSop,
  type Block,
  type Db,
  type Finding,
  type RecordDoc,
  type SopIngestResult,
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
// Local mode is a dev/test convenience: its databases and accounts live in
// files on this machine, with none of the deployment's backups or isolation.
if (PUBLIC && config.local) {
  console.error(
    `Refusing to start: REGREVIEW_LOCAL=1 keeps every database on this machine's\n` +
      `disk and is for local testing only, but HOST is ${HOST}. Bind to 127.0.0.1,\n` +
      `or unset REGREVIEW_LOCAL to use the configured Neon/MongoDB databases.`,
  );
  process.exit(1);
}

await ensureAuthIndexes();
if (AUTH_ENABLED && !config.local) {
  initQuota(await getMongoDb());
  await ensureQuotaIndexes();
}
await Promise.all([migrateCorpus(), migrateCustomer(), migrateSops()]);

/**
 * Writes plain-language descriptions for documents that lack one, in the
 * background (documentSummary.ts). Kicked on boot and after every upload, and
 * a no-op without a model credential. Two at a time: each is a short read, and
 * a first boot against a full project shouldn't open thirty requests at once.
 * A kick while it is running just schedules one more pass, so uploads made
 * mid-pass are picked up.
 */
const describer = { running: false, again: false, pending: 0 };

function kickDescriber(): void {
  if (!summariesAvailable()) return;
  if (describer.running) {
    describer.again = true;
    return;
  }
  describer.running = true;
  void (async () => {
    try {
      do {
        describer.again = false;
        const queue = await recordsNeedingDescription();
        describer.pending = queue.length;
        const worker = async (): Promise<void> => {
          for (let id = queue.shift(); id; id = queue.shift()) {
            try {
              await ensureDescription(id);
            } catch (err) {
              console.error(`[describe] ${id}: ${(err as Error).message}`);
            }
            describer.pending = queue.length;
          }
        };
        await Promise.all([worker(), worker()]);
      } while (describer.again);
    } finally {
      describer.running = false;
      describer.pending = 0;
    }
  })();
}

/**
 * Fill in coverage for documents uploaded before it was recorded, by
 * re-reading their original files. Coverage is only written when the
 * re-extraction produces exactly the stored text (same sha256): the report must
 * describe the text the findings were anchored to, so a document whose
 * extraction has since changed keeps "unknown" until it is replaced. Blocks and
 * findings are never touched. Deterministic and offline; a no-op once every
 * record has coverage, so it is cheap on every boot.
 */
async function backfillCoverage(): Promise<void> {
  const db = getCustomerDb();
  const rows = await db
    .prepare(`SELECT record_id, filename, stored_path, sha256, record_type FROM records WHERE coverage IS NULL`)
    .all<{ record_id: string; filename: string; stored_path: string; sha256: string; record_type: string }>();
  let filled = 0;
  for (const r of rows) {
    if (!existsSync(r.stored_path)) continue;
    try {
      const extracted = await extractRecord({
        path: r.stored_path,
        filename: r.filename,
        recordType: r.record_type as RecordDoc["recordType"],
      });
      if (extracted.record.sha256 !== r.sha256) continue;
      await db
        .prepare(`UPDATE records SET coverage = ?, format = ? WHERE record_id = ? AND coverage IS NULL`)
        .run(JSON.stringify(extracted.coverage), extracted.format, r.record_id);
      filled++;
    } catch {
      // Unreadable now (format support changed, file damaged): leave it unknown.
    }
  }
  if (rows.length > 0) console.log(`[coverage] backfilled ${filled} of ${rows.length} record(s) without coverage`);
}

await backfillCoverage();
kickDescriber();

/** Start a finished run's summary now, so it is usually ready when the results open. */
function prepareRunSummary(runId: string): void {
  void getRunSummary(runId).catch((err) => console.error(`[summary] ${runId}: ${(err as Error).message}`));
}

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
  const db = getCustomerDb();
  const stranded = await db
    .prepare(`SELECT run_id FROM runs WHERE status = 'running'`)
    .all<{ run_id: string }>();
  if (stranded.length > 0) {
    await db
      .prepare(
        `UPDATE runs SET status = 'failed', finished_at = ?,
           error = 'interrupted: the server process ended before this review finished'
         WHERE status = 'running'`,
      )
      .run(new Date().toISOString());
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
    /**
     * A failure to REACH the account database is not a failed login.
     *
     * `verifyLogin` throws when MongoDB is unreachable, and without this the
     * exception became a bare 500 that the sign-in screen reported as bad
     * credentials — sending whoever hit it to check their password while the
     * real problem was an Atlas IP allowlist. Say which of the two it is.
     */
    let username: string | null;
    try {
      username = await verifyLogin(parsed.data.username, parsed.data.password);
    } catch (err) {
      console.error("[login] account database unreachable:", (err as Error).message);
      return res.status(503).json({
        error:
          "Could not reach the account database, so your sign-in could not be checked. " +
          "This is not a password problem. If this is a dev machine, the usual cause is " +
          "MongoDB Atlas blocking this IP (Security → Network Access).",
      });
    }
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
  format: string | null;
  /** JSON `Coverage`; null for records extracted before coverage existed. */
  coverage: string | null;
  sha256: string;
  /** JSON `DocumentDescription`; current only while its sha256 matches. */
  description: string | null;
}

/** The record's description if it was written for its current text, as sent to the client. */
function currentDescription(r: { sha256: string; description: string | null }): { label: string; summary: string } | null {
  if (!r.description) return null;
  const d = JSON.parse(r.description) as DocumentDescription;
  return d.sha256 === r.sha256 ? { label: d.label, summary: d.summary } : null;
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
  anchor: string | null;
  cells: string | null;
}

/**
 * The project a request is scoped to: `?project=` (or a `project` form/body
 * field on uploads). Absent means the original project, so older clients and
 * the CLIs keep working unchanged.
 */
function projectOf(req: Request): string {
  const fromQuery = typeof req.query["project"] === "string" ? req.query["project"] : undefined;
  const fromBody = typeof req.body?.["project"] === "string" ? (req.body["project"] as string) : undefined;
  return fromQuery || fromBody || DEFAULT_PROJECT_ID;
}

app.get("/api/projects", async (_req, res) => {
  res.json(await listProjects());
});

const ProjectBody = z.object({ name: z.string().trim().min(1).max(80) });

app.post("/api/projects", async (req, res) => {
  const parsed = ProjectBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "a project needs a name (up to 80 characters)" });
  res.status(201).json(await createProject(parsed.data.name));
});

/** Documents that have at least one completed run, newest activity first. */
app.get("/api/records", async (req, res) => {
  const db = getCustomerDb();
  const project = projectOf(req);
  const rows = await db
    .prepare(
      `SELECT r.record_id, r.filename, r.record_type, r.doc_id, r.revision, r.created_at,
              r.format, r.coverage, r.sha256, r.description,
              COUNT(DISTINCT run.run_id) AS runs,
              MAX(run.started_at)       AS last_run_at
         FROM records r
         LEFT JOIN runs run ON run.record_id = r.record_id AND run.status = 'complete'
        WHERE r.project_id = ?
        GROUP BY r.record_id, r.filename, r.record_type, r.doc_id, r.revision, r.created_at,
                 r.format, r.coverage, r.sha256, r.description
        ORDER BY COALESCE(MAX(run.started_at), r.created_at) DESC`,
    )
    .all<Omit<RecordRow, "normalized_text"> & { runs: number; last_run_at: string | null }>(project);

  res.json(
    rows.map((r) => ({
      recordId: r.record_id,
      filename: r.filename,
      recordType: r.record_type,
      docId: r.doc_id,
      revision: r.revision,
      runs: r.runs,
      lastRunAt: r.last_run_at,
      format: r.format,
      // The status only: enough for the document list to mark a partly-read
      // document without shipping every gap for every record.
      coverageStatus: r.coverage ? (JSON.parse(r.coverage) as { status: string }).status : null,
      description: currentDescription(r),
    })),
  );
});

/** The document text, its blocks, and its runs. */
app.get("/api/records/:recordId", async (req, res) => {
  const { recordId } = req.params;
  const db = getCustomerDb();

  const record = await db
    .prepare(`SELECT * FROM records WHERE record_id = ?`)
    .get<RecordRow>(recordId);
  if (!record) return res.status(404).json({ error: "record not found" });

  const blocks = await db
    .prepare(
      `SELECT block_id, record_id, ordinal, char_start, char_end, heading, anchor, cells
         FROM blocks WHERE record_id = ? ORDER BY ordinal`,
    )
    .all<BlockRow>(recordId);

  const runs = await db
    .prepare(`SELECT * FROM runs WHERE record_id = ? ORDER BY started_at DESC`)
    .all<RunRow>(recordId);

  // The change this document captures, if it captures one. Surfaced so a
  // reviewer reading a finding on a change order can reach the change itself —
  // the join has always existed on `changes.record_id` and was never navigable.
  const captured = await db
    .prepare(
      `SELECT change_id, proposal, stage FROM changes
        WHERE record_id = ? AND stage NOT IN ('superseded')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get<{ change_id: string; proposal: string; stage: string }>(recordId);

  res.json({
    capturedChange: captured
      ? { changeId: captured.change_id, proposal: captured.proposal, stage: captured.stage }
      : null,
    recordId: record.record_id,
    filename: record.filename,
    recordType: record.record_type,
    docId: record.doc_id,
    revision: record.revision,
    format: record.format,
    // What extraction read and what it could not. Shown beside the findings so
    // a short or empty review of a partly-read document can't pass as clean.
    coverage: record.coverage ? JSON.parse(record.coverage) : null,
    description: currentDescription(record),
    // The single canonical rendering. Every offset in every finding indexes
    // into this exact string, so the client must not transform it.
    normalizedText: record.normalized_text,
    blocks: blocks.map((b) => ({
      blockId: b.block_id,
      ordinal: b.ordinal,
      charStart: b.char_start,
      charEnd: b.char_end,
      heading: b.heading,
      anchor: b.anchor,
      cells: b.cells ? JSON.parse(b.cells) : null,
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

/**
 * What a document looks like, for the previewer on the run page. See
 * core's preview.ts: this is for recognising the document, never for anchoring
 * findings, and nothing in it goes to the model.
 */
app.get("/api/records/:recordId/preview", async (req, res) => {
  const record = await getCustomerDb()
    .prepare(`SELECT filename, stored_path FROM records WHERE record_id = ?`)
    .get<{ filename: string; stored_path: string }>(req.params.recordId);
  if (!record) return res.status(404).json({ error: "record not found" });
  if (!existsSync(record.stored_path)) {
    return res.status(410).json({ error: "the original file is no longer on this server" });
  }
  try {
    res.json(await buildPreview(record.stored_path, record.filename));
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : "could not preview the document" });
  }
});

/**
 * A PDF's original bytes, for the browser's own PDF viewer. PDF only: it is the
 * one format the previewer shows unconverted, and serving arbitrary stored
 * files back is more surface than the previewer needs. Never cached — these
 * are customer documents.
 */
app.get("/api/records/:recordId/file", async (req, res) => {
  const record = await getCustomerDb()
    .prepare(`SELECT filename, stored_path FROM records WHERE record_id = ?`)
    .get<{ filename: string; stored_path: string }>(req.params.recordId);
  if (!record) return res.status(404).json({ error: "record not found" });
  if (!existsSync(record.stored_path)) {
    return res.status(410).json({ error: "the original file is no longer on this server" });
  }
  const bytes = readFileSync(record.stored_path);
  if (!bytes.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
    return res.status(415).json({ error: "only PDFs are served as original files" });
  }
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${record.filename.replace(/[^\w.-]/g, "_")}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.send(bytes);
});

/**
 * The run's plain-language summary: the biggest issues and whether the
 * document appears to do its job (documentSummary.ts). Written when the run
 * finishes, rewritten when a finding is rejected or restored. Not a finding.
 */
app.get("/api/runs/:runId/summary", async (req, res) => {
  try {
    res.json(await getRunSummary(req.params.runId));
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : "could not summarise this run" });
  }
});

/** Whether document descriptions are still being written — the run page polls this. */
app.get("/api/descriptions/status", (_req, res) => {
  res.json({ available: summariesAvailable(), running: describer.running, pending: describer.pending });
});

app.get("/api/runs/:runId/findings", async (req, res) => {
  res.json(await loadFindings(req.params.runId));
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
app.patch("/api/runs/:runId/findings/:findingId", async (req, res) => {
  const { runId, findingId } = req.params;
  const parsed = PatchBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body", detail: parsed.error.issues });
  }

  const db = getCustomerDb();
  const exists = await db
    .prepare(`SELECT 1 FROM findings WHERE run_id = ? AND finding_id = ?`)
    .get(runId, findingId);
  if (!exists) return res.status(404).json({ error: "finding not found" });

  await setFindingStatus({
    runId,
    findingId,
    status: parsed.data.status,
    actor: parsed.data.actor,
    ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
  });

  const updated = (await loadFindings(runId)).find((f: Finding) => f.findingId === findingId);
  res.json(updated);
});

// ---------------------------------------------------------------------------
// Cumulative change ledger (Phase 2).
//
// Every write here is a flag or a human input. The one thing this API will
// never expose is an endpoint that returns a submit / don't-submit
// determination — that is the manufacturer's call, and no route computes it.
// ---------------------------------------------------------------------------

app.get("/api/baselines", async (req, res) => {
  res.json(await listBaselines(undefined, projectOf(req)));
});

const BaselineBody = z.object({
  device: z.string().min(1),
  clearanceId: z.string().min(1),
  clearedAt: z.string().optional(),
  configuration: z.record(z.string()).optional(),
  note: z.string().optional(),
  threshold: z.number().int().min(1).max(1000).optional(),
  thresholdSource: z.string().optional(),
});

app.post("/api/baselines", async (req, res) => {
  const parsed = BaselineBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  res.status(201).json(await createBaseline({ ...parsed.data, projectId: projectOf(req) }));
});

// The escalation threshold belongs to the customer's change-control procedure,
// so it is editable, and the citation is editable with it — an escalation
// message that cannot name the procedure it comes from is just an opinion.
const ThresholdBody = z.object({
  threshold: z.number().int().min(1).max(1000),
  thresholdSource: z.string().nullable().optional(),
});

app.patch("/api/baselines/:baselineId/threshold", async (req, res) => {
  const parsed = ThresholdBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const updated = await setThreshold(
    req.params.baselineId,
    parsed.data.threshold,
    parsed.data.thresholdSource ?? null,
  );
  if (!updated) return res.status(404).json({ error: "baseline not found" });
  res.json(updated);
});

/** A baseline's changes and the deterministic cumulative assessment over them. */
app.get("/api/baselines/:baselineId/assessment", async (req, res) => {
  const baseline = await getBaseline(req.params.baselineId);
  if (!baseline) return res.status(404).json({ error: "baseline not found" });
  const changes = await listChanges(baseline.baselineId);
  const submissions = await listSubmissions(baseline.baselineId);
  const assessment = cumulativeAssessment(baseline, changes, submissions);
  // Attach, per change, the flowchart branches its type implicates — questions
  // to consider, never answers — and the resolved score with its provenance, so
  // the UI can show WHERE each number came from rather than just the total.
  res.json({
    ...assessment,
    changes: changes.map((c) => ({
      ...c,
      branches: implicatedBranches(c.changeType),
      effective: effectiveScore(c),
    })),
  });
});

const ChangeBody = z.object({
  proposal: z.string().min(1),
  comparator: z.string().optional(),
  changeType: ChangeType.optional(),
  subsystem: z.string().optional(),
  stage: Stage.optional(),
  changedAt: z.string().optional(),
});

app.post("/api/baselines/:baselineId/changes", async (req, res) => {
  const baseline = await getBaseline(req.params.baselineId);
  if (!baseline) return res.status(404).json({ error: "baseline not found" });
  const parsed = ChangeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  res.status(201).json(await addChange({ baselineId: baseline.baselineId, ...parsed.data }));
});

// The ONLY writer of a change's regulatory determination, and it takes it
// straight from the human. The tool never sets this.
const DeterminationBody = z.object({ determination: Determination });

app.patch("/api/changes/:changeId/determination", async (req, res) => {
  const parsed = DeterminationBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const updated = await setDetermination(req.params.changeId, parsed.data.determination);
  if (!updated) return res.status(404).json({ error: "change not found" });
  res.json(updated);
});

// --- Workflow ---------------------------------------------------------------

const StageBody = z.object({
  stage: Stage,
  /** Required to reach `documented`: the controlled document capturing it. */
  recordId: z.string().optional(),
});

/**
 * Advance a change through the workflow.
 *
 * The reviewer who marks a change documented is usually not the engineer who
 * logged it, so the acting username is stamped from the session rather than
 * taken from the body — an unverifiable "documented by" is worse than none.
 */
app.patch("/api/changes/:changeId/stage", async (req, res) => {
  const parsed = StageBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  try {
    const updated = await advanceStage(req.params.changeId, parsed.data.stage, {
      recordId: parsed.data.recordId,
      actor: req.username,
    });
    res.json(updated);
  } catch (err) {
    // Backwards transitions and a documented-without-a-document both land here;
    // both are the caller's error, not a server fault.
    res.status(400).json({ error: (err as Error).message });
  }
});

// --- Scoring ----------------------------------------------------------------

/**
 * Ask the model to suggest a risk score for a change.
 *
 * Writes `suggested_score` only. It cannot write `score`, cannot write a
 * determination, and its output is clamped up to the change type's floor when
 * totals are computed — see changeScorer.ts for why those three guards stand in
 * for the hallucination guard that free-typed text cannot have.
 */
app.post("/api/changes/:changeId/suggest-score", async (req, res) => {
  const change = await getChange(req.params.changeId);
  if (!change) return res.status(404).json({ error: "change not found" });
  const baseline = await getBaseline(change.baselineId);
  if (!baseline) return res.status(404).json({ error: "baseline not found" });

  try {
    const suggestion = await scoreChange(change, {
      device: baseline.device,
      clearanceId: baseline.clearanceId,
    });
    const updated = await saveSuggestedScore(
      change.changeId,
      suggestion.score,
      formatRationale(suggestion),
    );
    res.json({ change: updated, suggestion });
  } catch (err) {
    res.status(502).json({ error: `scoring failed: ${(err as Error).message}` });
  }
});

// The only writer of the human-confirmed score. `belowFloorRationale` is the
// documented rationale the FDA change guidance asks for when a presumptively
// significant change is judged otherwise; without it the floor holds, which is
// enforced in effectiveScore rather than here.
const ScoreBody = z.object({
  score: z.number().int().min(1).max(10),
  belowFloorRationale: z.string().optional(),
});

app.patch("/api/changes/:changeId/score", async (req, res) => {
  const parsed = ScoreBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const updated = await setScore(req.params.changeId, parsed.data.score, {
    actor: req.username,
    belowFloorRationale: parsed.data.belowFloorRationale,
  });
  if (!updated) return res.status(404).json({ error: "change not found" });
  res.json({ ...updated, effective: effectiveScore(updated) });
});

// --- Submissions ------------------------------------------------------------
//
// Tracking only. No route decides that a submission is needed, picks its kind,
// or files it; every one of these records something a person already did.

const SubmissionBody = z.object({
  title: z.string().min(1),
  kind: SubmissionKind.optional(),
  note: z.string().optional(),
  changeIds: z.array(z.string()).optional(),
});

app.get("/api/baselines/:baselineId/submissions", async (req, res) => {
  res.json(await listSubmissions(req.params.baselineId));
});

app.post("/api/baselines/:baselineId/submissions", async (req, res) => {
  const baseline = await getBaseline(req.params.baselineId);
  if (!baseline) return res.status(404).json({ error: "baseline not found" });
  const parsed = SubmissionBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  try {
    res.status(201).json(await createSubmission({ baselineId: baseline.baselineId, ...parsed.data }));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post("/api/submissions/:submissionId/changes", async (req, res) => {
  const parsed = z.object({ changeIds: z.array(z.string()).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  try {
    const attached = await attachChanges(req.params.submissionId, parsed.data.changeIds);
    res.json({ attached });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

const SubmissionStatusBody = z.object({
  status: SubmissionStatus,
  filedAt: z.string().optional(),
  /** Required for `cleared`: the number on the FDA letter. */
  clearanceId: z.string().optional(),
  decisionAt: z.string().optional(),
});

/**
 * Move a submission's status.
 *
 * `cleared` is the interesting one: it establishes a successor baseline and
 * retires the changes the submission carried, which is what resets accumulated
 * risk. It needs the clearance number from the FDA letter, entered by a person —
 * the tool never predicts or assumes one.
 */
app.patch("/api/submissions/:submissionId/status", async (req, res) => {
  const parsed = SubmissionStatusBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const { status, filedAt, clearanceId, decisionAt } = parsed.data;
  try {
    if (status === "cleared") {
      if (!clearanceId) {
        return res
          .status(400)
          .json({ error: "clearanceId is required to record a clearance" });
      }
      return res.json(
        await clearSubmission(req.params.submissionId, { clearanceId, decisionAt }),
      );
    }
    const updated =
      status === "filed"
        ? await fileSubmission(req.params.submissionId, filedAt ?? new Date().toISOString())
        : await setSubmissionStatus(req.params.submissionId, status);
    if (!updated) return res.status(404).json({ error: "submission not found" });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Cross-document graph (Phase 3). Read-only. Deterministic reference edges plus
// per-document finding severity, for the reference map. Computed on read.
// ---------------------------------------------------------------------------
app.get("/api/graph", async (req, res) => {
  res.json(await loadGraph(undefined, projectOf(req)));
});

/** The audit trail for one finding. */
app.get("/api/runs/:runId/findings/:findingId/events", async (req, res) => {
  const { runId, findingId } = req.params;
  const db = getCustomerDb();
  res.json(
    await db
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
const RULE_COLUMNS = `rule_id, source, citation, title, expectation, applies_to,
              harm_linked, citation_frequency, frequency_percentile`;

app.get("/api/rules", async (req, res) => {
  // ?include=all adds the customer's own SOP clauses. The reference library in
  // the Procedures view wants only the shipped corpus; the review rule picker
  // wants everything selectable, including the customer's procedures.
  //
  // The public corpus and SOP-derived rules live in separate databases now
  // (see db/index.ts), so this is two queries merged and re-sorted in JS
  // rather than one WHERE-filtered scan of a single table. The corpus query
  // alone already matches the old `WHERE source != 'sop'` case exactly, since
  // the corpus database's `rules` table structurally excludes 'sop' rows.
  const withSops = req.query["include"] === "all";

  const rows = await getCorpusDb()
    .prepare(`SELECT ${RULE_COLUMNS} FROM rules`)
    .all<RuleRow>();
  if (withSops) {
    rows.push(...(await getSopsDb().prepare(`SELECT ${RULE_COLUMNS} FROM rules`).all<RuleRow>()));
  }
  rows.sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      b.frequency_percentile - a.frequency_percentile ||
      b.citation_frequency - a.citation_frequency,
  );
  res.json(rows.map(mapRule));
});

/** The rule behind a finding, so the reviewer can read the requirement in full. */
app.get("/api/rules/:ruleId", async (req, res) => {
  const { ruleId } = req.params;
  // A rule may live in either database depending on its source (see
  // db/index.ts) — try the public corpus first, then the customer's SOPs.
  type FullRuleRow = {
    rule_id: string;
    source: string;
    citation: string;
    title: string;
    expectation: string;
    harm_linked: number;
    citation_frequency: number;
    frequency_percentile: number;
  };
  const row =
    (await getCorpusDb().prepare(`SELECT * FROM rules WHERE rule_id = ?`).get<FullRuleRow>(ruleId)) ??
    (await getSopsDb().prepare(`SELECT * FROM rules WHERE rule_id = ?`).get<FullRuleRow>(ruleId));
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
 * Extract an upload. The format is decided from the file's bytes (detect.ts);
 * the original name is passed only as a hint, since the stored name is
 * collision-proofed.
 */
function readUpload(storedPath: string, originalName: string, recordType: RecordDoc["recordType"]) {
  return extractRecord({ path: storedPath, recordType, filename: basename(originalName) });
}

/**
 * Refuse an upload we could not read, and delete its bytes: a rejected
 * customer document has no reason to stay on this disk. 415 when the file is a
 * format we don't read — the message names what it actually is — and 422 when
 * it is a supported format that failed to parse.
 */
function rejectUpload(res: Response, storedPath: string, err: unknown) {
  rmSync(storedPath, { force: true });
  if (err instanceof UnsupportedFormatError) return res.status(415).json({ error: err.message, kind: err.kind });
  return res.status(422).json({ error: err instanceof Error ? err.message : "could not read the document" });
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
app.post("/api/records", upload.single("file"), async (req, res) => {
  const uploaded = req.file;
  if (!uploaded) return res.status(400).json({ error: "no file in request" });

  const parsedType = RecordType.safeParse(req.body["recordType"] ?? "capa");
  const recordType = parsedType.success ? parsedType.data : "capa";
  const project = projectOf(req);
  if (!(await projectExists(project))) return res.status(404).json({ error: `no such project: ${project}` });

  const storedPath = join(uploadDir, safeStoredName(uploaded.originalname));
  writeFileSync(storedPath, uploaded.buffer);

  let extracted;
  try {
    extracted = await readUpload(storedPath, uploaded.originalname, recordType);
  } catch (err) {
    return rejectUpload(res, storedPath, err);
  }

  // Show the original filename, not the collision-proofed on-disk name. The
  // stored path keeps the prefixed name; only the display label is cleaned.
  extracted.record.filename = basename(uploaded.originalname);
  extracted.record.projectId = project;
  await saveRecord(extracted.record, extracted.blocks);
  kickDescriber();

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
    coverage: extracted.coverage,
  });
});

/**
 * Replace a document's file in place, keeping its identity.
 *
 * The workflow this removes: upload a new version, then hunt down and delete the
 * old one. Here the new file takes over the existing record id and type, so a
 * revised document stays the same document. saveRecord re-blocks it and, because
 * the content hash changes, discards findings from the prior version — those
 * were about text that no longer exists, and keeping them would anchor
 * highlights into a document that changed underneath them.
 */
app.post("/api/records/:recordId/replace", upload.single("file"), async (req, res) => {
  const uploaded = req.file;
  if (!uploaded) return res.status(400).json({ error: "no file in request" });

  const existing = await getCustomerDb()
    .prepare(`SELECT record_id, record_type FROM records WHERE record_id = ?`)
    .get<{ record_id: string; record_type: string }>(req.params.recordId);
  if (!existing) return res.status(404).json({ error: "record not found" });

  const parsedType = RecordType.safeParse(req.body["recordType"] ?? existing.record_type);
  const recordType = parsedType.success ? parsedType.data : (existing.record_type as never);

  const storedPath = join(uploadDir, safeStoredName(uploaded.originalname));
  writeFileSync(storedPath, uploaded.buffer);

  let extracted;
  try {
    extracted = await readUpload(storedPath, uploaded.originalname, recordType);
  } catch (err) {
    return rejectUpload(res, storedPath, err);
  }

  // Keep the existing identity: the new file IS this record now.
  extracted.record.recordId = existing.record_id;
  extracted.record.filename = basename(uploaded.originalname);
  // Blocks are keyed to the record id, so re-key them too.
  extracted.blocks = extracted.blocks.map((b, i) => ({
    ...b,
    recordId: existing.record_id,
    blockId: `${existing.record_id}:b${i}`,
  }));
  const { discardedFindings } = await saveRecord(extracted.record, extracted.blocks);
  kickDescriber();

  res.json({
    recordId: extracted.record.recordId,
    filename: extracted.record.filename,
    recordType: extracted.record.recordType,
    docId: extracted.record.docId,
    revision: extracted.record.revision,
    format: extracted.format,
    pageCount: extracted.pageCount ?? null,
    blocks: extracted.blocks.length,
    discardedFindings,
    warning: extracted.warning ?? null,
    coverage: extracted.coverage,
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
app.patch("/api/records/:recordId", async (req, res) => {
  const { recordId } = req.params;
  const parsed = RecordPatchBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: `recordType must be one of: ${RecordType.options.join(", ")}`,
    });
  }

  const db = getCustomerDb();
  const row = await db
    .prepare(`SELECT record_type FROM records WHERE record_id = ?`)
    .get<{ record_type: string }>(recordId);
  if (!row) return res.status(404).json({ error: "record not found" });

  await db
    .prepare(`UPDATE records SET record_type = ? WHERE record_id = ?`)
    .run(parsed.data.recordType, recordId);

  const runs = (
    await db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE record_id = ?`).get<{ n: number }>(recordId)
  )?.n ?? 0;

  res.json({
    recordId,
    previousType: row.record_type,
    recordType: parsed.data.recordType,
    // How many rules the new type actually brings, so the UI can warn when a
    // reclassification leaves a document with nothing to check it against.
    applicableRules: (await loadRulesFor(parsed.data.recordType)).length,
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
app.delete("/api/records/:recordId", async (req, res) => {
  const { recordId } = req.params;
  const db = getCustomerDb();

  const exists = await db.prepare(`SELECT 1 FROM records WHERE record_id = ?`).get(recordId);
  if (!exists) return res.status(404).json({ error: "record not found" });

  const counts = {
    runs:
      (await db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE record_id = ?`).get<{ n: number }>(recordId))
        ?.n ?? 0,
    findings:
      (await db
        .prepare(`SELECT COUNT(*) AS n FROM findings WHERE record_id = ?`)
        .get<{ n: number }>(recordId))?.n ?? 0,
  };

  await db.transaction(async () => {
    await db
      .prepare(
        `DELETE FROM finding_events WHERE run_id IN (SELECT run_id FROM runs WHERE record_id = ?)`,
      )
      .run(recordId);
    await db.prepare(`DELETE FROM findings WHERE record_id = ?`).run(recordId);
    await db.prepare(`DELETE FROM facts WHERE record_id = ?`).run(recordId);
    await db.prepare(`DELETE FROM runs WHERE record_id = ?`).run(recordId);
    await db.prepare(`DELETE FROM blocks WHERE record_id = ?`).run(recordId);
    await db.prepare(`DELETE FROM records WHERE record_id = ?`).run(recordId);
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
async function passCountFor(recordType: RecordType, ruleIds: string[]): Promise<number> {
  if (ruleIds.length === 0) return 4;
  const applicable = await loadRulesFor(recordType);
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

  const db = getCustomerDb();
  const record = await loadRecord(db, recordId);
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
    const r = await loadRecord(db, id);
    if (r) related.push(r);
  }

  const slot: JobResult = {
    recordId,
    filename: record.record.filename,
    docId: record.record.docId,
    status: "running",
    stepsDone: 0,
    stepsTotal: expectedSteps(await passCountFor(record.record.recordType, parsed.data.ruleIds)),
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
      prepareRunSummary(result.run.runId);
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

  const db = getCustomerDb();
  const loaded = [];
  for (const id of parsed.data.recordIds) {
    const r = await loadRecord(db, id);
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
    const r = await loadRecord(db, id);
    if (r) relatedDocs.push(r);
  }

  const job: Job = {
    jobId: randomUUID(),
    recordId: loaded[0]!.record.recordId,
    status: "running",
    progress: [],
    startedAt: new Date().toISOString(),
    results: await Promise.all(
      loaded.map(async (r) => ({
        recordId: r.record.recordId,
        filename: r.record.filename,
        docId: r.record.docId,
        status: "pending" as const,
        stepsDone: 0,
        stepsTotal: expectedSteps(await passCountFor(r.record.recordType, parsed.data.ruleIds)),
        phase: null,
      })),
    ),
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
        prepareRunSummary(result.run.runId);
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

app.get("/api/sops", async (_req, res) => res.json(await listSops()));

app.get("/api/sops/:sopId", async (req, res) => {
  const sop = await getSop(req.params.sopId);
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
    const appliesTo = parseAppliesTo(String(req.body["appliesTo"] ?? "capa"));

    const storedPath = join(uploadDir, safeStoredName(uploaded.originalname));
    writeFileSync(storedPath, uploaded.buffer);
    // Reuse format parsing so a .docx procedure becomes text before clause
    // extraction runs on it.
    let extracted;
    try {
      extracted = await readUpload(storedPath, uploaded.originalname, "unknown");
    } catch (err) {
      return rejectUpload(res, storedPath, err);
    }
    const result = await ingestSop({
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
  const result = await ingestSop({
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
app.put("/api/sops/:sopId", async (req, res) => {
  const { sopId } = req.params;
  const parsed = SopEditBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body", detail: parsed.error.issues });
  }
  if (parsed.data.text === undefined && parsed.data.appliesTo === undefined) {
    return res.status(400).json({ error: "nothing to update: provide text and/or appliesTo" });
  }
  if (!(await getSop(sopId))) return res.status(404).json({ error: "procedure not found" });

  const result = await updateSop({
    sopDocumentId: sopId,
    ...(parsed.data.text !== undefined ? { raw: parsed.data.text } : {}),
    ...(parsed.data.appliesTo !== undefined ? { appliesTo: parsed.data.appliesTo } : {}),
  });
  res.json(summarizeIngest(result));
});

app.delete("/api/sops/:sopId", async (req, res) => {
  const removed = await deleteSop(req.params.sopId);
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

function summarizeIngest(result: SopIngestResult) {
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
async function loadRecord(
  db: Db,
  recordId: string,
): Promise<{ record: RecordDoc; blocks: Block[] } | null> {
  const row = await db
    .prepare(`SELECT * FROM records WHERE record_id = ?`)
    .get<Record<string, unknown>>(recordId);
  if (!row) return null;

  const blockRows = await db
    .prepare(`SELECT * FROM blocks WHERE record_id = ? ORDER BY ordinal`)
    .all<Record<string, unknown>>(recordId);

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
    anchor: (b["anchor"] as string | null) ?? null,
    cells: b["cells"] ? JSON.parse(b["cells"] as string) : null,
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

/** host/dbname only — never the credential-bearing connection string. */
function describeDb(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "(unparseable)";
  }
}

app.listen(PORT, HOST, () => {
  console.log(`RegReview API on http://${HOST}:${PORT}`);
  console.log(
    `  auth      : ${config.local ? "local accounts" : AUTH_ENABLED ? "Mongo accounts" : "DISABLED (loopback only)"}`,
  );
  console.log(`  site      : ${SITE_ORIGINS.join(", ")}`);
  if (config.local) {
    console.log(`  databases : LOCAL (embedded Postgres) in ${config.localDataDir}`);
  } else {
    console.log(`  corpus db : ${describeDb(config.corpusDatabaseUrl)}`);
    console.log(`  customer db: ${describeDb(config.customerDatabaseUrl)}`);
    console.log(`  sops db   : ${describeDb(config.sopsDatabaseUrl)}`);
  }
  console.log(`  uploads   : ${config.uploadDir}`);
});
