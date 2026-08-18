# Working in this repository

## Branching and publishing

**Branch from `main`, work, open one PR back to `main`.** That is the whole
workflow. Merge with a merge commit (`--merge`), never squash: the commit
messages here carry reasoning, and collapsing them loses it.

**Do not create a `publish/*` branch.** Sub-projects M0 through M3-piece-3 used
one: each `feat/*` branch was cherry-picked onto `main` commit by commit with
`docs/` and `PerfPortal_Enterprise_PRD.md` stripped, leak-checked, and verified
from a clean install before its PR. That existed for one reason — keeping the
internal specs and the PRD off a public repository.

**That reason is gone.** On 2026-08-14 the four `feat/*` branches and the
`internal/pre-publish` tag were pushed to `origin`, deliberately. The PRD and
`docs/superpowers/` are public. Stripping them from `main` now protects
nothing, and the machinery costs real time — the last sub-project lost most of
an afternoon to a stacked-PR retarget trap and repeated base-branch confusion,
all of it in service of a boundary that no longer exists.

The `publish/*` branches and PRs #1–#9 are kept as history. Do not extend the
pattern.

### If you ever do stack a PR

Merged branches are **not deleted** in this repository. GitHub only
auto-retargets a stacked PR when its base branch is deleted, so here it does
not: PR #8 sat pointing at `publish/parity-charts` after that branch had
merged, and merging it would have landed the work on a side branch with no
error. Retarget explicitly before merging:

```
gh pr edit <N> --base main
```

PR #8's own description claimed the retarget would happen automatically. It was
wrong. Verify against the server (`git ls-remote origin refs/heads/main`)
rather than trusting a PR body or a merge click.

## Verification

**Use the Node in `.nvmrc` (22). On Node 20 the unit suite silently skips every
DOM-environment file.** jsdom 30 pulls an undici whose
`webidl.util.markAsUncloneable` does not exist on 20, so every component test —
i.e. exactly the ones a UI change needs — throws while LOADING. Vitest reports
those as `Errors` on a separate line from `Test Files`, and prints a confident
`Test Files N passed (N) | Tests M passed (M)` above them, counting only the
files that did load. A green-looking local run then fails in CI, which is on 22.

Only the RATIO matters, and it is roughly two thirds of the suite vanishing: on
Node 20 this was once measured at 47 of 67 files, 534 tests. Do not calibrate
against those absolutes — they were true of a smaller suite and are recorded
only to show the scale of what disappears.

`nvm use` first, and if a run reports fewer than **99 files / 1079 tests**, it
did not run everything. (Update those two numbers when a sub-project adds
suites, or the next reader calibrates against a stale floor and a
silently-skipped run looks like a pass. Last measured on the fold owner's
whole-branch review fixes, which added `packages/storage/test/blobs.test.ts`
(2, the black-hole socket case that catches `requestTimeout` being the wrong
option), `apps/worker/test/replay-cap.test.ts` (4, the replay stream's byte
budget) and `apps/worker/test/shutdown.test.ts` (3, a designed
`AggregateError` not being allowed to crash SIGTERM) as new files, plus 5
`withConnectionLimit` cases to `packages/persistence/test/client.test.ts` for
Prisma's own, previously unsized pool — from a floor of 96 / 1065. That
sub-project's own additions were `apps/worker/test/config.test.ts` (12),
`packages/persistence/test/client.test.ts` (3),
`packages/contracts/test/live-delta.test.ts` (9), and
`apps/worker/test/live-delta.test.ts` (9) as new files, plus 3 cases to
`apps/worker/test/retry.test.ts` — one for `PipelineService`'s own
`RUN_LOCKED` signal, one for pg-pool's own connect-timeout error, and one
proving an unrelated bare `Error` still reads as deterministic — from a floor
of 92 / 1029 — and that one from §22.6's mobile summary, which added
`DesktopOnly.test.tsx` (6) and `useIsCompact.test.tsx` (6), from a floor of
90 / 1017 — and that one from live run monitoring
part 1's review fixes, which added 2 cases to
`packages/plugin-gatling/test/stream.test.ts` — one pinning `consumedBytes`
against the last whole-record boundary, one pinning that the decoder's
retained buffer is bounded by the chunk rather than by the run — from a
floor of 90 / 1015. That sub-project's own additions were
`packages/statistics/test/live-engine.test.ts` (3),
`packages/statistics/test/chunk-invariance.test.ts` (2),
`packages/plugin-gatling/test/stream.test.ts` (3), and
`packages/contracts/test/live.test.ts` (10), plus 4 truncation-bounds cases
added to `packages/plugin-gatling/test/reader.test.ts`, from a floor of
86 / 993 — and that one from the shared time axis, which added
`apps/web/test/timeAxis.test.ts` (8) plus 3 axis cases to `Chart` and 3 pair
cases to `tooltip`, from a floor of 85 / 979 — and that one from the G-05
assertion decoder and evaluator, which added
`packages/plugin-gatling/test/assertions.test.ts` (6) and
`packages/statistics/test/tool-assertions.test.ts` (12), from 83 / 961. Earlier
floors: the standalone-errors fix (G-17) 83 / 957, the chart-controls pass
83 / 954, the run-timestamp fix 83 / 954, the time-brush fix 82 / 936, and
81 / 931 through `feat/telemetry-agent`. No fix's e2e or integration cases are
in this count: `pnpm test:unit` runs neither.)

