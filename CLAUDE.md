# RegReview

AI **pre-inspection review** for FDA-regulated medical device design and quality records. It ingests a company's records (CAPA, risk files, design controls, SOPs), flags where they conflict with FDA requirements, the company's own procedures, other documents, or basic logic, and presents each flag as a reviewable inline highlight with a severity, a cited reason, and a suggested direction.

## Two product constraints that override everything

1. **Flag, explain, suggest — never bulk-generate replacement text.** A human verifies every output. This is both the differentiator and the FDA's stated bar for AI use. Do not add features that auto-write or auto-apply document content.
2. **Confidential by construction.** Uploaded records are among the most sensitive documents a device company owns. Three invariants, all of which survived the move off local SQLite and none of which may be traded away for convenience:
   - Only *extracted text* is sent to the model API.
   - `apps/server` is the only process holding an Anthropic credential; the browser never calls the model API directly, and reviews run server-side as polled background jobs.
   - Customer content lives in the `customer` and `sops` databases and **never** in `corpus`. Original uploaded bytes stay on the server's disk (a mounted volume in the container), not in a database and not in the image.

## Positioning / language

- Say **"pre-inspection review"** or **"gap analysis"** in all user-facing copy. Never "audit" or "auditor" — those carry specific legal meaning in this industry.
- **Never embed or ship ISO standard text.** ISO 13485 / ISO 14971 are copyrighted. Rules reference clause IDs and use *our own authored prose* for the expectation. See `NOTICE.md`.

## Layout

Monorepo, npm workspaces, `tsc -b` project references, ESM throughout, Node 22+.

```
packages/core/     rule corpus, extraction, review engine, Claude calls, severity, CLIs,
                   and the Postgres layer (pg + the *Schema.sql files live here, not in the server)
packages/corpus/   one-time/refreshable ingest CLIs (FDA data, CFR, authored rules) — no runtime dep
packages/eval/     fixtures + labels + the harness (loadFixtures / score / runEval)
apps/server/       Express; the only process that holds an API key. Reaches Postgres through core,
                   and owns the MongoDB side (reviewer accounts, sessions, hourly quota)
apps/web/          Vite + React + TS reviewer UI, served as a separate origin from the API
```

## Storage

Two different stores, for two different reasons:

- **Neon Postgres, three databases, split by sensitivity** — `corpus` (public regulatory reference data: CFR text, FDA citation frequencies, the authored rule set), `customer` (uploaded records, blocks, facts, runs, findings — findings embed verbatim customer quotes, so they are customer content), and `sops` (uploaded procedures and the rules derived from them). Open them with `getCorpusDb()` / `getCustomerDb()` / `getSopsDb()`; there is no single `getDb()`.
- **MongoDB** — reviewer accounts, sessions, and the hourly review quota, in `apps/server` only. Core never touches it.

`db/pgDb.ts` is a better-sqlite3-shaped wrapper: `db.prepare(sql).run/get/all()` and `db.transaction(fn)()` behave as before, just async, and `?` placeholders are rewritten to `$1..$n`. So porting a call site is "add async/await", not "rewrite the query" — but note that **`fn` passed to `transaction()` must be async**, since AsyncLocalStorage is what threads the checked-out client through nested `prepare()` calls.

**A foreign key no longer protects findings from rule deletion.** `findings.rule_id` lives in `customer` and `rules` lives in `sops`; Postgres cannot enforce a constraint across databases. The explicit "is this rule still referenced" check in `ingestSop` is now the only thing preventing an orphaned finding. Don't remove it as redundant.

## Cumulative change ledger and cross-document graph

Two subsystems added for the advisor roadmap (see `docs/roadmap/execution-plan.md`). Both are deliberately **deterministic** and both have a constraint that is load-bearing, not incidental:

