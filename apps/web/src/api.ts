export type Severity = "high" | "medium" | "low";
export type FindingStatus = "open" | "accepted" | "rejected";
export type Confidence = "high" | "medium" | "low";

// --- Cumulative change ledger ---
export type ChangeType =
  | "software"
  | "labeling"
  | "material"
  | "component"
  | "geometry"
  | "performance_spec"
  | "risk_control"
  | "manufacturing_process"
  | "other";
export type Determination = "undecided" | "letter_to_file" | "new_submission";

export type Stage =
  | "proposed"
  | "implemented"
  | "documented"
  | "in_submission"
  | "cleared"
  | "superseded";

export type SubmissionKind =
  | "special_510k"
  | "traditional_510k"
  | "abbreviated_510k"
  | "letter_to_file"
  | "pma_supplement"
  | "other";

export type SubmissionStatus = "planned" | "filed" | "additional_info" | "cleared" | "withdrawn";

export interface Submission {
  submissionId: string;
  baselineId: string;
  title: string;
  kind: SubmissionKind;
  status: SubmissionStatus;
  filedAt: string | null;
  decisionAt: string | null;
  clearanceId: string | null;
  note: string | null;
  createdAt: string;
}

export interface Baseline {
  baselineId: string;
  device: string;
  clearanceId: string;
  clearedAt: string | null;
  configuration: Record<string, string>;
  note: string | null;
  /** The customer's own escalation threshold, from their change-control SOP. */
  threshold: number;
  thresholdSource: string | null;
  supersededBy: string | null;
  createdAt: string;
}

export interface ImplicatedBranch {
  chart: "main" | "software";
  step: string;
  consider: string;
}

export type ScoreSource = "confirmed" | "confirmed_below_floor" | "suggested" | "floor";

/**
 * The score that actually counts, and where it came from.
 *
 * `source` is the part the UI must never drop: a number a reviewer confirmed
 * and a number a model guessed look identical once they are summed, and the
 * whole credibility of the total rests on being able to tell them apart.
 */
export interface EffectiveScore {
  value: number;
  source: ScoreSource;
  floor: number;
  floorReason: string;
  clampedByFloor: boolean;
  belowFloorRationale: string | null;
}

export interface Change {
  changeId: string;
  baselineId: string;
  proposal: string;
  comparator: string | null;
  changeType: ChangeType;
  subsystem: string | null;
  determination: Determination;
  stage: Stage;
  recordId: string | null;
  changedAt: string | null;
  createdAt: string;
  score: number | null;
  suggestedScore: number | null;
  suggestedRationale: string | null;
  suggestedAt: string | null;
  scoredBy: string | null;
  scoredAt: string | null;
  belowFloorRationale: string | null;
  implementedAt: string | null;
  documentedAt: string | null;
  documentedBy: string | null;
  submissionId: string | null;
  /** Attached by the assessment endpoint: branches to consider for this type. */
  branches?: ImplicatedBranch[];
  /** Attached by the assessment endpoint: the resolved score and its provenance. */
  effective?: EffectiveScore;
}

export interface ChangeGap {
  gapId: string;
  changeId: string;
  origin: "deterministic" | "inferred";
  kind: string;
  detail: string;
  status: "open" | "accepted" | "dismissed";
}

export interface SubsystemCluster {
  subsystem: string;
  changeIds: string[];
  count: number;
}

export interface RiskPools {
  undocumented: number;
  unsubmitted: number;
  exposure: number;
  pipeline: number;
  projected: number;
  inSubmission: number;
  unconfirmed: number;
}

/**
 * The escalation signal. Note what it is not: a statement that a submission is
 * required. It reports the customer's own procedural threshold and whether
 * accumulated risk has passed it — the determination stays with the human.
 */
export interface Escalation {
  crossed: boolean;
  exposure: number;
  threshold: number;
  thresholdSource: string | null;
  headroom: number;
  projectedCrosses: boolean;
  undecided: number;
  message: string;
}

export interface CumulativeAssessment {
  baseline: Baseline;
  totalChanges: number;
  clusters: SubsystemCluster[];
  typesPresent: ChangeType[];
  gaps: ChangeGap[];
  undecided: number;
  pools: RiskPools;
  escalation: Escalation;
  stageCounts: Record<Stage, number>;
  submissions: Submission[];
  changes: Change[];
}

