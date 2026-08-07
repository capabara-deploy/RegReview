import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { MongoClient, type Collection, type Db } from "mongodb";

/**
 * Reviewer accounts and sessions.
 *
 * Previously this was one shared password in an environment variable, which
 * could not answer "who looked at this" and could not be revoked without
 * restarting the whole server. Real accounts fix the first problem; sessions
 * that live in the database (instead of a token derived from an in-memory
 * secret) fix the second — a session can be deleted, and it survives a
 * server restart or running more than one instance.
 */

export interface UserDoc {
  username: string;
  passwordHash: string;
  createdAt: string;
}

export interface SessionDoc {
  _id: string;
  username: string;
  createdAt: string;
  expiresAt: Date;
}

const MONGODB_URI = process.env["MONGODB_URI"] ?? "";
const MONGODB_DB = process.env["MONGODB_DB"] ?? "regreview";

export const AUTH_ENABLED = MONGODB_URI !== "";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches the session cookie's Max-Age.

let clientPromise: Promise<MongoClient> | null = null;

/** The shared Mongo connection, also used by quota.ts so both modules hit the same client. */
export async function getMongoDb(): Promise<Db> {
  if (!clientPromise) {
    const client = new MongoClient(MONGODB_URI);
    clientPromise = client.connect();
  }
  const client = await clientPromise;
  return client.db(MONGODB_DB);
}

async function users(): Promise<Collection<UserDoc>> {
  return (await getMongoDb()).collection<UserDoc>("users");
}

async function sessions(): Promise<Collection<SessionDoc>> {
  return (await getMongoDb()).collection<SessionDoc>("sessions");
}

/**
 * Create the indexes auth relies on.
 *
 * `sessions.expiresAt` is a TTL index — MongoDB itself deletes expired
 * sessions in the background, so an expired token stops working without any
 * cron job or manual sweep. `users.username` is unique so two accounts can
 * never collide on login.
 */
export async function ensureAuthIndexes(): Promise<void> {
  if (!AUTH_ENABLED) return;
  await (await users()).createIndex({ username: 1 }, { unique: true });
  await (await sessions()).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

export async function createUser(username: string, password: string): Promise<void> {
  const passwordHash = await bcrypt.hash(password, 12);
  await (await users()).insertOne({ username, passwordHash, createdAt: new Date().toISOString() });
}

/** Verify a login attempt. Returns the username on success, null otherwise. */
export async function verifyLogin(username: string, password: string): Promise<string | null> {
  const user = await (await users()).findOne({ username });
  if (!user) {
    // Hash something anyway so a nonexistent username doesn't return faster
    // than a wrong password — that timing gap is enough to enumerate accounts.
    await bcrypt.compare(password, "$2a$12$" + "0".repeat(53));
    return null;
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user.username : null;
}

/** Start a session and return its opaque token — the value to put in the cookie. */
export async function createSession(username: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await (await sessions()).insertOne({
    _id: token,
    username,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

/** The logged-in username for a session token, or null if it's missing/expired. */
export async function resolveSession(token: string): Promise<string | null> {
  const session = await (await sessions()).findOne({ _id: token, expiresAt: { $gt: new Date() } });
  return session?.username ?? null;
}

export async function deleteSession(token: string): Promise<void> {
  await (await sessions()).deleteOne({ _id: token });
}
