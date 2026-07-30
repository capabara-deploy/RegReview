import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "@regreview/core";

/**
 * Fetching public regulatory sources.
 *
 * Both fda.gov and ecfr.gov front their sites with CDNs that reject
 * non-browser clients — fda.gov returns 404 (not 403) to a default fetch
 * User-Agent, which looks like a dead link rather than a block and will cost
 * you an hour if you don't know. The data endpoints themselves are open. So:
 * browser-like headers, one request at a time, real backoff, and a contact
 * address so we are identifiable if our traffic ever bothers anyone.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Minimum gap between requests to the same host. Politeness, not a rate limit. */
const MIN_INTERVAL_MS = 750;

const lastRequestAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle(host: string): Promise<void> {
  const last = lastRequestAt.get(host);
  if (last !== undefined) {
    const wait = MIN_INTERVAL_MS - (Date.now() - last);
    if (wait > 0) await sleep(wait);
  }
  lastRequestAt.set(host, Date.now());
}

export interface FetchOptions {
  /** Cache filename. Downloads are cached so re-runs don't re-hit FDA. */
  cacheKey: string;
  /** Skip the cache and re-download. */
  force?: boolean;
  accept?: string;
  maxAttempts?: number;
}

/**
 * Download a URL to the corpus cache and return its bytes.
 *
 * Cached by `cacheKey`, so ingest CLIs are cheap to re-run — which matters
 * because you will re-run them while iterating on a parser.
 */
export async function fetchCached(url: string, opts: FetchOptions): Promise<Buffer> {
  const dir = join(config.corpusCache, "raw");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, opts.cacheKey);

  if (!opts.force && existsSync(path)) {
    return readFileSync(path);
  }

  const host = new URL(url).host;
  const maxAttempts = opts.maxAttempts ?? 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await throttle(host);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: opts.accept ?? "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          // Identify ourselves rather than hiding behind the UA alone.
          From: "regreview-corpus-ingest",
        },
      });

      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      if (!res.ok) {
        // 4xx other than 429 won't get better by retrying. Note the 404 trap
        // explicitly, because it is the symptom of CDN blocking, not a bad URL.
        throw Object.assign(
          new Error(
            `HTTP ${res.status} for ${url}` +
              (res.status === 404
                ? " — note fda.gov returns 404 to clients it does not recognize " +
                  "as browsers; verify the URL in a browser before assuming it moved"
                : ""),
          ),
          { fatal: true },
        );
      }

      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(path, buf);
      return buf;
    } catch (err) {
      lastError = err;
      if ((err as { fatal?: boolean }).fatal) break;
      if (attempt < maxAttempts) {
        const backoff = 1000 * 2 ** (attempt - 1);
        console.warn(`  retry ${attempt}/${maxAttempts - 1} in ${backoff}ms: ${String(err)}`);
        await sleep(backoff);
      }
    }
  }

  throw new Error(`failed to fetch ${url}: ${String(lastError)}`);
}

export function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}
