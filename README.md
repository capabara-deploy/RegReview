# RegReview

AI pre-inspection review for FDA-regulated design and quality records.

Reads a medical device company's quality records and leaves cited, inline
comments where a document is out of step with FDA requirements, with the
company's own procedures, or with the company's other documents — so problems
get found before an FDA investigator finds them.

It **flags, explains, and suggests**. It does not draft documents and it does not
generate replacement text to paste in. A human verifies every output. That is a
product decision and a regulatory one: FDA's position on AI in this context is
that it is acceptable as long as a human verifies the result.

> **Positioning:** describe this as *pre-inspection review* or *gap analysis*.
> Not "audit," and not "independent auditor" — those words carry specific legal
> meaning in this industry, and claiming standing we don't have invites exactly
> the skepticism a quality audience is primed for. We are decision support for
> the customer's own staff.

Status: **early build.** Corpus and engine under construction; see the phase
checklist below.

## What it checks

| Category | Against |
|---|---|
| **Compliance** | FDA requirements — Part 820 / QMSR, incorporated standards, FDA guidance |
| **Conformance** | The company's own uploaded SOPs, which are treated as binding in an inspection |
| **Consistency** | The company's other documents — risk ratings, IDs, dates, terminology |
| **Completeness** | Loop closure: was every concern raised actually addressed and closed |
| **Plausibility** | Internal logic and scientific soundness — conclusions the data doesn't support |

Each finding carries a tiered risk level (high / medium / low), the requirement
it's asserted against, why it matters, and a direction for the fix.

Severity is **derived, not guessed** — from how often FDA has actually cited that
requirement and whether the record touches patient harm. See
`packages/core/src/severity.ts`; every finding stores the inputs behind its own
rating so the UI can explain it.

## Layout

```
packages/corpus/   ingest CLIs for public regulatory sources (run occasionally)
packages/core/     rule corpus, extraction, review engine, Claude calls, schema
packages/eval/     fixtures + precision / recall / repeat-run agreement harness
apps/server/       Fastify + SQLite; the only process that holds a credential
apps/web/          Vite + React reviewer UI
```

## Setup

Requires Node 22+ (developed on 24).

```sh
npm install
cp .env.example .env     # then edit
npm run migrate          # creates ./data/regreview.db
```

**Credentials.** Either export `ANTHROPIC_API_KEY`, or run `ant auth login` and
leave it unset — the SDK resolves the stored OAuth profile automatically. Note
that a set-but-*empty* `ANTHROPIC_API_KEY` still takes precedence over a profile
and will authenticate with an empty key; unset it rather than blanking it.

## Building the rule corpus

Run in this order. Each is incremental and safe to re-run; downloads are cached
under `corpus-cache/`.

```sh
npm run ingest:observations   # FDA Inspectional Observation data (do this first)
npm run ingest:cfr            # 21 CFR Part 820, legacy QSR + current QMSR
npm run ingest:guidance       # FDA guidance PDFs
npm run ingest:rules          # our authored ISO clause skeleton
npm run corpus:report         # sanity-check what landed
npm run severity:check        # would the corpus produce a usable risk tiering?
```

Those last two are the checks worth running after any corpus change, and both
exist because both failure modes already happened once. `corpus:report` asserts
that CAPA is still a top-3 device citation — if it isn't, the column mapping
broke rather than FDA's behavior changing. `severity:check` prints the tier
distribution and warns if too much rates high; the first severity model rated
essentially every CAPA finding high, which is alarm fatigue rather than triage.

`ingest:observations` comes first because it seeds both the severity weighting
and the evaluation labels. Both `fda.gov` and the eCFR docs pages block
non-browser fetchers, so the ingest layer sends browser-like headers and backs
off; the data endpoints themselves are open.

> **Before adding to the corpus, read [`NOTICE.md`](./NOTICE.md).** ISO 13485
> and ISO 14971 are copyrighted and must never be ingested — only referenced by
> clause ID, with our own prose for the expectation. This matters more than it
> sounds: QMSR moved design controls and CAPA out of the CFR and into that
> paywalled standard.

## Running

### Loading the customer's own procedures

Do this before reviewing anything. Until a procedure is loaded the conformance
pass has no rules and **skips itself silently** — which means half the review is
missing and the output still looks complete.

```sh
npm run sop -- packages/eval/fixtures/sop-qsp-0012-capa.md --applies-to capa
npm run sop -- --list          # what's loaded
npm run rules:report           # rules per check pass; fails if a pass would skip
```

