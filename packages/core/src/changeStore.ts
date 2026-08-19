import { randomUUID } from "node:crypto";
import { getCustomerDb, type Db } from "./db/index.js";
import {
  ChangeType,
  Determination,
  type Baseline,
  type Change,
  type ChangeGap,
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
    createdAt: r["created_at"] as string,
  };
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
    status: r["status"] as Change["status"],
    recordId: (r["record_id"] as string | null) ?? null,
    changedAt: (r["changed_at"] as string | null) ?? null,
    createdAt: r["created_at"] as string,
  };
}

export async function createBaseline(
  args: {
    device: string;
    clearanceId: string;
    clearedAt?: string;
    configuration?: Record<string, string>;
    note?: string;
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
    createdAt: new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO baselines (baseline_id, device, clearance_id, cleared_at, configuration, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      baseline.baselineId,
      baseline.device,
      baseline.clearanceId,
      baseline.clearedAt,
      JSON.stringify(baseline.configuration),
      baseline.note,
      baseline.createdAt,
    );
  return baseline;
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
    comparator?: string;
    changeType?: ChangeType;
    subsystem?: string;
    status?: Change["status"];
    recordId?: string;
    changedAt?: string;
  },
  db: Db = getCustomerDb(),
): Promise<Change> {
  const change: Change = {
    changeId: `chg-${randomUUID().slice(0, 12)}`,
    baselineId: args.baselineId,
    proposal: args.proposal,
    comparator: args.comparator ?? null,
    changeType: args.changeType ?? "other",
    subsystem: args.subsystem ?? null,
    // Human-owned; a new change is always undecided. The tool never sets this.
    determination: "undecided",
    status: args.status ?? "proposed",
    recordId: args.recordId ?? null,
    changedAt: args.changedAt ?? null,
    createdAt: new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO changes
         (change_id, baseline_id, proposal, comparator, change_type, subsystem,
          determination, status, record_id, changed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      change.changeId,
      change.baselineId,
      change.proposal,
      change.comparator,
      change.changeType,
      change.subsystem,
      change.determination,
      change.status,
      change.recordId,
      change.changedAt,
      change.createdAt,
    );
  return change;
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
