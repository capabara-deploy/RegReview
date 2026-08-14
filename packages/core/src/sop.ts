import { createHash } from "node:crypto";
import { CORPUS_VERSION } from "./config.js";
import { getCustomerDb, getSopsDb, type Db } from "./db/index.js";
import { normalizeText, sha256Hex } from "./extract/text.js";
import type { RecordType, Rule } from "./types.js";

/**
 * Ingesting a customer's own procedures as reviewable requirements.
 *
 * This is the other half of the product, and until now it was dead code: the
 * conformance pass ran, found no rules with `source = 'sop'`, and skipped
 * itself on every review.
 *
 * Why it matters more than it sounds. The regulatory expert's strongest single
 * recommendation was that whatever procedures a company has written are treated
 * as the rule of law during an inspection. An investigator checks what FDA
 * requires, and then checks whether the company followed its own procedures —
 * including the requirements a company imposed on itself that go beyond what FDA
 * asks. A tool that checks only the regulation is checking half the problem, and
 * it is the half every competitor also checks.
 *
 * These rules are the customer's confidential content: stored in the sops
 * database (never the corpus database), scoped to the customer, and never
 * redistributed — see NOTICE.md.
 */

export interface SopDocument {
  sopDocumentId: string;
  filename: string;
  storedPath: string;
  sha256: string;
  title: string | null;
  docId: string | null;
  revision: string | null;
  effectiveDate: string | null;
  normalizedText: string;
  uploadedAt: string;
}

export interface SopClause {
  /** Clause number as written in the procedure, e.g. "5.2.1". */
  number: string;
  /** Heading text, when the clause has one. */
  heading: string | null;
  /** The clause body — this becomes the rule's `expectation`. */
  text: string;
  charStart: number;
  charEnd: number;
}

/**
 * Split a procedure into numbered clauses.
 *
 * Deliberately conservative and deterministic — no model involved. A customer's
 * SOP is the yardstick everything else is measured against, so a clause set that
 * silently drifts between ingests would undermine every conformance finding
 * derived from it. Numbered clauses are what SOPs in this industry are actually
 * built from, and they are what auditors cite.
 *
 * Clauses that are pure boilerplate (scope, references, revision history,
 * definitions) are skipped: they impose no obligation, and turning them into
 * rules produces confident findings about nothing.
 */
const CLAUSE_PATTERN = /^(\d+(?:\.\d+)*)\.?\s+(.{3,120})$/;

const BOILERPLATE = /^(purpose|scope|references?|definitions?|abbreviations?|revision history|record of changes|approvals?|table of contents|distribution)\b/i;

/**
 * A clause imposes an obligation only if it says something must happen. Without
 * this filter a heading like "5. Corrective Action" becomes a rule whose
 * expectation is its own title.
 */
const OBLIGATION = /\b(shall|must|is required to|are required to|will be|responsible for|ensure|verify|document|record|approve|review|maintain|establish)\b/i;

export function extractClauses(normalizedText: string): SopClause[] {
  const lines = normalizedText.split("\n");
  const clauses: SopClause[] = [];

  // Offset of the start of each line, so clause spans index into the same
  // canonical string every other offset in the system uses.
  const lineOffsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    lineOffsets.push(cursor);
    cursor += line.length + 1; // +1 for the newline removed by split
  }

  interface Open {
    number: string;
    heading: string | null;
    startLine: number;
    bodyLines: string[];
  }
  let open: Open | undefined;

  const close = (endLine: number): void => {
    if (!open) return;
    const text = [open.heading, ...open.bodyLines].filter(Boolean).join("\n").trim();
    const charStart = lineOffsets[open.startLine]!;
    const lastLine = Math.max(open.startLine, endLine - 1);
    const charEnd = Math.min(
      (lineOffsets[lastLine] ?? charStart) + (lines[lastLine]?.length ?? 0),
      normalizedText.length,
    );

    const isBoilerplate = open.heading !== null && BOILERPLATE.test(open.heading);
    if (!isBoilerplate && OBLIGATION.test(text) && text.length > 25) {
      clauses.push({
        number: open.number,
        heading: open.heading,
        text,
        charStart,
        charEnd,
      });
    }
    open = undefined;
  };

  for (const [i, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    const match = CLAUSE_PATTERN.exec(line);
    if (match) {
      close(i);
      open = {
        number: match[1]!,
        heading: match[2]!.trim(),
        startLine: i,
        bodyLines: [],
      };
      continue;
    }
    if (open && line !== "") open.bodyLines.push(line);
  }
  close(lines.length);

  return clauses;
}

