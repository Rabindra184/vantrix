# Run lifecycle strip

**Status:** approved 2026-09-26. Details were sharpened while writing the
plan, from reading the code and measuring the page: a failed run never
reaches the strip; what "stopped early" keys on and where it ends; an
incomplete run with nothing retained; where Received's gap is stated; the
Verdict step's exact words; the phone variant, which the measured fold
budget forced (one line, no verdict); and three wire fields rather than four,
because the fourth lost its only reader. Each is stated in place below.
Backlog item #2 of the Gatling Enterprise comparison. Contract-widening
(three optional `RunIdentity` fields) plus one new run-page component; no
migration.

## The change

The run page gains a strip that walks the run's journey through PerfPortal in
time order — each step with its outcome and how long it took — with a "Step
times" disclosure holding each step's start and end to the second. It sits in
its own row between the header and the decision band, and the band gives up
its Execution row, whose two sentences the strip now states with timings.

## Why

A reader asking "where did the time go" or "did this fail at ingest or at the
gate" has today one status word, one verdict word, and the Started and
Duration chips. PerfPortal already stores every timestamp the answer needs —
received, processing started and ended, the stream's last chunk, the moment a
dead stream was given up on, and for on-prem runs when the job was queued —
and publishes two of them. It is the run-list shape again: the data exists and
the contract throws it away.

## What Gatling Enterprise does, observed

On cloud.gatling.io the run page opens with
`Build successful ❯ Deployed · 14s ❯ Assertions failed · 2m 00s`: its own
pipeline in order, each step with an outcome and a duration. Expanded, each
step becomes a bar carrying an outcome colour, a duration, and its own start
and end wall-clock times. Its Logs tab separates the same phases
(`---| Deploying |---`, `Injecting`, `Ending`).

PerfPortal's steps are not Gatling's — it neither builds nor deploys — so the
SHAPE is copied (ordered steps, outcome and duration each, expandable to
start/end times) and the steps are PerfPortal's own.

## The steps

Derived from stored timestamps only; nothing is estimated. A run shows only
the steps its path has:

| Path | Steps |
|---|---|
| On-prem runner | Queued ❯ Load test ❯ Processing ❯ Verdict |
| Live stream (Gradle plugin) | Load test ❯ Processing ❯ Verdict |
| Uploaded bundle | Load test ❯ Received ❯ Processing ❯ Verdict |

