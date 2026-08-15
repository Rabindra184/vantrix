# Project identity, and the ingest fields the API discards — design

Sub-project 2 of the enterprise-UI family. Sub-project 1 shipped the design
system; 3a shipped the run shell. This one is the API sub-project: it gives
runs a visible owner, gives the org a list of its projects, and stops
throwing away three fields the ingest contract already accepts.

It exists to be the last API change in this family. Sub-project 3b — the
sidebar — should be able to consume what lands here and touch no server code
at all, which is what made 3a go smoothly.

---

## 1. Scope

In:

- `GET /v1/projects`, each project carrying its latest run's verdict
- `?project=<slug>` on `GET /v1/runs`
- `project` and `simulation` on both run response shapes
- Three new `run` columns — `environment`, `branch`, `commit_sha` — written
  at accept time from metadata the API already validates
- The run list's columns, and the run header's project name and chips
- A `/projects/:slug` route, so `?project=` has a consumer on day one (§8.3)

Out:

- The project sidebar — 3b, and the reason this sub-project exists
- RBAC and multi-org membership — `org_member.role` stays write-only until M6
- Any index on the three new columns. Nothing filters on them (§6.2)
- Filtering runs by environment or branch. Same reason

---

## 2. What already exists

Three facts checked against the code rather than assumed, because each one
removes work a reasonable person would otherwise plan:

**Project identity needs no migration.** `run.project_id` exists, is `NOT
NULL`, and is indexed via `@@index([projectId, startedAt(sort: Desc)])`.
`Project` already carries `slug` and `name`, unique per org. Surfacing a
run's project is a read-side join, nothing more.

**`simulation` is already on `RunRecord`.** It reaches `RunResponse` and is
absent from `RunListResponse` only because `toListItem`
(`apps/api/src/runs/runs.controller.ts`) never mapped it. Adding it to the
list costs one line and no query change.

**The three ingest fields are dropped in exactly one place.**
`IngestMetadataSchema` validates `environment`, `branch` and `commitSha`;
`parseMetadata` returns them; `IngestService.accept` builds
`runs.create({...})` from `metadata.tool` and `metadata.idempotencyKey` and
reads no others. A pipeline posting `branch=release/24.8` gets a 200 and the
value is gone — not stored anywhere, not logged, not in the bundle. There is
nothing to backfill from.

---

## 3. Contract changes

### 3.1 `packages/contracts/src/run.ts`

```ts
export const ProjectRefSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});
export type ProjectRef = z.infer<typeof ProjectRefSchema>;
```

`RunResponseSchema` gains:

```ts
  /** The project this run belongs to. Required: run.project_id is NOT NULL. */
  project: ProjectRefSchema,
  /** From ingest metadata, frozen at accept time. Null for every run
   *  created before migration 20260815000000_run_ingest_provenance, and
   *  for any run whose caller did not send them. */
  environment: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
```

**`project` is required, not optional.** Every run has a project by foreign
key, so an optional field would model a state the database cannot hold.
`apps/web/src/api/run.ts` parses responses with `RunResponseSchema.parse`,
so a server that forgets the field fails loudly instead of rendering a blank
where a project name belongs.

The three ingest fields are `.nullable().optional()`, matching how
`simulation`, `description` and `durationMs` are already declared — they
share the property of being absent on most rows.

`RunListResponseSchema` keeps deriving itself from `RunResponseSchema.pick`,
now including `project` and `simulation`:

```ts
RunResponseSchema.pick({
  id: true, status: true, verdict: true, tool: true,
  startedAt: true, toolStartedAt: true,
  project: true, simulation: true,
}),
```

That derivation is what stops the two shapes drifting, and it is why
`simulation` is free.

**`tool` stays in the contract** even though §8.1 removes its column. The
OpenAPI document describes the API, not the table layout, and `TOOL_IDS`
exists to grow.

### 3.2 `packages/contracts/src/project.ts` (new)

```ts
import { z } from 'zod';
import { RunStatusSchema, RunVerdictSchema } from './run.js';

export const ProjectListResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      slug: z.string(),
      name: z.string(),
      /** The project's most recent run by the same ordering GET /v1/runs
       *  uses. Null for a project that has never been ingested into. */
      latestRun: z
        .object({
          id: z.string().uuid(),
          status: RunStatusSchema,
          verdict: RunVerdictSchema.nullable(),
        })
        .nullable(),
    }),
  ),
});
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;
```

**`status` rides along with `verdict` deliberately.** A pending run has
`verdict: null`, and a badge reading that as *not evaluated* would state a
fact about a run nobody has measured yet — the same failure the D-14
sentence fix corrected on the run page. A consumer reads `status` first and
only falls through to `verdict` for a `complete` run.

