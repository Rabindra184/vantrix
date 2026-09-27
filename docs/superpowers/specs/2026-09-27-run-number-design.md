# Run number

**Status:** approved 2026-09-27, in chat, section by section.
Backlog item #5 of the Gatling Enterprise comparison: every run of a test
carries a number — `Run 12`, `#12` — that names it for good, the way Gatling
Enterprise names its runs. One migration, one widened contract field, two
worker writes, and a label change on every surface that identifies a run
within its test.

## What Gatling Enterprise does, measured

Read from the user's own cloud.gatling.io account on 2026-09-27, read-only.

| Where | What it shows |
|---|---|
| Tests list, LAST RUN cell | `#1` and `Run 1`, then the start time and duration |
| A test's runs panel | `Run 1` as the item's name; start time and duration as a second line |
| Run page header | the run's editable title (`Untitled run` when unset) with `#1` beside it |
| Trends x-axis | `#1` |
| Compare picker | `Run 1` with the start time under it; at most 5 selected |
| Compare, selected runs | chip `#1`; chart series `Run #1`; table column `Run 1` |
| Home, last run | `<test name> - Run 1` |

**The number is per test:** two different tests each hold a run `#1`. It
REPLACES the timestamp as a run's name everywhere a run is named within its
test; the timestamp becomes a second line.

**Not measurable, and recorded as such:** each test in that account holds one
run and the trial has no credits, so gaps, ordering under concurrency, and
whether a failed or aborted run consumes a number were not observed. The rules
below for those cases are this product's own, argued from its own constraints.

## Decisions taken, and the ones declined

