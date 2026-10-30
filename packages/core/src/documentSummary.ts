import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { getCustomerDb, type Db } from "./db/index.js";
import { loadFindings } from "./store.js";
import type { Coverage, Finding, RecordDoc, Severity } from "./types.js";

/**
 * Plain-language summaries for a reviewer who has not read the document yet.
 *
 * Built from discovery feedback: the findings list is accurate but hard to read
 * as a whole — twelve flags do not say which three matter, or whether the
 * document does its job. Two summaries answer that:
 *
 *   - a DESCRIPTION of each document (what it is, what it is for), shown on
 *     the run page so a reviewer can choose what to review, and on the
 *     findings page as context;
 *   - a RUN SUMMARY: the biggest issues this review found, and whether the
 *     document, as reviewed, appears to serve its purpose.
 *
 * Neither is a finding. They carry no severity, anchor to no text, and are
 * never stored in `findings`. The run summary is held to the findings it
 * summarises the same way findings are held to the document:
 *
 *   - every issue must cite at least one real finding from this run, or it is
 *     dropped — a summary may compress the evidence, never add to it;
 *   - the purpose answer is a fixed four-level scale with deterministic caps:
 *     it cannot read "does its job" while a high-severity finding is open, or
 *     while part of the document was never read (coverage), or when the run was
 *     the offline keyword baseline. A model can lower the answer, never raise
 *     it past those caps — the same shape as SCORE_FLOORS in the change ledger.
 *
 * And it is worded as a reading of the review, not a determination: never
 * "compliant", "ready for inspection" or "audit-ready". Whether the document is
 * acceptable is the manufacturer's call, as everywhere else in this product.
 */

/** Text sent per summary. Enough for any CAPA or FMEA; the limit is stated to the model. */
const MAX_DOCUMENT_CHARS = 60_000;

const PURPOSE_LEVELS = ["supports", "partly", "does_not", "cannot_tell"] as const;
export type PurposeLevel = (typeof PURPOSE_LEVELS)[number];

export interface DocumentDescription {
  /** Short kind label, e.g. "Design FMEA", "CAPA record". */
  label: string;
  /** One or two sentences: what the document is and what it is for. */
  summary: string;
  /** The record's text hash when written; a replaced file makes it stale. */
  sha256: string;
  model: string;
  createdAt: string;
}

export interface SummaryIssue {
  headline: string;
  /** Why it matters, in a sentence or two. */
  why: string;
  /** Findings this issue rests on — always at least one, all from this run. */
  findingIds: string[];
}

export interface RunSummary {
  issues: SummaryIssue[];
  purpose: PurposeLevel;
  purposeReason: string;
  /** Set when a deterministic cap lowered the model's answer, saying which. */
  purposeCappedBy: string | null;
  /** Hash of the findings it was written from (ids + statuses); stale when it changes. */
  basis: string;
  model: string;
  createdAt: string;
}

function documentExcerpt(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DOCUMENT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_DOCUMENT_CHARS), truncated: true };
}

function hasCredential(): boolean {
  return Boolean(process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"]);
}

function client(): Anthropic {
  return new Anthropic({ maxRetries: 4, timeout: 5 * 60 * 1000 });
}

function textOf(response: Anthropic.Message): string {
  if (response.stop_reason === "refusal") throw new Error("the model declined to summarise this document");
  const block = response.content.find((c) => c.type === "text");
  if (!block || block.type !== "text") throw new Error("summary returned no text content");
  return block.text;
}

// ---------------------------------------------------------------------------
// Document description
// ---------------------------------------------------------------------------

const DESCRIPTION_SCHEMA = {
  type: "object",
  properties: {
    label: {
      type: "string",
      description: 'What kind of document this is, in 2-5 words, e.g. "Design FMEA", "CAPA record", "Complaint handling procedure".',
    },
    summary: {
      type: "string",
      description:
        "One or two plain sentences: what this specific document is about and what job it does in the quality system. Under 45 words.",
    },
  },
  required: ["label", "summary"],
  additionalProperties: false,
} as const;

const DESCRIPTION_SYSTEM = `
You describe medical-device quality documents for a reviewer who has not opened them.

Say what kind of document it is and what it is for, using its own specifics (the
device, the problem, the scope) — for example "CAPA record for intermittent
display blanking on the SP-200 syringe pump; documents the investigation, root
cause and corrective actions."

Describe; do not evaluate. Do not say whether the document is complete, correct,
adequate or compliant — another step reviews that. Plain words, no marketing.
`.trim();

/**
 * Describe one document. Written with low effort: it is a short read of the
 * opening of a document, shown as a label, and runs once per upload.
 */
export async function describeDocument(record: RecordDoc): Promise<DocumentDescription> {
  const excerpt = documentExcerpt(record.normalizedText);
  const response = await client().messages.create({
    model: config.model,
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: DESCRIPTION_SCHEMA },
    },
    system: [{ type: "text", text: DESCRIPTION_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content:
          `Filename: ${record.filename}\nRecord type as filed: ${record.recordType}\n` +
          (excerpt.truncated ? `(Only the first ${MAX_DOCUMENT_CHARS} characters are shown.)\n` : "") +
          `\n<document>\n${excerpt.text}\n</document>`,
      },
    ],
  });
  const parsed = JSON.parse(textOf(response)) as { label: string; summary: string };
  return {
    label: parsed.label.trim().slice(0, 60),
    summary: parsed.summary.trim(),
    sha256: record.sha256,
    model: config.model,
    createdAt: new Date().toISOString(),
  };
}

