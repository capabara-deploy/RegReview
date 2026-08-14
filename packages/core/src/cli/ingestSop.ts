import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { migrateSops } from "../db/migrate.js";
import { isSampleSop } from "../sampleSops.js";
import { ingestSop, listSops } from "../sop.js";
import { RecordType } from "../types.js";

/**
 * Upload a customer procedure and turn its clauses into conformance rules.
 *
 * This is the "space to upload your own rules and standards" the product needs.
 * Until a procedure is loaded, the conformance pass has nothing to check and
 * skips itself — which means half the review is missing, silently.
 *
 *   npm run sop -- <file> [--applies-to capa,complaint] [--list]
 */

async function main(): Promise<void> {
  await migrateSops();
  const argv = process.argv.slice(2);

  if (argv.includes("--list") || argv.length === 0) {
    const sops = await listSops();
    if (sops.length === 0) {
      console.log(
        "No procedures loaded. The conformance pass will be skipped on every review.\n\n" +
          "  npm run sop -- <file.md> --applies-to capa",
      );
      return;
    }
    console.log(`${sops.length} procedure(s) loaded:\n`);
    for (const s of sops) {
      console.log(
        `  ${(s.docId ?? s.filename).padEnd(16)} Rev ${(s.revision ?? "?").padEnd(4)} ` +
          `${String(s.ruleCount).padStart(3)} clauses  ${s.title ?? ""}` +
          `${isSampleSop(s.sopDocumentId) ? "  [SAMPLE]" : ""}`,
      );
    }

    // Say this every time it is true. A sample procedure produces conformance
    // findings that look exactly like real ones, and the whole force of a
    // conformance finding is that the customer wrote the clause it cites.
    if (sops.every((s) => isSampleSop(s.sopDocumentId))) {
      console.log(
        `\nOnly sample procedures are loaded. Conformance findings will cite\n` +
          `SAMPLE-* clauses, which your company never wrote and is not bound by.\n` +
          `They demonstrate the pass; do not act on them. Load your own:\n\n` +
          `  npm run sop -- <your-procedure.md> --applies-to capa`,
      );
    }
    return;
  }

  const positional = argv.filter((a) => !a.startsWith("--"));
  const path = positional[0];
  if (!path) {
    console.error("usage: sop <file> [--applies-to capa,complaint] | --list");
    process.exitCode = 2;
    return;
  }

  const appliesToArg = argv.find((a) => a.startsWith("--applies-to"));
  const raw = appliesToArg?.includes("=")
    ? appliesToArg.split("=")[1]
    : argv[argv.indexOf("--applies-to") + 1];

  // Default to CAPA rather than "everything": asserting a CAPA procedure against
  // a design record produces confident findings about the wrong requirement,
  // which costs more trust than missing a finding.
  const appliesTo = (raw ?? "capa")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const parsed = RecordType.safeParse(s);
      if (!parsed.success) {
        console.error(`unknown record type "${s}". Valid: ${RecordType.options.join(", ")}`);
        process.exit(2);
      }
      return parsed.data;
    });

  const absolute = resolve(path);
  const result = await ingestSop({
    filename: basename(absolute),
    storedPath: absolute,
    raw: readFileSync(absolute, "utf8"),
    appliesTo,
  });

  const d = result.document;
  console.log(`Procedure : ${d.docId ?? d.filename}`);
  console.log(`Title     : ${d.title ?? "(not found)"}`);
  console.log(`Revision  : ${d.revision ?? "(not found)"}`);
  console.log(`Effective : ${d.effectiveDate ?? "(not found)"}`);
  console.log(`Applies to: ${appliesTo.join(", ")}`);
  console.log(`\n${result.rulesWritten} obligation-bearing clause(s) became rules:\n`);

  for (const clause of result.clauses) {
    console.log(`  §${clause.number.padEnd(6)} ${clause.heading ?? ""}`);
    console.log(`          ${clause.text.replace(/\s+/g, " ").slice(0, 110)}`);
  }

  console.log(
    `\nClauses that impose no obligation (purpose, scope, references, definitions)\n` +
      `are deliberately skipped — turning them into rules produces confident\n` +
      `findings about nothing.`,
  );
}

await main();