Clause extraction is deterministic — no model involved. The customer's SOP is the
yardstick every conformance finding is measured against, so a clause set that
drifted between ingests would undermine all of them. Clauses that impose no
obligation (purpose, scope, references, definitions) are skipped deliberately.

### Reviewing a document

```sh
# Real review. Needs a credential (see Setup).
npm run review -- packages/eval/fixtures/capa-001-infusion-pump-alarm.md

# Same pipeline, no API call and no spend. Crude keyword heuristics stand in
# for the model, so the output is NOT product-quality — but blocking, offsets,
# the anchoring guard, severity, and persistence are all genuinely exercised.
npm run review -- <file> --offline

# Measure repeat-run consistency, the requirement Fresenius named as critical.
npm run review -- <file> --repeat 3

# Self-consistency voting: sample each check N times, keep what a majority
# agree on. Costs Nx. This is the lever for the consistency requirement.
npm run review -- <file> --samples 3

# See what the verifier pass is actually removing.
npm run review -- <file> --no-verifier

# Compare two stored runs (free — reads the database, no API calls).
cd packages/corpus && npx tsx src/cli/diffRuns.ts --latest
cd packages/corpus && npx tsx src/cli/agreement.ts <runIdA> <runIdB>
```

Flags: `--type <recordType>` (default `capa`), `--offline`, `--repeat N`,
`--samples N`, `--no-verifier`, `--quiet`.

The CLI prints, per finding: the requirement, the verbatim quote, the problem,
why it matters in inspection terms, a direction for the fix, and **why it was
rated at that tier**. It also prints the pipeline funnel — how many findings
were proposed, then dropped by the verifier, by the anchoring guard, or as
duplicates. When this tool is wrong, that funnel is where the answer is.

Cost, measured rather than estimated: **$0.63–0.95 per document** for a single
sample (four category passes plus a verifier, Opus 4.8 at high effort), and
roughly Nx that with `--samples N`. Latency is about **two minutes** per document
with the passes running concurrently.

The important cost fact: **output tokens dominate.** A typical run is ~24k input
and ~24k output, which at $5/$25 per MTok is about $0.12 input against $0.58
output. Prompt caching is verified working (~64% of input served from cache on
the second run onward) but it can only ever address the smaller half. The lever
for cost is **effort level**, not caching — worth testing `medium`, which may also
improve consistency.

### Not yet wired

```sh
npm run eval          # Phase 2 — harness scaffolded, fixtures not written
npm run dev:server    # Phase 4
npm run dev:web       # Phase 4
```

## Phases

- [x] **0** — Scaffold, schema, severity model
- [x] **1a** — FDA Inspectional Observation data: FY2014–FY2025, 2,273 rows.
      Verified: `820.100(a)` (CAPA procedures) is the #1 device citation at
      3,367, which both confirms the parse and validates the CAPA-first wedge
- [x] **1b** — 21 CFR Part 820 at two dates. Confirmed §820.30, §820.100 and
      §820.198 are all gone from the current text
- [x] **1d** — 15 authored rules (12 ISO-clause, 3 logic), each inheriting real
      FDA citation frequency via its CFR crosswalk
- [x] **3** — Review engine: four LLM check passes (concurrent, bounded at 4),
      verifier pass, anchoring/hallucination guard, deterministic near-duplicate
      collapse, derived severity, self-consistency voting, persistence with audit
      trail, `npm run review` CLI
