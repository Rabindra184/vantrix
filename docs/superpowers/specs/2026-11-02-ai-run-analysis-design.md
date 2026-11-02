# AI run analysis — design

Gatling Enterprise comparison backlog item **#11**. The research this rests on
is `docs/superpowers/research/2026-11-02-ge-ai-run-analysis/README.md`: GE's
card measured on a real run, its output verbatim, and every figure in it
checked against that run's own Report.

## Why

GE's run Summary carries an "AI run analysis" card: one button produces a
three-section written analysis of the run, stored with it. PerfPortal is
rebuilding every GE page (the enterprise parity programme), and the user ruled
on 2026-11-02 that GE parity takes precedence over the PRD's AI phase order
(§25 puts narrative summaries last) for this card.

The measurement says what to beat. GE's analysis copies every number
correctly and gets the numbers it WORKS OUT wrong: it added Place Order's 172
failures to 170 401s for a KO rate whose real count was 289, never named Add
To Cart although that request holds the run's slowest tail, and read the run's
last two seconds — only the final scenario step still in flight — as "a
systemic functional failure point". PerfPortal's accuracy standard is "every
number exact against the raw data", so the design rule is:

**The model never does arithmetic and never reads a chart. PerfPortal computes
every fact deterministically; the model only writes sentences about facts it is
handed; every number in its text is checked against those facts before
anything is stored.**

## Goals

1. A card on the run Summary with GE's shape: before generation one button,
   **Analyze with AI**; after, three collapsible sections — **Health**,
   **Insights** (a two-column grid of **Errors**, **Assertions**, **Injection
   profile**, **Response times**), **Recommendations** — each a bold headline
   sentence over bullets. Stored per run, shown on every later visit, with
   "Generated on <date>".
2. Every number in the text is exact for the run, because it is copied from a
   computed fact, never produced by the model.
3. The derived claims GE got wrong are computed facts here: failure counts
   that partition the KO total, which request owns the latency tail, which
   requests failed every time, and whether an outcome change happened during
   the run or only in its final drain.
4. Two-step opt-in: nothing leaves the deployment unless an operator
   configures a provider AND an admin turns AI features on for the org.
   Without both the card does not render at all.
5. Works with Claude (the default) or a self-hosted model through an
   OpenAI-compatible endpoint (Ollama, vLLM, LM Studio), per PRD §25's
   data-handling rule.

## Non-goals