/** Extract the procedure's own identifier, revision and title from its text. */
function extractSopMetadata(normalizedText: string): {
  title: string | null;
  docId: string | null;
  revision: string | null;
  effectiveDate: string | null;
} {
  const docId =
    /\b(?:SOP|WI|QSP|QM|POL)[- ]?([A-Z0-9]{1,4}[-.]?\d{2,5})\b/i.exec(normalizedText)?.[0] ?? null;
  // Same trailing-\b discipline as the record parser: without it "Reviewed"
  // matches as Rev + "iewed".
  const revision =
    /\bRev(?:ision)?\b[*_\s]*\.?[*_\s]*[:#]?[*_\s]*([A-Z0-9][A-Z0-9.\-]{0,7})\b/i.exec(
      normalizedText,
    )?.[1] ?? null;
  const effectiveDate =
    /\bEffective(?:\s+Date)?\b[*_\s]*[:#]?[*_\s]*(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i.exec(
      normalizedText,
    )?.[1] ?? null;

  // First non-empty, non-metadata line is the best guess at a title.
  const title =
    normalizedText
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find((l) => l.length > 6 && !/^[A-Za-z ]+:/.test(l) && !/^-+$/.test(l)) ?? null;

  return { title, docId, revision, effectiveDate };
}

export interface SopIngestResult {
  document: SopDocument;
  clauses: SopClause[];
  rulesWritten: number;
  skipped: number;
}

/**
 * Store a procedure and turn its obligation-bearing clauses into rules.
 *
 * `appliesTo` is supplied by the caller rather than inferred: which record types
 * a given procedure governs is a judgment about the customer's quality system,
 * and guessing it wrong means either missing conformance findings or asserting a
 * procedure against records it does not cover. Both erode trust; the second
 * erodes it faster.
 */
