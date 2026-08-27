import { randomUUID } from "node:crypto";
import { getCustomerDb, type Db } from "./db/index.js";
import {
  ChangeType,
  Determination,
  Stage,
  SubmissionKind,
  SubmissionStatus,
  STAGE_ORDER,
  type Baseline,
  type Change,
  type ChangeGap,
  type Submission,
} from "./changeLedger.js";

/**
 * Persistence for the cumulative change ledger.
 *
 * Deterministic gaps (the comparator check, the aggregate-assessment condition)
 * are computed on read by `cumulativeAssessment`, not stored — they are a pure
 * function of the changes, and storing them would let them drift. Only INFERRED
 * gaps (model suggestions awaiting human acceptance) are persisted, via
 * `saveInferredGaps`. See changeLedger.ts for why inferred gaps never touch the
 * findings table.
 */

function rowToBaseline(r: Record<string, unknown>): Baseline {
  let configuration: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse((r["configuration"] as string) || "{}");
    if (parsed && typeof parsed === "object") configuration = parsed as Record<string, string>;
  } catch {
    /* leave empty */
  }
  return {
    baselineId: r["baseline_id"] as string,
    device: r["device"] as string,
    clearanceId: r["clearance_id"] as string,
    clearedAt: (r["cleared_at"] as string | null) ?? null,
    configuration,
    note: (r["note"] as string | null) ?? null,
    threshold: Number(r["threshold"] ?? 30),
    thresholdSource: (r["threshold_source"] as string | null) ?? null,
    supersededBy: (r["superseded_by"] as string | null) ?? null,
    createdAt: r["created_at"] as string,
  };
}

/** Postgres returns INTEGER as a number, but a null must not become 0 here. */
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function rowToChange(r: Record<string, unknown>): Change {
  return {
    changeId: r["change_id"] as string,
    baselineId: r["baseline_id"] as string,
    proposal: r["proposal"] as string,
    comparator: (r["comparator"] as string | null) ?? null,
    changeType: ChangeType.catch("other").parse(r["change_type"]),
    subsystem: (r["subsystem"] as string | null) ?? null,
    determination: Determination.catch("undecided").parse(r["determination"]),
    stage: Stage.catch("proposed").parse(r["stage"]),
    recordId: (r["record_id"] as string | null) ?? null,
    changedAt: (r["changed_at"] as string | null) ?? null,
    createdAt: r["created_at"] as string,
    score: numOrNull(r["score"]),
    suggestedScore: numOrNull(r["suggested_score"]),
    suggestedRationale: (r["suggested_rationale"] as string | null) ?? null,
    suggestedAt: (r["suggested_at"] as string | null) ?? null,
    scoredBy: (r["scored_by"] as string | null) ?? null,
    scoredAt: (r["scored_at"] as string | null) ?? null,
    belowFloorRationale: (r["below_floor_rationale"] as string | null) ?? null,
    implementedAt: (r["implemented_at"] as string | null) ?? null,
    documentedAt: (r["documented_at"] as string | null) ?? null,
    documentedBy: (r["documented_by"] as string | null) ?? null,
    submissionId: (r["submission_id"] as string | null) ?? null,
  };
}

function rowToSubmission(r: Record<string, unknown>): Submission {
  return {
    submissionId: r["submission_id"] as string,
    baselineId: r["baseline_id"] as string,
    title: r["title"] as string,
    kind: SubmissionKind.catch("other").parse(r["kind"]),
    status: SubmissionStatus.catch("planned").parse(r["status"]),
    filedAt: (r["filed_at"] as string | null) ?? null,
    decisionAt: (r["decision_at"] as string | null) ?? null,
    clearanceId: (r["clearance_id"] as string | null) ?? null,
    note: (r["note"] as string | null) ?? null,
    createdAt: r["created_at"] as string,
  };
}