- Anything gating: no AI output ever changes a verdict, an assertion, a run
  status or an alert (PRD §25's governing constraint, unchanged).
- Chat, follow-up questions, or analysis across several runs or a trend.
- Editing the generated text. GE offers none; nor does this — the user's
  ruling, over PRD §25's "always editable", because an edit would void the
  guarantee that every number was checked. A reader who wants to annotate
  has the run note.
- A spending cap beyond one generation per run. Generating again is offered
  only when the analysis is stale (below), so each run costs at most one
  call until its figures change; no per-day or per-org quota.
- Anomaly detection or root-cause ranking (§25 phases 1–2): this design
  computes a handful of named facts, not a statistical model.

## Anti-goals (failure even if it works)

- **A number in the text that does not appear in the facts.** That is the
  one way this feature could make PerfPortal's figures less trustworthy than
  having no feature, so it is refused, not logged.
- **Run data leaving the machine without an operator having configured it.**
- **The card shown on a run where it cannot work** (no provider, run not
  terminal, no statistics) as a button that then fails.
- **A second definition of a figure.** Facts are read from the same stored
  rows and the same functions the run pages use; the facts builder never
  recomputes a percentile or a rate its own way.

## Constraints

- **The org switch.** A boolean on the org, `ai_enabled`, default **false**,
  set by an admin from a new Administration section (the product's first
  org-level setting; `users:manage`-level, i.e. admin). It is shown only
  when a provider is configured, and says in one sentence what leaves the
  deployment when it is on. The API's GET reports `org_disabled` and the POST
  refuses while it is off; the worker re-checks it before calling the
  provider, so a job queued just before an admin turned it off sends nothing.
- The provider is opted into by environment, read by both API and worker:
  `AI_PROVIDER` = `anthropic` | `openai-compatible` (unset = off),
  `AI_MODEL` (default `claude-opus-5-5` for `anthropic`, required for
  `openai-compatible`), `ANTHROPIC_API_KEY` for `anthropic`,
  `AI_BASE_URL` (+ optional `AI_API_KEY`) for `openai-compatible`. Compose
  passes them through `app_env` as `PERFPORTAL_AI_*`, and `.env.example`
  must list them (the `compose` CI job's guard fails otherwise). Read with
  the repo's rules: blank is unset; a provider named without its required
  companions stops the process at startup with a message naming the missing
  variable (the `parseRawLogRetentionDays` precedent), rather than failing on
  first click.
- Claude is called through the official `@anthropic-ai/sdk` with
  structured output (`client.messages.parse` + `zodOutputFormat` over the
  output schema), adaptive thinking (Opus 5.5's only mode), the server-side
  refusal fallback (`fallbacks: "default"` with its beta header) and a
  bounded timeout. The self-hosted path is a plain OpenAI-compatible
  chat-completions call asking for a JSON response, parsed with the same zod
  schema. One `AnalysisProvider` interface; the rest of the pipeline cannot
  tell which ran.
- Generation runs in the **worker** as a BullMQ queue (`ai-analysis`,
  concurrency 1), the verify/recompute shape: the API marks a row pending and
  enqueues; the worker builds facts, calls the provider, validates, stores.
  The API never holds a request open for a model.
- The run must be terminal and have statistics (`complete` or `incomplete`
  with `run_stat` rows). Anything else answers that the analysis is not
  available yet, never a button.
- What is sent is aggregates and labels only: run totals, per-request and
  per-group statistics, error messages and counts, assertion expressions and
  outcomes, injection figures, the computed facts. Never the raw log, never a
  user's identity. Error messages are Gatling's check failures and can carry
  fragments of URLs or response bodies; `DEPLOYMENT.md` says so in the
  section that documents the variables.
- PRD §25 data handling: a self-hosted model must be usable and the feature
  must be removable entirely (unset `AI_PROVIDER`).
- The repo's gates and conventions apply: contracts in
  `@perfportal/contracts`, a migration, OpenAPI registration (the route
  walk and `REQUEST_BODIES` guards will demand it), access rules in
  `ACCESS_BY_ROUTE`, required-not-defaulted parameters where a wrong value
  is silent, red-verified tests.

## How it works

### 1. Facts (deterministic, pure)

A pure function builds `RunFacts` from rows the platform already stores:
the run identity and `RunTelemetry`-free statistics (`run_stat` at run,
request and group scope), the error table, the run series buckets, the
platform SLA assertions and the simulation's own Gatling assertions, peak
users and duration. It lives beside the statistics engine's readers (a new
module in `packages/statistics`, or its own package if the builder finds the
dependency graph argues for it), takes already-read rows, and does no I/O.

Each fact is `{ id, label, value }` where `value` is the number AS THE
PAGE DISPLAYS IT (same formatter, same rounding) plus its raw form for the
check. Facts the model may cite include at least:

- run totals: requests, OK, KO, error rate, throughput, duration, peak
  users, mean / p50 / p95 / p99 / max / stddev;
- per request and per group: count, KO, error rate, p95, p99, max;
- errors: each message with its count and its share **of recorded errors**,
  exactly as the Errors table shows them, and the total number of recorded
  errors (which may exceed KO — the standalone-error rule this repo already
  documents). Not GE's "share of requests": that figure appears on no
  PerfPortal page, and the facts never define a figure a second way;
- assertions: each one's expression, expected, actual, outcome;
- **derived**, computed here and named as facts so the model never derives
  them: requests whose every response failed; the request holding the run's
  max and the largest p99 (the tail's owner); KO broken down by request so it
  sums to the run's KO; whether the share of OK responses fell to zero, and
  if so whether only during the final drain (after the last user started) or
  during the run proper; the slowest request by p95.

### 2. Generation

The worker hands the provider a fixed system prompt (the rules: cite only
given facts, use their displayed form, no arithmetic, no causes beyond what a
fact supports, PerfPortal's plain wording) and the facts as structured input,
and asks for the output schema:

```
health          { headline, bullets[] }
insights        { headline, errors[], assertions[], injectionProfile[], responseTimes[] }
recommendations { headline, bullets[] }
```

with bounded lengths (bullets per section, characters per bullet).

### 3. The number check

Every number in every string of the output is extracted and must match a
fact's displayed or raw value, allowing only the renderings the facts module
itself produces (thousands separators, the unit suffixes it uses). A
recommendation that wants to suggest a limit may only use a figure the facts
contain (`facts` may carry a small set of computed suggestions, e.g. the
current p99 rounded up — the builder decides whether to include any).
Numbers that are part of a label — a request named `Step 2`, a status code
inside an error message — are allowed when they occur inside that label's
own text. On failure the worker retries ONCE, telling the model which numbers
were not in the facts; a second failure stores the attempt as `failed` with
the reason, and the card says the analysis could not be produced.

### 4. Storage and staleness

One row per run in a new table `run_ai_analysis`: status (`pending`,
`ready`, `failed`), the validated content (jsonb), provider and model, a
facts version, the failure reason, requested-by user, created and generated
timestamps. Cascades from `run`.

**Stale** means the run's stored statistics were rewritten after the
analysis was generated: its `recomputed_at` or `ingested_at` is later than
the analysis's generated time. The card then says the figures changed since
it was written and offers to generate it again. That is the one case where
generating again is offered; otherwise, like GE, there is no regenerate.
A facts-version bump in a release does NOT make analyses stale (an upgrade
must not invite paid regeneration across an install); the stored version is
a record. A verification `mismatch` does not make it stale either — the
figures the analysis cites are the figures the page shows — but no NEW
analysis is generated while a run's verification reads `mismatch`.

### 5. API

- `GET /v1/runs/{id}/ai-analysis` — read scope (session or bearer), any
  project role. Answers `{ available: false, reason }` (`not_configured`,
  `org_disabled`, `not_terminal`, `no_statistics`, `estimated`,
  `verification_mismatch`) or the row's state and content. `estimated` is a
  run whose statistics predate exact statistics (never recomputed, or retired
  with a `recompute_error`): the design promises exact numbers and those runs
  cannot keep it, so they get no card.
- `POST /v1/runs/{id}/ai-analysis` — session only, `run:analyze`, lowest
  role **member** (it spends the operator's money; a viewer can read the
  result). 202 with the pending state; a second POST while pending, or on a
  ready and non-stale analysis, answers the existing row rather than
  enqueueing again.

### 6. The card

On the run Summary **below the verdict band and the run's totals, above the
charts** — the user's ruling, deliberately not GE's position (GE puts it above
the lifecycle strip). The verdict and the numbers stay the first screen, which
`mobile.spec.ts` (7.6px of headroom on a phone) and `run-tables.spec.ts`
(totals inside 900px) hold; neither bound moves. So the card mounts in
`RunSummary`, not `RunShell`. Styled with the existing card primitives and the
clean-UI rules: no description line, the "generated" fact and the model behind an ⓘ.
States: button; "Analysing…" while pending (polling, not a live region that
re-announces); the three sections, each collapsible, all open on arrival;
failed, with the reason in one sentence and a retry for a member; stale. The
card's title says it is AI-generated, and one ⓘ says every number was checked
against this run's figures. It renders on every viewport, phones included:
it is text, and text is what a phone can show (the glossary precedent),
unlike the charts §22.6 withholds below 768px.

## Decided, and by whom

- GE parity overrides PRD §25's phase order for this card — **the user**,
  2026-11-02.
- PRD §25's other rules stand: never gating, opt-in, self-hosted support —
  **the user**, same day.
- Card below the verdict band and totals, not GE's position — **the user**.
- Opt-in is the operator's env var AND an admin's org switch, off by
  default — **the user**.
- Not editable, over PRD §25's "always editable" — **the user**.
- The real check uses the user's own Anthropic key, put in `infra/.env` by
  the user — **the user**.
- Claude Opus 5.5 is the default model; an operator may name another —
  **my call** (the current default model; `AI_MODEL` overrides).
- Member to generate, any role to read — **my call**.
- Regenerate only when stale; stale = statistics rewritten after generation,
  never a facts-version bump — **my call**.
- Error shares are of recorded errors, as the page shows — **my call**.
- No card on estimated runs or while verification reads `mismatch` — **my
  call**.
- No spending cap beyond one generation per run — **my call**.
- Shown on phones — **my call**.

## Left to the builder

- Where the facts module lives, its exact fact list beyond the minimum above,
  and the number-extraction rules' implementation.
- The system prompt's wording and the output schema's exact length bounds.
- Timeouts, `max_tokens`, effort level, and the retry's wording.
- PR boundaries (a backend PR and a UI PR is the natural cut).
- How the e2e suite fakes a provider (a stub server behind
  `AI_BASE_URL` is the obvious route). The real check is fixed: one real
  Claude generation on a fresh real Gatling run, with the key the user puts in
  `infra/.env`, every number read against that run's Report, before merge.