A run came from the RUNNER when `queuedAt` is set. It was STREAMED when it
is `running` or `incomplete`, or carries `streamUpdatedAt`: only a stream can
end incomplete (the sweeper's `running` arm, or a close with no bytes), so the
status alone decides it for a row with no stamps, like the e2e suite's seeded
incomplete run. Otherwise it was UPLOADED.

- **Queued** — the runner job's `created_at` until the runner opened the run
  (`startedAt`). Runner runs only, and always done by the time a run page
  exists: the run is created at the moment the runner opens it.
- **Load test** — the test's own start (`toolStartedAt`) plus
  `activityMs ?? durationMs`, the expression `RunHeader`'s Duration chip
  computes, so the page shows one number under one word.
  - Streaming: the active step, "streaming · 42s", measured from the run's
    open (`startedAt`) to its last accepted chunk (`streamUpdatedAt`) —
    advancing with each identity refresh (every 5 s), never by a client clock.
  - An `incomplete` run's load test reads "stopped early". It ENDS where the
    test did: the processed partial log's own span when there is one, else
    the last accepted chunk — the producer's last sign of life. Never at the
    moment the sweeper gave up on it (`stream_abandoned_at`), which would
    count the silence before the give-up as load; that silence shows in Step
    times as the gap before Processing, which the sweeper starts in the same
    statement.
  - An upload's test ran before PerfPortal saw anything; until the bundle is
    parsed the step cannot know its span and reads "known once processed".
- **Received** — uploads only: the instant the bundle arrived (`startedAt`).
  Once the bundle is parsed and the test's span is known, its Step times row
  also says how long after the test's end that was — the gap that makes the
  Started chip (ingest time) differ from the test's own start. The strip
  itself just says "Received", to stay short.
- **Processing** — `parsingStartedAt` to `ingestedAt`, ending "processed".
  An `incomplete` run whose log never became statistics reads "nothing
  retained", the words the statistics table already uses for it: either
  nothing arrived to process (no `parsingStartedAt` — the sweeper finalized
  it in place, or a close carried no bytes), or the sweeper's assembly found
  nothing decodable (processing began, but no `durationMs` was ever
  measured).
  - A FAILED run never reaches the strip: `GET /v1/runs/{id}` answers it with
    the ingest problem (400 or 413), and the page shows that problem and its
    remediation instead of the run shell. `lifecycle.ts` still maps `failed`
    to "processing failed", defensively, and says why.
  - An upload the worker has not picked up yet (status `pending`, no
    `parsingStartedAt`) reads "waiting for a worker since 22:10" — the
    "stuck at pending and nothing on screen says why" state
    `running-perfportal-locally` warns about.
  - For a streamed run, `parsingStartedAt` is stamped at close
    (`claimForClose`), so the step starts when the stream ended.
- **Verdict** — `Verdict: <word>`, the word being the band's own big word
  verbatim (Passed, Failed, Not configured, Not evaluated), from one function
  both import, so the strip and the band can never describe one verdict in
  two vocabularies. Until the run is judged the step is pending and reads
  just "Verdict".

**States.** Each step is done, active, pending (not reached yet) or failed.
After a failure the later steps stay pending, drawn muted. The strip renders
for every run status, live included.

## The contract

`RunIdentitySchema` gains three fields, all `.nullable().optional()`: the
browser drops any body that fails its schema, so a required field would blank
the run page for a whole rolling deploy (the argument `activityMs` and `sla`
already make).

| Field | From | Null when |
|---|---|---|
| `parsingStartedAt` | `run.parsing_started_at` | not yet processing |
| `streamUpdatedAt` | `run.stream_updated_at` | an upload, or a stream with no chunk yet |
| `queuedAt` | the runner job's `created_at`, joined on `run_id` (`runner_job_run_id_idx`) | the run did not come from the on-prem runner |

`startedAt` (received) and `ingestedAt` (processing ended) are already on the
wire and unchanged.

**Not added: `streamAbandonedAt`.** The first cut published it to end an
abandoned stream's load test at the sweeper's give-up. That end was wrong
(see Load test above), and with it gone the field has no reader: `streamed`
is already decided by the status or the last chunk, and processing's start
is `parsingStartedAt`, which the sweeper stamps in the same statement. A
field nothing reads is surface to keep correct for no one.

**Both identity builders send all three**: `runs.service.ts`'s terminal
identity and the hand-written 202 projection in `runs.controller.ts` that a
pending, parsing or running run gets. A field reaching only the first would be
missing exactly while a run is live — the defect CLAUDE.md records for
`warmupMs`, fixed then by one shared helper (`warmupMsOf`). The runner lookup
is likewise shared so neither builder can drift.

**Nothing is derived server-side.** The OpenAPI schema follows from zod, and
the document's "every response validates" sweep covers the new fields.

**Not added:** separate claimed and starting times for runner jobs. The job
keeps only `created_at` and an overwritten `updated_at`; Queued stays one step
rather than earning a column and a migration.

## On the page

- **Two units.** `apps/web/src/routes/lifecycle.ts` is a pure function from a
  run's identity to its ordered steps (name, state, outcome word, start, end,
  duration) — the way `window.ts` holds the time window's math.
  `apps/web/src/routes/RunLifecycle.tsx` draws them. `RunShell` mounts it
  between `RunHeader` and `RunDecisionBand` for every status.
- **The strip** is an ordered list (`<ol>`; the order is a real sequence)
  inside `<section aria-label="Run lifecycle">`. **No heading**: the Overview
  tab's heading outline is asserted as an exact list and shell chrome must not
  add to it. Each step's state is carried by its outcome word and a mark from
  `marks.tsx`, never by colour alone; colours are the status tokens, applied
  the way the repo already does. Durations use `formatDuration`.