export async function createBaseline(
  args: {
    device: string;
    clearanceId: string;
    // `| undefined` so a caller may pass the field explicitly absent (zod's
    // .optional() yields `T | undefined`, which exactOptionalPropertyTypes
    // otherwise rejects against a bare `?:`).
    clearedAt?: string | undefined;
    configuration?: Record<string, string> | undefined;
    note?: string | undefined;
    threshold?: number | undefined;
    thresholdSource?: string | undefined;
  },
  db: Db = getCustomerDb(),
): Promise<Baseline> {
  const baseline: Baseline = {
    baselineId: `bl-${randomUUID().slice(0, 12)}`,
    device: args.device,
    clearanceId: args.clearanceId,
    clearedAt: args.clearedAt ?? null,
    configuration: args.configuration ?? {},
    note: args.note ?? null,
    // 30 is a placeholder until the customer's own change-control procedure is
    // read; it is theirs to set, and the UI says so rather than presenting it
    // as a recommendation of ours.
    threshold: args.threshold ?? 30,
    thresholdSource: args.thresholdSource ?? null,
    supersededBy: null,
    createdAt: new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO baselines
         (baseline_id, device, clearance_id, cleared_at, configuration, note,
          threshold, threshold_source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      baseline.baselineId,
      baseline.device,
      baseline.clearanceId,
      baseline.clearedAt,
      JSON.stringify(baseline.configuration),
      baseline.note,
      baseline.threshold,
      baseline.thresholdSource,
      baseline.createdAt,
    );
  return baseline;
}

/**
 * Update the escalation threshold and the procedure it comes from.
 *
 * Separate from creation because this is the value a customer tunes after
 * reading their own SOP, and because the citation matters as much as the
 * number — an escalation message without one is as arbitrary as the spreadsheet
 * it replaces.
 */
export async function setThreshold(
  baselineId: string,
  threshold: number,
  thresholdSource: string | null,
  db: Db = getCustomerDb(),
): Promise<Baseline | null> {
  await db
    .prepare(`UPDATE baselines SET threshold = ?, threshold_source = ? WHERE baseline_id = ?`)
    .run(threshold, thresholdSource, baselineId);
  return getBaseline(baselineId, db);
}

export async function listBaselines(db: Db = getCustomerDb()): Promise<Baseline[]> {
  const rows = (await db
    .prepare(`SELECT * FROM baselines ORDER BY created_at DESC`)
    .all()) as Record<string, unknown>[];
  return rows.map(rowToBaseline);
}

export async function getBaseline(
  baselineId: string,
  db: Db = getCustomerDb(),
): Promise<Baseline | null> {
  const row = (await db
    .prepare(`SELECT * FROM baselines WHERE baseline_id = ?`)
    .get(baselineId)) as Record<string, unknown> | undefined;
  return row ? rowToBaseline(row) : null;
}

export async function addChange(
  args: {
    baselineId: string;
    proposal: string;
    comparator?: string | undefined;
    changeType?: ChangeType | undefined;
    subsystem?: string | undefined;
    stage?: Stage | undefined;
    recordId?: string | undefined;
    changedAt?: string | undefined;
  },
  db: Db = getCustomerDb(),
): Promise<Change> {
  const now = new Date().toISOString();
  const stage = args.stage ?? "proposed";
  const change: Change = {
    changeId: `chg-${randomUUID().slice(0, 12)}`,
    baselineId: args.baselineId,
    proposal: args.proposal,
    comparator: args.comparator ?? null,
    changeType: args.changeType ?? "other",
    subsystem: args.subsystem ?? null,
    // Human-owned; a new change is always undecided. The tool never sets this.
    determination: "undecided",
    stage,
    recordId: args.recordId ?? null,
    changedAt: args.changedAt ?? null,
    createdAt: now,
    score: null,
    suggestedScore: null,
    suggestedRationale: null,
    suggestedAt: null,
    scoredBy: null,
    scoredAt: null,
    belowFloorRationale: null,
    // An engineer logging a change that is already in the product enters at
    // `implemented`, and the aging clock has to start from that moment or the
    // most important gap in the ledger never fires.
    implementedAt: stage === "implemented" ? (args.changedAt ?? now) : null,
    documentedAt: null,
    documentedBy: null,
    submissionId: null,
  };
  await db
    .prepare(
      `INSERT INTO changes
         (change_id, baseline_id, proposal, comparator, change_type, subsystem,
          determination, stage, record_id, changed_at, implemented_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      change.changeId,
      change.baselineId,
      change.proposal,
      change.comparator,
      change.changeType,
      change.subsystem,
      change.determination,
      change.stage,
      change.recordId,
      change.changedAt,
      change.implementedAt,
      change.createdAt,
    );
  return change;
}

export async function getChange(
  changeId: string,
  db: Db = getCustomerDb(),
): Promise<Change | null> {
  const row = (await db
    .prepare(`SELECT * FROM changes WHERE change_id = ?`)
    .get(changeId)) as Record<string, unknown> | undefined;
  return row ? rowToChange(row) : null;
}

/**
 * Advance a change through the workflow.
 *
 * Transitions only move forward along STAGE_ORDER. That is not bureaucracy: the
 * stage timestamps are what the aging gap and the accumulated totals are
 * computed from, so a change that could slide backwards could silently erase an
 * exposure the ledger had already reported. Correcting a mistaken advance is a
 * deliberate, separate act (`resetStage`), not an ordinary transition.
 *
 * Moving to `documented` requires the controlled document that captures the
 * change, because "documented" with nothing to point at is exactly the claim
 * this product exists to catch.
 */
export async function advanceStage(
  changeId: string,
  stage: Stage,
  opts: { recordId?: string | undefined; actor?: string | undefined; at?: string | undefined } = {},
  db: Db = getCustomerDb(),
): Promise<Change> {
  const current = await getChange(changeId, db);
  if (!current) throw new Error(`change not found: ${changeId}`);

  if (stage === "superseded") {
    await db.prepare(`UPDATE changes SET stage = 'superseded' WHERE change_id = ?`).run(changeId);
    return (await getChange(changeId, db))!;
  }

  const from = STAGE_ORDER.indexOf(current.stage);
  const to = STAGE_ORDER.indexOf(stage);
  if (to === -1) throw new Error(`not a workflow stage: ${stage}`);
  if (from !== -1 && to <= from) {
    throw new Error(`change ${changeId} is already at "${current.stage}"; stages move forward only`);
  }

  const recordId = opts.recordId ?? current.recordId;
  if (stage === "documented" && !recordId) {
    throw new Error(
      "marking a change documented requires the controlled document that captures it",
    );
  }

  const at = opts.at ?? new Date().toISOString();
  await db
    .prepare(
      `UPDATE changes
          SET stage = ?,
              record_id = ?,
              implemented_at = COALESCE(implemented_at, CASE WHEN ? = 'implemented' THEN ? END),
              documented_at  = COALESCE(documented_at,  CASE WHEN ? = 'documented'  THEN ? END),
              documented_by  = COALESCE(documented_by,  CASE WHEN ? = 'documented'  THEN ? END)
        WHERE change_id = ?`,
    )
    .run(stage, recordId, stage, at, stage, at, stage, opts.actor ?? null, changeId);
  return (await getChange(changeId, db))!;
}

/** Undo a mistaken advance. Deliberately explicit — see `advanceStage`. */
export async function resetStage(
  changeId: string,
  stage: Stage,
  db: Db = getCustomerDb(),
): Promise<Change | null> {
  await db.prepare(`UPDATE changes SET stage = ? WHERE change_id = ?`).run(stage, changeId);
  return getChange(changeId, db);
}

/**
 * Record the model's suggested score. Never writes `score`.
 *
 * The separation is the whole guarantee: `suggested_score` is an inference about
 * text that carries no controlled-document quote, so it is not protected by the
 * hallucination guard, and every surface that reads it must be able to tell it
 * apart from a number a person stands behind.
 */
export async function saveSuggestedScore(
  changeId: string,
  suggestedScore: number,
  rationale: string,
  db: Db = getCustomerDb(),
): Promise<Change | null> {
  await db
    .prepare(
      `UPDATE changes SET suggested_score = ?, suggested_rationale = ?, suggested_at = ?
        WHERE change_id = ?`,
    )
    .run(suggestedScore, rationale, new Date().toISOString(), changeId);
  return getChange(changeId, db);
}

/**
 * Record the human's confirmed score, and the rationale if it goes below the
 * type's floor. The only writer of `score`.
 */
export async function setScore(
  changeId: string,
  score: number,
  opts: { actor?: string | undefined; belowFloorRationale?: string | undefined } = {},
  db: Db = getCustomerDb(),
): Promise<Change | null> {
  await db
    .prepare(
      `UPDATE changes
          SET score = ?, scored_by = ?, scored_at = ?, below_floor_rationale = ?
        WHERE change_id = ?`,
    )
    .run(
      score,
      opts.actor ?? null,
      new Date().toISOString(),
      opts.belowFloorRationale?.trim() || null,
      changeId,
    );
  return getChange(changeId, db);
}

export async function listChanges(
  baselineId: string,
  db: Db = getCustomerDb(),
): Promise<Change[]> {
  const rows = (await db
    .prepare(
      `SELECT * FROM changes WHERE baseline_id = ?
       ORDER BY COALESCE(changed_at, created_at)`,
    )
    .all(baselineId)) as Record<string, unknown>[];
  return rows.map(rowToChange);
}

/**
 * Record the human's regulatory determination on a change.
 *
 * This is the ONLY writer of `determination`, and it exists to make the point
 * structural: the submit / don't-submit call is set here, by a person, and
 * never by any analysis in this codebase.
 */
export async function setDetermination(
  changeId: string,
  determination: Determination,
  db: Db = getCustomerDb(),
): Promise<Change | null> {
  await db
    .prepare(`UPDATE changes SET determination = ? WHERE change_id = ?`)
    .run(determination, changeId);
  const row = (await db
    .prepare(`SELECT * FROM changes WHERE change_id = ?`)
    .get(changeId)) as Record<string, unknown> | undefined;
  return row ? rowToChange(row) : null;
}

// ---------------------------------------------------------------------------
// Submissions.
//
// A submission is a plain tracking record of something a human decided to do.
// Nothing here decides that one is needed, picks its kind, or files it. What it
// buys is the question a change spreadsheet cannot answer at all: is this change
// actually out the door, or does everyone just believe it is?
// ---------------------------------------------------------------------------

export async function createSubmission(
  args: {
    baselineId: string;
    title: string;
    kind?: SubmissionKind | undefined;
    note?: string | undefined;
    changeIds?: string[] | undefined;
  },
  db: Db = getCustomerDb(),
): Promise<Submission> {
  const submission: Submission = {
    submissionId: `sub-${randomUUID().slice(0, 12)}`,
    baselineId: args.baselineId,
    title: args.title,
    kind: args.kind ?? "special_510k",
    status: "planned",
    filedAt: null,
    decisionAt: null,
    clearanceId: null,
    note: args.note ?? null,
    createdAt: new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO submissions
         (submission_id, baseline_id, title, kind, status, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      submission.submissionId,
      submission.baselineId,
      submission.title,
      submission.kind,
      submission.status,
      submission.note,
      submission.createdAt,
    );
  if (args.changeIds?.length) {
    await attachChanges(submission.submissionId, args.changeIds, db);
  }
  return submission;
}

export async function listSubmissions(
  baselineId: string,
  db: Db = getCustomerDb(),
): Promise<Submission[]> {
  const rows = (await db
    .prepare(`SELECT * FROM submissions WHERE baseline_id = ? ORDER BY created_at`)
    .all(baselineId)) as Record<string, unknown>[];
  return rows.map(rowToSubmission);
}

export async function getSubmission(
  submissionId: string,
  db: Db = getCustomerDb(),
): Promise<Submission | null> {
  const row = (await db
    .prepare(`SELECT * FROM submissions WHERE submission_id = ?`)
    .get(submissionId)) as Record<string, unknown> | undefined;
  return row ? rowToSubmission(row) : null;
}

/**
 * Put changes on a submission, moving them to `in_submission`.
 *
 * Only documented changes are eligible. Carrying an undocumented change on a
 * submission would take it out of the exposure total on the strength of a
 * promise — the ledger would go quiet about the exact thing it exists to track.
 */
export async function attachChanges(
  submissionId: string,
  changeIds: string[],
  db: Db = getCustomerDb(),
): Promise<number> {
  let attached = 0;
  for (const changeId of changeIds) {
    const change = await getChange(changeId, db);
    if (!change) continue;
    if (change.stage !== "documented") {
      throw new Error(
        `change ${changeId} is at "${change.stage}"; only documented changes can go on a submission`,
      );
    }
    await db
      .prepare(`UPDATE changes SET submission_id = ?, stage = 'in_submission' WHERE change_id = ?`)
      .run(submissionId, changeId);
    attached++;
  }
  return attached;
}

/** Mark a submission filed. `filed_at` is what "is it actually out?" reads. */
export async function fileSubmission(
  submissionId: string,
  filedAt: string | null = new Date().toISOString(),
  db: Db = getCustomerDb(),
): Promise<Submission | null> {
  await db
    .prepare(`UPDATE submissions SET status = 'filed', filed_at = ? WHERE submission_id = ?`)
    .run(filedAt, submissionId);
  return getSubmission(submissionId, db);
}

export async function setSubmissionStatus(
  submissionId: string,
  status: SubmissionStatus,
  db: Db = getCustomerDb(),
): Promise<Submission | null> {
  await db
    .prepare(`UPDATE submissions SET status = ? WHERE submission_id = ?`)
    .run(status, submissionId);
  return getSubmission(submissionId, db);
}

export interface ClearanceResult {
  submission: Submission;
  /** The successor baseline the cleared configuration establishes. */
  baseline: Baseline;
  /** Changes retired into the new cleared configuration. */
  retired: number;
}

/**
 * Close the loop: a cleared submission establishes a new baseline.
 *
 * This is the step every change spreadsheet gets wrong, and getting it wrong is
 * why those spreadsheets drift until nobody trusts them. Once FDA clears a
 * submission, the changes it carried are no longer *accumulated deviation from
 * the cleared device* — they ARE the cleared device. Accumulation has to restart
 * from the new clearance number, and every later change has to be compared
 * against it rather than against the original.
 *
 * So this marks the carried changes `cleared` (removing them from exposure),
 * mints a successor baseline carrying the same threshold and procedure citation,
 * and links the old baseline forward so the clearance lineage stays readable.
 * The clearance number is entered by a human from the FDA letter; nothing here
 * predicts or assumes it.
 */
export async function clearSubmission(
  submissionId: string,
  args: { clearanceId: string; decisionAt?: string | undefined },
  db: Db = getCustomerDb(),
): Promise<ClearanceResult> {
  const submission = await getSubmission(submissionId, db);
  if (!submission) throw new Error(`submission not found: ${submissionId}`);
  const prior = await getBaseline(submission.baselineId, db);
  if (!prior) throw new Error(`baseline not found: ${submission.baselineId}`);

  const decisionAt = args.decisionAt ?? new Date().toISOString();
  const successor: Baseline = {
    baselineId: `bl-${randomUUID().slice(0, 12)}`,
    device: prior.device,
    clearanceId: args.clearanceId,
    clearedAt: decisionAt.slice(0, 10),
    configuration: prior.configuration,
    note: `Established by ${submission.title} (${submission.kind}), clearing ${prior.clearanceId}.`,
    threshold: prior.threshold,
    thresholdSource: prior.thresholdSource,
    supersededBy: null,
    createdAt: new Date().toISOString(),
  };

  // One transaction: a half-applied clearance would leave changes retired with
  // no baseline to have been retired into, and the totals would be wrong in the
  // direction that hides exposure.
  await db.transaction(async () => {
    await db
      .prepare(
        `UPDATE submissions SET status = 'cleared', clearance_id = ?, decision_at = ?
          WHERE submission_id = ?`,
      )
      .run(args.clearanceId, decisionAt, submissionId);
    await db
      .prepare(`UPDATE changes SET stage = 'cleared' WHERE submission_id = ?`)
      .run(submissionId);
    await db
      .prepare(
        `INSERT INTO baselines
           (baseline_id, device, clearance_id, cleared_at, configuration, note,
            threshold, threshold_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        successor.baselineId,
        successor.device,
        successor.clearanceId,
        successor.clearedAt,
        JSON.stringify(successor.configuration),
        successor.note,
        successor.threshold,
        successor.thresholdSource,
        successor.createdAt,
      );
    await db
      .prepare(`UPDATE baselines SET superseded_by = ? WHERE baseline_id = ?`)
      .run(successor.baselineId, prior.baselineId);
  })();

  const retired = (await db
    .prepare(`SELECT COUNT(*)::int AS n FROM changes WHERE submission_id = ?`)
    .get(submissionId)) as { n: number } | undefined;

  return {
    submission: (await getSubmission(submissionId, db))!,
    baseline: successor,
    retired: retired?.n ?? 0,
  };
}