- **Change ledger** (`changeLedger.ts` / `changeStore.ts` / `changeScorer.ts`, tables `baselines` / `changes` / `change_gaps` / `submissions`). It flags gaps in change assessments (wrong comparator vs the cleared 510(k) — "GP7"; missing aggregate assessment — "GP6") and lists which decision-flowchart branches a change *type* raises. **It must never render a submit / don't-submit determination** — that is the manufacturer's statutory call (21 CFR 807.81(a)(3)) and the highest-liability string this product could emit. `changes.determination` is written **only** by `setDetermination`, from a human; nothing computes it. Model inferences about a proposed change go in `change_gaps` with `origin='inferred'`, never in `findings` — a typed change has no controlled-document text to quote, so it is not protected by the hallucination guard and carries no severity.

  It also replaces what companies actually do today — a spreadsheet of 1–10 risk scores with a running total and a threshold. Four things make that honest rather than a nicer spreadsheet, and each is load-bearing:

  - **Risk is pooled by workflow stage.** `Stage` is `proposed → implemented → documented → in_submission → cleared`. Exposure is `implemented` (in the product, no controlled document) **plus** `documented` (written up, not yet filed) — the two middle stages only. `proposed` is carried separately as `pipeline` (a forecast, not exposure); `cleared`/`superseded` are excluded. Keep those boundaries: counting `proposed` as exposure overstates today, and dropping it entirely throws away the only predictive thing the ledger knows.
  - **Every score has a deterministic floor** (`SCORE_FLOORS`, from the change type's FDA flowchart branch). `effectiveScore()` clamps any score up to the floor, with exactly one escape hatch: a human who writes `belowFloorRationale` may go under it, because that is the rebuttal the guidance itself provides. A *model* never can. Unscored changes resolve to their floor, never to zero — zero would let an untouched ledger read as "no exposure", the most dangerous way this number could be wrong.
  - **`changeScorer.ts` writes only `suggested_score`.** It is the one place a model output is not protected by the hallucination guard (there is no document to quote), so three things substitute: it cannot write `score`, the floor clamps it, and its prompt forbids any statement about whether a submission is required. `pools.unconfirmed` reports how much of the headline total rests on unconfirmed suggestions, and the UI must keep showing it.
  - **The escalation is a conformance finding against the customer's own SOP, not FDA advice.** `baselines.threshold` / `threshold_source` are *theirs*, cited (e.g. "QSP-0031 §5.4"). Crossing it says "your procedure requires a determination and none has been made". Do not let that message drift toward "submit a 510(k)" — the distinction is the entire reason this feature is shippable.

  `clearSubmission()` closes the loop: recording a clearance retires the changes it carried, mints a **successor baseline** carrying the threshold forward, and links the old one via `superseded_by`. That is the step every real-world change spreadsheet gets wrong, and why theirs drift until nobody trusts them — accumulation must restart against the *new* clearance number, not zero a counter while later changes still compare to the original.

- **Cross-document graph** (`graph.ts` / `graphStore.ts`). Reference edges are extracted deterministically (a document id appearing in another document's text), classified by nearby words, and the target is stored *as written* then resolved in a second pass — so "cites a document we don't hold" is an explicit `danglingRefs` output, not a dropped edge. Computed live on read; do not materialize edges until a customer actually has thousands of documents. The shared doc-id vocabulary is `docIdMatcher()` in `extract/text.ts` — widen it there, once, if a new document-id prefix appears.

Workspaces import `@regreview/core` via its **dist output**, so core builds first. `npm run build:core` before anything that depends on it (most scripts already chain this).

## Common commands (run from repo root)

```bash
npm run build            # tsc -b everything
npm run migrate          # create/upgrade all three Postgres schemas; seeds SAMPLE-* SOPs
npm run user:create -- <username> <password>   # a reviewer account (MongoDB)
npm run ingest:observations   # FDA Inspectional Observation data (severity weights + eval labels)
npm run ingest:cfr            # CFR Part 820 (legacy QSR + QMSR)
npm run ingest:rules          # authored ISO-clause + logic rules
npm run corpus:report         # sanity-check the loaded corpus
npm run review -- <file>      # review one record from the CLI (--rule ID to scope)
npm run eval                  # eval harness, offline baseline (free); --real for the model number
npm run ledger:demo           # seed + print the Northlake cumulative change ledger
npm run ledger:demo -- --reseed   # rebuild the VP-400 demo rows (deletes + reseeds them)
npm run graph:demo            # ingest the demo corpus + print the cross-document graph
npm run dev:server            # start the API + built web UI
npm run dev:web               # Vite dev server (proxies /api to the server)
```

Scripts run with cwd set to the *workspace* dir, but all paths anchor to the repo root (see below), so run these from the root.

**`npm run eval` — the harness exists now.** Runs the engine over labeled
fixtures (`<id>.labels.json` sidecars) and reports precision/recall. Offline by
default (keyword baseline, free, CI-safe, no DB writes); `--real` for the model
number (spends, and persists the fixture + its related docs because the
consistency pass caches facts under a FK to `records`). Precision is counted
**only** on fixtures marked `exhaustive: true` — a fixture that labels the
planted defects but not every real finding must stay `exhaustive: false`, or the
engine's genuine unlabeled findings count as false positives and the precision
number lies. The first real run: recall 80% defect / 60% rule. There is not yet
an exhaustive fixture, so there is not yet a precision gate — building one
(and deciding how the sample-SOP conformance pass participates) is the next eval
task.

## Things that will bite you

- **Paths anchor to the repo root, not cwd.** `packages/core/src/config.ts` walks up to the workspace-declaring `package.json`. This exists because npm workspace scripts set cwd to the workspace dir, which once produced *three separate databases* (migrate wrote one, ingest another, the reader a third empty one). Don't "simplify" config paths to be cwd-relative.
- **Non-TS assets do not reach `dist`, and do not reach the image either.** `tsc` emits only `.ts`. The `*Schema.sql` files live inside `src/`, so `migrate.ts` checks both the sibling path (tsx-from-src) and `../../src` (running from dist). `packages/core/samples/` sidesteps that by sitting outside `src/` — but the Dockerfile copies `dist` only, so it needs its own explicit `COPY`. Any new asset needs one of these two treatments; forgetting produces a container that boots fine and silently does less.
- **The server migrates on every boot** (`apps/server/src/index.ts`), so anything hooked into a `migrate*()` function runs in production on every deploy. Keep it idempotent and cheap.
- **Repeat-run consistency is a hard requirement**, named explicitly by the Fresenius interviewee. The model, prompt version, and corpus version are pinned and stamped on every run (`config.ts`, `runs` table). Findings from different `corpus_version` / `prompt_version` are **not comparable**. Bump `CORPUS_VERSION` on any corpus change that could move a finding; bump `PROMPT_VERSION` on any prompt change.
- **Consistency check is deterministic, not the LLM.** Facts are extracted per-record into a table; a plain TS/SQL diff finds mismatches, and only then does the model explain the real ones. Don't replace it with an LLM eyeballing many documents.
- **Hallucination guard:** every finding must carry the verbatim quote it anchors to; if that string isn't in the block text, the finding is dropped before the reviewer sees it. Keep this invariant.

## Model / API

- Anthropic SDK, `claude-opus-4-8`, effort `high` (pinned in `config.ts`; override via `REGREVIEW_MODEL` / `REGREVIEW_EFFORT`).
- `ANTHROPIC_API_KEY` in `.env` (gitignored). If unset, the SDK resolves an `ant auth login` profile. The offline keyword engine (`--offline`) is a crude dev baseline, not product output — never default the UI to it.

## Config / env

`.env` is gitignored, so **`.env.example` is the only spec anyone setting up a
second machine has.** Add every new variable there when you add it, or the next
person configures blind. Everything except the auth/deploy block is read through
`config.ts`; read it there rather than calling `process.env` directly.

| Variable | |
|---|---|
| `ANTHROPIC_API_KEY` | Unset it to fall back to an `ant auth login` profile. Set-but-*empty* still wins and authenticates with an empty key |
| `ANTHROPIC_AUTH_TOKEN` | Accepted by the server as an alternative credential |
| `REGREVIEW_MODEL` / `REGREVIEW_EFFORT` | Pinned; part of a run's identity |
| `NEON_DATABASE_URL` / `NEON_CUSTOMER_DATABASE_URL` / `NEON_SOPS_DATABASE_URL` | The three databases. Read lazily, so a CLI that never opens one doesn't need it set |
| `NEON_OLD_DATABASE_URL` | The frozen pre-migration SQLite archive. Not read by the running app |
| `MONGODB_URI` / `MONGODB_DB` | Reviewer accounts, sessions, quota |
| `REGREVIEW_UPLOAD_DIR` / `REGREVIEW_CORPUS_CACHE` | Relative values resolve against the repo root, not cwd |
| `REGREVIEW_SKIP_SAMPLE_SOPS` | `1` disables seeding the `SAMPLE-*` procedures |
| `HOST` / `PORT` / `REGREVIEW_RATE_LIMIT` | Rate limit defaults to 120/min |
| `REGREVIEW_SITE_ORIGIN` | Must match exactly where the web app is served — scheme, host, port. The site is a different origin from the API now, and these are credentialed requests |
| `REGREVIEW_HOURLY_REVIEW_LIMIT` | Per account, counted per document rather than per request |
| `REGREVIEW_ADMIN_PASSWORD` | Unset ⇒ the reset-limit endpoint 404s. No default, deliberately |

**Deployment footgun:** `HOST` defaults to `127.0.0.1`, and the server calls
`process.exit(1)` on any non-loopback `HOST` without `MONGODB_URI`
(`apps/server/src/index.ts:87`). That is deliberate — this process serves
uploaded customer documents and a button that spends money per click — but it
exits before serving a request, so it reads as a broken deploy if you don't know.

## Deployment

Split across two DigitalOcean products, on purpose:

- **`apps/web`** — App Platform static site, spec checked in at `.do/app.yaml`, `deploy_on_push: true`. **Pushing the branch named in that spec deploys it.** The spec is explicit rather than auto-detected because App Platform's detector mistakes a `packages/` workspace root for a Functions project.
- **`apps/server`** — a Droplet, built from `Dockerfile`. Not on App Platform: it needs persistent disk for uploaded documents and holds review-job state in memory, neither of which survives a stateless container. Deployed by hand, so a merge to `master` does **not** ship the API.

Connection strings and the Anthropic key are passed at runtime (`--env-file`), never baked into the image.

## Conventions

- TypeScript strict, ESM, `.js` extensions on relative imports (NodeNext resolution).
- `zod` for schemas shared between server and web.
- Comments explain *why*, not *what* — match the existing density (this codebase comments the non-obvious decisions heavily; keep that where it earns its place).