- **Step times** is a `<details>` beside the strip holding a small table of
  each step's start, end and duration: times of day to the second in the
  viewer's zone (`formatClockTime`, the axis's own notation), with the date
  and the zone (`formatZoneOffset`, at the run's own start) stated once in
  the table's caption. The list stays
  OUTSIDE the `<summary>`, whose contents lose their semantics for a screen
  reader. The times are absolute; the Offset/Datetime axis mode does not
  touch them.
- **The decision band drops its Execution row.** Its sentences move into the
  strip rather than disappearing: "the stream stopped early" becomes the Load
  test's outcome, and "could not be processed" the pure function's defensive
  failed branch (unreachable on the page today, as above).
- **Compact viewports** (below 768 px) show ONE line under the header: the
  furthest step reached — `Processed · 2s`, `Load test · streaming · 42s`,
  `Waiting for a worker since 22:10` — with "Step times" beside it and every
  step inside. No card, and no verdict step. MEASURED, not chosen: at
  375x812 the run's first total starts at y=802 against `mobile.spec.ts`'s
  812 bound, and removing the band's Execution row gives back 22 px. A
  carded row in the shell's 24 px column gap would cost ~70 px (totals near
  850); one 16 px line grouped 8 px under the header costs 24 (804). The
  verdict is the band's 36 px word directly below the line, and M02 already
  removed exactly that kind of restatement from the phone.
- **Placement.** `RunShell` groups the header and the strip in one block —
  12 px apart on a desktop, 8 on a phone — so the strip reads as part of the
  run's identity, the way Gatling Enterprise sets its strip directly under
  the run's title. The shell's 24 px gap then separates that block from the
  decision band. Desktop measured at 1440x900: the first total at y=733
  today, ~769 with the strip, against `run-tables.spec.ts`'s 900.

## Edge cases

- **A run crossing midnight**: a Step times cell whose date differs from the
  caption's carries its own date, so the wrap is never ambiguous.
- **Clock-skewed stamps** (a step ending before it starts, from two clocks):
  the duration is shown as unavailable rather than negative.
- **Legacy rows** (processed before a column existed, so a stamp is null): the
  step reads what it can, and a missing start or end shows as a dash in Step
  times rather than a guessed value.
- **A runner job that failed before opening a run** has no run page, so the
  strip never has to draw a Queued step with no run after it.

## Testing

Unit, every case red-verified before it is trusted:

- `lifecycle.ts` across each path and each state, including a stream in
  progress, an abandoned stream, the defensive failed branch, an incomplete run with nothing retained, an upload
  waiting for a worker, and an upload not yet parsed — pinned to
  `Asia/Kolkata` with the pin asserted, and also run under `TZ=UTC`.
- Agreement rather than literals: the Verdict word equals the band's own word
  for each verdict, and the Load test's duration equals the Duration chip's
  number.
- `RunLifecycle`: list semantics, no heading, outcome as text and mark, Step
  times outside the `<summary>`, the compact variant.
- The band's two Execution tests re-pointed at the strip, not deleted.
- The contract: an identity without the new fields still parses.

Integration: the three fields read through the real API on both builders — a
running live run on the 202, a stream being closed, a finished upload, an
incomplete stream, and a runner run's `queuedAt` both live and finished.
Red-verified by dropping them from each builder in turn.

End to end: a seeded run shows the strip and its Step times, and the band has
no Execution row; `run-list.spec.ts`'s incomplete-run case re-pointed to the
strip's "stopped early"; the fold bounds re-measured — the first run total
above 900 px at 1440x900 (`run-tables.spec.ts`, y=733 today) and within
812 px at 375x812 (`mobile.spec.ts`, 802 today, 804 expected);
`run-detail.spec.ts`'s pending-run case, which asserts the page draws no
table, still passes with the strip's Step times table closed.

Real runs: the strip checked on the developer database's real Gatling runs
(live and uploaded paths), plus one real on-prem runner run for the Queued
step.

## Deliberately out of scope

- Runner claim and start timestamps (a migration; see "Not added").
- A Logs tab (backlog item #6, which needs a scope decision first).
- Showing the lifecycle on the run list.
- Changing the header's Started and Duration chips.
