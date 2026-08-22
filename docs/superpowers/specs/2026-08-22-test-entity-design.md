# Test: a named layer between a project and its runs

**Status:** approved 2026-08-22. Slices 1–4 in scope; SLA rule re-scoping is a
follow-up (see *Deliberately out of scope*).

## The change

```
Org → Project → Run                    (today)
Org → Project → Test → Run             (this design)
```

`Run.simulation` — the simulation class the tool reported, a bare string on the
row — stops being the de-facto grouping key and becomes what it always was:
captured execution metadata. `Test` becomes the thing a run belongs to, and the
thing a reader navigates.

## Why the current shape is a problem

Nothing in the schema groups runs. `Run.simulation` is the only signal, and it
is used as one in exactly one place — `TRENDS_SQL`, which cohorts by
`AND r.simulation IS NOT DISTINCT FROM $3`
(`packages/persistence/src/metrics/trends.ts:122`). So the concept already
exists; it is spelled as a string comparison and has no identity, no name a
reader chose, nowhere to hang configuration, and no page of its own.

The user-facing consequence is that a project with three simulations is one
undifferentiated list of runs, and the only way to see one simulation's history
is to open a run and click Trends.

## ═══ THE CONSTRAINT THAT SHAPES EVERYTHING ═══

**The simulation class is not known when a run is created.**

`POST /v1/runs` inserts at `status: 'pending'` with no simulation
(`RunRepository.create`). The worker parses it out of the log header and writes
it later, in a raw SQL update alongside `tool_started_at`, `description` and
`duration_ms` (`apps/worker/src/pipeline/pipeline.service.ts:351`). The live
path is the same: `createLive` inserts at `running` and the fold owner has no
header until bytes arrive.

Three things follow, and every design decision below is downstream of them:

1. **`run.test_id` cannot be `NOT NULL`.** There is no value to put in it at
   insert time.
2. **A run can legitimately never acquire a test.** A bundle that fails to parse
   never yields a simulation class. So can a run that is still pending, and so
   can every pre-migration row whose `simulation` was already null.
3. **Making it `NOT NULL` would mean clients declaring the test at submit
   time**, which breaks the Gradle plugin, the telemetry agent, and every
   curl-based ingest at once.

## Schema

```prisma
model Test {
  id              String   @id @default(uuid()) @db.Uuid
  orgId           String   @map("org_id")     @db.Uuid
  projectId       String   @map("project_id") @db.Uuid
  /// URL identity within the project. Derived from `simulationClass` on
  /// auto-creation; editable later without moving the runs, because the runs
  /// point at `id`.
  slug            String
  /// What a reader calls it. Defaults to `simulationClass` so an
  /// auto-created test is never nameless, and is editable.
  name            String
  /// The tool's own class name — the key the worker matches a parsed run on.
  simulationClass String   @map("simulation_class")
  description     String?
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime @updatedAt      @map("updated_at") @db.Timestamptz(3)

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  runs    Run[]

  @@unique([projectId, slug])
  @@unique([projectId, simulationClass])
  @@index([projectId, createdAt(sort: Desc)])
  @@map("test")
}
```

`Run` gains:

```prisma
  testId String? @map("test_id") @db.Uuid
  test   Test?   @relation(fields: [testId], references: [id], onDelete: SetNull)
  @@index([testId, createdAt(sort: Desc)])
```

`timestamptz(3)` on both instants, not a bare timestamp — the rule CLAUDE.md
records after a raw-pool read reported a start time 5h30m out on an
Asia/Kolkata machine and stayed invisible in UTC.

`onDelete: SetNull` on the run's side, NOT cascade: deleting a test must never
delete the runs it grouped. That is the same instinct `run_assertion` follows
by storing a rule snapshot rather than a live foreign key — history survives the
thing that organised it.

### `@@unique([projectId, simulationClass])`, and when it goes

This is what makes worker auto-assignment deterministic: given a parsed
simulation class there is exactly one test it can belong to.

**Gatling Enterprise does not have this constraint.** Its Test is a named
configuration, so two tests may share a simulation class with different load
profiles — their list showed `gold incredible octopus test` and
`orange remarkable kangaroo test` as separate tests. Reaching that needs clients
to name the test at submit time, which is the optional `metadata.test` field in
*Later* below. Taking the constraint now and relaxing it then is deliberate: it
buys a non-breaking migration today and costs nothing that cannot be undone,
because dropping a unique index is not a data change.

## How a run acquires its test

**The worker resolves-or-creates, where it already writes `simulation`.**

In the same transaction as the header update, keyed on
`(projectId, simulationClass)`:

- test exists → use its id
- test does not → insert one with `name = simulationClass` and a derived slug

**The runtime rule and the backfill rule are the same rule.** That is the
property that makes the migration trustworthy: it is not a one-off script that
can drift from what the application does afterwards, it is the same grouping
executed once over history.

Runs with `test_id IS NULL` are not a failure state. They are pending runs,
failed ingests, and pre-migration rows. The project-level run list already lists
them and continues to.

## Migration and backfill

One migration, additive, no destructive statement:

