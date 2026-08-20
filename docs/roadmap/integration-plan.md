# Integrating Changes and Map into one pipeline

A plan for making the five tabs behave as one product: a single spine, one
notion of "what's outstanding", and a way to see the evidence behind every
claim from anywhere in the app.

Written 2026-08-20. Companion to `execution-plan.md` (the Cass roadmap, now
built) and `SESSION-HANDOFF.md`.

---

## 1. Diagnosis

Five sibling tabs, each a terminal destination.

`ChangeLedger` and `GraphMap` are handed exactly one prop — `onAuthError`. They
cannot navigate anywhere, and nothing can navigate into them. That is the whole
integration problem in one line of `App.tsx`.

Underneath it are four structural facts:

**1. The spine does not exist in the data.** `records` has no device or project
column. `PROJECTS` in `App.tsx` is a hardcoded one-element array. `baselines.device`
is a free-text string. Every idea below that begins "scope this to a device"
is blocked on a schema change that does not exist yet. This is the prerequisite.

**2. There is no routing.** Navigation is `useState<Page>`. You cannot link to a
finding, a change, or a document. In a tool whose users email each other
evidence and paste it into audit responses, deep links are a feature, not a
nicety — and every cross-surface idea below silently assumes them.

**3. The joins already exist and are invisible.** `changes.record_id` links a
change to the controlled document that captures it — and that document has
findings, and those findings may be *about the very change*. Nothing surfaces
that. Graph nodes already carry `worstSeverity` and `findingCount`; both render
as dead text in a panel that cannot open them.

**4. There are four incompatible models of "a gap".**

| Source | Evidence standard | Severity? | Where it lives |
|---|---|---|---|
| `findings` | verbatim quote, hallucination-guarded | yes, derived | Findings tab |
| `change_gaps` | deterministic **or** model-inferred | never | Changes tab |
| `danglingRefs` | deterministic, computed on read | no | Map tab |
| coverage holes | not modelled at all | no | nowhere |

The product's entire promise is "find the gaps before FDA does". It currently
cannot answer *"what is outstanding on this device?"*, because the answer is
split four ways across three tabs and one place that doesn't exist.

That fourth row is the interesting one. Nothing today tells a reviewer that a
document has **never been reviewed**, or was reviewed under a superseded
`CORPUS_VERSION`, or that an implemented change has **no document at all**.
Those are gaps in the record of exactly the kind an investigator finds, and the
product is silent about them.

---

## 2. The reframe

Stop treating Changes and Map as *places*. They are **lenses on one object
graph**.

- The **objects** are documents and changes (plus submissions and runs).
- Findings, change gaps, dangling references and coverage holes are all
  **gaps** — one concept, observed at different evidence tiers.
- The **map** is not a destination. It is the *structure* lens over those
  objects.

Four moves follow:

1. **One spine** — the device. Everything filters by it.
2. **One gap ledger** — a read-model unioning all four sources, carrying an
   explicit evidence tier.
3. **One drawer** — a deep-linkable overlay that opens any object from anywhere.
4. **Every number is a link.**

---

## 3. The pipeline

This is what "seamless" has to mean concretely. Every object sits somewhere on
one line:

```
change occurs
  └─> captured in a controlled document
        └─> document reviewed against the corpus
              └─> findings triaged
                    └─> remediated
                          └─> change bundled into a submission
                                └─> cleared  ──> new baseline, accumulation resets
```

Transparency, stated precisely, is three questions answerable for any object:

- **Where is it** on that line?
- **What is blocking it** from moving?
- **What evidence** stands behind every claim the product is making about it?

The app can answer none of the three today without changing tabs and
reconciling by eye.

---

## 4. Architecture

### 4.1 The Gap read-model — the core of the plan

One typed union, computed server-side on read, never stored (storing it would
let it drift from its sources, the same reasoning that keeps deterministic
change gaps out of the database today):

