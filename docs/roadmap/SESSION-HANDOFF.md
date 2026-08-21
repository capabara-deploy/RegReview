# RegReview — Session Handoff

Paste this into a new chat to orient it. It explains what the project is, how the
repo is laid out, the rules that must not be broken, how to run it locally
(including the gotchas that will waste an hour), and what has been built lately.

---

## 1. What this is

**RegReview** is an AI **pre-inspection review** tool for FDA-regulated medical
device quality records. It reads a company's records (CAPAs, risk files, design
controls, SOPs, change records) and leaves **cited, inline findings** where a
document conflicts with FDA requirements, the company's own procedures, other
documents, or basic logic — so problems get found before an FDA investigator
finds them.

It is a real venture (founder Jack Wade + cofounders). Positioning: **"pre-inspection
review" / "gap analysis," never "audit."** The product **flags, explains, and
suggests — it never drafts or auto-writes document content.** A human verifies
every output. That is both the differentiator and FDA's stated bar for AI use.

There is a deployed demo at **demo.capabara.io** (see Deployment below), but the
active development instance is **local**.

---

## 2. Opening the repo

- **Local path:** `C:\Users\jamsv\Projects\RegReview`
- **GitHub:** `capabara-deploy/RegReview` (private). Default branch `master`.
- If a session's working directory is elsewhere, request access to that path
  (or launch the session rooted there) before editing.
- Read **`CLAUDE.md`** first — it is the operational doctrine and loads
  automatically when the session is rooted in the repo.

---

## 3. Where things stand right now

**All recent work is on branch `roadmap-build` — 15 commits ahead of `master`,
NOT pushed and NOT merged.** Start there:

```bash
git -C ~/Projects/RegReview checkout roadmap-build
git -C ~/Projects/RegReview log --oneline master..roadmap-build
```

That branch contains a full execution of a roadmap (`docs/roadmap/execution-plan.md`):
the eval harness, a 23-document demo corpus, a cumulative change ledger, a
cross-document graph + map, a rule corpus grown from 29 to **110 rules**, and a
set of "Run a review" UX changes. See §7 for detail.

`master` still has the older state. `korea`/`seoul` are a cofounder's deployment
branches already merged into the line `roadmap-build` sits on.

---

## 4. Repo map

Monorepo, npm workspaces, `tsc -b` project references, ESM, Node 22+, TypeScript
strict with `exactOptionalPropertyTypes` (so zod `.optional()` output needs
`| undefined` on target param types).

```
packages/core/     rule corpus, extraction, review engine, Claude calls, severity,
                   the Postgres layer, and CLIs. The heart.
packages/corpus/   one-time/refreshable ingest CLIs (FDA data, CFR, authored rules)
packages/eval/     the eval harness (loadFixtures / score / runEval) + fixtures + labels
apps/server/       Express API; the only process holding an Anthropic key. Reaches
                   Postgres through core; owns MongoDB (accounts/sessions/quota).
apps/web/          Vite + React reviewer UI
docs/roadmap/      the plan, critique, demo-corpus blueprint + fact ledger, and this file
```

**Storage — two systems, don't confuse them:**
- **Neon Postgres, three databases split by sensitivity:** `corpus` (public
  regulatory reference data + the rule set), `customer` (records, blocks, facts,
  runs, findings), `sops` (uploaded procedures + their rules). Open with
  `getCorpusDb()` / `getCustomerDb()` / `getSopsDb()` — there is no single `getDb()`.
- **MongoDB** — reviewer accounts, sessions, hourly quota, in `apps/server` only.

`db/pgDb.ts` is a better-sqlite3-shaped **async** wrapper: `db.prepare(sql).run/get/all()`
and `db.transaction(fn)()` behave as before, just async; `?` placeholders become
`$1..$n`. The `fn` passed to `transaction()` **must be async**.