```sql
CREATE TABLE test (...);

-- One test per distinct (project, simulation) that has ever been parsed.
-- created_at is the FIRST run's, so a test's age is the age of the thing it
-- describes rather than the age of this migration.
INSERT INTO test (id, org_id, project_id, slug, name, simulation_class, created_at, updated_at)
SELECT gen_random_uuid(), org_id, project_id, <slug>, simulation, simulation,
       MIN(created_at), now()
FROM run
WHERE simulation IS NOT NULL
GROUP BY org_id, project_id, simulation;

ALTER TABLE run ADD COLUMN test_id uuid REFERENCES test(id) ON DELETE SET NULL;

UPDATE run SET test_id = t.id
FROM test t
WHERE t.project_id = run.project_id AND t.simulation_class = run.simulation;

CREATE INDEX ...;
```

**Nothing is lost and nothing is deleted.** `run.simulation` stays on every row,
so the backfill is re-derivable and the migration is reversible by dropping the
column and the table.

### Slug collisions

`checkout.Basic` and `checkout-Basic` both slugify to `checkout-basic` under the
grammar `NewProject.tsx` already uses (lowercase, non-alphanumeric → `-`,
collapse, trim). Within one project that is a unique-constraint violation
mid-migration.

Resolved by appending `-2`, `-3` … on conflict, ordered by `MIN(created_at)` so
the assignment is deterministic and re-running the migration on a copy produces
identical slugs. A simulation class that slugifies to the empty string (all
punctuation) falls back to `test-<n>`.

## API

New, all session-or-bearer like the rest of the read surface:

| Method | Path | Returns |
|---|---|---|
| `GET` | `/v1/projects/{slug}/tests` | the project's tests, newest first, each with its latest run |
| `GET` | `/v1/projects/{slug}/tests/{testSlug}` | one test |
| `PATCH` | `/v1/projects/{slug}/tests/{testSlug}` | rename / re-describe (`name`, `description` only) |

`GET /v1/runs` gains an optional `test` filter, beside the existing `project`
one.

**No create endpoint.** A test comes into existence because a run of it was
parsed. Offering a create button would let a reader make a test no run will ever
match — the simulation class is the tool's, not theirs to invent.

**No delete endpoint in this slice.** Deleting a test orphans its runs
(`SetNull`), which is a real operation but needs its own confirmation design;
out of scope rather than done badly.

## Trends

`TRENDS_SQL`'s cohort predicate becomes `AND r.test_id = $3`, replacing
`AND r.simulation IS NOT DISTINCT FROM $3`.

For backfilled data these select identically, which is the point — the cohort a
reader already gets does not change under them. What changes is that the cohort
now has a name, and `RunTrends`'s "this unnamed simulation" fallback can say the
test's name instead.

Runs with no test drop out of trends. They already did: `IS NOT DISTINCT FROM`
grouped all the nulls together, which cohorted every unparsed run in a project
with every other one regardless of what they were. Losing that is a fix.

## UI

```
/projects/:slug                     project overview → list of tests
/projects/:slug/tests/:testSlug     test detail → its run history
/runs/:runId                        unchanged
```

`paths.test.ts` guards against a literal segment under `/projects/` that matches
the slug grammar — `/projects/new` once permanently shadowed a project slugged
`new`. `/projects/:slug/tests` is under a slug and safe; **`/projects/tests`
must never be added.**

The run page's header gains the test as a breadcrumb between project and run.

## Deliberately out of scope

**SLA rules stay project-scoped.** `sla_rule.project_id` means a p95 gate
written against a checkout simulation is evaluated against a search simulation
too — probably the largest correctness win available anywhere near this change.
It is a separate migration with its own unanswered question (does an existing
project rule become one rule per test, or a project-level default that tests
inherit and may override?), and folding it in would make this change
unreviewable. Follow-up.

**Deleting a test.** See API above.

## Later, and why it is later

`metadata.test` on the ingest request — an optional client-declared test name.
It is what lets two tests share a simulation class, which is the shape Gatling
Enterprise has. Optional, so no client breaks; and it needs no schema change
beyond dropping `@@unique([projectId, simulationClass])`, which is why the
constraint is safe to take now.

## Slices

Each is a PR.

1. **Schema, migration, backfill, repository.** `test_id` is populated and
   nothing reads it. Provable on its own: every run that had a simulation has a
   test, every test has ≥1 run, no run changed project.
2. **Contracts and API.** The three endpoints and the `test` filter.
3. **Trends cohort.** `simulation` → `test_id`.
4. **UI.** Project → tests → test detail → run history, plus the run header
   breadcrumb.

## Verification

Slice 1 carries the load, because a migration is the one thing that cannot be
fixed forward cheaply:

- **Backfill is exhaustive** — `SELECT count(*) FROM run WHERE simulation IS NOT
  NULL AND test_id IS NULL` is 0.
- **Backfill invents nothing** — every `test.simulation_class` matches at least
  one run's `simulation` in the same project.
- **Grouping is faithful** — for every project, the count of distinct
  `simulation` equals the count of tests.
- **Slug collisions resolve** — an integration case seeds `a.B` and `a-B` in one
  project and asserts two tests with distinct slugs.
- **The worker's rule matches the migration's** — a real `gatlingRun` after the
  migration lands in the SAME test the backfill created for that simulation
  class, rather than making a second one. This is the assertion that catches the
  two rules drifting, and it needs a real run: the fixture path can be made to
  agree with itself.
- **Idempotence** — two concurrent runs of a new simulation class produce ONE
  test, not two. Upsert on the unique index, not read-then-write.