```ts
type EvidenceTier =
  | "quoted"         // verbatim quote located in the document — findings only
  | "deterministic"  // computed by code: comparator, dangling ref, coverage
  | "inferred"       // model suggestion, unconfirmed, nothing to quote
  | "confirmed";     // a human signed it

interface Gap {
  gapId: string;
  deviceId: string;
  kind: "finding" | "change_gap" | "dangling_ref" | "coverage";
  stage: PipelineStage;                       // where on §3 it blocks
  subject: { type: "record" | "change" | "submission"; id: string; label: string };
  evidence: EvidenceTier;
  severity?: "high" | "medium" | "low";       // findings ONLY — see below
  detail: string;
  citation?: string;
  quote?: string;
}
```

**`evidence` is a safety mechanism, not a display hint.** Merging four gap
sources into one list is precisely how a model-inferred change gap ends up
looking as authoritative as a quote-anchored finding. So:

- the tier is **structural** — in the type, set at the source, not decided by
  the UI;
- `inferred` gaps **must never carry a severity**, matching the invariant
  `changeLedger.ts` and `customerSchema.sql` already enforce;
- the UI must render tiers visibly differently, not merely sort by them.

CLAUDE.md already protects this separation. The union must not launder it.

**New information this model surfaces** (the `coverage` kind, which exists
nowhere today):

- a document never reviewed;
- a document last reviewed under a superseded `CORPUS_VERSION` or
  `PROMPT_VERSION` — findings from different versions are explicitly *not
  comparable*, so this is a real staleness signal;
- an implemented change with no `record_id`;
- a document nothing cites and which cites nothing (an orphan in the graph).

### 4.2 The device spine

- `devices` table; `records.device_id`; `baselines.device_id`.
- Backfill one device (Northlake VP-400) and attach every existing record.
- The top-bar picker becomes real, and every read filters by it.

Note the subtlety: **device ≠ baseline.** A device accumulates successor
baselines as submissions clear (`clearSubmission` already mints them and links
`superseded_by`). The spine is the *device*; its current baseline is a property.

### 4.3 The universal object drawer

One overlay, deep-linkable, that opens for any object id:

```
#/device/:deviceId/record/:id
#/device/:deviceId/change/:id
#/device/:deviceId/finding/:runId/:id
#/device/:deviceId/submission/:id
```

Contents, in order: **identity → position in the pipeline → open gaps →
relationships (graph neighbourhood mini-map) → evidence chain → actions.**

This is the actual seamlessness mechanism. You never lose your place, and any
surface can link to any object without either surface knowing about the other.

### 4.4 The evidence chain — "how do we know this?"

Fully reconstructible from data already stored. Nothing new to persist:

**For a finding:** finding → rule → rule source (CFR paragraph / FDA guidance /
SOP clause) → severity basis (citation frequency, percentile, harm linkage) →
the run (model, effort, `corpus_version`, `prompt_version`) → the verbatim quote
→ the block → the document.

**For a change score:** type floor (and the flowchart branch it comes from) →
model suggestion + rationale → human confirmation (who, when) → below-floor
rationale if any → contribution to exposure → threshold and the SOP clause that
sets it.

This is the Fresenius ask — consistent, defensible, repeat-run output — rendered
as a screen. It is also the strongest demo artifact in the plan, because it is
the one thing no competitor's black box can show.

---

## 5. Navigation after

```
[Device ▾]   Readiness · Documents · Changes · Review · Procedures
                                                   (+ object drawer overlay)
```

- **Readiness** — new home. Pipeline stages with counts, the gap ledger, the
  accumulated-risk gauge, coverage statistics.
- **Documents** — the record list, plus a **Structure** lens (the map, as a view
  mode).
- **Changes** — the existing stage board and gauge, now cross-linked.
- **Review**, **Procedures** — unchanged.

### Why the map gets demoted