**`latestRun.id` is included** so the sidebar's badge can link to the run it
describes. It costs one column in a query that already reads the row.

**No `nextCursor`.** An org has a handful of projects, not a page of them.
If one ever has enough to need paging, this endpoint needs a cursor and the
sidebar needs a scroll region — one change, and this paragraph is where it
starts.

---

## 4. `GET /v1/projects`

### 4.1 One query, not one per project

```sql
SELECT p.id, p.slug, p.name,
       r.id AS "latestRunId", r.status AS "latestRunStatus",
       r.verdict AS "latestRunVerdict"
FROM project p
LEFT JOIN LATERAL (
  SELECT id, status, verdict
  FROM run
  WHERE project_id = p.id
  ORDER BY COALESCE(tool_started_at, started_at) DESC, id DESC
  LIMIT 1
) r ON true
WHERE p.org_id = $1
ORDER BY p.name ASC
```

**`LEFT JOIN LATERAL`, not `DISTINCT ON (project_id)` over `run`.** A
project with zero runs must appear in the sidebar — an org's newest project
is exactly the one with nothing in it — and `DISTINCT ON` over the run table
would silently omit it. This is falsification checkpoint 2.

**The inner `ORDER BY` must resolve the same run `RunRepository.list` puts
first** — same `COALESCE`, same tie-break. If those two expressions ever
disagree, the sidebar's "latest run" and the run list's top row describe
different runs, and nothing on screen looks wrong. This is falsification
checkpoint 1.

The requirement is semantic, not textual. `RunRepository.list` qualifies its
columns `r.` because it joins `project` and both tables carry an `id`; this
lateral's subquery reads from `run` alone and needs no alias. Demanding a
literal match would mean inventing an alias for a single-table subquery, and
a comment claiming the two are "character-for-character" identical would
invite a later reader to add one.

Ordered by `p.name ASC` — the sidebar is a list a human scans, so it sorts
the way a human expects, not by creation time.

### 4.2 Auth is one rule

**The projects this credential can see.** A session sees every project in
its org. A bearer token sees the one project it was minted against, as a
one-element list — useful to a CI job resolving its own slug, and consistent
with every other token-scoped read.

Implementation: the same handler and the same query, with `AND p.id = $2`
appended to its `WHERE` when `tenant.projectId` is present. Not two
endpoints and not a 400: a token asking what it can see is a reasonable
question with a correct answer.

### 4.3 Placement

`ProjectsController` in `apps/api/src/projects/`, a new module. Not folded
into `RunsModule`: `ProjectRunsController` already lives beside the runs
because it returns runs, and this returns projects.

---

## 5. `?project=<slug>` on `GET /v1/runs`

| Credential | `?project=` | Result |
|---|---|---|
| Session | resolves in org | Filtered list |
| Session | unknown in org | 404 |
| Session | absent | Unfiltered — the org's runs, as today |
| Token | agrees with its pinned project | Filtered list, same as omitting it |
| Token | names another project | 400 `PROJECT_MISMATCH` |
| Token | absent | Unfiltered within its project, as today |

`PROJECT_MISMATCH` is raised through `badRequest(code, message,
remediation)` in `apps/api/src/common/validation.ts`, the same helper
`ProjectRunsController` already uses for `PROJECT_REQUIRED`.

**404, not an empty list, for an unknown slug.** An empty 200 would describe
a project that exists and happens to be idle. A caller cannot tell those
apart, and one of them is a lie.

**404, not 403, for a slug that exists in another org.** The response must
not distinguish "no such project" from "not yours", or it confirms the
existence of another org's project by its status code. Falsification
checkpoint 4.

Needs `ProjectRepository.findBySlugInOrg(orgId: string, slug: string)`. The
existing `findBySlug` takes an org **slug**; `req.tenant` carries an org
**id**. A new method rather than bending that one into accepting either,
which would make every call site read ambiguously.

### 5.1 The cursor interaction, stated rather than discovered

