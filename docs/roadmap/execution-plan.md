# RegReview Execution Plan

## Where Ben's asks actually stand

Ben gave us three asks. They are not equal, and treating them as a menu of three features to build in parallel is the fastest way to burn a quarter we don't have.

**Ask 3 (continuous/cumulative risk) is the only one grounded in validated pain.** The catch-up-510(k) / letter-to-file-creep problem is real, enforcement-backed, and felt directly by a company like the Fresenius Kabi lead — a manufacturer with cleared devices and a change history. The research is unambiguous: no "catch-up" mechanism exists in regulation, change-management procedures ignore the sum of changes since clearance, and FDA's enforcement conclusions turn on *documentation quality*, which is exactly what RegReview already sells. This is the wedge.

**Ask 1 (spider map) is an aesthetic intuition, not a pain.** A visualization is a rendering of a graph, not the value; the value is absence findings ("which risk control is unverified"), which Ben did not ask for. The map is worth building *because feature 3 needs the underlying graph*, not for its own sake.

**Ask 2 (ingest online best practices) rests on a premise our own research demolishes:** publication is not dedication to the public domain, company documents are copyrighted, and there is no open industry best-practice corpus. The one salvageable piece — mining FDA warning-letter frequency — is real but belongs as narrow severity infrastructure for feature 3, not as a SOPs-adjacent UI tab.

**The single highest-value thing to build is not on Ben's list: the eval harness.** I'll defend that now, because everything else sequences off it.

## The eval-harness question, resolved

Build `runEval.ts` first. Not as a co-requisite, not "in parallel" — first.

The reasoning is not academic. Our README states precision is the entire asset: a false alarm costs credibility a missed finding does not. Today precision is unmeasured. The only quality signal is `runAgreement`, which measures self-consistency, and it sits at ~71% at the ruleLevel — roughly three findings in ten don't even reproduce run-to-run, before anyone asks whether they're *correct*. Every feature on Ben's list adds finding surface area (graph adds absence findings, cumulative-risk adds change-gap findings, public-corpus adds a fifth rule source into the compliance pass) and moves precision in a direction no one can currently see. Four independent designs each wrote "unmeasurable until the eval harness exists" in their risk sections. That is the same wall hit five times. Build the wall's door once.

The fixtures already exist in `packages/eval` (types.ts + two format CLIs); only `runEval.ts` is missing. This is a days-to-weeks task, not months, and it unlocks measured judgment on everything after it. **Phase 0, ~6–8 days.** Deliverable: a harness that runs the current review engine over labeled fixtures and reports precision/recall against expected findings, plus the existing ruleLevel agreement as a secondary signal. Demoable to Ben as "here is our actual accuracy number," which is itself a credibility asset in a fundraising conversation.

## Build order

Each phase is independently demoable and ordered so that value ships before infrastructure investment compounds.

**Phase 0 — Eval harness. ~7 days.** `runEval.ts` over existing fixtures. Precision/recall + agreement. Gate for every later finding-generating change.

**Phase 1 — Synthetic demo documents (Ask 4). ~5 days.** The critic is right that this is the most under-designed ask and the one most tied to survival — winning customer #2. Generate a coherent, cross-referencing set: an initial 510(k), a DHF with a traceability matrix, two CAPAs, an FMEA, and FDA correspondence, all sharing document IDs and containing *deliberate, known* inconsistencies and gaps. No new finding surface, no licensing landmine, no severity code. It doubles as labeled eval fixtures (feeding Phase 0) and as the demo corpus every later phase renders against. Build this second precisely because it is cheap and it makes every subsequent phase demoable on realistic data. Warning: synthetic FDA-correspondence language should be authored by us, not lifted from real warning letters verbatim into fixture prose we then ship as a template.

**Phase 2 — Cumulative Change Ledger, deterministic wedge (Ask 3, reshaped). ~12 days.** This is the reshaped version of Ben's ask, and the reshaping is the design. **Do not build the free-text "type a change, get a risk verdict" box Ben described.** The submit/don't-submit determination is the manufacturer's statutory responsibility (21 CFR 807.81(a)(3)), the guidance is nonbinding, and a wrong "no new 510(k) required" is the highest-liability output in this domain — and it is the exact auto-generate-and-trust pattern constraint 1 forbids.