// --- Cross-document graph ---
export type EdgeKind =
  | "references"
  | "governed_by"
  | "supersedes"
  | "modifies"
  | "verifies"
  | "implements"
  | "escalates_to"
  | "captured_by"
  | "submitted_in";

/** How an edge is drawn — seven kinds collapse to three the eye can hold. */
export type DrawKind = "derives" | "governs" | "broken";

export type Lane = "cleared" | "trigger" | "proposition" | "change_doc" | "submission";

export const LANE_ORDER: Lane[] = [
  "cleared",
  "trigger",
  "proposition",
  "change_doc",
  "submission",
];

export const LANE_LABEL: Record<Lane, string> = {
  cleared: "Cleared record",
  trigger: "Triggers",
  proposition: "Propositions",
  change_doc: "Change documents",
  submission: "Submissions",
};

/**
 * `proposed` is a document a change owes and has not produced. It is not a
 * document: no id, no findings, no severity. Never render it as one.
 */
export type NodeKind = "document" | "change" | "proposed" | "submission";

export interface NodeRisk {
  changeId: string;
  score: number;
  scoreSource: ScoreSource;
  stage: Stage;
  gapCount: number;
  gapKinds: string[];
  daysUndocumented: number | null;
}

export interface GraphNode {
  nodeId: string;
  kind: NodeKind;
  lane: Lane;
  recordId: string | null;
  changeId: string | null;
  docId: string | null;
  label: string;
  sublabel: string;
  worstSeverity: "high" | "medium" | "low" | null;
  findingCount: number;
  risk: NodeRisk | null;
}

export interface GraphEdge {
  edgeId: string;
  srcNodeId: string;
  dstRef: string;
  dstNodeId: string | null;
  kind: EdgeKind;
  drawKind: DrawKind;
  quote: string;
  charStart: number;
  charEnd: number;
}

/** Accumulated risk for the map header — the change ledger's totals. */
export interface GraphRisk {
  device: string;
  clearanceId: string;
  exposure: number;
  threshold: number;
  thresholdSource: string | null;
  crossed: boolean;
  undocumented: number;
  unsubmitted: number;
  owedDocuments: number;
}

export type GraphIssueKind =
  | "broken_reference"
  | "owed_document"
  | "orphan"
  | "unreviewed"
  | "stale_review";

export const GRAPH_ISSUE_LABEL: Record<GraphIssueKind, string> = {
  broken_reference: "Cites a document not held",
  owed_document: "Document owed, not written",
  orphan: "Not referenced by anything",
  unreviewed: "Never reviewed",
  stale_review: "Reviewed under an older corpus",
};

/** A problem with the record itself, as opposed to a finding inside a document. */
export interface GraphIssue {
  kind: GraphIssueKind;
  nodeId: string;
  label: string;
  detail: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  danglingRefs: { srcNodeId: string; dstRef: string }[];
  issues: GraphIssue[];
  risk: GraphRisk | null;
}

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
  /**
   * The change this document captures, if any. The join has always existed on
   * `changes.record_id`; surfacing it is what lets a reviewer reading a finding
   * on a change order reach the change and its accumulated risk.
   */
  capturedChange: { changeId: string; proposal: string; stage: string } | null;
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

// The API is a separately deployed origin now (see apps/server), so every
// request needs an absolute URL and `credentials: "include"` — without the
// latter the browser will not attach the session cookie to a cross-origin
// request at all, and the API will see every call as logged out.
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  // 204 No Content has no body.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Thrown when the API rejects a request as unauthenticated — the caller
 *  should send the user back to the login screen rather than show this as a
 *  generic error. */
export class AuthError extends Error {
  constructor() {
    super("not signed in");
  }
}

export interface UploadResult {
  recordId: string;
  filename: string;
  recordType: string;
  /** Parsed out of the document text, so null when no id could be matched. */
  docId: string | null;
  revision: string | null;
  format: string;
  pageCount: number | null;
  blocks: number;
  warning: string | null;
}

/**
 * The replace endpoint's response: an upload, plus what replacing cost.
 *
 * Replacing a document re-blocks it, and findings anchored to character offsets
 * in the old text cannot survive that — so they are discarded. The count is
 * reported rather than swallowed because a reviewer who has just lost twelve
 * findings needs to be told, and it is the one thing this response carries that
 * a first-time upload cannot.
 */
