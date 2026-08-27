import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { SCORE_FLOORS, implicatedBranches, type Change, type ChangeType } from "./changeLedger.js";

/**
 * Model-suggested risk scoring for a proposed change.
 *
 * This module exists in tension with the rest of the product, and the tension is
 * deliberate rather than an oversight, so it is worth stating plainly.
 *
 * Everywhere else, a model output must quote verbatim text from a controlled
 * document or it is discarded. A change typed into a box has no such document:
 * there is nothing to quote, so the hallucination guard cannot protect this
 * output. Three constraints substitute for it:
 *
 *  1. **It writes only `suggested_score`.** `score` is human-only. A suggestion
 *     is visibly provisional everywhere it appears, and the ledger reports how
 *     much of the accumulated total rests on unconfirmed suggestions.
 *  2. **The deterministic floor clamps it.** A model will cheerfully rate a
 *     risk-control change a 3; the FDA change guidance presumes such a change
 *     significant. `effectiveScore` raises any suggestion to the type's floor,
 *     so the model can only ever argue a change is *worse* than its floor.
 *  3. **It never answers the flowchart.** The prompt forbids any statement about
 *     whether a submission is required. The score is an input to a human's
 *     determination, never a proxy for one.
 *
 * The scorer is also told to be concrete and to say what it does not know. A
 * rationale that names the specific unknown ("no indication whether the new
 * polymer contacts the fluid path") is worth more to a reviewer than a confident
 * number, because the reviewer's job here is to correct the number, not receive it.
 */

const SCORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "rationale", "unknowns"],
  properties: {
    // The structured-output schema rejects `minimum`/`maximum` on integers, so
    // the range lives in the description and is enforced by the clamp below —
    // which has to exist regardless, since a schema is not a guarantee.
    score: {
      type: "integer",
      description:
        "Risk of the change relative to the cleared device. An integer from 1 (trivial) to 10 (severe) inclusive.",
    },
    rationale: {
      type: "string",
      description:
        "Two or three sentences naming the specific mechanism of risk, in the reviewer's own domain terms. No regulatory conclusions.",
    },
    unknowns: {
      type: "array",
      items: { type: "string" },
      description:
        "Specific facts absent from the proposal that would move the score materially. Empty if none.",
    },
  },
} as const;

export interface SuggestedScore {
  score: number;
  rationale: string;
  unknowns: string[];
}

export interface ChangeScorerOptions {
  client?: Anthropic;
  model?: string;
  effort?: string;
}

function systemPrompt(): string {
  return [
    "You are assisting a medical device quality engineer who is scoring an engineering change",
    "against a cleared (510(k)) device configuration, so that changes can be accumulated and",
    "tracked. You assign a risk score from 1 to 10 and explain it.",
    "",
    "What the score means:",
    "  1-3   Trivial relative to the cleared device. No plausible path to affecting safety,",
    "        effectiveness, performance specifications, or the basis of the clearance.",
    "  4-6   Plausibly consequential. Touches performance, manufacturing, or labeling in a way",
    "        that existing verification may or may not still cover.",
    "  7-8   Likely consequential. Affects a risk control, body/fluid contact, a performance",
    "        specification, or an assumption the clearance rested on.",
    "  9-10  Severe. Introduces a new hazard, invalidates prior verification or validation, or",
    "        alters the device's indications or intended use.",
    "",
    "Rules you must follow:",
    "  - NEVER state or imply whether a new 510(k) or other submission is required, whether the",
    "    change is 'significant', or what the manufacturer should file. That determination is the",
    "    manufacturer's alone. You are scoring risk as an input to their decision, nothing more.",
    "  - Score the change as described. Do not invent device details, test results, materials,",
    "    or intended uses that the description does not contain. Where a material fact is missing,",
    "    put it in `unknowns` rather than assuming a value for it.",
    "  - The rationale must name a concrete mechanism ('a stiffer tubing durometer changes the",
    "    occlusion-detection pressure profile'), not a category ('this is a material change').",
    "  - Do not restate the proposal back. The reviewer wrote it.",
    "  - When the description is too thin to score confidently, score toward the middle and say",
    "    exactly what is missing. An honest 5 with named unknowns is more useful than a confident 8.",
  ].join("\n");
}

