# One pathway: change → document → review → map

A plan for making Changes, Documents, Review and Map behave as a single
pipeline, followed from the place work actually starts — an engineer typing
what they changed — to the place it becomes defensible: a map of the record
with its holes visible.

Written 2026-08-20. Supersedes the earlier draft of this file. Companion to
`execution-plan.md` and `SESSION-HANDOFF.md`.

---

## 1. The pathway

Everything below serves one line:

```
engineer records a change
  └─> a document-shaped hole appears in the record
        └─> someone attaches the document that captures it
              └─> the document is reviewed
                    └─> findings and reference problems surface on the map
                          └─> the change is bundled into a submission
                                └─> clearance folds it into the baseline
```

Six steps. Today the first lives in Changes, the third in Run a review, the
fourth in Findings, the fifth in Map, and **nothing carries you between them**.

The single idea that stitches them together is step two.

---

## 2. The idea: a proposed change is a document that does not exist yet

When an engineer records a change, the product already knows something
important and does nothing with it: **a controlled document is now owed.**

So the moment a change is recorded, it appears on the map as a **ghost node** —
dashed, in the change-documents lane, labelled with the proposal. It is a
placeholder for the document that must exist and does not.

That one move does four things at once:

- the map stops being a picture of what you have and becomes a picture of
  **what the record should contain**, which is the thing an investigator
  actually compares you against;
- the Changes tab and the Map tab are now the same object seen twice, so
  linking them is natural rather than bolted on;
- "attach a document" becomes a visible, satisfying state change — the ghost
  turns solid;
- the count of ghosts *is* the undocumented-exposure pool the gauge already
  totals, drawn instead of summed.

Nothing new needs storing. A ghost node is any change where
`stage IN ('proposed','implemented')` and `record_id IS NULL`.

---

## 3. The map, simplified

The current graph is a force-laid blob with **seven edge kinds**
(`references`, `governed_by`, `supersedes`, `modifies`, `verifies`,
`implements`, `escalates_to`). It is unreadable at 24 nodes and meaningless at
10,000.

Three changes fix it.

### 3.1 Lanes instead of a blob

Every node gets a lane from its role, and the flow runs top to bottom:

| Lane | Holds | Source |
|---|---|---|
| **Cleared record** | the design history as cleared — design inputs/outputs, risk file, V&V, traceability | `records` of design types |
| **Triggers** | why a change happened — CAPAs, complaints, NCRs, 483 observations | `records` of issue types |
| **Propositions** | changes since clearance, proposed and implemented | `changes` |
| **Change documents** | the DCOs and updated design docs that capture them — **plus the ghosts** | `records` via `changes.record_id`, ghosts where null |
| **Submission** | what has been bundled and filed | `submissions` |

Procedures (SOPs) are not a lane. They govern everything, so they sit in a
collapsed band and only draw a line when you select a node.

### 3.2 Deterministic layout

Lane by record type, order within lane by document date, no force simulation.

This matters more than it sounds. A graph that rearranges itself on every load
cannot be screenshotted into an audit response, and it quietly contradicts the
repeat-run consistency Fresenius asked for by name. **Same data, same picture.**
It is also far less code than a force layout.

### 3.3 Three line kinds, not seven

| Line | Means | Built from |
|---|---|---|
| **solid** | derives from — this exists because of that | `supersedes`, `modifies`, `implements`, `references` |
| **dotted** | governed by — a procedure constrains this | `governed_by` |
| **dashed red** | **broken** — the link does not resolve | dangling refs, ghost documents |

The seven kinds stay in the data (`graph.ts` already classifies them and the
drawer can show the specific verb). They collapse only for *drawing*, because
the eye can hold three line weights and cannot hold seven.

Edges run between adjacent lanes wherever possible, which is what makes the
picture read as a flow rather than a web.

---

## 4. Key issues in inter-document references

These are the things worth flagging, all computable, roughly in order of value:

**1. Missing document.** A change is implemented and no record captures it. The
ghost node. Already derivable, never surfaced.

**2. Dangling reference.** A document cites a document id we do not hold.
Already computed in `graph.ts` as `danglingRefs`; currently displayed as a
count in a corner of the Map and nowhere else.

