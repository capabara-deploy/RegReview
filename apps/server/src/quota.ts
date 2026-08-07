import type { Collection, Db } from "mongodb";

/**
 * Per-user hourly cap on documents sent to the model.
 *
 * The quota unit is documents actually entered into the review pipeline, not
 * HTTP requests — a batch review of 20 documents costs 20, the same as 20
 * separate single reviews would. Counting requests instead would let one
 * batch call blow past any limit meant to bound spend (~$0.65/document, per
 * the cost comment on the review routes).
 *
 * The increment is applied atomically and rolled back if it pushes the
 * bucket over the limit, so two concurrent requests from the same user can't
 * both read a stale count and both be admitted.
 */

export const REVIEWS_PER_HOUR = Number(process.env["REGREVIEW_HOURLY_REVIEW_LIMIT"] ?? 20);

interface UsageDoc {
  _id: string;
  username: string;
  hourBucket: string;
  count: number;
  expiresAt: Date;
}

let dbRef: Db | null = null;

/** Wired up from index.ts, which already owns the Mongo connection for auth. */
export function initQuota(db: Db): void {
  dbRef = db;
}

function usage(): Collection<UsageDoc> {
  if (!dbRef) throw new Error("initQuota() was not called");
  return dbRef.collection<UsageDoc>("usage_counters");
}

export async function ensureQuotaIndexes(): Promise<void> {
  if (!dbRef) return;
  await usage().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

function currentHourBucket(): string {
  return new Date().toISOString().slice(0, 13); // "2026-08-06T14"
}

function nextHourBoundary(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

export interface QuotaResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: string;
}

/**
 * Attempt to spend `count` documents against a user's hourly quota.
 *
 * Always increments first, then rolls back if that pushed the bucket over
 * the limit — see the module comment for why this is done atomically rather
 * than read-then-write.
 */
export async function consumeQuota(username: string, count: number): Promise<QuotaResult> {
  const bucket = currentHourBucket();
  const key = `${username}:${bucket}`;
  const resetAt = nextHourBoundary().toISOString();

  const after = await usage().findOneAndUpdate(
    { _id: key },
    {
      $inc: { count },
      $setOnInsert: {
        username,
        hourBucket: bucket,
        // Cleared well after the bucket it belongs to stops being "current",
        // not exactly on the hour — this is housekeeping, not the quota logic.
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
    },
    { upsert: true, returnDocument: "after" },
  );

  const newCount = after?.count ?? count;
  if (newCount > REVIEWS_PER_HOUR) {
    await usage().updateOne({ _id: key }, { $inc: { count: -count } });
    return { ok: false, limit: REVIEWS_PER_HOUR, remaining: 0, resetAt };
  }
  return { ok: true, limit: REVIEWS_PER_HOUR, remaining: REVIEWS_PER_HOUR - newCount, resetAt };
}

/** How much of the current hour's quota is left, without spending any of it. */
export async function peekQuota(username: string): Promise<QuotaResult> {
  const bucket = currentHourBucket();
  const doc = await usage().findOne({ _id: `${username}:${bucket}` });
  const used = doc?.count ?? 0;
  return {
    ok: true,
    limit: REVIEWS_PER_HOUR,
    remaining: Math.max(0, REVIEWS_PER_HOUR - used),
    resetAt: nextHourBoundary().toISOString(),
  };
}

/** Admin override: clear a user's usage for the current hour. */
export async function resetQuota(username: string): Promise<void> {
  const bucket = currentHourBucket();
  await usage().deleteOne({ _id: `${username}:${bucket}` });
}