function userPrompt(
  change: Pick<Change, "proposal" | "changeType" | "subsystem" | "comparator">,
  device: string,
  clearanceId: string,
): string {
  const floor = SCORE_FLOORS[change.changeType];
  const branches = implicatedBranches(change.changeType);
  return [
    `Device: ${device}`,
    `Cleared configuration: ${clearanceId}`,
    `Change type: ${change.changeType}`,
    change.subsystem ? `Subsystem: ${change.subsystem}` : null,
    change.comparator ? `Compared by the engineer against: ${change.comparator}` : null,
    "",
    "Proposed change, as the engineer wrote it:",
    `"""`,
    change.proposal,
    `"""`,
    "",
    // The floor and branches go in as context, not as an instruction to comply.
    // Telling the model the floor makes its rationale engage with the presumption
    // rather than wander past it; the clamp is enforced in code either way.
    `For context, changes of this type carry a floor of ${floor.floor} in this ledger because: ${floor.reason}`,
    "",
    "Considerations the FDA change-decision flowcharts raise for this type of change (questions,",
    "not conclusions — do not answer them):",
    ...branches.map((b) => `  - [${b.chart}/${b.step}] ${b.consider}`),
    "",
    "Score the change and explain the mechanism.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/**
 * Ask the model to score one change.
 *
 * Returns the raw suggestion. The caller persists it via `saveSuggestedScore`,
 * which cannot write the human-owned `score` column, and `effectiveScore` clamps
 * it to the type's floor when the ledger totals are computed. Both of those are
 * the safety net; nothing here should be trusted on its own.
 */
export async function scoreChange(
  change: Pick<Change, "proposal" | "changeType" | "subsystem" | "comparator">,
  context: { device: string; clearanceId: string },
  options: ChangeScorerOptions = {},
): Promise<SuggestedScore> {
  const client =
    options.client ?? new Anthropic({ maxRetries: 8, timeout: 5 * 60 * 1000 });

  const response = await client.messages.create({
    model: options.model ?? config.model,
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    output_config: {
      // Scoring one short paragraph does not need the review engine's effort
      // level, and this call sits in an interactive path where a reviewer is
      // watching a spinner. Overridable for evaluation.
      effort: (options.effort ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max",
      format: { type: "json_schema", schema: SCORE_SCHEMA },
    },
    system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: userPrompt(change, context.device, context.clearanceId) },
    ],
  });

  const block = response.content.find((c) => c.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("scorer returned no text content");
  }
  const parsed = JSON.parse(block.text) as SuggestedScore;

  // Belt and braces around the schema: a score outside 1-10 would corrupt every
  // total downstream, and the column's CHECK constraint would reject it anyway.
  const score = Math.min(10, Math.max(1, Math.round(parsed.score)));
  return {
    score,
    rationale: parsed.rationale?.trim() || "No rationale returned.",
    unknowns: Array.isArray(parsed.unknowns) ? parsed.unknowns : [],
  };
}

/**
 * Fold the unknowns into the stored rationale.
 *
 * They are kept in the same string rather than a separate column because they
 * are only ever read by a human deciding whether to trust the number, and that
 * reader wants them adjacent to the reasoning, not in a second panel.
 */
export function formatRationale(s: SuggestedScore): string {
  if (s.unknowns.length === 0) return s.rationale;
  return `${s.rationale}\n\nWould change this score if known:\n${s.unknowns.map((u) => `• ${u}`).join("\n")}`;
}

/** Re-exported so callers can show the floor without importing the ledger. */
export function floorFor(type: ChangeType): { floor: number; reason: string } {
  return SCORE_FLOORS[type];
}