`pnpm test:unit` does **not** run the integration or e2e suites —
`vitest.config.ts` excludes `*.integration.test.ts` and `*.e2e.test.ts`. A
change to anything the API consumes by name can pass every unit gate and still
break `apps/api/test`. Before claiming a sub-project complete:

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

`test:integration` and `test:e2e` need the local stack:

```
docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
export REDIS_URL=redis://localhost:6380
export S3_ENDPOINT=http://localhost:9000
export S3_ACCESS_KEY=perfportal
export S3_SECRET_KEY=perfportal123
```

**No compose service here has a volume, so EDITING one destroys its data.**
`docker compose up -d` recreates a container whose service definition changed,
and with no volume the recreated container starts empty — the edit does not
have to be about storage, it just has to be an edit. Postgres is the one that
hurts: you get a running server with no schema, and `test:integration` fails on
missing relations rather than on anything you changed. This has already
happened once, to everyone who pulled the `max_connections=200` line
(`infra/docker-compose.yml`) that live monitoring's connection budget needed.
After any change to that file, assume the database is gone and re-run:

```
pnpm --filter @perfportal/persistence exec prisma migrate deploy --schema prisma/schema.prisma
```

CI never sees this — `.github/workflows/ci.yml` declares its own service
containers and does not read the compose file. Which also means a compose-only
fix is invisible to CI: the `max_connections` override cannot be expressed as a
GitHub Actions service container, so CI still runs Postgres at the stock 100.

Never run `pnpm test:integration` while `scripts/capture-chart-fixture.mjs` is
capturing: that suite truncates every table on setup and will delete the org
the capture just seeded, mid-run.

**The same applies to `pnpm test:e2e` — so run the gate in its documented
order, integration BEFORE e2e, and not the other way round.** Playwright's
`webServer` and the worker it starts do not stop the instant the last spec
passes, and `test:integration` truncating every table underneath a
still-draining queue produces a failure that reproduces on nothing. Seen once,
running the two ad hoc in the reverse order, as a bare `exit 1` with no
reported failing test, then two clean 814-test runs in a row. If integration
fails right after an e2e run and the tail shows no failing assertion, re-run it
alone before believing it.

**There is now a second gate, and `pnpm` does not run it.** The load-generator
telemetry agent is Go, lives at `agent/`, and is outside the pnpm workspace —
so `pnpm lint`, `pnpm typecheck` and every `pnpm test:*` are all blind to it:

```
cd agent && go vet ./... && go test ./... -race
```

`-race` is not optional here. The agent's whole design is a sampler goroutine
writing to a bounded buffer a sender goroutine drains; a data race in that pair
is the one defect class its tests exist to catch, and the race detector is what
makes those tests able to catch it.


## Conventions that bite

**Expectations are computed from the payload, never written down.** A test that
hard-codes a value `apps/web/test/fixtures/reference-run.json` supplies breaks
on the next re-capture for a reason that is not a defect. Derive it.

**`?name=X` without `scope` is silently ignored.** The metrics endpoints force
`name` to `''` when `scope` is absent, so a scoped call missing `scope` returns
the whole run's data with a 200. Both parameters, always. Test the omission,
not just the correct call.