export async function ingestSop(
  args: {
    filename: string;
    storedPath: string;
    raw: string;
    appliesTo: RecordType[];
    /**
     * Reuse an existing procedure's ID instead of deriving one from the
     * filename. Supplied when editing in place, so the stable references and the
     * rule links survive a text change — otherwise editing a procedure's body
     * would orphan its old rules under a new ID and leave two copies.
     */
    sopDocumentId?: string;
    /**
     * Override the label every clause is cited by. Normally the procedure's own
     * document number is correct and this is left unset.
     *
     * It exists for the shipped sample procedures, whose citations must not be
     * mistakable for the customer's own: a finding reading "QSP-0012 Rev 6 §8.2"
     * asserts an obligation the customer actually signed, and one reading
     * "SAMPLE-CAPA-001 Rev 1 §8.2" does not. See `sampleSops.ts`.
     */
    citationLabel?: string;
  },
  db: Db = getSopsDb(),
): Promise<SopIngestResult> {
  const normalizedText = normalizeText(args.raw);
  const meta = extractSopMetadata(normalizedText);
  const sopDocumentId =
    args.sopDocumentId ??
    `sop-${createHash("sha256")
      .update(`${args.filename}|${meta.docId ?? ""}`)
      .digest("hex")
      .slice(0, 16)}`;

  const document: SopDocument = {
    sopDocumentId,
    filename: args.filename,
    storedPath: args.storedPath,
    sha256: sha256Hex(normalizedText),
    title: meta.title,
    docId: meta.docId,
    revision: meta.revision,
    effectiveDate: meta.effectiveDate,
    normalizedText,
    uploadedAt: new Date().toISOString(),
  };

  const clauses = extractClauses(normalizedText);

  // Re-ingesting a procedure refreshes its rules, but it cannot simply delete
  // and re-insert them: a rule may be cited by findings from an earlier review.
  // `findings.rule_id` used to carry a foreign key into `rules`, but findings
  // now live in the customer database and rules live here in the sops
  // database — Postgres can't enforce that constraint across databases, so
  // this check is now the only thing standing between deleting a rule and
  // orphaning a finding's reference to it. Cascading the delete would erase
  // findings, destroying the audit trail this tool is careful to keep.
  //
  // So: upsert every current clause in place, then delete only the clauses that
  // are gone from the new text AND cited by no finding (checked against the
  // customer database). A removed clause that a past finding still references
  // is left in place; that is a rare edge (you edited out a clause that had
  // already been flagged) and keeping the historical finding valid is worth
  // the small staleness.
  const customerDb = getCustomerDb();
  let rulesWritten = 0;

  await db.transaction(async () => {
    await db
      .prepare(
        `INSERT INTO sop_documents
           (sop_document_id, filename, stored_path, sha256, title, doc_id, revision,
            effective_date, normalized_text, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sop_document_id) DO UPDATE SET
           filename        = excluded.filename,
           stored_path     = excluded.stored_path,
           sha256          = excluded.sha256,
           title           = excluded.title,
           doc_id          = excluded.doc_id,
           revision        = excluded.revision,
           effective_date  = excluded.effective_date,
           normalized_text = excluded.normalized_text,
           uploaded_at     = excluded.uploaded_at`,
      )
      .run(
        document.sopDocumentId,
        document.filename,
        document.storedPath,
        document.sha256,
        document.title,
        document.docId,
        document.revision,
        document.effectiveDate,
        document.normalizedText,
        document.uploadedAt,
      );

    const label = args.citationLabel ?? document.docId ?? document.filename;
    const currentIds = new Set<string>();

    for (const clause of clauses) {
      const ruleId = `sop:${document.sopDocumentId}:${clause.number}`;
      currentIds.add(ruleId);
      await db
        .prepare(
          `INSERT INTO rules
             (rule_id, source, citation, title, expectation, applies_to,
              harm_linked, citation_frequency, frequency_percentile,
              corpus_version, sop_document_id)
           VALUES (?, 'sop', ?, ?, ?, ?, 0, 0, 0, ?, ?)
           ON CONFLICT(rule_id) DO UPDATE SET
             citation       = excluded.citation,
             title          = excluded.title,
             expectation    = excluded.expectation,
             applies_to     = excluded.applies_to,
             corpus_version = excluded.corpus_version`,
        )
        .run(
          ruleId,
          // Cited the way an investigator would: procedure, revision, clause.
          `${label}${document.revision ? ` Rev ${document.revision}` : ""} §${clause.number}`,
          clause.heading ?? `Clause ${clause.number}`,
          clause.text,
          JSON.stringify(args.appliesTo),
          CORPUS_VERSION,
          document.sopDocumentId,
        );
      rulesWritten++;
    }

    // Prune clauses that no longer exist, but only if nothing depends on them.
    const prior = await db
      .prepare(`SELECT rule_id FROM rules WHERE sop_document_id = ?`)
      .all<{ rule_id: string }>(document.sopDocumentId);
    for (const { rule_id } of prior) {
      if (currentIds.has(rule_id)) continue;
      const referenced = await customerDb
        .prepare(`SELECT 1 FROM findings WHERE rule_id = ? LIMIT 1`)
        .get(rule_id);
      if (referenced) continue;
      await db.prepare(`DELETE FROM rules WHERE rule_id = ?`).run(rule_id);
    }
  })();

  return {
    document,
    clauses,
    rulesWritten,
    skipped: 0,
  };
}

/** One procedure with its extracted clauses. `null` if unknown. */
export async function getSop(
  sopDocumentId: string,
  db: Db = getSopsDb(),
): Promise<
  | (SopDocument & {
      appliesTo: RecordType[];
      clauses: { number: string; citation: string; heading: string; expectation: string }[];
    })
  | null
> {
  const row = await db
    .prepare(`SELECT * FROM sop_documents WHERE sop_document_id = ?`)
    .get<Record<string, unknown>>(sopDocumentId);
  if (!row) return null;

  const ruleRows = await db
    .prepare(
      `SELECT rule_id, citation, title, expectation, applies_to FROM rules WHERE sop_document_id = ? ORDER BY rule_id`,
    )
    .all<{
      rule_id: string;
      citation: string;
      title: string;
      expectation: string;
      applies_to: string;
    }>(sopDocumentId);

  // applies_to is stored identically on every clause of a procedure, so the
  // first rule's value is the procedure's.
  let appliesTo: RecordType[] = [];
  if (ruleRows[0]) {
    try {
      const parsed: unknown = JSON.parse(ruleRows[0].applies_to);
      if (Array.isArray(parsed)) appliesTo = parsed as RecordType[];
    } catch {
      /* treat as all */
    }
  }

  return {
    sopDocumentId: row["sop_document_id"] as string,
    filename: row["filename"] as string,
    storedPath: row["stored_path"] as string,
    sha256: row["sha256"] as string,
    title: (row["title"] as string | null) ?? null,
    docId: (row["doc_id"] as string | null) ?? null,
    revision: (row["revision"] as string | null) ?? null,
    effectiveDate: (row["effective_date"] as string | null) ?? null,
    normalizedText: row["normalized_text"] as string,
    uploadedAt: row["uploaded_at"] as string,
    appliesTo,
    clauses: ruleRows.map((r) => ({
      // The clause number is the tail of the rule id: "sop:<id>:5.2".
      number: r.rule_id.split(":").pop() ?? "",
      citation: r.citation,
      heading: r.title,
      expectation: r.expectation,
    })),
  };
}