- [x] **4** — API + reviewer UI, verified in-browser. Two views: **Review**
      (upload a `.pdf`/`.docx`/`.md` document, run a review with a visible cost
      estimate and live progress, read the findings) and **Procedures** (upload,
      edit, and delete the customer's SOPs, clauses shown). Editing a procedure
      re-runs clause extraction on save. The review runs server-side as a polled
      background job — the browser never touches the model API.
- [x] **Conformance** — SOP upload and clause extraction; 13 findings against a
      customer procedure, cited as `QSP-0012 Rev 6 §8.2`
- [ ] **1c** — FDA guidance PDFs (Design Control 1997, AI-enabled devices)
- [x] **Consistency pass** — fact extraction + deterministic cross-document diff.
      Found 5/5 planted discrepancies between the CAPA and the FMEA, including
      risk severity 3 vs 4 and an acceptability threshold of 20 vs 15; the
      agreeing value was correctly not flagged
- [x] **`.docx` / `.pdf` parsing** — verified on real generated files; every
      block's offsets match its own text exactly in all three formats, and PDF
      blocks carry page plus bounding box for on-page highlighting

```sh
cd packages/eval
npx tsx src/cli/makeFormatFixtures.ts fixtures/capa-001-infusion-pump-alarm.md
npx tsx src/cli/checkFormats.ts capa-001-infusion-pump-alarm
```
- [ ] **2** — Eval harness and CAPA fixtures. Gate before UI work: precision
      ≥ 0.8 and repeat-run agreement ≥ 0.9
- [ ] **3** — Extraction and review engine
- [ ] **4** — Server and reviewer UI
- [ ] **5** — Warning-letter ingest, DHF expansion, in-boundary deployment,
      Part 11 audit trail and validation package

The eval harness is built **before** the engine on purpose. Precision is the
whole asset with this audience — a false alarm costs credibility that a missed
finding doesn't — so there has to be a way to measure it from the first day the
engine produces output.

## Design decisions worth knowing before you change things

**Consistency is a deterministic diff, not a model reading everything.** A model
does the *extraction* — recognising that "Severity was rated 3 (Minor)" and a
column reading `S=4` describe the same rated attribute of the same failure mode
requires reading. Code does the *comparison*: facts land in the `facts` table and
a join finds the disagreements.

Three things follow, and all three matter. It is **repeatable by construction** —
a join has no temperature, so this pass contributes identical findings every run.
It is **defensible** — the finding is not "a model thinks these disagree" but
"this document says 3 here and that one says 4 there", both passages quoted and
located. And it **scales** — N documents cost N extractions, not N² comparisons,
which is the difference between reviewing a document base and sampling it.

Findings are templated rather than generated for the same reason: a mechanical
discrepancy has a mechanical description, and a template says it identically
every time.

```sh
npm run review -- <capa.md> --related <fmea.md>
cd packages/corpus && npx tsx src/cli/factsReport.ts   # facts, join keys, diffs
```

Facts are cached per document, so re-reviewing against the same FMEA costs
nothing, and the diff can be re-run and debugged with no API calls at all.

**Repeat-run consistency is engineered, not configured — and is still the weakest
part of the system.** Sampling parameters don't exist on Opus 4.8, so: the model,
effort, prompt version, corpus version and sample count are pinned and recorded
on every run; finding IDs hash rule + normalized quote + block so "the same
finding" is identifiable across runs; and agreement is measured at two levels
(identical quotes, and same-rule/same-block/overlapping-span).

Agreement is reported at **three levels**, loosest first, because the strict ones
kept understating it:

| Level | Question it answers | Measured (3-sample voting) |
|---|---|---|
| **same requirements** | Did both runs find the same problems? | **71%** |
| same localisation | Did they point at the same passage? | 42% |
| identical quotes | Is the output byte-reproducible? | 37% |

Read them together. The 71→42 gap is entirely *same problem, different sentence*.
And the 29% of requirements that differ are mostly the **same problem filed under
a different-but-overlapping rule** — one run cited `iso13485-8.5.2-investigation`
for "software ruled out by assertion" where the other cited
`regreview-logic-conclusion-supported`. True detection agreement is therefore
higher than 71%; the instability is largely **rule attribution, not detection**.

Self-consistency voting (`--samples 3`) is built and does remove genuinely
unstable findings — its vote histograms are the best diagnostic available, and
they show instability concentrated in the `completeness` and `plausibility`
passes, where the judgement is most open-ended. It did not by itself reach the
90% target.

**Don't quote a consistency figure to a customer yet.** The next lever is further
rule disambiguation — this time between the ISO clause rules and the general
soundness rules, which still overlap.

Two traps worth knowing, both of which bit once:

- *Agreement between two empty runs is not 100%.* A review in which every check
  pass failed once reported "100% agreement, PASS". `AgreementResult.comparable`
  now guards that, and the CLI refuses to pass on it.
- *A failed check pass must never be silent.* `--quiet` once suppressed the
  reason every pass failed, leaving only "0 findings". Failures now go to
  `console.error` unconditionally.

**Every finding must quote the text it's about.** If the quote isn't found
verbatim in the document, the finding is discarded before a reviewer ever sees
it. That's the hallucination guard, and it's also what lets the viewer anchor a
highlight to exact offsets.

**Nothing is deleted.** Reviewer decisions append to `finding_events`. This is
Part 11 groundwork: while the tool sits *beside* the official record we don't
inherit audit-trail and e-signature obligations, but when it eventually touches
the record we won't be retrofitting them.