| Question | Chosen | Declined, and why |
|---|---|---|
| Order | ARRIVAL: a run takes the next number the moment it joins its test, and keeps it for ever | Numbering by when the test ran: a late upload of an old bundle would renumber every later run, so `#12` in last week's thread would name a different run today. Numbering by time and freezing at arrival: a late run has no integer slot to take. |
| Allocation | A counter on the test, bumped in the statement that sets the run's test | `max + 1` with a retry: a retry loop at every writer, and it can reuse a number once runs are ungrouped. Computed at read time (`row_number()`): a live run numbered at its header can be renumbered when an earlier-created upload finishes, and every list and trends read pays a window over the test's history. |
| Which runs | Every run that joins a test, from the moment it joins | Numbering failed ingests: a run that never reaches the resolver has no test to be numbered within. |
| Scope | Every surface that names a run within its test, like GE | Identity surfaces only (the Compare chips and the list would then name one run two ways); also the org-wide and project run lists (they never show a run's test today). |
| Run title | Not built | GE's editable per-run title overlaps Gatling's own description (PRD G-02) and the run note (backlog #3). |

## Data

Migration `20260927180000_run_number`:

```sql
ALTER TABLE test ADD COLUMN next_run_number integer NOT NULL DEFAULT 1;
ALTER TABLE run  ADD COLUMN run_number      integer;

-- Existing runs, by the same arrival rule: creation order within each test.
UPDATE run r
   SET run_number = n.num
  FROM (SELECT id,
               row_number() OVER (PARTITION BY test_id ORDER BY created_at, id) AS num
          FROM run
         WHERE test_id IS NOT NULL) n
 WHERE r.id = n.id;

UPDATE test t
   SET next_run_number = COALESCE((SELECT max(run_number) FROM run WHERE test_id = t.id), 0) + 1;

CREATE UNIQUE INDEX run_test_id_run_number_key ON run (test_id, run_number);
```

`schema.prisma`: `Test.nextRunNumber Int @default(1) @map("next_run_number")`,
`Run.runNumber Int? @map("run_number")`, `@@unique([testId, runNumber])` on
`Run` — Prisma's default name for that index is exactly the one above, which is
what keeps the schema-matches-migrations CI step green. NULLs are distinct in a
unique index, so every run without a test coexists.

**The invariant:** `run_number` is non-null exactly when `test_id` is. Both
writers below maintain it in the same statement, and test deletion maintains it
explicitly (see below).

## The two writers

A run's test is set in exactly two places (`apps/worker`), so a number is
assigned in exactly those two, in the SAME statement that sets the test.

**1. `LiveFoldOwner#identify`, at the log header.** Today
`UPDATE run SET test_id = $2 WHERE id = $1 AND test_id IS NULL`. It becomes:

```sql
WITH target AS (
  SELECT id FROM run WHERE id = $1 AND test_id IS NULL FOR UPDATE
), allocated AS (
  UPDATE test SET next_run_number = next_run_number + 1
   WHERE id = $2 AND EXISTS (SELECT 1 FROM target)
  RETURNING next_run_number - 1 AS n
)
UPDATE run SET test_id = $2, run_number = (SELECT n FROM allocated)
 WHERE id = (SELECT id FROM target)
```

The `EXISTS` guard is what stops a re-claimed run burning a number: a second
identify blocks on the row lock, re-reads `test_id IS NULL` as false, finds
`target` empty and allocates nothing. So a live run carries its number while it
streams, as GE's does.

**2. `PipelineService`, the terminal write.** Today its last statement writes
`test_id = $10` unconditionally, inside the finalize transaction. It becomes a
statement of the same shape that also decides the number:

```sql
WITH cur AS (
  SELECT test_id FROM run
   WHERE id = $1 AND status NOT IN ('complete', 'failed') FOR UPDATE
), allocated AS (
  UPDATE test SET next_run_number = next_run_number + 1
   WHERE id = $10::uuid
     AND EXISTS (SELECT 1 FROM cur WHERE cur.test_id IS DISTINCT FROM $10::uuid)
  RETURNING next_run_number - 1 AS n
)
UPDATE run SET status = …, …, test_id = $10,
       run_number = CASE WHEN run.test_id IS NOT DISTINCT FROM $10::uuid
                         THEN run.run_number
                         ELSE (SELECT n FROM allocated) END
 WHERE id = $1 AND status NOT IN ('complete', 'failed')
```

| The run arrives with | The resolver answers | Number |
|---|---|---|
| no test (an upload) | a test | that test's next number |
| test A, `#5` (a live run) | test A | `#5`, kept |
| test A, `#5` | test B | B's next number; A keeps a gap at 5 |
| any | `null` (resolution failed) | cleared |

It stays the LAST statement before `COMMIT`, so the test's row lock is held for
that statement alone, and two runs of one test finishing together queue for
milliseconds rather than for a whole finalize.

**Lock order is run, then test, in both writers** — and in test deletion below —
so none of the three can deadlock another.

## Deleting a test

`TestRepository`'s delete reads the test, then `deleteMany`s it; `run.test_id`
is `ON DELETE SET NULL`, which cannot clear a second column. The delete becomes
one transaction: clear `run_number` on that test's runs, then delete the test.
A run therefore never reports a number without the test it counts within. A
test later recreated under the same slug is a NEW row and starts at `#1`; the
ungrouped runs of the old one carry no number, so nothing collides.

## Contract (`packages/contracts`)

`runNumber: z.number().int().positive().nullable().optional()` on:

- `RunIdentitySchema` — so both the terminal `RunResponse` and the 202
  `RunProcessing` body carry it;
- the run-list item `.extend({…})`;
- `TrendRunSchema`;
- `TestSummary.latestRun`.

`.nullable()` because a run with no test has no number; `.optional()` because
the browser drops any body that fails `safeParse`, so a required field would
blank the page for a whole rolling deploy — the rule every newer field on these
schemas already argues. The OpenAPI document derives from these schemas.

## API and persistence reads

Every place the field has to be named to reach the wire (none is automatic):

- `RunRecord` and `toRecord()`; the run-list raw `SELECT` and `RunListItem`;
- `RunsService.toResponse()` (terminal) AND `respondWithRun()`'s hand-written
  202 body AND `toListItem()` — the two identity builders are pinned
  separately, the `warmupMs` lesson;
- `TRENDS_SQL`'s inner and outer `SELECT`, `StoredTrendRun`, and `trends()`'s
  mapping;
- `TestRepository`'s `latestRun` selection.

## The web app

**One module owns the spelling.** `apps/web/src/runNumber.ts`:

- `runName(n)` → `Run 12` — where a run is NAMED: list rows, Compare chips,
  chart series, matrix columns, summary tiles, the baseline note, the tests
  catalogue;
- `runTag(n)` → `#12` — where it is a compact TAG: the Trends axis.

GE spells its Compare series `Run #1` and its table column `Run 1`; here both
are `Run 12`, because both are built from one `label` field and copying GE's
inconsistency buys nothing.

**A run with no number keeps exactly today's label**, through one fallback, so
no surface grows its own: the id prefix where it showed one, and
`compareLabels`' minute label (with its collision suffix) on Compare and Trends.
Only runs WITHOUT a number pass through `compareLabels`; a minute label can
never equal `Run 12`, so the two populations cannot collide.

| Surface | Today | With a number |
|---|---|---|
| Run header breadcrumb, current rung | `3764bc74` | `Run 12` |
| Run header `<h1>` | the test's name | unchanged — no `#12` badge (below) |
| Document title | the simulation, else `Run 3764bc74` | `<test name> · Run 12` |
| A test's run list, row and card | the id prefix | `Run 12`; the copy button still copies the full id |
| Compare picker chip | `09-13 11:31` | `Run 12`, start time as its second line |
| Compare series, matrix columns, summary tiles | `09-13 11:31` (· id suffix on collision) | `Run 12` |
| Trends axis | `09-13 11:31` (· id suffix on collision) | `#12` |
| Baseline note | "the run of <instant>" | "Run 11 (started <instant>)" |
| Tests catalogue, last-run cell | two badges | `Run 12` beside the two badges |
| Org-wide and project run lists | the simulation | unchanged |

**No `#12` beside the `<h1>`.** GE puts its number beside the run title; here
the `<h1>` is the test's name, and on a phone that line wrapping would push the
run's totals down — `mobile.spec.ts`'s fold has 7.6 px of headroom. The
breadcrumb's current-page rung already names the run on every viewport.

**The document title is the one addition beyond the approved sections.** Two
tabs open on two runs of one test are indistinguishable today (both are titled
with the simulation). `<test name> · Run 12` when the run has a number; exactly
today's title otherwise. Nothing asserts on the title today.

**Arrival and display order disagree, deliberately.** Lists and the baseline
note order by when the test ran (`COALESCE(tool_started_at, started_at), id`);
numbers follow arrival. A late upload of an old bundle therefore reads
`Run 13` between `Run 7` and `Run 8`, and the baseline note on `Run 8` can
name `Run 13` as its previous run. That is the arrival rule working, not a
defect, and the spec says so where the next reader will look.

## Tests, and what each must be seen failing for

Every case red-verified from a checkpoint commit; every mutation's replacement
count asserted before the run.

**Worker / persistence (integration, real schema):**

| Case | Mutation that must fail it, alone |
|---|---|
| two uploads to one test get 1 then 2 | allocation removed from the terminal write |
| a live run is numbered at its header, and keeps it at finalize | the `IS NOT DISTINCT FROM` arm reallocating |
| re-matched to another test at finalize takes that test's next | the kept number never reallocated |
| resolver `null` clears the number | the `CASE` keeping the old number |
| a re-claimed identify burns no number | the `EXISTS (target)` guard removed |
| N runs of one test finalizing concurrently get N distinct numbers | the counter replaced by `max + 1` without a lock |
| deleting a test clears its runs' numbers | the clearing step removed |
| the backfill numbers by `(created_at, id)` and sets the counter to max + 1 | ordering by `started_at`; counter left at 1 |

**API (integration):** `runNumber` on the terminal builder, on the 202 builder
(each mutation fails its own case alone), on list items, on trends rows and on
`latestRun`; `null` for an ungrouped run.

**Contracts (unit):** positive integers accepted; `0`, negatives and fractions
refused; a body WITHOUT the field still parses (the rolling-deploy case).

**Web (unit):** each surface renders `runName` / `runTag` from the payload; a
numberless run renders exactly today's label; Compare's series names follow the
number on two runs whose starts fall in ONE minute, so a timestamp-built label
cannot pass.

**Browser (e2e):** a test seeded with two runs — its run list reads `Run 1` and
`Run 2`, the breadcrumb and the document title match, Compare's chips and
series read the same, and the Trends axis reads `#1` and `#2`. Existing specs
that pin the old label move with it: `copy-ids.spec.ts` asserts a test's run
list shows the 8-character prefix, and now asserts `Run N` while still proving
the link shows less than the id the button copies.

**Geometry:** the phone fold and the list's p95/Errors bounds re-measured on a
real run before and after; `Run 12` is narrower than the prefix it replaces,
and that is checked rather than assumed.

**Real runs:** a Gradle-plugin live run and an on-prem runner run against the
developer database — each numbered at the right moment, the live one showing
its number while it streams — and the backfilled numbers of an existing test
read back in arrival order.

**Gates:** all five by their own exit codes, in order, against a scratch
database and a scratch Redis index; the new case counts are totalled from the
source before any suite runs, so a silently skipped file shows as a shortfall.

## Not in this change

- An editable per-run title (GE's `Untitled run`).
- Showing the number on the org-wide and project run lists.
- Re-attaching an ungrouped run to a test, which would need a number — there is
  no such path today, and none is added.
- Making the number part of a URL (`/tests/:slug/runs/12`); runs stay addressed
  by id.