/**
 * Edit a procedure in place: new text and/or new applies_to, same ID.
 *
 * Re-runs the deterministic clause extraction, so a reviewer editing a
 * procedure's wording immediately changes what the conformance pass checks —
 * which is the point of making it editable. The ID is preserved so nothing that
 * references the procedure is orphaned.
 */
export async function updateSop(
  args: {
    sopDocumentId: string;
    raw?: string;
    appliesTo?: RecordType[];
  },
  db: Db = getSopsDb(),
): Promise<SopIngestResult> {
  const existing = await getSop(args.sopDocumentId, db);
  if (!existing) throw new Error(`no procedure with id ${args.sopDocumentId}`);

  return ingestSop(
    {
      filename: existing.filename,
      storedPath: existing.storedPath,
      raw: args.raw ?? existing.normalizedText,
      appliesTo: args.appliesTo ?? existing.appliesTo,
      sopDocumentId: args.sopDocumentId,
    },
    db,
  );
}

/** Remove a procedure and every conformance rule derived from it. */
export async function deleteSop(sopDocumentId: string, db: Db = getSopsDb()): Promise<boolean> {
  const info = await db.transaction(async () => {
    // Rules cascade via the foreign key, but delete explicitly so the intent is
    // visible and the count is knowable.
    await db.prepare(`DELETE FROM rules WHERE sop_document_id = ?`).run(sopDocumentId);
    return db.prepare(`DELETE FROM sop_documents WHERE sop_document_id = ?`).run(sopDocumentId);
  })();
  return info.changes > 0;
}

export async function listSops(
  db: Db = getSopsDb(),
): Promise<(SopDocument & { ruleCount: number })[]> {
  const rows = await db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM rules r WHERE r.sop_document_id = s.sop_document_id)
                     AS rule_count
         FROM sop_documents s ORDER BY s.uploaded_at DESC`,
    )
    .all<Record<string, unknown> & { rule_count: number }>();

  return rows.map((r) => ({
    sopDocumentId: r["sop_document_id"] as string,
    filename: r["filename"] as string,
    storedPath: r["stored_path"] as string,
    sha256: r["sha256"] as string,
    title: (r["title"] as string | null) ?? null,
    docId: (r["doc_id"] as string | null) ?? null,
    revision: (r["revision"] as string | null) ?? null,
    effectiveDate: (r["effective_date"] as string | null) ?? null,
    normalizedText: r["normalized_text"] as string,
    uploadedAt: r["uploaded_at"] as string,
    ruleCount: r.rule_count,
  }));
}

/** SOP-derived rules only, for the conformance pass. */
export async function loadSopRules(recordType: RecordType, db: Db = getSopsDb()): Promise<Rule[]> {
  const rows = await db
    .prepare(`SELECT * FROM rules WHERE source = 'sop'`)
    .all<Record<string, unknown>>();

  return rows
    .map((r) => {
      let appliesTo: RecordType[] = [];
      try {
        const parsed: unknown = JSON.parse(r["applies_to"] as string);
        if (Array.isArray(parsed)) appliesTo = parsed as RecordType[];
      } catch {
        /* treat as all record types */
      }
      return {
        ruleId: r["rule_id"] as string,
        source: "sop" as const,
        citation: r["citation"] as string,
        title: r["title"] as string,
        expectation: r["expectation"] as string,
        appliesTo,
        harmLinked: false,
        citationFrequency: 0,
        frequencyPercentile: 0,
        corpusVersion: r["corpus_version"] as string,
      };
    })
    .filter((rule) => rule.appliesTo.length === 0 || rule.appliesTo.includes(recordType));
}