/** The stored description, if it was written for the record's current text. */
export async function getDescription(recordId: string, db: Db = getCustomerDb()): Promise<DocumentDescription | null> {
  const row = await db
    .prepare(`SELECT sha256, description FROM records WHERE record_id = ?`)
    .get<{ sha256: string; description: string | null }>(recordId);
  if (!row?.description) return null;
  const d = JSON.parse(row.description) as DocumentDescription;
  return d.sha256 === row.sha256 ? d : null;
}

async function loadRecordForSummary(recordId: string, db: Db): Promise<RecordDoc & { coverage: Coverage | null }> {
  const row = await db
    .prepare(
      `SELECT record_id, filename, stored_path, sha256, record_type, doc_id, revision,
              normalized_text, created_at, coverage
         FROM records WHERE record_id = ?`,
    )
    .get<Record<string, string | null>>(recordId);
  if (!row) throw new Error(`record not found: ${recordId}`);
  return {
    recordId: row["record_id"]!,
    filename: row["filename"]!,
    storedPath: row["stored_path"]!,
    sha256: row["sha256"]!,
    recordType: row["record_type"] as RecordDoc["recordType"],
    docId: row["doc_id"] ?? null,
    revision: row["revision"] ?? null,
    normalizedText: row["normalized_text"]!,
    createdAt: row["created_at"]!,
    coverage: row["coverage"] ? (JSON.parse(row["coverage"]) as Coverage) : null,
  };
}

/** Write and store a description for one record, unless a current one exists. */
export async function ensureDescription(recordId: string, db: Db = getCustomerDb()): Promise<DocumentDescription> {
  const existing = await getDescription(recordId, db);
  if (existing) return existing;
  const record = await loadRecordForSummary(recordId, db);
  const description = await describeDocument(record);
  await db
    .prepare(`UPDATE records SET description = ? WHERE record_id = ? AND sha256 = ?`)
    .run(JSON.stringify(description), recordId, description.sha256);
  return description;
}

/** Records with no description for their current text. */
export async function recordsNeedingDescription(db: Db = getCustomerDb()): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT record_id, sha256, description FROM records ORDER BY created_at`)
    .all<{ record_id: string; sha256: string; description: string | null }>();
  return rows
    .filter((r) => !r.description || (JSON.parse(r.description) as DocumentDescription).sha256 !== r.sha256)
    .map((r) => r.record_id);
}

export { hasCredential as summariesAvailable };

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      description: "The biggest problems this review found, most important first. At most 3; fewer if fewer matter.",
      items: {
        type: "object",
        properties: {
          headline: { type: "string", description: "The problem in under 15 plain words." },
          why: {
            type: "string",
            description: "One or two sentences: what is wrong and why it matters for this document's job.",
          },
          findingIds: {
            type: "array",
            items: { type: "string" },
            description: "IDs of the findings (from the list given) that this issue summarises. At least one.",
          },
        },
        required: ["headline", "why", "findingIds"],
        additionalProperties: false,
      },
    },
    purpose: {
      type: "string",
      enum: [...PURPOSE_LEVELS],
      description:
        "Based on this review's findings, does the document do the job described? supports = no significant gaps found; " +
        "partly = does its job but with significant gaps; does_not = gaps defeat its main purpose; " +
        "cannot_tell = the review cannot support an answer.",
    },
    purposeReason: {
      type: "string",
      description: "One or two sentences explaining the answer, grounded in the findings.",
    },
  },
  required: ["issues", "purpose", "purposeReason"],
  additionalProperties: false,
} as const;

const SUMMARY_SYSTEM = `
You summarise the results of an automated pre-inspection review of a medical-device
quality document, for a quality reviewer who finds a long list of findings hard to
interpret.