/** Persist inferred (model-suggested) gaps for a change, pending acceptance. */
export async function saveInferredGaps(
  gaps: Omit<ChangeGap, "gapId" | "createdAt" | "origin" | "status">[],
  db: Db = getCustomerDb(),
): Promise<void> {
  const now = new Date().toISOString();
  for (const g of gaps) {
    await db
      .prepare(
        `INSERT INTO change_gaps (gap_id, change_id, origin, kind, detail, status, created_at)
         VALUES (?, ?, 'inferred', ?, ?, 'open', ?)`,
      )
      .run(`gap-${randomUUID().slice(0, 12)}`, g.changeId, g.kind, g.detail, now);
  }
}

export async function listInferredGaps(
  changeId: string,
  db: Db = getCustomerDb(),
): Promise<ChangeGap[]> {
  const rows = (await db
    .prepare(`SELECT * FROM change_gaps WHERE change_id = ? ORDER BY created_at`)
    .all(changeId)) as Record<string, unknown>[];
  return rows.map((r) => ({
    gapId: r["gap_id"] as string,
    changeId: r["change_id"] as string,
    origin: r["origin"] as ChangeGap["origin"],
    kind: r["kind"] as string,
    detail: r["detail"] as string,
    status: r["status"] as ChangeGap["status"],
    createdAt: r["created_at"] as string,
  }));
}
