export type Severity = "high" | "medium" | "low";
export type FindingStatus = "open" | "accepted" | "rejected";
export type Confidence = "high" | "medium" | "low";

export interface SeverityBasis {
  citationFrequency: number;
  frequencyPercentile: number;
  harmLinked: boolean;
  harmRelevant: boolean;
  confidence: Confidence;
  reason: string;
}

export interface Finding {
  findingId: string;
  runId: string;
  recordId: string;
  blockId: string;
  charStart: number;
  charEnd: number;
  category: string;
  severity: Severity;
  severityBasis: SeverityBasis;
  ruleId: string;
  citation: string;
  quote: string;
  problem: string;
  rationale: string;
  suggestion: string;
  confidence: Confidence;
  status: FindingStatus;
  reviewerNote: string | null;
}

export interface RunSummary {
  runId: string;
  model: string;
  effort: string;
  promptVersion: string;
  corpusVersion: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  /** Why a failed run failed. Null on healthy runs. */
  error: string | null;
}

export interface RecordDetail {
  recordId: string;
  filename: string;
  recordType: string;
  docId: string | null;
  revision: string | null;
  normalizedText: string;
  blocks: { blockId: string; ordinal: number; charStart: number; charEnd: number; heading: string | null }[];
  runs: RunSummary[];
}

export interface RecordSummary {
  recordId: string;
  filename: string;
  recordType: string;
  docId: string | null;
  revision: string | null;
  runs: number;
  lastRunAt: string | null;
}

export interface Rule {
  ruleId: string;
  source: string;
  citation: string;
  title: string;
  expectation: string;
  harmLinked: boolean;
  citationFrequency: number;
  frequencyPercentile: number;
}

export interface CorpusRule extends Rule {
  appliesTo: string[];
}

export interface FindingEvent {
  event_id: number;
  event_type: string;
  actor: string;
  note: string | null;
  occurred_at: string;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  // 204 No Content has no body.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface UploadResult {
  recordId: string;
  filename: string;
  recordType: string;
  format: string;
  pageCount: number | null;
  blocks: number;
  warning: string | null;
}

/** One document's slot in a job. Always present; length 1 for a single review. */
export interface JobResult {
  recordId: string;
  filename: string;
  docId: string | null;
  status: "pending" | "running" | "complete" | "failed";
  stepsDone: number;
  stepsTotal: number;
  phase: string | null;
  runId?: string;
  findingCount?: number;
  error?: string;
}

export interface Job {
  jobId: string;
  recordId: string;
  status: "running" | "complete" | "failed";
  progress: string[];
  runId?: string;
  findingCount?: number;
  error?: string;
  results: JobResult[];
}

export interface SopSummary {
  sopDocumentId: string;
  filename: string;
  docId: string | null;
  revision: string | null;
  title: string | null;
  ruleCount: number;
  uploadedAt: string;
}

export interface SopDetail {
  sopDocumentId: string;
  filename: string;
  docId: string | null;
  revision: string | null;
  title: string | null;
  appliesTo: string[];
  normalizedText: string;
  clauses: { number: string; citation: string; heading: string; expectation: string }[];
}

export const api = {
  records: () => json<RecordSummary[]>("/api/records"),
  record: (recordId: string) => json<RecordDetail>(`/api/records/${recordId}`),
  findings: (runId: string) => json<Finding[]>(`/api/runs/${runId}/findings`),
  rule: (ruleId: string) => json<Rule>(`/api/rules/${ruleId}`),
  rules: () => json<CorpusRule[]>("/api/rules"),
  /** Every selectable rule, including the customer's own SOP clauses. */
  allRules: () => json<CorpusRule[]>("/api/rules?include=all"),
  events: (runId: string, findingId: string) =>
    json<FindingEvent[]>(`/api/runs/${runId}/findings/${findingId}/events`),
  setStatus: (runId: string, findingId: string, status: FindingStatus, note?: string) =>
    json<Finding>(`/api/runs/${runId}/findings/${findingId}`, {
      method: "PATCH",
      body: JSON.stringify({ status, note }),
    }),

  // Uploads use FormData, so they bypass the JSON helper's Content-Type.
  uploadRecord: async (file: File, recordType: string): Promise<UploadResult> => {
    const form = new FormData();
    form.append("recordType", recordType);
    form.append("file", file);
    const res = await fetch("/api/records", { method: "POST", body: form });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    }
    return (await res.json()) as UploadResult;
  },

  startReview: (
    recordId: string,
    opts: { related?: string[]; samples?: number; offline?: boolean; ruleIds?: string[] },
  ) =>
    json<{ jobId: string }>(`/api/records/${recordId}/review`, {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  /** Review many documents against one rule set — the standards-transition scan. */
  startBatchReview: (opts: {
    recordIds: string[];
    ruleIds?: string[];
    samples?: number;
    offline?: boolean;
    related?: string[];
    crossCheckSelected?: boolean;
  }) =>
    json<{ jobId: string; records: number }>("/api/reviews/batch", {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  job: (jobId: string) => json<Job>(`/api/jobs/${jobId}`),
  /** Every job the server knows about — lets a reloaded page re-attach. */
  jobs: () => json<Job[]>("/api/jobs"),

  /** Reclassify a document. Changes which rules apply; leaves past runs alone. */
  setRecordType: (recordId: string, recordType: string) =>
    json<{
      recordId: string;
      previousType: string;
      recordType: string;
      applicableRules: number;
      priorRuns: number;
    }>(`/api/records/${recordId}`, {
      method: "PATCH",
      body: JSON.stringify({ recordType }),
    }),

  /** Delete a document and everything derived from it. Destructive. */
  deleteRecord: (recordId: string) =>
    json<{ recordId: string; runs: number; findings: number }>(`/api/records/${recordId}`, {
      method: "DELETE",
    }),

  sops: () => json<SopSummary[]>("/api/sops"),
  sop: (sopId: string) => json<SopDetail>(`/api/sops/${sopId}`),
  createSopFromText: (filename: string, text: string, appliesTo: string[]) =>
    json<{ sopDocumentId: string; clauses: number }>("/api/sops", {
      method: "POST",
      body: JSON.stringify({ filename, text, appliesTo }),
    }),
  updateSop: (sopId: string, patch: { text?: string; appliesTo?: string[] }) =>
    json<{ sopDocumentId: string; clauses: number }>(`/api/sops/${sopId}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  deleteSop: (sopId: string) => json<void>(`/api/sops/${sopId}`, { method: "DELETE" }),
};