`RunRepository.list` resolves the cursor **under the same scope it lists
with**. A cursor obtained from the unfiltered list therefore does not
resolve once `?project=` is applied *if the cursor's run belongs to a
different project than the one now being filtered to* — the lookup's `WHERE`
adds `projectId` and finds nothing, so the caller gets an empty page: the
repository's existing, deliberate behaviour for an unresolvable cursor
("silently restarting pagination would resurface items the caller already
saw"). If the cursor's run belongs to the selected project, the lookup finds
it under the narrower scope too and paging continues normally.

This is correct and stays. The web resets the cursor when the filter
changes, so the state is unreachable from the UI. It is documented here so
that an API consumer combining the two gets an explanation rather than a
mystery.

---

## 6. The migration and the writer

### 6.1 Migration `20260815000000_run_ingest_provenance`

```sql
ALTER TABLE "run" ADD COLUMN "environment" TEXT;
ALTER TABLE "run" ADD COLUMN "branch" TEXT;
ALTER TABLE "run" ADD COLUMN "commit_sha" TEXT;
```

Nullable, no default, no backfill. §2 established there is nothing to
backfill from. Every run created before this migration reads null forever,
and that is the honest state — not `''`, which would claim the caller sent
an empty branch.

### 6.2 Three columns, not a JSON bag

`run.engine_options` is JSON because it holds an open set of engine knobs
whose membership changes. These three are a closed, documented, bounded set
that `IngestMetadataSchema` already validates. Columns keep them queryable
the day someone wants every run on `main`.

No index on any of them. Nothing filters on them yet, and an index on a
column that is null for 100% of existing rows earns nothing.

### 6.3 The writer

`CreateRunInput` gains `environment?: string`, `branch?: string`,
`commitSha?: string`. `RunRepository.create` maps each with `?? null`,
exactly as it already does for `idempotencyKey`. `IngestService.accept`
passes them through with the same `...(x ? { x } : {})` spread form.

No worker change. These arrive at accept time and are frozen there, like
`engineOptions`, for the same reason: they describe the run that was
submitted, and a later edit must not rewrite what was true when it ran.

### 6.4 An idempotent re-post does not update them

`accept()` returns the existing run before it writes anything, so re-posting
the same `idempotencyKey` with a corrected `branch` is a no-op. That is what
idempotency means. It is recorded here — and pinned by a test — because the
first person to fix a typo in a pipeline and re-run it will expect
otherwise.

---

## 7. `RunRecord` grows a project

```ts
  /** Joined from `project`. Required: run.project_id is NOT NULL, so every
   *  read path can supply it and none should have to be checked. */
  project: { id: string; slug: string; name: string };
```

All four read paths carry it:

| Path | How |
|---|---|
| `create` | Prisma `include: { project: true }` |
| `findById` | `include` |
| `findByIdUnscoped` | `include` |
| `list` | `JOIN project p ON p.id = r.project_id` in the raw SQL, three added columns on `RunRow` |

**On the record, not joined at the API.** `toListItem` and `toResponse` both
need it; a lookup inside `RunsService.toResponse` would be one extra query
per run detail plus one per list page, and two independent pieces of code
that could disagree about which project a run belongs to.

**The cost, stated:** the worker's `findByIdUnscoped` now joins a table it
does not read — one indexed foreign-key join per job. That is cheaper than
maintaining two `RunRecord` shapes, and far cheaper than an
optional-but-always-present field, which is the promise-nothing-enforces
pattern that produced most of the review findings in sub-projects 1 and 3a.

---

## 8. UI

### 8.1 The run list

Columns become **Started / Project / Simulation / Status / Verdict**.

`Tool` goes. `TOOL_IDS` has exactly one member, so the column reads
`gatling` on every row this platform can currently produce. It returns the
day a second tool ships, at which point it carries information. The field
stays in the contract (§3.1).

The `Run` column goes too: the link moves onto the simulation name, which is
what a reader is looking for. When `simulation` is null — a pending run the
worker has not parsed, or a failed one that never will — the link text falls
back to the short id, as today. The accessible name stays `View run ${id}`
in both cases, because "View" repeated down a column names nothing.

`data-testid="run-row"` and `data-run-id` are untouched. `e2e/helpers.ts`
declares them as a contract independent of visible text and column order,
which is the reason this column change costs no selector churn.

The `<caption>` gains the project sentence; it currently explains only the
ingest-time marker.

### 8.2 The run header

- **Project name** as an eyebrow above the simulation heading, linking to
  `/projects/:slug` (§8.3).
- **Environment, branch, commit** as chips, each rendered only when
  non-null. A run carrying none looks exactly as it does today rather than
  growing three dashes.
- The commit chip shows seven characters, with the full SHA in the group's
  accessible name — mirroring the run list's short-id-versus-full-id
  handling. **It links nowhere:** the platform does not know the repository
  host, and a chip that looks like a link but is not is worse than plain
  text.

Chips use the `role="group"` + `aria-label` wrapper `RunHeader` established
in 3a, not a bare `Badge` — the run-shell review established that
`role="img"` on the shared `Badge` re-types every badge in the run list as a
graphic.

### 8.3 `/projects/:slug`, and why it is in scope

`?project=` would otherwise ship with no consumer — API surface nothing
calls, which is what got `run_indicator.failed` deleted from this schema.

So this sub-project adds a `/projects/:slug` route rendering the existing
`RunList` filtered to one project: `useParams()` supplies the slug,
`fetchRuns(cursor, slug)` passes it through, and the heading reads the
project's name instead of "Runs". It is small, it gives the filter a real
consumer on day one, and it keeps 3b what it was meant to be — sidebar
chrome pointing at routes that already work.

**The cursor does not reset by itself, and assuming it did would ship the
bug §5.1 describes.** `RunList` holds the cursor in `useState`. Moving from
`/runs` to `/projects/a` swaps one route element for another and does
remount it — but moving from `/projects/a` to `/projects/b` matches the
*same* route, so React reuses the component instance and the cursor
survives. The reader would then be paging project B from a cursor pointing
at a row in project A, which no longer resolves under the new scope, and the
list would come back empty for no visible reason.

The fix is one character of intent: the route renders `<RunList
key={slug} projectSlug={slug} />`, so a different project is a different
component. Falsification checkpoint 5 exists to prove it, because the
failure only appears after paging forward and then switching projects —
which no casual click-through does.

---

## 9. Testing

**Integration** (`apps/api/test`), because every claim here is about what
the server returns:

- `GET /v1/projects` under a session and under a token
- The lateral-versus-list ordering agreement (checkpoint 1)
- A project with no runs (checkpoint 2)
- The `?project=` table in §5, all six rows
- The three fields round-tripping through POST and GET (checkpoint 3)
- An idempotent re-post leaving them unchanged (§6.4)
- A run inserted without the columns reading null, not `''`

**OpenAPI.** `openapi.integration.test.ts` gains assertions naming
`RunResponse.project`, the three ingest fields, `ProjectListResponse`, and
the `project` query parameter on `GET /v1/runs`. The previous sub-project
shipped a fix for `run_series_bucket.family` being absent from the document;
"the document validates" never catches an omission, because a document
missing a field is still a valid document.

**Unit** (`apps/web/test`) for the list's simulation-null fallback and the
header's three null branches.

**Playwright** for the header chips' accessible names. Whether a truncated
SHA inside a `<code>` pollutes its group's name is a Chromium question that
`dom-accessibility-api` cannot answer — the rule this repo has now paid for
three times.

**Expected typecheck breakage:** `apps/web/test/RunHeader.test.tsx` and
`RunShell.test.tsx` construct `RunResponse` literals and will fail to
compile the moment `project` becomes required. That is the compiler
enumerating every construction site, not a defect.

---

## 10. Falsification checkpoints

1. **`/v1/projects`'s `latestRun.id` equals `/v1/runs`'s first item.** Seed
   two runs in one project whose `tool_started_at` and `started_at` disagree
   in opposite directions, so a query ordering by the wrong column picks the
   wrong run. This is the only thing standing between the sidebar's "latest"
   and the run list's top row meaning different runs — a disagreement that
   looks like nothing on screen.
2. **A project with zero runs appears, with `latestRun: null`.** Fails the
   day someone simplifies the lateral into a `DISTINCT ON`.
3. **The three fields round-trip.** Written first, this fails today at the
   GET. If it passes before the writer is implemented, it is asserting
   against something other than a stored value.
4. **A slug from another org returns 404, not 403 and not an empty 200.**
   Seed two orgs; ask the first's session for the second's project.
5. **Paging forward in one project and then switching to another shows that
   project's first page.** Not an empty list. Proves the `key={slug}` of
   §8.3 is present; without it the assertion fails on a screen that looks
   merely empty rather than broken.

   **This check belongs in jsdom, not Playwright, and the reason is the
   whole point of the guard.** It was first written as an e2e test using
   `page.goto('/projects/beta')` — and it passed identically with and
   without the `key`, because `page.goto` is a full document load: React
   unmounts entirely and the cursor dies whatever the key says. The bug
   only exists across a CLIENT-SIDE transition between two URLs matching
   the same route, which is a fact about React reusing a component
   instance, not about the browser. So the test renders `MemoryRouter` and
   performs the transition through a link click. An e2e version cannot be
   written today in any case: nothing in the app links from one project to
   another until the sidebar arrives in 3b.

   This is the inverse of the repo's usual rule. Accessible names go in
   Playwright because jsdom cannot see them; component identity across a
   route change goes in jsdom because Playwright's navigation resets the
   very state under test.

---

## 11. Success criteria

- `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration &&
  pnpm test:e2e` all green
- `GET /v1/runs` with no `?project=` returns exactly what it returns today,
  plus the two new fields
- Every run response names its project; no response invents one
- A run posted with `environment`, `branch` and `commitSha` reads them back
- A run posted without them reads null, and its header shows no chips
- `/projects/:slug` lists that project's runs and nothing else, and
  switching between two projects after paging forward shows page one of the
  second, not an empty list
- The OpenAPI document declares every field and parameter added here
