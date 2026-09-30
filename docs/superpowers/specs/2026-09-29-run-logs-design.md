# Run logs

**Status:** approved 2026-09-29, in chat, section by section.
Backlog item #6 of the Gatling Enterprise comparison: a Logs tab on the run
page, for runs the on-prem runner executed, showing the run's own lifecycle
events the way Gatling Enterprise's Logs tab shows its orchestration events.
One table, three writers, one run-scoped endpoint, one widened identity field
and one tab.

## What Gatling Enterprise does, measured

Read from the user's own cloud.gatling.io account on 2026-09-29, read-only,
on two finished runs: a 2-minute no-code run and a 3-second JVM run.

| Aspect | What it does |
|---|---|
| Where | a Logs tab beside Summary and Report, at its own route (`…/runs/<id>/logs`), icon `terminal` |
| Panel | one dark, monospace block of lines; nothing else on the tab |
| A line | `[17:11:11.113 GMT+5:30] [gatling-enterprise] Start requested.` — local time to the millisecond with the zone offset, a source in brackets, the message |
| Sources | the component speaking: `gatling-enterprise`, `stats-aggregator`, `control-plane`, and each load generator by its address (`13.36.241.219`) |
| Phases | separator lines IN the log: `---\| Deploying \|-----…`, `---\| Injecting \|-----…`, `---\| Ending \|-----…` |
| Colour | timestamps blue; quoted values (`'Europe - Paris'`) and numbers highlighted |
| Content | orchestration events only — start requested, the simulation class, the package (with its size on a JVM test), deploy, `Gatling process started and ready to inject traffic`, `Run injection ended with reason 'Run completed normally'`, run ended. **No JVM console at all**, on either test type |
| Controls | none: no search, filter, download, copy, wrap or follow. The run's `⋮` menu holds Share public link, Create custom report, Delete run — nothing about logs |

The no-code run's log, whole:

```
[17:11:11.113 GMT+5:30] [gatling-enterprise] Start requested.
[17:11:11.225 GMT+5:30] [gatling-enterprise] Starting the simulation: 'io.gatling.enterprise.probe.simulations.NoCodeSimulation'
[17:11:11.234 GMT+5:30] [gatling-enterprise] Using package: 'no-code'
[17:11:11.239 GMT+5:30] [gatling-enterprise] Launching the stats aggregator (may take about a minute).
[17:11:13.464 GMT+5:30] [gatling-enterprise] Stats aggregator start requested.
[17:11:49.143 GMT+5:30] [stats-aggregator] Stats aggregator started successfully
[17:11:49.379 GMT+5:30] ---| Deploying |------------------------------------------------------
[17:11:49.394 GMT+5:30] [stats-aggregator] Request deployment to locations: 'Europe - Paris'
[17:11:49.970 GMT+5:30] [control-plane] Deploying locations: 'Europe - Paris' (1 load generator)
[17:12:04.100 GMT+5:30] [13.36.241.219] Load generator '13.36.241.219' deployed, starting gatling process
[17:12:04.115 GMT+5:30] [stats-aggregator] Load generators are all deployed, waiting for all gatling processes to be started
[17:12:09.198 GMT+5:30] [13.36.241.219] Gatling process started and ready to inject traffic
[17:12:09.231 GMT+5:30] ---| Injecting |------------------------------------------------------
[17:12:09.250 GMT+5:30] [stats-aggregator] Request run start
[17:12:11.281 GMT+5:30] [13.36.241.219] Run started: '13.36.241.219'
[17:14:10.419 GMT+5:30] [13.36.241.219] Run injection ended with reason 'Run completed normally' for: '13.36.241.219'
[17:14:10.464 GMT+5:30] ---| Ending |------------------------------------------------------
[17:14:10.475 GMT+5:30] [stats-aggregator] Run injection ended for all load generators
[17:14:10.487 GMT+5:30] [13.36.241.219] Run ended, no after-hook was defined: '13.36.241.219' (0 remaining)
[17:14:10.697 GMT+5:30] [stats-aggregator] Run ended for all load generators
[17:14:10.884 GMT+5:30] [stats-aggregator] Stats aggregator shutting down
```

## Decisions taken, and the ones declined

- **Runner runs only, now.** Only on-prem runner jobs pass through a process
  PerfPortal controls from start to end. Capturing anything for Gradle-plugin
  and upload runs is a separate, later sub-project (a new ingest path in the
  Kotlin plugin, the bundle and storage), not part of this change.
