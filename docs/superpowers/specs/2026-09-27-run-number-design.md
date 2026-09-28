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

**The invariant:** UNGROUPED ⇒ UNNUMBERED — a run never carries a number
without a test. Both writers below set the test and the number in the same
statement, and test deletion clears the number of every run it ungroups (see
below). **The goal**, not an invariant, is the converse: a run in a test has a
number. It has one known exception — a run an older, pre-numbering worker
attached to its test during an upgrade, which carries a test and no number;
the finalize numbers it when it meets it (the self-heal row in the table
below).

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
`test_id = $10` unconditionally, inside the finalize transaction. The number is
decided by a NEW, separately testable function, `numberRunForTest` — its OWN
statement, called IMMEDIATELY BEFORE the terminal UPDATE, inside the same
transaction and therefore atomic with it, rather than folded into the terminal
UPDATE's own `SET` clause. Two reasons: it is then a function
`apps/worker/test/run-number.integration.test.ts` can call and assert on
directly, without constructing the terminal write's other nine parameters
just to reach it; and it has to run BEFORE the terminal UPDATE
rather than after, because it repeats that UPDATE's own status guard
(`status NOT IN ('complete', 'failed')`) to refuse a redelivered job that has
already gone terminal — a guard that would no longer match if the terminal
UPDATE had already run first and set the run to `complete`.

```sql
WITH cur AS (
  SELECT test_id, run_number FROM run
   WHERE id = $1 AND status NOT IN ('complete', 'failed') FOR UPDATE
), allocated AS (
  UPDATE test SET next_run_number = next_run_number + 1
   WHERE id = $2
     AND EXISTS (SELECT 1 FROM cur
                  WHERE cur.test_id IS DISTINCT FROM $2 OR cur.run_number IS NULL)
  RETURNING next_run_number - 1 AS n
)
UPDATE run
   SET test_id = $2,
       run_number = CASE WHEN run.test_id IS NOT DISTINCT FROM $2 AND run.run_number IS NOT NULL
                         THEN run.run_number
                         ELSE (SELECT n FROM allocated) END
 WHERE id = $1 AND EXISTS (SELECT 1 FROM cur)
```

| The run arrives with | The resolver answers | Number |
|---|---|---|
| no test (an upload) | a test | that test's next number |
| test A, `#5` (a live run) | test A | `#5`, kept |
| test A, `#5` | test B | B's next number; A keeps a gap at 5 |
| test A, no number (an older worker attached it before this shipped) | test A | A's next number |
| any | `null` (resolution failed) | cleared |

The terminal UPDATE that follows, unchanged in shape, then writes the run's
status, verdict and metrics with `test_id = $10` — bound to the same test id
`numberRunForTest` took as its `$2`, so the two statements can never disagree
about which test the row belongs to. Because `numberRunForTest` is the LAST
statement before that terminal UPDATE and both run inside one transaction
before `COMMIT`, the test's row lock is held for two short statements rather
than for the whole finalize, and two runs of one test finishing together queue
for milliseconds, not for a full finalize each.

**The keep row writes nothing.** A run already in the resolved test with a
number is answered from `cur`, which still locks it, and is not rewritten —
not even to the values it holds. A rewrite made the terminal UPDATE re-check
the run's foreign key (Postgres re-checks a row the same transaction already
wrote, measured with `test_id` unchanged), and that check locks the test row;
without the rewrite the terminal UPDATE runs no check and never asks for the
test.

**Neither writer above deadlocks `TestRepository.remove` below, with one
window left — and it is not because of a shared lock order.** `remove`'s
delete locks the TEST row and its cascade then locks RUN rows, the reverse of
both writers' RUN then TEST. What rules out a cycle is WHICH rows each side can
be waiting for:

- **A writer waits on test T only while holding its own run R**, where R is
  either not committed in T (an attach, or a finalize moving R into T), or
  committed in T without a number (the self-heal row, in `allocated`). A
  finalize that keeps R's number never asks for T, because the keep row
  writes nothing (above).