A 24-node graph is a demo. At ten thousand documents it is noise, and the
Fresenius pitch is explicitly "review everything, not a sample". The map's real
value is two things, and neither is a global canvas:

1. **the neighbourhood of one document** — what it cites, what cites it. That is
   a drawer feature.
2. **structural gaps** — dangling references and orphans. Those are gap-ledger
   rows.

As a tab it is decorative. As a lens plus a drawer mini-map it becomes
load-bearing, and it stops being a thing users must remember to visit.

---

## 6. Phases

| Phase | What | Est. | Gate |
|---|---|---|---|
| **0** | Substrate: hash routing + device spine (schema, backfill, real filtering) | ~3d | none |
| **1** | Make every number a link | ~2d | needs 0 |
| **2** | Gap read-model + `GET /api/devices/:id/gaps` | ~5d | **precision gate** |
| **3** | Readiness home | ~5d | needs 2 |
| **4** | Object drawer + evidence chain | ~6d | needs 0 |
| **5** | Map as lens; dangling refs/orphans into the gap ledger | ~3d | needs 2 |
| — | *Stretch:* point-in-time view | — | defer |

**Phase 0 is a true prerequisite.** Nothing composes without routing and a
device column.

**Phase 1 is the cheapest real win in this document.** Graph node "12 findings"
opens the findings. A change marked documented opens its document. A subsystem
cluster count opens the filtered list. No new concepts, no schema, immediate
payoff — worth doing on its own even if the rest slips.

**Phase 4 can run in parallel with 2/3.** The drawer needs only the spine and
routing; the evidence chain reads tables that already exist.

**Stretch — point in time.** Every timestamp needed already exists
(`runs`, `changes.implemented_at/documented_at`, `submissions.filed_at`,
`records.created_at`). "Show me what an investigator would have seen in March"
is a compelling story and a genuine audit capability. Defer until the spine and
the gap model are real, or it becomes a fifth incompatible view of the truth.

---

## 7. Risks, and things worth arguing about

**1. Do not build a single "readiness score."** It is the most tempting number
in this plan and it is the same class of error as the submit/don't-submit
verdict: one composite figure reads as a judgment about regulatory standing, and
the manufacturer's own staff will quote it to auditors. Use **counts per
pipeline stage**. If a headline number is wanted, make it an explicit coverage
fact — *"38 of 41 documents reviewed against corpus 2026.08.4"* — which is
checkable, not a grade.

**2. Do not flatten the evidence tiers.** See §4.1. This is the one change in
this plan that could quietly break a doctrine the codebase currently enforces in
three places.

**3. Precision is still unmeasured, and this plan multiplies finding surface.**
The top open item in `SESSION-HANDOFF.md` remains the exhaustive eval fixture
and the precision gate that depends on it. Recall is ~80%; precision is not
computed at all. Phases 0 and 1 add no new gap surface and are safe to do now.
**Phase 2 adds four new gap kinds at once** — shipping that before precision is
measurable means adding unmeasured noise to a surface whose entire credibility
is that it does not waste a reviewer's time. Build the fixture first.

**4. The graph stays computed on read** until a customer genuinely has thousands
of documents, per CLAUDE.md. Phase 5 must not quietly materialise edges to make
a lens feel faster.

**5. Deep links have an access-control edge.** A shareable `#/device/…/finding/…`
URL is only as safe as the session check behind it. Findings embed verbatim
customer quotes; the drawer must fetch through the authenticated API, never
render from a URL-encoded payload.

---

## 8. What this buys, in one sentence each

- A reviewer opens **one screen** and sees everything outstanding on a device,
  ranked, with the evidence tier of each item visible.
- Any number anywhere is a **link** to the thing it counts.
- Any object opens in the **same drawer**, from any surface, with a URL that can
  be pasted into an email.
- For any claim the product makes, there is a **chain** back to the regulation,
  the run that produced it, and the quoted text.
- The map stops being a curiosity and becomes the thing that explains **why a
  document matters** — what depends on it.
