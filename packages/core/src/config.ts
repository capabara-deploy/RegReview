import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The corpus version stamped onto every rule and every run.
 *
 * Bump this whenever the rule corpus changes in a way that could change a
 * finding — new rules, edited `expectation` prose, a refreshed FDA citation
 * frequency table. Findings from different corpus versions are not comparable,
 * and `runs.corpus_version` is what lets us tell.
 */
export const CORPUS_VERSION = "2026.08.4";

/**
 * The prompt version stamped onto every run. Bump on any change to a check
 * prompt, for the same reason as above.
 */
export const PROMPT_VERSION = "p2";

/**
 * Pinned model. Not read from a "latest" alias on purpose: repeat-run
 * consistency was named a critical requirement by the Fresenius interviewee,
 * and a silently-changing model would break it.
 */
export const DEFAULT_MODEL = "claude-opus-4-8";
export const DEFAULT_EFFORT = "high";

/**
 * Find the monorepo root by walking up for the root package.json (the one
 * declaring workspaces).
 *
 * This matters more than it looks. npm workspace scripts run with cwd set to
 * the *workspace* directory, so a relative path like "./data/regreview.db"
 * resolves to packages/corpus/data/... under one script and packages/core/data/...
 * under another. That silently produced three separate databases: `migrate`
 * created tables in one, `ingest` wrote rows to a second, and a reader found a
 * third, empty one. Anchor to the repo root so every entry point agrees.
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { workspaces?: unknown };
        if (pkg.workspaces) return dir;
      } catch {
        // Unparseable package.json on the way up: keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to cwd rather than throwing — a developer running a one-off
  // script outside the repo should get a working (if local) path.
  return process.cwd();
}

export const REPO_ROOT = findRepoRoot();

/**
 * Resolve a configurable path against the repo root.
 * Absolute values in the environment are honored as-is.
 */
function configuredPath(envVar: string, fallback: string): string {
  const value = process.env[envVar] ?? fallback;
  return isAbsolute(value) ? value : resolve(REPO_ROOT, value);
}

/**
 * Read a required Neon connection string.
 *
 * Thrown lazily (only when a DB is actually opened) rather than at import
 * time, so CLIs and tests that never touch that particular database don't
 * need every connection string set.
 */
function requiredDatabaseUrl(envVar: string): string {
  const value = process.env[envVar];
  if (!value) {
    throw new Error(`${envVar} is not set. Add it to .env first.`);
  }
  return value;
}

export const config = {
  model: process.env["REGREVIEW_MODEL"] ?? DEFAULT_MODEL,
  effort: process.env["REGREVIEW_EFFORT"] ?? DEFAULT_EFFORT,
  // Uploaded files (original bytes, not extracted text) stay on local disk
  // deliberately — see the confidentiality note in db/index.ts. This is the
  // one piece of customer content this migration does not move to Neon.
  uploadDir: configuredPath("REGREVIEW_UPLOAD_DIR", "./data/uploads"),
  corpusCache: configuredPath("REGREVIEW_CORPUS_CACHE", "./corpus-cache"),
  port: Number(process.env["PORT"] ?? 8787),
  get corpusDatabaseUrl(): string {
    return requiredDatabaseUrl("NEON_DATABASE_URL");
  },
  get customerDatabaseUrl(): string {
    return requiredDatabaseUrl("NEON_CUSTOMER_DATABASE_URL");
  },
  get sopsDatabaseUrl(): string {
    return requiredDatabaseUrl("NEON_SOPS_DATABASE_URL");
  },
} as const;
