import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { getCustomerDb, type Db } from "./db/index.js";
import { blockContaining, locateQuote } from "./extract/text.js";
import type { Block, Fact, RecordDoc } from "./types.js";

/**
 * Extracting comparable values from a record.
 *
 * This is the input to the cross-document consistency check, and the division of
 * labour here is the whole point of the design:
 *
 *   - A model does the EXTRACTION, because recognising that "Severity was rated
 *     3 (Minor)" and "Sev: 5" refer to the same rated attribute of the same
 *     failure mode requires reading, not pattern matching.
 *   - Nothing but code does the COMPARISON. Once values are in a table, finding
 *     the disagreements is a join, and a join is repeatable, auditable, cheap,
 *     and scales to tens of thousands of documents.
 *
 * Both discovery conversations independently named cross-document inconsistency
 * as a real and unmet need — the same condition rated differently by department,
 * FMEA severity scales that do not line up with software risk categories. The
 * reason no existing process catches it is that it requires holding thousands of
 * documents in view at once, which is exactly what a table does and a reader
 * cannot. Asking a model to eyeball every pair of documents would be the
 * expensive, unrepeatable way to get a worse answer.
 */

/**
 * Fact kinds worth comparing.
 *
 * Deliberately narrow. A fact is only useful here if the same thing can appear
 * in two documents and disagree; extracting everything would fill the table with
 * values that can never conflict and slow the join for nothing.
 */
export const FACT_KINDS = [
  "risk_severity",
  "risk_occurrence",
  "risk_detection",
  "risk_index",
  "risk_acceptability_threshold",
  "failure_mode_cause",
  "affected_quantity",
  "software_version",
  "part_number",
  "date_opened",
  "date_closed",
  "requirement_id",
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

const ExtractedFact = z.object({
  kind: z.enum(FACT_KINDS),
  /**
   * What the value is about, in the record's own words — the failure mode,
   * hazard, requirement, or component. This is the join key across documents,
   * so it must describe the thing itself and not the section it appears in.
   */
  subject: z.string().min(1),
  /** The value, normalized to bare content: "3", not "3 (Minor)". */
  value: z.string().min(1),
  /**
   * Verbatim text containing the value, for anchoring. Same discipline as
   * findings: a fact that cannot be located in the document is discarded, so a
   * consistency finding can always point at real text in both documents.
   */
  quote: z.string().min(1),
});

const FactBatch = z.object({ facts: z.array(ExtractedFact) });

const FACTS_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...FACT_KINDS] },
          subject: {
            type: "string",
            description:
              "What the value describes — the failure mode, hazard, requirement or " +
              "component — in the document's own words. Not the section name.",
          },
          value: {
            type: "string",
            description: "Bare value only. For 'Severity was rated 3 (Minor)' this is '3'.",
          },
          quote: {
            type: "string",
            description: "Exact text from the document containing the value.",
          },
        },
        required: ["kind", "subject", "value", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["facts"],
  additionalProperties: false,
} as const;

const EXTRACTION_SYSTEM = `
Extract comparable values from a medical device quality record so they can be
checked for consistency against the company's other documents.

Extract only values that could meaningfully disagree with another document:
risk ratings and their scales, the cause a record settles on, affected
quantities, software versions, part numbers, key dates, requirement identifiers.

Rules:
  - The subject is the join key. Describe the THING the value is about — the
    failure mode, hazard, requirement or component — using the record's own
    wording. Do not use the section heading as the subject.
  - Give the bare value. For "Severity was rated 3 (Minor)" the value is "3".
    For a date, use ISO format if the record makes the date unambiguous.
  - Quote exact text containing the value, copied character-for-character.
  - Do not infer values the record does not state. Do not compute a value from
    other values. An absent value is not a fact.
  - If the same value appears several times, extract it once.

This is extraction only. Do not judge whether any value is correct, and do not
report problems — a later step compares values across documents.
`.trim();