Instead: two new first-class tables parallel to `records` — `baselines` (anchoring the last-cleared K-number, the GP7 "original device" comparator) and `changes` (durable rows: engineer's typed proposal, comparator field, change-type taxonomy, status, and a human-owned `determination` defaulting to *undecided*, never pre-filled). Then deterministic outputs only: the Appendix B comparison table assembled from confirmed facts; the GP7 wrong-comparator check (comparator is an internal revision, not the cleared K-number — deterministic and citable); the GP9 list of changes to describe in the next submission; and which flowchart branches (A/B/C/D, software Q1–Q4) are *implicated* by the change type, rendered as "branches to consider," never answered yes/no.

Ship a change-fact extraction pass (`extractChangeFacts`, a copy of `extractFacts` over the typed proposal). But **be honest about the anchoring guard here** — see the constraints section below. The demoable output: "14 letter-to-file changes against your 2023 clearance; 3 used an internal revision as comparator (GP7); 2 moved a risk acceptability category with no linked risk-file update; 6 are missing an Appendix B element." All code-computed, all citable, no verdict.

**Phase 3 — Graph backbone, deterministic edges + read-only map (Ask 1, minimal). ~9 days.** This is the shared infrastructure. Feature 3's *full* version (cumulative risk propagation across documents) and feature 1 (the map) both require the same thing: a typed edge model and stable document identity. Build it once, deterministic-first:

- `graph_nodes` (two-tier: documents = existing records; items = hazards, requirements, risk controls, etc.) and `graph_edges` with a typed `kind`, all in the customer DB (every edge embeds a customer quote, same reasoning that puts findings there).
- Deterministic extractors only in this phase: `references` (widen the doc-ID regex already at `extract/text.ts:118`), `contains`, `supersedes`, `governed_by`, `executes`, `modifies` (from an ECO's affected-documents table). 60–75% of edges in a company with functioning document control are deterministic and need no model call.
- The **target-as-written, resolved-separately** move: an edge stores the string the document wrote plus any parsed ID, and resolution to a concrete `dst_record_id` is a second deterministic indexed pass. This keeps the graph O(N), makes "cites a document we don't hold" itself a finding, and repairs dangling edges on re-upload without re-reading anything.
- Persist `findDiscrepancies()` output (today thrown away for non-participating clusters) into a `discrepancies` table — this gives the map real `conflicts_with` content on day one with zero new model cost.
- `GET /api/graph` read-only, ~30 lines. A lazy-loaded React Flow map view (code-split behind `React.lazy` so non-map users pay nothing on the ~181 kB bundle). Default to **problems-first**, not the whole graph.

**Phase 4 and beyond — gated on the harness.** Model-proposed edges (folded into the existing fact-extraction call, not a second pass, to avoid doubling per-doc cost), two-tier item expansion, and **absence findings** (orphan requirement, unverified control) come only after Phase 0's harness can measure their precision *and* a corpus-completeness gate is in place. Absence findings are the highest-value and highest-precision-risk output: a customer who uploads 40 of 400 documents makes everything look orphaned, producing exactly the false-alarm storm the README says destroys credibility. Do not ship these ungated. Cumulative risk *propagation* (Phase 4 of the cumulative design) rides on this same graph and sequences here too.

## The graph is the shared infrastructure — build it once

Two of Ben's three asks converge on one backbone. The spider map is a rendering of the graph; feature 3's cross-document cumulative risk is a traversal of it. Build `graph_nodes` / `graph_edges` / the resolution pass / stable document identity **once** (Phase 3), deterministic-first, and let both features read it. Do not build a separate "reference model" for the map and a separate "impact model" for cumulative risk. This is the single most important scope decision in the plan.

## Where the designs tension with the six constraints, and how each is resolved

1. **FLAG/EXPLAIN/SUGGEST, never auto-apply.** Feature 3's original free-text-verdict framing violates this outright. Resolved by making the regulatory determination a human input field, emitting only gaps and implicated branches, and never a submit/don't-submit string. Model-proposed graph edges are `status='proposed'`, rendered distinct, and require reviewer acceptance — the tool never writes the customer's traceability matrix.

2. **Verbatim-quote hallucination guard — honestly.** The cumulative design claims anchoring change-facts to the engineer's just-typed text preserves the guard. The critic is right: that's theater. A verbatim match against a sentence typed thirty seconds ago guards nothing — the guard's purpose is to point at controlled document text. Resolution: state plainly that change-fact anchoring is *provenance*, not the hallucination guard. The real grounding is **node-grounding** — a change must reference hazards/parts that exist in already-uploaded, already-anchored documents, or it becomes an absence finding. The model's "this implies a new hazard" inference is quarantined as an acceptance-gated consideration in a separate `change_gaps` table, never in `findings`, and cannot set a severity tier. The findings-table guard is never weakened because nothing unanchored enters it.

3. **Never ship ISO text.** Change-assessment rules cite `820.10(c)` / ISO 13485 7.3.9 and 14971 Clause 10 by clause ID plus our own prose. FDA 2017 guidance is public-domain and quotable; ISO is not. Note the citation rot: the 2017 guidances cite `820.30(i)`/`820.40`, which are [Reserved] as of 2026-02-02 — any rule citing them needs a dual citation or it's wrong in front of a customer.

4. **No OpenRegulatory / CC BY-NC-SA.** Untouched; flowchart logic is encoded from public-domain FDA guidance, and the matrix parser (if ever built) reads the customer's own matrix.

5. **Severity is derived.** The public-corpus "cap advisory rules at medium" branch is freehand selection with an audit string — the critic is right. Resolution: **do not add that branch.** Rules without citation frequency stay at the existing low floor unless `harm_linked`, exactly like every SOP rule today. If we want real severity for change rules, mine warning-letter frequency (genuine derivation) — later, as infrastructure, not a UI tab. Per-item change severity reuses `deriveSeverity` unchanged with inputs inherited from the baseline items a change perturbs.

6. **Consistency is a deterministic diff.** Preserved and extended: all deltas, GP4/GP7 checks, edge resolution, and cumulative aggregation are code over model-extracted primitives. The only model step remains per-document extraction. The cumulative aggregator emits counts and a max-tier, **never a composite risk number** — a single score would read as the forbidden verdict and has no defensible scale.

## What NOT to build

- **The free-text "evaluate my change's risk" oracle.** Highest-liability output in the domain; reshape to the deterministic ledger.
- **The public-best-practices UI tab, product-code rule expansion, and CI license-check machinery.** Premise is legally false; salvage only warning-letter frequency mining, later, as severity infra.
- **Absence findings, model edges, and cumulative propagation before the harness exists** and a corpus-completeness gate is in place.
- **Scale infrastructure** — pg_trgm blocking, Message Batches backfill, resolution-pass optimization for a 10k-document corpus. We have zero paying customers and no path to that corpus. Build for tens of documents; revisit at real scale.
- **A composite cumulative risk score.** Counts and max-tier only.

## Licensing landmines (concrete)

- **Warning letters:** the data.gov catalog tags them ODbL 1.0 (share-alike). FDA-authored letters are US-gov public domain under 17 U.S.C. §105 regardless, but get counsel sign-off before any warning-letter-derived rule ships to a paying customer. Do not ship in a phase that precedes that sign-off.
- **510(k) Summaries** (`cdrh_docs/pdfNN/K…`) are manufacturer-authored and copyrighted; FDA Decision Summaries (`cdrh_docs/reviews/K…`) are FDA-authored PD. Distinguish per document, not per URL. Extract facts only from the former (Feist), never prose.
- **openFDA UDI/GMDN content** carries a separate GMDN license for AI training — strip GMDN fields at the loader.
- **ISO/AAMI/IMDRF:** never embed. Clause IDs and our own prose only. AAMI's stated damages are $100k per offense.

## Team reality

Three people, one of them starting college, one warm lead, zero paying customers, no eval harness. This plan spends the first ~12 days on measurement and demo material (Phases 0–1) that directly serve fundraising and customer #2, then ~12 days on the one validated-pain feature (Phase 2), before touching the graph. That is roughly 33 days to a demoable cumulative-change ledger with measured accuracy — versus the ~100 design-days (200–300 real) the full roadmap implied. Hold the line on scope: ship the deterministic wedge of the one feature that maps to real pain, prove precision, and defer everything whose value is unmeasurable until the harness can grade it.