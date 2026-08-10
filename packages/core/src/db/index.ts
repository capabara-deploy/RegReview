import { config } from "../config.js";
import { PgDb } from "./pgDb.js";

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

export function getCorpusDb(): PgDb {
  if (!corpus) corpus = new PgDb(config.corpusDatabaseUrl);
  return corpus;
}

export function getCustomerDb(): PgDb {
  if (!customer) customer = new PgDb(config.customerDatabaseUrl);
  return customer;
}

export function getSopsDb(): PgDb {
  if (!sops) sops = new PgDb(config.sopsDatabaseUrl);
  return sops;
}

export async function closeAllDbs(): Promise<void> {
  await Promise.all([corpus?.end(), customer?.end(), sops?.end()]);
  corpus = undefined;
  customer = undefined;
  sops = undefined;
}