- **`remove(T)` ungroups the runs committed in T FIRST**, in a statement that
  holds no lock on T (statement (1) under "Deleting a test"). Changing
  `test_id` — a key column, half of the unique index on `(test_id,
  run_number)` — takes each run FOR UPDATE, which waits behind any lock a
  writer holds, the FOR KEY SHARE of a finalize's `run_assertion` inserts
  included. So `remove` waits on such a writer only before it holds T, and
  that writer can then get T and finish; a writer holding only the KEY SHARE
  upgrades it as the run's sole locker without queueing behind `remove`.
- **Once `remove` holds T** it waits only on runs committed in T that (1) did
  not see — runs that joined T after (1) read; the writer that joined each
  needed a lock on T's row, so it has already committed and holds nothing —
  and on ungrouped-but-numbered runs, which by the invariant are only the ones
  its own cascade made. A joiner that arrived numbered is finalized by the
  keep row and never asks for T.

**The two residuals this section used to record are closed**, each pinned by
a case in `apps/worker/test/run-number.integration.test.ts` that deadlocked
(40P01) against the earlier code and passes now:

1. *A numbered run that joins T after (1) read, finalized before the cascade
   reaches it* — the finalize's terminal UPDATE re-checked the key on a row the
   keep arm had rewritten, and waited on T. Closed by the keep row writing
   nothing; pinned by "does not deadlock a delete against a finalize keeping
   the number of a run that joined mid-delete", and by "finalizes a run
   already numbered in its test without waiting on the test row", which drives
   the real `PipelineService` while another transaction holds the test row.
2. *A self-heal run whose finalize had inserted its assertion rows* — (1)
   rewrote the number NULL to NULL, took only FOR NO KEY UPDATE, passed the
   KEY SHARE, and the delete then held T while its cascade waited on the KEY
   SHARE and the finalize waited on (1). Closed by (1) ungrouping, which takes
   FOR UPDATE; pinned by "does not deadlock a delete against a self-healing
   finalize that already wrote its assertions".

**One window is left, while a deployment of this version rolls out.** A joiner
that an OLDER, pre-numbering worker attached — in T with no number — is
finalized by the self-heal row, which must take T to allocate. If that
finalize takes the run and then asks for T after `remove` has taken or queued
for it — inside one statement, or with a third transaction numbering another
run into T so that both queue behind it — Postgres aborts one side (40P01,
never a hang): measured 3 of 3 with the fixes in place, the victim varying. The
outcomes match the ordinary race's but for one: a finalize that loses fails its
run, as it would losing to the delete without a deadlock (its test is gone,
23503); a delete that loses answers an error, and retrying it succeeds. No lock
order closes it — the finalize must take T to allocate, and the joiner is a run
(1) could not have seen — and it ends once no older worker is attaching runs.

Widening either of `remove`'s clearing statements, or either writer's
`target`/`cur` filter, needs this argument re-made.

## Deleting a test

`TestRepository`'s delete reads the test, then runs one transaction of three
statements; `run.test_id` is `ON DELETE SET NULL`, which cannot clear a second
column:

1. ungroup the runs committed in the test — `test_id` and `run_number` both
   to NULL, the test named by its slug — BEFORE the test row, for the lock
   order above as much as for clearing;
2. delete the test, whose cascade ungroups any run that joined after (1)
   read;
3. clear `run_number` on every ungrouped-but-numbered run in the project —
   which, by the invariant, is exactly the runs that joined the test after (1)
   read (a writer that committed in between) and were ungrouped by (2)'s
   cascade still numbered.

A run therefore never reports a number without the test it counts within. A
test later recreated under the same slug is a NEW row and starts at `#1`; the
ungrouped runs of the old one carry no number, so nothing collides. A finalize
that queued on the deleted test's runs behind (1) finds the test gone and
fails its foreign key (`23503`) — the outcome a finalize racing its test's
deletion has always met, since the terminal UPDATE has always written
`test_id`.

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
| a delete does not deadlock a finalize that numbers a run already in the test | `remove`'s statement (1) removed |
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