- **Events only — an exact copy of GE's content.** The tab shows the run's
  lifecycle events, never Gatling's console. Declined: showing the console
  (the runner's job log already holds it, on the New on-prem run page), and
  showing both. A consequence worth keeping: the runner's job log records the
  full Gatling command line, every `-D` value included, and none of it reaches
  the run page.
- **An events table, not lines in the job log file, not derived timestamps.**
  Structured rows are testable, need no filesystem shared between API and
  runner, and go with the job at retention. Deriving events from stored
  timestamps was declined: it would largely repeat the lifecycle strip and
  cannot say what GE says (an injection's end reason).
- **The tab exists only on runner runs.** This repo's rule is that a control
  over a section that can never have content is a false claim, so it is
  withheld rather than shown empty. A runner run from before this change still
  gets the tab, with an explained empty state.
- **No controls**, as GE has none. Declined for now: search, download, follow.

## The events

Each event is `(at, source, message, phase)`. `phase` is null for an ordinary
event and names the phase for a separator row, which carries no message of
its own. Wording is GE's wherever the moment exists here.

| When | Writer | Source | Message |
|---|---|---|---|
| Job queued (and retried) | API, in the job's transaction | `perfportal` | `Start requested.` |
| | | `perfportal` | `Starting the simulation: '<simulation class>'` |
| | | `perfportal` | `Using package: '<artifact name>' (<artifact size>)` |
| Job claimed | runner | `runner` | `Claimed by the runner on '<host>'` |
| | runner | — | phase `Deploying` |
| Package extracted | runner | `runner` | `Package prepared` |
| Process spawned | runner | `runner` | `Gatling process started and ready to inject traffic` |
| | runner | — | phase `Injecting` |
| Gatling exits | runner | `runner` | `Run injection ended with reason '<reason>'` |
| | runner | — | phase `Ending` |
| Close | runner | `runner` | `Run ended` |
| Cancel requested | API | `perfportal` | `Cancel requested.` |

`<reason>` is one of `Run completed normally` (exit 0), `Gatling exited with
code <n>`, `Gatling was terminated by <signal>`, `Cancelled`.

The unhappy paths end on their outcome rather than stopping mid-list:

| Path | Final event (source `runner`) |
|---|---|
| UID isolation refused | `Run failed: RUNNER_UID_ISOLATION_REQUIRED: <message>` |
| Cancelled before the run opened, before launch, or mid-run | `Cancelled before the run opened` / `Cancelled before Gatling started` / `Run injection ended with reason 'Cancelled'` then `Run ended without results` |
| Gatling produced no simulation.log | `Run failed: <code>: <message>` |
| Run closed with no data | `Run ended without results` |
| Any other failure | `Run failed: <code>: <message>` |

A job that fails before its live run opens has no run and therefore no run
page; its events are still recorded against the job.

**Never in an event:** the command line, `javaOptions`, any system property
name or value, the artifact's storage key. The simulation class and the
artifact's own name and size are the only job parameters an event names.

Messages are capped at 2,000 characters, the excess replaced by `…`.

## Data

A new table, `runner_job_event`:

| Column | Type | Notes |
|---|---|---|
| `seq` | `bigint GENERATED ALWAYS AS IDENTITY` primary key | the ORDER; two events in one millisecond keep the order they were written in |
| `job_id` | `uuid` not null | `REFERENCES runner_job(id) ON DELETE CASCADE` |
| `org_id`, `project_id` | `uuid` not null | tenant scoping on every read, the rule every repository follows |
| `at` | `timestamptz` not null default `now()` | an instant, so `timestamptz` (CLAUDE.md: Prisma and node-postgres disagree about a bare `timestamp`) |
| `source` | `text` not null | `CHECK (source IN ('perfportal', 'runner'))` |
| `message` | `text` null | null exactly for a phase row |
| `phase` | `text` null | `CHECK (phase IN ('Deploying', 'Injecting', 'Ending'))`; exactly one of `message`/`phase` is non-null |

Index `(job_id, seq)`. It reaches `org` through `runner_job`'s cascade, so
`infra/test/fk-free-tables.sql`'s closure covers it without being named; it
joins `SCHEMA_TABLES` so every suite truncates it.

**Retention:** the runner's retention sweep deletes old `runner_job` rows and
the events go with them. From then the run has no runner job, `runnerJobId`
is null, and the tab disappears — exactly as the lifecycle strip's Queued step
already does. Stated, not fixed.

## The three writers

- **API, at queue and retry.** `RunnerRepository.createQueued` and
  `RunnerRepository.retry` each insert the three queue events inside the
  transaction that inserts the job, so a job never exists without them and a
  failed insert leaves none. `retry` is a hand-written `INSERT..SELECT`; it is
  the second writer this repository keeps finding one short.
- **API, at cancel.** The cancel handler writes `Cancel requested.` for a job
  it actually moved (a no-op cancel writes nothing).
- **Runner, at each step.** Through a `RunnerRepository` method, best-effort:
  a failed insert is logged to the job log and never fails the job. These
  events exist to explain a run; a database hiccup must not cost somebody the
  load test they are trying to watch. This is a deliberate choice of silence
  over failure, and the only one in this change.

## Contract (`packages/contracts`)

- `RunEventSchema`: `{ at: string (datetime), source: 'perfportal' | 'runner',
  message: string | null, phase: 'Deploying' | 'Injecting' | 'Ending' | null }`.
- `RunEventsResponseSchema`: `{ runId, recorded: boolean, events: RunEvent[] }`.
  `recorded` is false when the run has no runner job.
- `RunIdentity.runnerJobId`: `string (uuid) | null`, `.nullable().optional()`
  — the rolling-deploy reason `activityMs` already argues: the browser drops a
  body that fails the schema, so a required field would blank the run page
  for every response from a pod that predates it.

## API

- `GET /v1/runs/{id}/events`, `@Scopes('read')`, on a controller at
  `@Controller('/v1/runs/:id')`. It resolves the run in the caller's tenant
  (404 otherwise, never 403), finds its job through `runner_job.run_id`, and
  returns that job's events in `seq` order.
- By sitting under that prefix it joins the two derived guards the repository
  already has: the cross-org case list in `session-auth.integration.test.ts`
  and the route/document join in `openapi.integration.test.ts`. Both must fail
  until the route is covered — that is how they are meant to be used.
- `runnerJobId` comes from `RunsService.lifecycleOf`, which already queries
  the job by `run_id`; both identity builders (`toResponse` and the 202 a live
  run is read through) take it from there. The 202 is the one a reader is
  watching while the run streams, which is the `warmupMs` lesson: the guard for
  the 202 is written first.

## The web app

- **Tab:** `Logs`, after `Errors`, icon `terminal`, rendered only when the
  run's identity carries a `runnerJobId`. Route `runs/:runId/logs`, path helper
  `runLogsPath`, a lazily-loaded `RunLogs` component, like the other tabs.
- **Panel:** one block, dark in both themes as GE's is, monospace. Each event
  is one line: `[HH:MM:SS.mmm GMT±H:MM] [source] message`, the time in the
  viewer's own zone (per call, never a module-scope `Intl.DateTimeFormat` —
  CLAUDE.md's Asia/Kolkata trap). A phase row renders as
  `[time] ---| Injecting |-----…` with the dashes filling the line as GE's do.
  Timestamps take the chart tokens' blue; quoted values and numbers are
  highlighted. Colours come from tokens, never literals.
- **Live:** while the run is not terminal the events are refetched every 2 s;
  once it is terminal, one more fetch, then none.
- **Empty state:** a runner run with no events recorded reads "No events were
  recorded for this run — it ran before PerfPortal began recording them." No
  other state is reachable: a run with no runner job has no tab.
- **Accessibility:** `role="log"` on the panel, so a screen reader announces
  new events politely; the tab is a `NavLink` like its siblings.

## Tests, and what each must be seen failing for

Every case is written first and seen failing, from a checkpoint commit.

- **Contracts:** the event and response schemas; `runnerJobId` absent still
  parses (the rolling-deploy case), present-and-null parses, a non-uuid fails.
- **Persistence:** `createQueued` and `retry` each write the three queue events
  in the job's transaction (a failed job insert leaves none); events list in
  `seq` order and are tenant-scoped; deleting the job deletes its events; the
  one-of `message`/`phase` check refuses both and neither.
- **Runner:** the exact event sequence on each path — success, non-zero exit,
  signal, cancelled before open / before launch / mid-run, UID refusal, no
  simulation.log — and an event insert that throws, where the job still
  completes and the failure is in the job log.
- **No parameters leak:** a guard that no event of a job whose `javaOptions`
  and system properties carry distinctive values contains any of them.
  Red-verified by putting the command line back into an event.
- **API:** the endpoint answers a runner run's events in order and
  `recorded: false` with no events for an upload run; 404 across orgs; both
  identity builders carry `runnerJobId` (the 202 first); the derived guards
  pick the route up by its existence.
- **Web:** the line format with the zone pinned, and again under `TZ=UTC`;
  the phase row; the empty state; `role="log"`; the tab present only with
  `runnerJobId`; polling stops once the run is terminal.
- **e2e:** a seeded runner job with events linked to a run — the Logs tab
  shows its rows and phases; an upload run has no Logs tab.
- **Real run:** a real Gatling job through the real on-prem runner, its tab
  read while it streams and after it finishes. No suite can stand in for this,
  and it is how the plugin's missing test grouping was found.

## Not in this change

- Any log for Gradle-plugin or upload runs (the later sub-project above).
- Gatling's console anywhere on the run page.
- Search, filter, download, copy, follow.
- Backfilling events for runner jobs that ran before this change.
- Keeping events past the runner's retention.
- Redacting the job log file itself (a separate problem: it holds the command
  line with every `-D` value, and it is what the New on-prem run page shows).