**Key files to know:**
- `packages/corpus/src/authoredRules.ts` — the 110 rules. Sections: CAPA, risk,
  FDA_QSR, GUIDANCE, DEVICE_TYPE, logic. `sourceFor()` routes rule-id prefixes
  (`cfr-`, `guidance-`, `iso…`) to a `source`.
- `packages/core/src/config.ts` — `CORPUS_VERSION` (bump on any corpus change
  that can move a finding), pinned model `claude-opus-4-8`, effort `high`.
- `packages/core/src/changeLedger.ts` / `changeStore.ts` — cumulative change ledger.
- `packages/core/src/graph.ts` / `graphStore.ts` — cross-document graph.
- `packages/core/src/extract/text.ts` — `docIdMatcher()` (widen once if a new
  document-id prefix appears), `normalizeText` (line endings + trailing space only,
  markdown preserved).
- `packages/eval/src/cli/runEval.ts` — the harness.
- `apps/web/src/{App,RunReview,Findings,ChangeLedger,GraphMap,Procedures}.tsx`.

---

## 5. Doctrine that overrides normal instincts

These are in `CLAUDE.md` and `NOTICE.md`; the ones that bite:

1. **Flag / explain / suggest — never bulk-generate or auto-apply document text.**
   Especially: the change ledger must **never** emit a submit / don't-submit
   determination (that is the manufacturer's statutory call, 21 CFR 807.81(a)(3)).
   `changes.determination` is written only by `setDetermination`, from a human.
2. **Hallucination guard:** every finding must quote text found verbatim in the
   document, or it is discarded before a reviewer sees it. Don't weaken it. A typed
   change (change ledger) has no document to quote, so model inferences about it go
   in `change_gaps` (origin `inferred`), never in `findings`, and carry no severity.
3. **Never ship ISO / copyrighted standard text.** ISO 13485/14971 and all consensus
   standards (IEC 60601, ISO 10993/11607, ASTM, AAMI, CLSI) are referenced **by
   clause/number only** with our own prose. 21 CFR and FDA guidance are US-Gov
   public domain and are the basis for `cfr-`/`guidance-` rules — but the expectation
   prose is still our own; no regulation text pasted.
4. **Severity is derived, not chosen** — from FDA citation frequency + patient-harm
   linkage. After any corpus change run `npm run severity:check`; if >~40% of rules
   rate high it warns (alarm fatigue) — recalibrate `harmLinked` honestly.
5. **Consistency is a deterministic diff**, not a model reading everything. A model
   extracts facts; code compares them. Same for the graph's reference edges.
6. **Bump `CORPUS_VERSION`** on any corpus change that could move a finding.
7. When adding rules, prefer record types that **don't** dilute the CAPA pass —
   design/verification/validation/risk rules don't load on CAPA reviews.

---

## 6. Running it locally (and the gotchas)

The app needs the three Neon URLs + `MONGODB_URI` in `.env` (gitignored; secrets
are NOT in this doc). Assuming `.env` is populated:

```bash
# API (Express, port 8787) and web (Vite, port 5174), from the repo root:
npm run dev:server      # or: node --env-file-if-exists=.env --import tsx apps/server/src/index.ts
npm run dev:web
```

Then open **http://localhost:5174** and sign in. **Local demo login:**
`demo` / `update3` (a throwaway dev credential in the local Mongo database
`regreview`).

**Gotchas that will waste your time:**

- **Atlas IP allowlist.** MongoDB Atlas blocks the machine's IP unless it's on
  Security → Network Access. A home IP changes; the symptom is login returning
  **500**, and the server log shows a TLS `ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR`.
  Fix: add the current public IP (`curl https://api.ipify.org`) in Atlas, or add
  `0.0.0.0/0` once for a dev cluster.
- **Node DNS + `mongodb+srv`.** On this machine Node's resolver has been refusing
  the Atlas SRV lookup (`querySrv ECONNREFUSED`) even when `nslookup` works. Boot
  the server with a tiny preload that points Node at public DNS:
  ```js
  // dns-fix.mjs
  import dns from "node:dns"; dns.setServers(["8.8.8.8","1.1.1.1"]);
  ```
  ```bash
  node --import ./dns-fix.mjs --env-file-if-exists=.env --import tsx apps/server/src/index.ts
  ```
  (Local dev only; not committed. Postgres uses normal A-records and is unaffected.)
- **Two Mongo databases.** Local `.env` uses `MONGODB_DB=regreview`; production
  (`demo.capabara.io`) uses `regreview-demo`. Accounts created locally don't exist
  in prod and vice versa. `demo`/`update3` was created in local `regreview`.
- **`npm install` fails on Windows** because `better-sqlite3` (a devDependency for
  an archive script) needs a C++ toolchain. `npm install --ignore-scripts` works;
  nothing at runtime imports it.
- The tsx dev server does **not** hot-reload server code — restart it after editing
  `apps/server` or `packages/core`. Vite **does** hot-reload the web app.
- Running against `.env` points at the **real (prod) Neon databases** — writes are
  live. The corpus DB is public reference data (least sensitive); customer/sops hold
  real content.

---

## 7. What was built recently (the `roadmap-build` branch)

- **Phase 0 — eval harness.** `npm run eval` runs the engine over labeled fixtures
  and reports precision/recall. Offline by default (free, CI-safe); `--real` for the
  model number (spends). Precision counts only on fixtures marked `exhaustive:true`;
  there isn't one yet, so **there is no precision gate yet** — building an exhaustive
  fixture is the top open task. First real run: recall ~80%.
- **Phase 1 — Northlake demo corpus.** 23 hand-authored, cross-referencing fixtures
  in `packages/eval/fixtures/` (fictional Northlake Medical Systems / VP-400 infusion
  pump), 19 catalogued planted defects. See `README-northlake-demo.md` +
  `docs/roadmap/demo-corpus-facts.md`.
- **Phase 2 — cumulative change ledger.** `changeLedger.ts`/`changeStore.ts`, server
  routes, a **Changes** UI tab. Flags GP7 wrong-comparator + GP6 aggregate gaps and
  lists decision-flowchart questions; never issues a verdict. `npm run ledger:demo`.
- **Changes tab rebuilt into a workflow (2026-08-20).** The tab was a flat list; it is
  now the thing it was meant to replace — the risk spreadsheet every device company
  keeps — done honestly. Five-stage workflow (`proposed → implemented → documented →
  in_submission → cleared`), risk pooled into **undocumented** vs **unsubmitted**
  exposure, a deterministic **floor** under every 1–10 score (from the change type's
  FDA flowchart branch) that only a written rationale can go below, model scoring via
  `changeScorer.ts` (suggestions only — never `score`, always clamped), **submissions**
  as first-class rows, and `clearSubmission()` which re-baselines the device so
  accumulation correctly restarts. UI is a threshold **gauge** + a **stage board** with
  a detail panel. Escalation is phrased as a conformance finding against the customer's
  *own* change-control threshold (`baselines.threshold` / `threshold_source`), never as
  FDA advice — see CLAUDE.md for why that line matters. New gap kinds: `unscored_change`,
  `unconfirmed_score`, `below_floor_no_rationale`, `undocumented_aging`.
  `npm run ledger:demo -- --reseed` rebuilds the VP-400 demo rows to exercise all of it.
- **Phase 3 — cross-document graph + map.** Deterministic reference edges,
  `GET /api/graph`, a dependency-free SVG **Map** tab. `npm run graph:demo`.
- **Pipeline integration (2026-08-20).** Changes and Map stopped being dead ends.
  **Routing** (`apps/web/src/routes.ts`) — hash routes with an optional target
  (`#/map/rec%3Aabc`, `#/changes/chg-1`, `#/findings/rec-9`); navigation is derived
  from the address bar, so a pasted link, the back button and an in-app click all
  take one path. **Cross-links both ways**: map node → its document or change;
  change → the document that captures it, and → its node on the map; document →
  the change it captures (new `capturedChange` on `GET /api/records/:id`) and →
  the map. **The map now draws the record, not the inventory**: change nodes, the
  document each undocumented change owes (dashed `proposed` node), submissions,
  accumulated risk on nodes and in the header, five lanes, three draw kinds,
  deterministic layout. **`deriveIssues()`** adds record-level problems — broken
  references, owed documents, orphans, never-reviewed, stale-corpus — shown as a
  collapsible list above the map. Plan: `docs/roadmap/integration-plan.md`.
  **NOT done: the device spine** (`records` still has no device column, `PROJECTS`
  is still a hardcoded one-element array) — deliberately, since it is invisible
  with one device and is a prod schema migration; do it when a second device exists.

- **Corpus 29 → 110 rules.** 35 CFR, 46 guidance, 26 ISO-clause, 3 logic — grounded
  in real FDA inspection-citation frequency and current guidance (verified currency
  on biocompat 2023, sterility 2024, AI 2024/25, software CSA 2025). Plus a GMP SOP
  (QSP-0025) loaded as a live conformance procedure.
- **Run-a-review UX:** rule picker grouped into collapsible topic sub-dropdowns +
  search; a top-bar **project** selector (single project for now); **upload-and-replace**
  (`POST /api/records/:id/replace`, per-row ⟳); document list grouped by type;
  cross-check simplified to Compare-to-all/None + an adjust-targets dropdown.

---

## 8. Command cheat-sheet (run from repo root)

```bash
npm run build                 # tsc -b everything
npm run eval                  # eval harness, offline; --real for the model number
npm run review -- <file>      # review one record from the CLI (--rule ID to scope)
npm run ingest:rules          # load authored rules into the corpus (attaches FDA freq)
npm run corpus:report         # sanity: CAPA still top-3?
npm run severity:check        # tier distribution; warns on alarm-fatigue
npm run sop -- <file> --applies-to <type>   # load a procedure as conformance rules
npm run ledger:demo           # seed + print the Northlake change ledger
npm run ledger:demo -- --reseed   # rebuild the VP-400 demo rows (deletes + reseeds them)
npm run graph:demo            # ingest the demo corpus + print the reference graph
npm run dev:server / dev:web  # run the app locally (see §6 for the DNS preload)
```

---

## 9. Open / next work

- **Build one exhaustive eval fixture** so precision becomes measurable — the
  corpus is broad and current, but whether it makes reviews *better* is unmeasured.
  This is the single highest-value next step and everything measurement-related
  gates on it.
- Label design/change fixtures so the new (design/device/change) rules get exercised.
- The **project selector** is scaffolding — it doesn't filter yet (one project). Wire
  it to filter records/graph/ledger when a second project exists.
- Decide push/merge of `roadmap-build`. Nothing is pushed.

---

## 10. Deployment reality

- **Site (`apps/web`)** → DigitalOcean App Platform, custom domain **demo.capabara.io**
  (also `regreview-j2s5i.ondigitalocean.app`). Spec at `.do/app.yaml` (`deploy_on_push`
  wired to branch `korea`). **GitHub auto-deploy has been broken since the repo moved
  to the `capabara-deploy` org** — App Platform stopped building; recent commits are
  pushed to GitHub but not live. Fix is in the DO console (Settings → Source, reconnect
  the org).
- **API (`apps/server`)** → a hand-deployed Droplet at `167.71.105.204`
  (`https://167.71.105.204.sslip.io`), built from `Dockerfile`. **It does not have the
  new routes** (ledger, graph, replace) until the container is rebuilt. So on
  demo.capabara.io the Changes/Map tabs 404 until then; the local instance has everything.
- Nothing on `roadmap-build` is deployed anywhere yet.
```