**An instant column must be `timestamptz`, because Prisma and node-postgres
disagree about a bare `timestamp`.** Prisma decodes `timestamp without time
zone` as UTC; node-postgres decodes it in the NODE PROCESS's local zone, and
serializes a JS Date PARAMETER in local time too. A column holding UTC by
convention therefore reads back differently depending on which client asked,
and both halves of that have already shipped here: the worker passes
`tool_started_at` as an ISO string to survive the write side
(`pipeline.service.ts`), and `GET /v1/runs/:id/trends` — the one read that goes
through the raw pool (`TRENDS_SQL`) — reported a start time 5h30m off the
`GET /v1/runs/:id` value for the same row on an Asia/Kolkata machine. **It is
invisible in UTC**, so CI can never catch it: a test comparing the two
endpoints passes on every runner regardless. `run`'s columns are timestamptz as
of `20260817000000_run_timestamps_are_timestamptz`; `telemetry_sample`'s always
were. The remaining bare-`timestamp` columns (`org`, `project`, `api_token`,
`org_member`, Better Auth's own tables) are read only through Prisma today —
put a raw-pool read on one and it is the same bug again.

**A test for a timezone bug must SET the timezone, and prove it took.** Node
honours `process.env.TZ` changed after startup, so the case can flip to
`Asia/Kolkata` mid-test — but on a UTC runner the offset is zero and a case
that merely compares two endpoints passes whether or not the bug is there.
`trends.integration.test.ts`'s zone case asserts the flip landed
(`new Date('…T00:00:00Z').getHours() === 5`) before asserting anything else, and
restores the old value in a `finally` — integration files share a worker
process (`fileParallelism: false`), so a leaked `TZ` becomes someone else's
mystery failure.

**A `type: 'value'` x-axis needs PAIR-shaped series, and scalars on one fail
silently.** `ChartData.series[].data` has two forms — one value per
`axisLabels` entry, or explicit `[x, y]` pairs — and `Chart` hands whichever it
is straight to ECharts. Give a value axis the scalar form and ECharts maps each
number onto BOTH axes: the chart plots the measure against itself, a straight
45° line, with both axes carrying the same range. It throws nothing and logs
nothing. `TimeBrush` did this for its whole life, and because the dataZoom
slider reports its handles in the AXIS' units, every drag committed a window in
rate values read as milliseconds — a drag over a third of a 63 s run produced
`?from=0&to=7`. When adding `xAxis={{ type: 'value' }}`, check the transform
emits pairs (`toErrorSeries`, `toPercentileDistribution` and
`toRequestRate(_, { x: 'ms' })` do).

**§22.6's mobile rule is the app's ONE JS breakpoint, and it has to be.** Every
other responsive decision here is a Tailwind class, and should stay that way.
Below 768px the run page is a read-only summary because "deep analysis is
explicitly a desktop task" — and a class can only HIDE the charts, leaving a
phone paying for ten ECharts instances, a statistics table of every request, and
the four payloads behind them, to display none of it. That is the "degrading
badly" the rule exists to prevent, so `useIsCompact()` decides and the charts
never mount. `DesktopOnly` takes its children as a FUNCTION for the same reason:
a node would be built before the component could decline it. Its `onShow` exists
because the withheld content usually needs data, and the caller's queries are
`enabled` on the same flag — leaving the decision inside would fetch payloads it
had just been told not to draw.

**A CONNECTED `axisPointer` ON A CATEGORY AXIS SYNCS BY INDEX, not by time.**
So charts sharing a crosshair (`Chart`'s `group`) point at the same INSTANT only
if their category lists are identical — and on a run page they are not:
`/series` is sparse (a second with no request produces no bucket at all), so the
reference run carries 62 response-time buckets against 63 user buckets, spanning
the same start and the same end. One payload has a hole in the middle, and every
index past it is a second out. The fix is that every time chart is now a VALUE
axis in milliseconds, pinned to one `[0, durationMs]` domain
(`useTimeDomainFromShell`) and labelled in seconds via `tickUnit`. **Adding a
time chart means pairs plus that domain, never a category axis** —
`timeAxis.test.ts` is the guard, and the failure it prevents is silent.

**Two things follow a value axis that are easy to miss.** A pair-shaped series
makes the tooltip print BOTH components (`"42000, 127.75 ms"`) unless the chart
declares `pairValue="y"` — right for a scatter, whose x is a measurement, wrong
for a time series, whose x is already the tooltip's title. And the axis
POINTER's label IS that title, so it needs the same unit formatting as the
ticks or the tooltip announces `49,000.00` above an axis reading `0..100`.

**A `<caption>`'s WORDS become the table's accessible name, and Playwright
matches names as a case-insensitive SUBSTRING.** So adding a table whose caption
merely mentions an existing table's subject breaks that table's query, in a file
you did not touch. `run-tables.spec.ts` reaches the statistics table with
`getByRole('table', { name: /statistics/i })`; the G-05 assertions table shipped
with a caption reading "…re-checked against this run's statistics", and five
specs failed at once on a strict-mode violation resolving two elements. Same
class as the `ProjectRail` collision below — the query was never wrong, the new
name simply collided with it. **Before adding a table, grep the e2e suite for
`getByRole('table'` and make sure your caption shares no distinctive word with
an existing one.**

**Sharing a transform does NOT share its colours — `roles` is a separate,
silently-optional prop.** `Chart` falls back to the six-hue categorical palette
whenever `roles` is absent, so a chart can consume the right numbers and draw
them in the wrong language with nothing failing. `TimeBrush` and `RatesChart`
both call `toRequestRate`, but only `RatesChart` passed `RATE_ROLES`
(`['neutral','passed','failed']`) — so the run page drew All/OK/KO as
grey/green/red in one figure and indigo/teal/**violet** in the figure directly
above it, with KO in a hue `rates.ts` explicitly reserves for "neither
outcome". Nothing threw, no test failed, and both components' own tests stayed
green because neither asserted colour. **When a transform exports a `*_ROLES`
constant, every chart built on that transform has to pass it**; `TimeBrush.test.tsx`
now pins that for this pair by asserting the emitted `color` array contains no
`CATEGORICAL` hue.

**The value axis' `name` and a top-anchored legend occupy the same band.** A
value axis draws its name one `nameGap` ABOVE the axis line — i.e. directly
above `grid.top`, exactly where `legend: { top: 0 }` sits. They always compete,
and on the percentile chart they collided at every width: at 1568px the `min`
swatch was drawn over `Response time (ms)`, and at 390px the wrapped legend
covered both the axis name and the topmost tick label. The legend is now
bottom-anchored and `type: 'scroll'` — one row, always, because a wrapping
legend has no bounded height and no reservation in `grid.bottom` could be right
at every width. **jsdom cannot see any of this** (it lays every chart out at
0×0), so the guard in `Chart.test.tsx` asserts the layout NUMBERS — that the
legend carries `bottom` and no `top`, and that `grid.bottom` clears both it and
the brush slider.

**A mocked renderer cannot see it either, and neither can a green unit suite on
both sides.** `Chart.test.tsx` proved the brush reports its handles in the
axis' own units; `transforms.rates.test.ts` proved the transform's numbers.
Both stayed green while the two disagreed about what those units WERE, because
nothing asserted the join. That is what `apps/web/test/TimeBrush.test.tsx` is
for — assert the numbers a component hands the renderer for x, not just that
each side is internally consistent.

**A jsdom test cannot see an accessible-name defect.** `dom-accessibility-api`
does not consult a descendant's `aria-label`; Chromium does. A `<button
aria-label>` inside a `<th>` therefore pollutes the header's name in a browser
and in no unit test. Those assertions belong in Playwright.

**`getByRole(role, { name })` is EXACT in Testing Library and a
case-insensitive SUBSTRING in Playwright.** The same call reads as the same
assertion in `apps/web/test` and `apps/web/e2e`, but it is not: Playwright's
default `name` match will pass `{ name: 'Beta' }` against rendered text
`'beta'`, or against `'Beta Checkout'`. Pass `exact: true` whenever a
fallback value (a slug, an id, a placeholder) could be a substring or case
variant of the value you actually mean to require — otherwise the assertion
passes whether or not the real value ever loaded. Cheaper still: pick fixture
values that cannot collide with their fallback in the first place —
`'beta'`/`'Beta Checkout Flow'`, never `'beta'`/`'Beta'`.

**Every page-scoped `getByRole('link', { name })` in the e2e suite now shares
a document with N rail links.** `ProjectRail` (`apps/web/src/ProjectRail.tsx`)
renders on every authenticated page — **All runs** plus one link per
project — so a link query that used to have the page mostly to itself can
now also be satisfied by a rail row instead of the one it meant to find,
under Playwright's case-insensitive substring default above. Green today
only because no seeded project name collides with a page's own link text;
that is a standing constraint on fixture naming from here on, not a one-off
check to pass once. (The brand link moved to `AppShell`'s header in the
design pass, but it is still in the document on every page — same rule.)

**A truncated read does not throw — `subarray` returns a short buffer.**
`BinaryReader.readString` reads a length then slices, and slicing past the
end yields fewer bytes with nothing raised, so a truncated string decoded to
a plausible wrong value. Every primitive now bounds-checks explicitly and
throws `TruncatedError`, which a streaming caller distinguishes from
corruption: it rewinds and waits on the first, gives up on the second.

**There is exactly ONE record decoder, and that is deliberate.**
`packages/plugin-gatling/src/record-decoder.ts` is shared by
`parseSimulationLog` (pull, finished buffer) and `StreamingLogDecoder` (push,
live feed). A second copy was written and removed during this work: drift
between two decoders surfaces as the live chart contradicting the final
report, which is the worst failure this product can produce. Do not
re-duplicate it.

**A replay must be acknowledged, never re-written.** `POST
/v1/runs/:id/stream` with an offset behind the cursor returns 202 and writes
nothing. Writing it re-creates an orphan chunk object at an unvalidated key,
which `LiveChunkStore.finalize` then splices into the assembled log — and
`close()` hashes the corrupt assembly, so the checksum passes and the decoder
eats it. The bytes are already stored, because the cursor only advances after
the write.

**A raw-body handler must reject an ALREADY-CONSUMED request, not wait on
it.** Nest registers Express's global `json()` and `urlencoded()`, and either
one fully drains a body whose Content-Type matches its own before any handler
runs. A handler that then attaches `'data'`/`'end'` to that stream waits for
an `'end'` that has already happened and will never fire again: no response,
one leaked socket and one leaked promise per request, and no timeout on the
path. `readRawBody` (`live.controller.ts`) guards on `req.readableEnded` —
true only once `'end'` has actually been emitted, so a body nobody has read
yet, including a legitimate zero-byte one, still reads `false`. The sibling
`readMultipart` never had the bug (`req.pipe(bb)` on an ended stream fires
`'close'` and rejects), which is exactly why it is easy to reintroduce.
**Test the wrong Content-Type with a request DEADLINE** — without one the
case does not fail, it hangs, and takes the file's whole `testTimeout` with
it.

**A per-request memory cap is not a per-run size cap.** `MAX_BUNDLE_BYTES`
(512 MB) bounds a whole run; `MAX_STREAM_CHUNK_BYTES` (8 MiB) bounds one
`POST /v1/runs/:id/stream` body, which the API buffers in memory before it
can judge the offset — so sharing the first number let one in-flight request
pin 512 MB and N requests pin N × that, even for a chunk about to be refused
as a gap. Both answer 413 under `BUNDLE_TOO_LARGE`; the message says which,
because re-chunking fixes one and not the other. Whenever a limit's number
looks reusable, check the two limits bound the same THING first.

**`close()` releases its claim only up to `finalizeLive`.** The claim
(`claimForClose`) is reverted by `releaseClose` when an object-store step
fails, which is right — those are retryable. `queue.add` is not: past
`finalizeLive` the bundle is assembled, hashed and recorded, and the
per-chunk objects are deleted, so reverting to `running` re-opens
`advanceOffset` to bytes that a retried `close()` will silently drop
(`finalize`'s `exists(key)` guard skips the re-assembly, deletes the new
chunks anyway, and hashes the stale bundle). Recovery past that point is the
sweeper's `parsing` branch, not a client retry. `releaseClose` is called with
its own rejection swallowed, so a failing compensating write cannot replace
the error that caused it.

**The sweeper measures `parsing` staleness from `parsing_started_at`, and
`running` staleness from `stream_updated_at` — never `created_at` for
either.** A live run's `created_at` is its OPEN time, so any run
streaming longer than `parsingStaleAfterMs` (15 min default) was sweepable
the instant `close()` moved it to `parsing` — the sweeper would re-enqueue
it, the pipeline would run against an empty `bundleSha256`, and the run would
be permanently `failed` while `close()`'s own write silently no-opped.
`finalizeLive` requires `status: 'parsing'` exactly (`run.ts`); `markIncomplete`
excludes `'failed'` (among other terminal states) from the rows it will touch
— two different guards, but both already miss once the sweeper's premature
re-enqueue has driven the pipeline to mark the row `failed` first, which is
what makes `close()`'s own write a silent no-op rather than a conflict. The
sweeper reads `COALESCE(parsing_started_at, created_at)` so rows predating
the migration stay sweepable. `running` is the same trap one state over and
needed its own column: a soak run streams for hours, so ageing it from
`created_at` would finalize a healthy mid-stream run as `incomplete` purely
for being long. What "stale" means there is that the PRODUCER stopped, so
`advanceOffset` stamps `stream_updated_at` on every ACCEPTED chunk — not on
a replay, which proves the agent is alive but not that it is progressing.
That branch finalizes in place via `markIncomplete`; it must never
re-enqueue, because nothing is assembled at `bundleKey` until `close()` runs.

**A raw SQL write inside the sweeper's transaction cannot be a Prisma call.**
`sweep()` holds its rows under `FOR UPDATE` in its own transaction, so
reaching for `RunRepository` would open a SECOND connection and block on the
lock this transaction holds — a self-deadlock that resolves only when the
pool times out. `Sweeper` is constructed with a `pg.Pool` and no Prisma
client for that reason; a new terminal transition there is hand-written SQL
on the sweep's own client, carrying the repository method's guard verbatim.

**A run status absent from `statusFor` inherits the `202` fallthrough,
silently.** `RunsService.statusFor` is the one function `POST /v1/runs` and
`GET /v1/runs/{id}` both call through `respondWithRun` — that sharing is the
entire "same code for the same state" guarantee. It has explicit branches for
`failed`, `incomplete`, and `complete`; everything else falls through to
`202`, which is correct for `pending`/`parsing`/`running` but wrong for any
future terminal status that forgets to add its own branch. This is not
hypothetical: `incomplete` shipped with exactly that bug first — before
`statusFor` gained its `run.status === 'incomplete'` line, a closed,
zero-byte run answered `202` with a `Retry-After` header and no `verdict`
field, forever, because an aborted live run has no worker left to ever move
it past 202. Add a status to `statusFor` in the same change that adds it to
`RunStatusSchema`.

**A fold cursor is a fetch frontier, not a decode position.**
`LiveChunkStore.readFrom` returns every chunk whose **start** offset is at
or past the offset it is given (`packages/storage/src/live-chunks.ts`) — it
wants the highest byte already FETCHED. `StreamingLogDecoder.consumedBytes`
is the last whole-record boundary instead, and it routinely sits *behind*
the last byte fetched: a record straddling a chunk boundary leaves a partial
tail the decoder buffers and reports as unconsumed. Passing that value to
`readFrom` re-selects chunks already delivered; the decoder splices them in
again after the tail it correctly retained, and every absolute position from
there on is wrong, silently, for the rest of the run. `LiveFoldOwner`'s
`FoldState.fetchedBytes` tracks the fetch frontier instead, advanced by the
length of the bytes just received — exact, because offset negotiation only
ever accepts a chunk at `offset === cursor` (`LiveService.stream`), so a
run's chunks tile `[0, stream_offset)` with no gap and no overlap.
`fold-owner.integration.test.ts`'s "folds correctly when chunks are smaller
than a single record, across several ticks" is the guard.

**Two series, two widths.** `UserSeries` coalesces against its own
`maxBucketsUsers` cap, independent of the response-time series'
`maxBucketsRun`, and on its own per-scenario schedule — bucket count tracks
a scenario's active SPAN, not its event volume, so a run whose scenarios
have staggered durations genuinely holds two widths at once
(`packages/statistics/src/users.ts`). A live delta therefore carries one
`widthMs` per envelope, never one for the whole message. The users width is
the **minimum** across scenarios, not the maximum: every real width is
`1000 × 2^k`, so the finest width divides every coarser scenario's offsets
exactly, while a coarser width does not divide a finer scenario's —
declaring anything but the minimum leaves a fine scenario's real offsets as
non-multiples of the declared width. `apps/worker/test/live-delta.test.ts`'s
"reduces the users envelope width to the FINEST scenario, not the coarsest"
is the guard.

**The owned-run cap and the pool size are one decision.** `createPool`
defaults to `new pg.Pool({ max: 10 })` with no `connectionTimeoutMillis`
(`packages/persistence/src/client.ts`), and the worker hands that ONE pool
to `PipelineService`, `Sweeper`, and `LiveFoldOwner` alike
(`apps/worker/src/main.ts`). A `maxOwnedRuns` cap above what the pool can
serve does not degrade — it deadlocks the whole worker: at ten owned runs
every client is held by a `FoldState`, the eleventh `pool.connect()` queues
forever because pg's own default connection timeout is 0, `tick()` never
reaches its fold loop, and the pipeline and sweeper starve behind it, with
no error, no timeout, no log. `main.ts` now sizes the pool as `maxOwnedRuns`
plus one client for the fold owner's own discovery query, `concurrency * 2`
for the pipeline's worst case, and one for the sweeper — and sets a
10-second `connectionTimeoutMillis`, so a future mis-sizing surfaces as a
loud, rejected `connect()` instead of a silent, permanent stall.

**A cursor must not advance past a failed publish.** `LiveFoldOwner#publish`
builds a delta from `state.cursor`, then writes it to both `PUBLISH
live:{runId}` and `XADD live:{runId}:deltas`; that cursor carries the
coalesce-replacement flag (`lastBucketWidthMs`) the NEXT delta's replacement
decision is computed from. Advancing `state.cursor` before either Redis call
means a dropped connection on the very tick the buckets halve loses that
tick's `replaces: true` — the next delta then computes `replaces = width !==
prev.lastBucketWidthMs` against a width the cursor already (wrongly) equals,
so it silently presents new-width buckets as a plain upsert into a series
the consumer never got the replacement for. On failure only `seq` advances
(`{ ...state.cursor, seq: next.seq }`): a consumer still needs a gap-free
`seq` to detect a drop, but nothing about `replaces`/`since` may be assumed
to have reached anyone. `fold-owner.integration.test.ts`'s "preserves the
coalesce replacement flag across a failed publish, so the next tick still
replaces rather than silently upserting" is the guard.

## Conventions the design pass added

Each of these shipped as a real defect first and was caught by a browser, not
by the unit suite.

**`text-transform` CHANGES A PLAYWRIGHT ACCESSIBLE NAME.** Playwright computes
accessible names in its own injected script and applies `text-transform`, so a
`<th class="uppercase">Percentage</th>` is named `PERCENTAGE` and
`getByRole('columnheader', { name: 'Percentage', exact: true })` no longer
resolves. jsdom's `dom-accessibility-api` reads `textContent` and sees none of
it, so the unit suite stays green. **Never put `uppercase` on anything queried
by accessible name** — column headings (`tableStyles.ts`'s `TH`) and section
headings (`components/SectionHeading.tsx`) both carry a comment saying so. It
is fine on a `<dt>`, a `<p>` label, or a rail overline, where nothing queries by
name.

**A token that is not in `@theme` produces NO utility, silently.** Tailwind v4
generates utilities only from `@theme` declarations, never from a bare `:root`
custom property. `text-accent-foreground` looked correct in the markup, matched
a real token in `tokens.css`, and emitted no CSS at all — so the skip link and
every primary button inherited `color` from `body` and rendered dark slate on
indigo at 2.84:1. Publish the alias under a DIFFERENT name than the runtime
token (`--color-on-accent: var(--color-accent-foreground)`), because a key that
reads a `var()` of its own name also resolves to nothing, equally silently.

**A decorative `<svg>` inside a chart `<figure>` breaks nine specs.**
`run-charts.spec.ts` and `request-detail.spec.ts` prove a chart really drew by
counting SVG elements within the figure — `toHaveCount(1)` per chart, and
`toHaveCount(0)` for one with nothing to draw. An icon in `DataTable`'s toggle
(which `Chart` renders inside the figure) makes both counts wrong AND destroys
the invariant they rest on. Icons are fine everywhere else; not in there.

**`focus:not-sr-only` resets `padding` to 0.** It has to, to undo `sr-only` —
and a `focus:`-variant utility outranks an unprefixed one, so `sr-only … px-3
focus:not-sr-only` reveals a skip link with no padding. Every visual utility on
a skip link must be `focus:`-prefixed, including the padding.

**A `<caption>` is as wide as its TABLE, not its scroll box.** Put a table in
`overflow-x-auto` and its caption stops wrapping at the viewport and scrolls
sideways with the columns — on a phone the reader gets half a sentence and has
to drag a data table to finish it. `components/TableFrame.tsx` is the fix:
one caption node, drawn visibly outside the scroller and again as the real
`sr-only` `<caption>` inside, so the accessible name and the
`caption.textContent` assertions in `ErrorsTable.test.tsx` /
`StatisticsTable.test.tsx` keep working.
