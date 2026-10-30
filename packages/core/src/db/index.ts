import { join } from "node:path";
import { config } from "../config.js";
import { PgDb, type PgTarget } from "./pgDb.js";

export type Db = PgDb;

/**
 * Three separate Neon Postgres databases, split by data sensitivity:
 *
 *  - corpus: public regulatory reference data (21 CFR text, FDA citation
 *    frequencies, the hand-authored/public rule corpus). No customer content.
 *  - customer: uploaded records, extracted blocks/facts, and every run and
 *    finding derived from them. Findings embed verbatim quotes from the
 *    customer's document, so this is customer content, same as records.
 *  - sops: uploaded SOPs and the rules derived from them. Also customer
 *    content, kept in its own database rather than folded into `customer`.
 *
 * The confidential-document reasoning that used to justify a purely local
 * SQLite file (see git history) now lives one level up: instead of "never
 * leaves this machine," it's "customer content lives in customer/sops,
 * never in corpus, and the app never needs all three to answer one query
 * except when merging the public and SOP-derived halves of the rule set —
 * see loadRulesFor in store.ts."
 */

let corpus: PgDb | undefined;
let customer: PgDb | undefined;
let sops: PgDb | undefined;

/**
 * In local mode each database is its own PGlite directory, so the
 * sensitivity split survives: customer content still never shares storage
 * with the corpus. The url getter is only touched outside local mode, so a
 * local run never needs (or reads) a Neon connection string.
 */
function target(name: string, url: () => string): PgTarget {
  return config.local
    ? { kind: "local", dataDir: join(config.localDataDir, name) }
    : { kind: "url", connectionString: url() };
}

export function getCorpusDb(): PgDb {
  if (!corpus) corpus = new PgDb(target("corpus", () => config.corpusDatabaseUrl));
  return corpus;
}

export function getCustomerDb(): PgDb {
  if (!customer) customer = new PgDb(target("customer", () => config.customerDatabaseUrl));
  return customer;
}

export function getSopsDb(): PgDb {
  if (!sops) sops = new PgDb(target("sops", () => config.sopsDatabaseUrl));
  return sops;
}

let accounts: PgDb | undefined;

/**
 * Local mode only: reviewer accounts, sessions and the hourly quota, which
 * MongoDB holds in a deployment. Kept in its own directory so it never mixes
 * with customer content. Opening this outside local mode is a bug.
 */
export function getLocalAccountsDb(): PgDb {
  if (!config.local) throw new Error("getLocalAccountsDb() is only available with REGREVIEW_LOCAL=1");
  if (!accounts) accounts = new PgDb({ kind: "local", dataDir: join(config.localDataDir, "accounts") });
  return accounts;
}

export async function closeAllDbs(): Promise<void> {
  await Promise.all([corpus?.end(), customer?.end(), sops?.end(), accounts?.end()]);
  corpus = undefined;
  customer = undefined;
  sops = undefined;
  accounts = undefined;
}