/** Normalize a subject for joining. Two records will never phrase one identically. */
export function normalizeSubject(subject: string): string {
  return subject
    .toLowerCase()
    // Drop filler that varies between documents without changing meaning.
    .replace(/\b(the|a|an|of|for|to|in|on|during|causing|caused by|due to)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize a value for comparison.
 *
 * Compares what the record means, not how it typed it: "3" and "3 (Minor)" and
 * "Severity 3" all reduce to "3", so a genuine disagreement is not masked by
 * formatting and a formatting difference is not reported as a disagreement.
 */
export function normalizeValue(value: string): string {
  const trimmed = value.trim();

  // Dates and dotted versions must survive intact. An earlier version stripped
  // everything after the first number, which silently turned "2026-04-03" into
  // "2026" and "3.2.1" into "3.2" — making every date look equal and every
  // patch-level version difference disappear.
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  if (/^\d+(\.\d+){2,}/.test(trimmed)) {
    return /^(\d+(?:\.\d+)+)/.exec(trimmed)![1]!;
  }

  // A rating is a bare number, possibly followed by a word label: "3 (Minor)"
  // and "3" are the same rating. Only strip the label when what follows the
  // number is clearly not part of the value.
  const rating = /^(\d+)\s*(?:\(|-|—|:)?\s*[A-Za-z]*\)?$/.exec(trimmed);
  if (rating) return rating[1]!;

  // Numbers with thousands separators or a leading approximation.
  const quantity = /^(?:approx(?:imately)?\.?\s*|~\s*)?([\d,]+)\s*(?:units?)?$/i.exec(trimmed);
  if (quantity) return quantity[1]!.replace(/,/g, "");

  return trimmed.toLowerCase().replace(/\s+/g, " ");
}

/**
 * Fact kinds whose subject does not need to match to be comparable.
 *
 * Some values describe the document or the product as a whole rather than one
 * hazard: a risk acceptability threshold, the affected population, the affected
 * software version. Two documents will describe those in completely different
 * words ("acceptability threshold defined in risk management plan" versus "risk
 * index acceptability threshold") while unmistakably meaning the same quantity,
 * so requiring the subjects to match would miss the disagreement entirely — and
 * these are among the most consequential disagreements there are, since a record
 * using a more permissive threshold than the risk file reaches a different
 * acceptability conclusion from the same numbers.
 */
const DOCUMENT_SCOPED_KINDS = new Set<string>([
  "risk_acceptability_threshold",
  "affected_quantity",
  "software_version",
]);

export function isDocumentScoped(kind: string): boolean {
  return DOCUMENT_SCOPED_KINDS.has(kind);
}

/**
 * Do two normalized subjects refer to the same thing?
 *
 * Exact equality is not enough, and the reason is structural rather than
 * incidental: an FMEA labels its rows, so it says "FM-201 spurious occlusion
 * alarm causing infusion interruption" where the CAPA says "spurious occlusion
 * alarm causing infusion interruption". Every cross-document comparison between
 * a hazard table and a narrative record hits this.
 *
 * So: token containment (one subject's words are all present in the other's), or
 * a high enough Jaccard overlap to survive rewording. Containment is what
 * handles the identifier-prefix case; the overlap threshold is deliberately high
 * because a false join produces a confident finding about two unrelated things,
 * which is worse than missing one.
 */
const SUBJECT_OVERLAP_THRESHOLD = 0.6;

export function subjectsMatch(a: string, b: string): boolean {
  if (a === b) return true;

  const ta = new Set(a.split(" ").filter((t) => t.length > 2));
  const tb = new Set(b.split(" ").filter((t) => t.length > 2));
  if (ta.size === 0 || tb.size === 0) return false;

  const intersection = [...ta].filter((t) => tb.has(t)).length;

  // Containment: every meaningful word of the shorter subject appears in the
  // longer one. This is the FMEA row-identifier case.
  const smaller = Math.min(ta.size, tb.size);
  if (intersection === smaller) return true;

  const union = new Set([...ta, ...tb]).size;
  return intersection / union >= SUBJECT_OVERLAP_THRESHOLD;
}

export interface ExtractFactsResult {
  facts: Fact[];
  droppedUnanchored: number;
  inputTokens: number;
  outputTokens: number;
}

export async function extractFacts(
  args: { record: RecordDoc; blocks: Block[] },
  client: Anthropic = new Anthropic({ maxRetries: 8 }),
  model = config.model,
): Promise<ExtractFactsResult> {
  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: {
      // Extraction is recognition, not judgement — it does not need the effort a
      // check pass needs, and this pass runs once per document rather than four
      // times, so keeping it cheap matters.
      effort: "medium",
      format: { type: "json_schema", schema: FACTS_SCHEMA },
    },
    system: [{ type: "text", text: EXTRACTION_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          `Record: ${args.record.docId ?? args.record.filename} (${args.record.recordType})`,
          "",
          "--- BEGIN DOCUMENT ---",
          args.record.normalizedText,
          "--- END DOCUMENT ---",
        ].join("\n"),
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text");
  const facts: Fact[] = [];
  let droppedUnanchored = 0;

  if (text && text.type === "text") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.text);
    } catch {
      parsed = undefined;
    }
    const batch = FactBatch.safeParse(parsed);
    if (batch.success) {
      for (const raw of batch.data.facts) {
        const span = locateQuote(args.record.normalizedText, raw.quote);
        if (!span) {
          // Same guard as findings: an unlocatable fact could produce a
          // consistency finding pointing at text that does not exist.
          droppedUnanchored++;
          continue;
        }
        const block = blockContaining(args.blocks, span.charStart);
        if (!block) {
          droppedUnanchored++;
          continue;
        }
        facts.push({
          factId: createHash("sha256")
            .update(
              `${args.record.recordId}|${raw.kind}|${normalizeSubject(raw.subject)}|${span.charStart}`,
            )
            .digest("hex")
            .slice(0, 20),
          recordId: args.record.recordId,
          blockId: block.blockId,
          kind: raw.kind,
          subject: raw.subject,
          value: raw.value,
          charStart: span.charStart,
          charEnd: span.charEnd,
        });
      }
    }
  }

  return {
    facts,
    droppedUnanchored,
    inputTokens:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    outputTokens: response.usage.output_tokens,
  };
}