**3. Stale companion.** A change document cites a governing document — the risk
file, the traceability matrix — whose own revision predates the change. The
change happened; the thing that should have been updated with it was not.

  *Caveat worth respecting:* `records.created_at` is upload time, not document
  date. Doing this honestly means using `records.revision` or an extracted
  document date, and saying "we could not determine a date" rather than
  inferring one from when a file happened to be uploaded. An upload-time
  heuristic here would produce confident nonsense.

**4. Orphan.** A document nothing cites and which cites nothing. Either it is
outside the design history or the references that should reach it are missing.

**5. Unreviewed / stale review.** A document with no run, or whose last run used
a superseded `CORPUS_VERSION` or `PROMPT_VERSION`. Findings across versions are
explicitly not comparable, so this is a real gap in coverage — and today nothing
says it out loud.

**6. Cluster with no aggregate assessment.** Several changes touching one
subsystem. Already computed as GP6 in `cumulativeAssessment`; belongs on the map
as a highlighted lane region, not only as a line of text in Changes.

Items 1–4 are *reference* problems and belong to the map. 5–6 are *coverage*
problems and belong wherever the pathway shows a step. All six should be the
same clickable object so a reviewer can work a single list.

---

## 5. What each surface becomes

**Changes** — unchanged in substance; gains an "open in map" and, once a
document is attached, a direct link to that document's findings.

**Run a review** — gains an entry point from a change: *review the document that
captures this change*, with cross-check pre-seeded to the documents that change
touches (its lane neighbours). This is the step that currently requires the user
to remember a filename.

**Findings** — gains the reverse link: *this document captures change X*, so a
reviewer reading a finding about a DCO can see which change it belongs to and
what that change's accumulated risk is.

**Map** — becomes the pathway's picture: lanes, ghosts, three line kinds, and
the six issues above rendered on the nodes they belong to.

**Readiness (new, small)** — not a dashboard. A short list: ghosts, dangling
refs, stale companions, unreviewed documents. The pathway's outstanding work in
one place, each row opening the object it names.

---

## 6. Phases

| Phase | What | Est. |
|---|---|---|
| **0** | Routing + device spine (schema, backfill, real filtering) | ~3d |
| **1** | Ghost nodes: derive them, draw them, link change ↔ node | ~3d |
| **2** | Lane layout + three line kinds, deterministic | ~4d |
| **3** | Pathway links: change → document → review → findings, both directions | ~3d |
| **4** | Reference issues 2–4 computed and drawn on nodes | ~4d |
| **5** | Coverage issues 5–6, and the small Readiness list | ~4d |

**Phase 0 is still a hard prerequisite.** `records` has no device column,
`PROJECTS` is a hardcoded one-element array, and navigation is `useState` with
no URLs — so nothing is linkable and nothing is scoped until this exists.

**Phases 1 and 2 are the demo.** Ghosts plus lanes turn the map from a curiosity
into the product's clearest single image: *here is your design history, and here
are the holes in it.* If only two phases ship, these are the two.

**Phase 3 is the seamlessness** the pathway is named for, and it is mostly
wiring — the joins already exist in the data.

---

## 7. Risks

**1. Ghost nodes must never be mistaken for documents.** A dashed placeholder
labelled with an engineer's free text sitting in a diagram of controlled
documents is exactly the kind of thing that gets screenshotted and misread. It
needs a permanent visual and textual distinction — not a colour alone — and it
must never carry a document id, a severity, or a finding count.

**2. The stale-companion check needs a real document date.** See §4.3. This is
the one item here that can produce confident nonsense from a plausible-looking
proxy.

**3. Precision is still unmeasured.** Recall is ~80%, precision is not computed,
and the exhaustive eval fixture remains the top open item in `SESSION-HANDOFF.md`.
Phases 0–3 add *navigation*, not new findings, and are safe now. Phases 4–5 add
new flag kinds — build the fixture first, or ship them behind a toggle and
measure before making them loud.

**4. Layout stays deterministic and computed on read.** No force simulation, no
materialised edges, until a customer genuinely has thousands of documents.
Both are cheap now and both are the kind of thing that gets "optimised" into
instability later.