You are given the document, what it is for, what the review could and could not
read, and the review's findings. Produce:

1. The biggest issues — at most three — merging findings that are really one
   problem. Rank by how much each undermines what the document is for, not by
   count. Every issue must cite the IDs of the findings it rests on. Do not add
   problems that no finding raises: you summarise the review, you do not extend it.

2. Whether the document, as reviewed, appears to do its job, on the fixed scale.
   Judge against the document's own purpose (a CAPA must establish a root cause
   and show the action addressed it; an FMEA must identify and rate failure modes
   and control the unacceptable ones; and so on).

Rules:
  - This is a reading of the review for a human, not a determination. Never say
    the document is compliant, acceptable, approved, audit-ready or ready for
    inspection, and never say it is not. Whether it is acceptable is the
    manufacturer's decision.
  - No findings does not mean no problems: if parts of the document were not read,
    or the review was narrow, say what that limits.
  - Plain language. Name the specifics (failure mode, action, figure) rather than
    rule numbers.
`.trim();

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/**
 * What the findings were when a summary was written. Rejected findings are
 * left out of the summary (a reviewer dismissed them), so rejecting or
 * restoring one makes the summary stale.
 */
function findingsBasis(findings: Finding[]): string {
  const parts = findings.map((f) => `${f.findingId}:${f.status === "rejected" ? "x" : "o"}`).sort();
  return createHash("sha256").update(parts.join(",")).digest("hex").slice(0, 16);
}

const LEVEL_ORDER: PurposeLevel[] = ["supports", "partly", "does_not"];

/**
 * The deterministic caps on the purpose answer. Returns the highest level the
 * evidence allows, with the reason, or null when nothing caps it.
 */
function purposeCap(args: {
  findings: Finding[];
  coverage: Coverage | null;
  offline: boolean;
}): { level: PurposeLevel; reason: string } | null {
  if (args.offline) {
    return { level: "cannot_tell", reason: "this run was the offline keyword baseline, not a model review" };
  }
  if (args.coverage?.status === "unreadable") {
    return { level: "cannot_tell", reason: "almost no text could be read from the document" };
  }
  if (args.findings.some((f) => f.severity === "high" && f.status !== "rejected")) {
    return { level: "partly", reason: "a high-severity finding is still open" };
  }
  if (args.coverage?.status === "partial") {
    return { level: "partly", reason: "part of the document could not be read" };
  }
  return null;
}

function applyCap(answer: PurposeLevel, cap: { level: PurposeLevel } | null): PurposeLevel {
  if (!cap) return answer;
  if (cap.level === "cannot_tell") return "cannot_tell";
  if (answer === "cannot_tell") return answer;
  // Higher index = worse; the answer can only move toward worse.
  return LEVEL_ORDER.indexOf(answer) < LEVEL_ORDER.indexOf(cap.level) ? cap.level : answer;
}

/** Without a model (offline run, or no credential): the top findings, verbatim. */
function deterministicSummary(findings: Finding[], basis: string, reason: string): RunSummary {
  const top = [...findings]
    .filter((f) => f.status !== "rejected")
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, 3);
  return {
    issues: top.map((f) => ({ headline: f.problem.split(/(?<=\.)\s/)[0] ?? f.problem, why: f.rationale, findingIds: [f.findingId] })),
    purpose: "cannot_tell",
    purposeReason:
      top.length > 0
        ? `Not assessed: ${reason}. Listed below are the most severe findings, as written.`
        : `Not assessed: ${reason}.`,
    purposeCappedBy: reason,
    basis,
    model: "none",
    createdAt: new Date().toISOString(),
  };
}

function formatFindings(findings: Finding[]): string {
  return findings
    .map(
      (f) =>
        `- id: ${f.findingId}\n  severity: ${f.severity}; category: ${f.category}; citation: ${f.citation}` +
        (f.status !== "open" ? `; reviewer marked: ${f.status}` : "") +
        `\n  quote: "${f.quote.replace(/\s+/g, " ").slice(0, 240)}"\n  problem: ${f.problem}\n  why: ${f.rationale}`,
    )
    .join("\n");
}

function formatCoverage(coverage: Coverage | null): string {
  if (!coverage) return "Coverage was not recorded for this document.";
  const gaps = coverage.gaps.filter((g) => g.level === "gap");
  return (
    `Read status: ${coverage.status}.` +
    (gaps.length > 0
      ? ` Not read: ${gaps.map((g) => (g.where ? `${g.where} — ${g.detail}` : g.detail)).join(" ")}`
      : "")
  );
}

export async function summarizeRun(runId: string, db: Db = getCustomerDb()): Promise<RunSummary> {
  const run = await db
    .prepare(`SELECT run_id, record_id, model, status FROM runs WHERE run_id = ?`)
    .get<{ run_id: string; record_id: string; model: string; status: string }>(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  if (run.status !== "complete") throw new Error("this run did not complete, so there is nothing to summarise");

  const findings = await loadFindings(runId, db);
  const basis = findingsBasis(findings);
  const record = await loadRecordForSummary(run.record_id, db);
  const offline = run.model.startsWith("keyword-");
  const considered = findings.filter((f) => f.status !== "rejected");

  if (offline) return deterministicSummary(findings, basis, "this run was the offline keyword baseline");
  if (!hasCredential()) return deterministicSummary(findings, basis, "no model credential is configured on the server");

  const description = await ensureDescription(record.recordId, db).catch(() => null);
  const excerpt = documentExcerpt(record.normalizedText);

  const response = await client().messages.create({
    model: config.model,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: SUMMARY_SCHEMA },
    },
    system: [{ type: "text", text: SUMMARY_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content:
          `Document: ${record.docId ?? record.filename} (${record.recordType})\n` +
          (description ? `What it is: ${description.label} — ${description.summary}\n` : "") +
          `${formatCoverage(record.coverage)}\n` +
          (excerpt.truncated ? `(Only the first ${MAX_DOCUMENT_CHARS} characters of the document are shown.)\n` : "") +
          `\n<document>\n${excerpt.text}\n</document>\n\n` +
          (considered.length > 0
            ? `<findings count="${considered.length}">\n${formatFindings(considered)}\n</findings>`
            : `<findings count="0">This review produced no findings (or the reviewer rejected all of them).</findings>`),
      },
    ],
  });

  const parsed = JSON.parse(textOf(response)) as {
    issues: SummaryIssue[];
    purpose: PurposeLevel;
    purposeReason: string;
  };

  // The grounding guard: an issue survives only with at least one real,
  // un-rejected finding behind it, and only the real ids are kept.
  const valid = new Set(considered.map((f) => f.findingId));
  const issues = parsed.issues
    .map((i) => ({ ...i, findingIds: i.findingIds.filter((id) => valid.has(id)) }))
    .filter((i) => i.findingIds.length > 0)
    .slice(0, 3);

  const answer = PURPOSE_LEVELS.includes(parsed.purpose) ? parsed.purpose : "cannot_tell";
  const cap = purposeCap({ findings, coverage: record.coverage, offline });
  const purpose = applyCap(answer, cap);

  return {
    issues,
    purpose,
    purposeReason: parsed.purposeReason.trim(),
    purposeCappedBy: purpose !== answer && cap ? cap.reason : null,
    basis,
    model: config.model,
    createdAt: new Date().toISOString(),
  };
}

/**
 * The run's summary: the stored one if its findings haven't changed since, else
 * a fresh one (stored). Concurrent callers for the same run share one request.
 */
const inFlight = new Map<string, Promise<RunSummary>>();

export async function getRunSummary(runId: string, db: Db = getCustomerDb()): Promise<RunSummary> {
  const row = await db
    .prepare(`SELECT summary FROM runs WHERE run_id = ?`)
    .get<{ summary: string | null }>(runId);
  if (row?.summary) {
    const stored = JSON.parse(row.summary) as RunSummary;
    if (stored.basis === findingsBasis(await loadFindings(runId, db))) return stored;
  }

  const pending = inFlight.get(runId);
  if (pending) return pending;
  const work = (async () => {
    const summary = await summarizeRun(runId, db);
    await db.prepare(`UPDATE runs SET summary = ? WHERE run_id = ?`).run(JSON.stringify(summary), runId);
    return summary;
  })().finally(() => inFlight.delete(runId));
  inFlight.set(runId, work);
  return work;
}