export async function saveFacts(
  recordId: string,
  facts: Fact[],
  db: Db = getCustomerDb(),
): Promise<void> {
  await db.transaction(async () => {
    await db.prepare(`DELETE FROM facts WHERE record_id = ?`).run(recordId);
    for (const f of facts) {
      await db
        .prepare(
          `INSERT INTO facts (fact_id, record_id, block_id, kind, subject, value, char_start, char_end)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(fact_id) DO UPDATE SET
             value = excluded.value, subject = excluded.subject`,
        )
        .run(f.factId, f.recordId, f.blockId, f.kind, f.subject, f.value, f.charStart, f.charEnd);
    }
  })();
}

export async function loadFacts(recordIds: string[], db: Db = getCustomerDb()): Promise<Fact[]> {
  if (recordIds.length === 0) return [];
  const placeholders = recordIds.map(() => "?").join(",");
  const rows = await db
    .prepare(`SELECT * FROM facts WHERE record_id IN (${placeholders}) ORDER BY record_id, kind`)
    .all<Record<string, unknown>>(...recordIds);

  return rows.map((r) => ({
    factId: r["fact_id"] as string,
    recordId: r["record_id"] as string,
    blockId: r["block_id"] as string,
    kind: r["kind"] as string,
    subject: r["subject"] as string,
    value: r["value"] as string,
    charStart: r["char_start"] as number,
    charEnd: r["char_end"] as number,
  }));
}