export interface ReplaceResult extends UploadResult {
  discardedFindings: number;
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
  me: () => json<{ username: string }>("/api/me"),
  login: (username: string, password: string) =>
    json<{ ok: true; username: string }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => json<{ ok: true }>("/api/logout", { method: "POST" }),

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
    const res = await fetch(`${API_URL}/api/records`, {
      method: "POST",
      credentials: "include",
      body: form,
    });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    }
    return (await res.json()) as UploadResult;
  },

  /** Replace a document's file in place, keeping its record identity. */
  replaceRecord: async (recordId: string, file: File): Promise<ReplaceResult> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API_URL}/api/records/${recordId}/replace`, {
      method: "POST",
      credentials: "include",
      body: form,
    });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    }
    return (await res.json()) as ReplaceResult;
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

  // Cumulative change ledger. Note there is deliberately no method that returns
  // a submit / don't-submit determination — the tool never computes one.
  baselines: () => json<Baseline[]>("/api/baselines"),
  createBaseline: (body: {
    device: string;
    clearanceId: string;
    clearedAt?: string;
    note?: string;
    threshold?: number;
    thresholdSource?: string;
  }) => json<Baseline>("/api/baselines", { method: "POST", body: JSON.stringify(body) }),
  assessment: (baselineId: string) =>
    json<CumulativeAssessment>(`/api/baselines/${baselineId}/assessment`),
  setThreshold: (baselineId: string, threshold: number, thresholdSource: string | null) =>
    json<Baseline>(`/api/baselines/${baselineId}/threshold`, {
      method: "PATCH",
      body: JSON.stringify({ threshold, thresholdSource }),
    }),
  addChange: (
    baselineId: string,
    body: {
      proposal: string;
      comparator?: string;
      changeType?: ChangeType;
      subsystem?: string;
      stage?: Stage;
      changedAt?: string;
    },
  ) =>
    json<Change>(`/api/baselines/${baselineId}/changes`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  setDetermination: (changeId: string, determination: Determination) =>
    json<Change>(`/api/changes/${changeId}/determination`, {
      method: "PATCH",
      body: JSON.stringify({ determination }),
    }),

  /** Advance a change through the workflow. `documented` requires a recordId. */
  advanceStage: (changeId: string, stage: Stage, recordId?: string) =>
    json<Change>(`/api/changes/${changeId}/stage`, {
      method: "PATCH",
      body: JSON.stringify(recordId ? { stage, recordId } : { stage }),
    }),

  /** Ask the model for a score. Writes only the suggestion, never the score. */
  suggestScore: (changeId: string) =>
    json<{ change: Change; suggestion: { score: number; rationale: string; unknowns: string[] } }>(
      `/api/changes/${changeId}/suggest-score`,
      { method: "POST" },
    ),

  /** The human's score. `belowFloorRationale` is required to go under the floor. */
  setScore: (changeId: string, score: number, belowFloorRationale?: string) =>
    json<Change & { effective: EffectiveScore }>(`/api/changes/${changeId}/score`, {
      method: "PATCH",
      body: JSON.stringify(
        belowFloorRationale ? { score, belowFloorRationale } : { score },
      ),
    }),

  submissions: (baselineId: string) =>
    json<Submission[]>(`/api/baselines/${baselineId}/submissions`),
  createSubmission: (
    baselineId: string,
    body: { title: string; kind?: SubmissionKind; note?: string; changeIds?: string[] },
  ) =>
    json<Submission>(`/api/baselines/${baselineId}/submissions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  attachChanges: (submissionId: string, changeIds: string[]) =>
    json<{ attached: number }>(`/api/submissions/${submissionId}/changes`, {
      method: "POST",
      body: JSON.stringify({ changeIds }),
    }),
  setSubmissionStatus: (
    submissionId: string,
    body: {
      status: SubmissionStatus;
      filedAt?: string;
      clearanceId?: string;
      decisionAt?: string;
    },
  ) =>
    json<Submission | { submission: Submission; baseline: Baseline; retired: number }>(
      `/api/submissions/${submissionId}/status`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  // Cross-document reference map.
  graph: () => json<Graph>("/api/graph"),
};
