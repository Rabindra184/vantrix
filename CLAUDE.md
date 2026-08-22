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

### Deleting merged branches, and the stacked-PR trap

**Delete a `feat/*` or `fix/*` branch once its PR has merged**, locally and on
`origin`. Nothing is lost: the merge commit keeps every commit reachable from
`main`, which is what `git merge-base --is-ancestor <tip> main` proves before
you delete. Deleting is also what makes GitHub **auto-retarget** any PR still
stacked on it, which removes the trap below rather than leaving it armed.

This reverses the older convention, and the reversal is the point. Branches
used to be kept, and PR #8 sat pointing at `publish/parity-charts` after that
branch had merged — merging it would have landed the work on a side branch,
with no error. Its own description claimed the retarget would happen
automatically; it was wrong, precisely because the base branch still existed.

The `publish/*` branches and PRs #1–#9 stay as history — they record the
stripped-publication era described above, and nothing points at them. Keeping
those is not the same as keeping every merged branch.

So: if you somehow have a PR stacked on a branch that has already merged and
still exists, retarget it explicitly before merging:

```
gh pr edit <N> --base main
```

Either way, **verify against the server** (`git ls-remote origin refs/heads/main`)
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

`nvm use` first, and if a run reports fewer than **128 files / 1373 tests**, it
did not run everything. (Update those two numbers when a sub-project adds
suites, or the next reader calibrates against a stale floor and a
silently-skipped run looks like a pass. Last measured on the test-api branch,
which added ONE unit file — `packages/contracts/test/test.test.ts` (13) — from
a floor of 127 / 1360. Its integration floor is **123 files / 1462 tests**
(that `.ts` file runs there too, plus `apps/api/test/tests.integration.test.ts`
(21) and two cases in `openapi.integration.test.ts`) and its e2e stays 96.

ONE THING FROM IT, AND IT IS ABOUT ASSERTING A SPLIT. The tests routes guard
per HANDLER — GETs take either credential, the PATCH is session-only — and the
gate over that asserts BOTH halves: the PATCH overrides to cookieAuth, AND the
GETs carry no override at all. Only the pair catches the split collapsing in
either direction. A one-sided assertion would have let a GET quietly become
session-only, locking out the bearer callers it exists for, with every other
test still green. **When a rule is "these differ", assert both sides of the
difference, not the interesting one.**

Before that, the test-entity branch added no unit
FILE and no unit case — its whole surface is a migration, a worker rule and one
INTEGRATION file — so the unit floor is unchanged while **integration rises to
121 files / 1426 tests** (`apps/worker/test/test-entity.integration.test.ts`, 8)
and e2e stays 96.

TWO THINGS ABOUT RUNNING THE GATE, AND NEITHER IS ABOUT THE CODE.

FIRST, `No space left on device` LOOKS LIKE TWO HUNDRED BROKEN TESTS. Docker's
VM disk filled (1.9 GB free of 58.4 GB) and the integration suite failed across
nearly every file at once — `LiveFoldOwner`, `PipelineService`, the OpenAPI
document, the rules API, all of them. Not one message named the disk except a
single Postgres line buried in the output: `could not create file
"base/16384/…": No space left on device`. Everything downstream reported
`Can't reach database server`, which reads like a stack problem and is not one.
The PerfPortal database was 14 MB at the time — the suite's own data is never
the cause. `docker system df` is the check, and `docker builder prune -f`
reclaimed 20.4 GB with no images, volumes or containers touched. Re-run after
that: 1426/1426.

SECOND, `pnpm test:e2e` AT ITS DEFAULT FIVE WORKERS IS NOT RELIABLE ON A LOADED
MACHINE. Five specs failed with missing run data — no statistics table, no
error count, no compare chart — and every failure was a fixture whose data had
not arrived. It reproduced on a tree with the branch's changes STASHED, and
worse there (5 failures against 3), which is the measurement that matters: it
is not the change under test. `--workers=2` passes 96/96, and CI passes at its
own default. **Before believing an e2e failure that looks like missing data,
re-run at `--workers=2`, and re-run it with your change stashed.** The second
half is what separates "my change broke this" from "this machine is busy".

Before that, the rail-layout
branch, which added no unit FILE and 2 cases to `apps/web/test/Badge.test.tsx`,
from a floor of 127 / 1358. Its integration floor stays 120 files / 1418 tests
(every file it touches is a `.tsx` integration never runs) and its **e2e rises
to 96**.

TWO THINGS FROM IT.

FIRST, A `truncate` DEFECT IS INVISIBLE TO EVERY TEXT ASSERTION. `truncate` is
`text-overflow: ellipsis`, which leaves the full string in the DOM — so
`textContent` is identical whether a name is clipped or not, and every
existing assertion in `ProjectRail.test.tsx` and `project-rail.spec.ts` passed
while the rail was clipping fourteen-character project names. Only
`scrollWidth > clientWidth` can see it, and only in a browser. What caused it
is worth as much as the fix: the badge is `shrink-0` and the name is the
flexible one, so a 119px status word took its width out of the NAME's budget —
"Search Service" needed 94px and got 84. **A `shrink-0` sibling is a claim on
space that something else pays for, and the payer is whatever has
`truncate`.**

SECOND, THE RAIL'S ACTIVE-ROW FILL WAS NEVER DOING THE JOB ITS COMMENT
CLAIMED. `ProjectRail`'s docstring described `bg-surface` as a "card-raised"
signal, the card colour being one step lighter than the sidebar in both
themes. Measured, that step is **1.05:1 in dark and 1.04:1 in light** — one
step lighter, and very nearly nothing. What a reader actually sees is the
accent `before:` bar (6.38:1 / 4.96:1) and, since this pass, the accent-
coloured ICON (6.07:1 / 5.18:1). The claim was not false, it was just not
load-bearing, which is the harder kind of stale comment to notice.

Before that, the
chart-header-controls branch, which added ONE unit file —
`apps/web/test/ChartActions.test.tsx` (13) — from a floor of 126 / 1345.
Its integration floor stays 120 files / 1418 tests (every file it touches is a
`.tsx` integration never runs) and its **e2e rises to 95**, the first e2e case
added since the review-followup branch: a chart filling the screen, which no
unit layer can see.

TWO DEFECTS FROM IT, AND BOTH WERE INVISIBLE TO A GREEN SUITE.

FIRST, A REMOUNT NEEDS **BOTH** ECHARTS EFFECTS RE-RUN, NOT ONE. Expanding a
chart moves its canvas into a `<dialog>`, which remounts the node — so the
instance effect has to rebuild on the new element, which is obvious, and the
OPTION effect has to re-run too, which is not: a fresh instance has no option
on it. Miss the second and full screen is a blank rectangle with a valid SVG
root in it. `Chart.tsx` lists `expanded` in both dependency arrays and says why
in each. Verified red by removing the option one.

SECOND, `m-auto` ON A `<dialog>` IS LOAD-BEARING UNDER TAILWIND. A modal
`<dialog>` centres itself with the UA stylesheet's `margin: auto`, and
Tailwind's preflight resets `margin: 0` on **every** element — so a modal pins
to the top-left corner and the class list looks entirely reasonable. Measured
at (0,0) in a 1440×900 viewport before the fix. jsdom lays out nothing, so only
a browser can see it; `run-charts.spec.ts` now asserts the left and right gaps
match, and that assertion was verified red too.

A THIRD THING NEARLY SHIPPED AND IS RECORDED BECAUSE IT REPEATS AN EXISTING
LESSON ONE ROLE OVER. `ChartActions`'s copy-feedback live region was written
always-mounted, per the usual advice — so ten charts contributed ten
permanently-EMPTY `role="status"` elements, and `RunTelemetry`'s clock-skew
test began resolving eleven. That is exactly the unscoped-`alert` trap recorded
below, reintroduced for `status` within a minute of being read. A status role
now exists exactly when there is a status, which is what `Chart`'s own
empty-state `<p role="status">` always did. **The rule generalizes: a component
rendered N times per page must not contribute an always-present landmark or
live region.**

Before that, the sla-rule-authoring
branch, which added TWO unit files — `packages/contracts/test/rules.test.ts`
(29) and `apps/web/test/ProjectRules.test.tsx` (12) — from a floor of
124 / 1304, which is FIVE TESTS ABOVE the 124 / 1299 recorded below and
measured on `main` itself rather than inferred by subtraction. The integration
and e2e figures were both accurate; only the unit test count had drifted. That
is the drift this parenthetical exists to catch, and it is worth knowing it
happens even while the FILE count stays right — a branch that adds cases to an
existing file moves one number and not the other, which is the easier of the
two to forget. Its integration floor is 120 files / 1418 tests: `rules.test.ts`
is a `.ts` file integration runs too, plus one new integration FILE
(`apps/api/test/rules.integration.test.ts`, 33) and one case added to
`openapi.integration.test.ts`. Its e2e stays 94.

THREE THINGS FROM IT, AND THE FIRST IS A TRAP THIS FILE ALREADY WARNS ABOUT
IN THE OTHER DIRECTION. A page-wide `getByRole('alert')` silently changes
meaning when a page grows a second thing that can fail: it stops asking "did
the revoke fail" and starts asking "did ANYTHING fail". Composing
`ProjectRules` into `ProjectSetup` broke two token tests that way — the
rules panel's own load failure (its query has no server under jsdom)
answered the query first. Unlike the `ProjectRail` link collision, jsdom CAN
see this one, because both alerts are in ONE document rather than in two
components rendered apart. The fix is the same either way: scope the query
to the block it means (`token-mint`, `token-list`), and mock the new
section's data the way the file already mocked the others. **A page with N
independently-failing sections cannot be asserted on with an unscoped
`alert` query, and the assertion does not fail when it goes wrong — it just
starts passing for a different reason.**

SECOND, THE 201 CARVE-OUT IN `openapi.integration.test.ts` IS
BIDIRECTIONAL AND THAT IS THE POINT. Adding `POST /v1/projects/{slug}/rules`
to `CREATES_SYNCHRONOUSLY` does not wave it through: the allowlist branch
ASSERTS the operation still declares 201, so an operation that drops it
while its handler keeps returning 201 fails there rather than being skipped.
The standard it had to meet is the one already written down — a handler that
awaits a single Prisma insert and returns the row it wrote, complete and
addressable when the response is sent.

THIRD, A UNIT FAILURE THAT NEVER REPRODUCED, recorded because the
investigation is worth more than the verdict.
`apps/web/test/RequestDetail.test.tsx`'s "renders the row it found, and says
so when there is none" failed ONCE, on a branch that does not touch it, with
a `request-stat-count` cell from that test's own FIRST render surviving into
its second. It passes alone, and the full unit suite then passed six
consecutive times at 126 / 1345, plus four runs of `apps/web/test` alone.
That test does two renders in one case with an `unmount()` between them,
which is the only unusual thing about it. One occurrence stands, mechanism
undiagnosed — do not "fix" it on the strength of this note, and do not
assume a new file caused it beyond perturbing timing.

THE WHOLE GATE PASSED AND PROVED NOTHING ABOUT THE FEATURE, which is the
fourth thing and the reason the section below this one exists. Every suite
was green while the only question that mattered — does a rule authored here
actually judge a run — was answered by no test in any of them, because the
three suites between them never author a rule through the API and then feed
a real simulation to the evaluator. Three real `gatlingRun` executions
through `clients/gatling-gradle/e2e/e2e-project` did answer it, and it took
about ten minutes: a run-scoped p95 gate PASSED at 645ms/800, an error-rate
gate FAILED at 2.23%/1% and drove the run's verdict to `failed`, disabling
that gate through PATCH flipped the NEXT run's verdict to `passed` with one
assertion instead of two, and neither the disable nor a subsequent DELETE
touched the assertion the first run had already recorded. A request-scoped
rule authored through the browser form then failed `Search`'s p50 at 572ms
against 100 — independently agreeing with `ParitySimulation`'s own
deliberately-failing Gatling assertion about that same request, which is a
cross-check no unit fixture can give you.

Before that, the redesign-run-page
branch added no unit FILE and 1 case to
`apps/web/test/RunDecisionBand.test.tsx` — the gate tick strip follows the
counts' own evaluated gate and stays aria-hidden — from a floor of 124 / 1299.
Its integration floor stays 118 files / 1355 tests (the touched test file is
`.tsx`, which integration never runs) and its e2e stays 94. The
redesign-foundation branch before it (the control-room retheme: palette, three
vendored faces, shell restyles) moved no counts at all — its churn was inside
`palette.test.ts`'s mirrors, updated in lockstep with `charts/theme.ts`.
Before that, the duration-is-activity-span branch added no unit
FILE and 2 cases to `packages/statistics/test/parity.test.ts`, from a floor of
124 / 1297. Its integration floor is 117 files / 1351 tests (that `.ts` file
runs there too, plus `PT-G-13` in `parity.e2e.test.ts`) and its e2e stays 94.
The openapi-public branch then took integration to 118 files / 1355 tests --
one new integration FILE, `apps/api/test/openapi-public.integration.test.ts`
(4) -- leaving the unit floor at 124 / 1299 and e2e at 94, since it adds no
`.tsx` file and no spec.

TWO THINGS FROM THAT BRANCH, AND THE SECOND IS ABOUT HOW TO RUN THIS GATE.

FIRST, `apps/api/test/openapi.integration.test.ts` FAILED ONCE WITH
`expected 401 to be 200`, AND WAS NEVER REPRODUCED. Recorded because the
investigation is more useful than the verdict. The file passes 4 of 4 in
isolation and the full suite passes clean on an idle stack; one occurrence
stands, mechanism undiagnosed. An earlier note here claimed it "fails 2 of 3
on main" — that measurement was taken while a queued e2e was running and is
worthless; see the second point. Do not trust a flake rate measured against a
busy stack, including one your own diagnosis is keeping busy.

What the investigation DID establish, by measuring the real bootstrap:
`/v1/openapi.json` and `/v1/docs` answer 200 with no credential while
`/v1/runs` answers 401. Those two were public only as a SIDE EFFECT OF MOUNT
ORDERING — `mountOpenApi` registers them on Express before `app.init()`, and
Express matches in registration order, so they resolved ahead of
`AuthMiddleware`, which excludes nothing. `app.module.ts` states that contract
explicitly now and `openapi-public.integration.test.ts` pins it. Note which
case guards it: `/v1/runs` stays 401 even under a wide-open `exclude('v1/*path')`,
because `AuthGuard` still runs for MATCHED routes — only the
unimplemented-path case (must 401, never 404) catches an over-broad exclusion,
and it was verified red exactly that way.

SECOND, "RUN INTEGRATION BEFORE e2e" IS NOT ENOUGH — NOTHING ELSE MAY TOUCH
THE STACK WHILE EITHER RUNS, INCLUDING DIAGNOSIS. Three ad-hoc integration
runs started to investigate the flake above, while a queued e2e was already
executing, truncated every table underneath it: 63 of 94 passed and the log
filled with `failed to update last_used_at ... No record was found for an
update` — tokens deleted mid-run. Nothing was wrong with the code. Re-run
alone: 94/94. The rule below about not racing the suite against ITSELF
applies just as much to the commands you type WHILE it runs.

Before that, the second review-followup
branch, which added ONE unit file — `RunSectionNotFound.test.tsx` (3) — plus a
route-declaration guard in `paths.test.ts`, from a floor of 123 / 1293. Its
integration floor is 117 files / 1348 tests (four cases in
`repositories.integration.test.ts`: a project-name search, an id-prefix
search, and a PLAN assertion) and its e2e rises to 94 — the first e2e case
added in several sub-projects, for a stale run-section URL, which only a real
router resolving a real URL can see.

THE PLAN ASSERTION IS THE ONE WORTH KNOWING ABOUT. Two ordinary-looking
things silently made the run search's indexes unreachable while every row
assertion stayed green: wrapping a nullable column in `COALESCE(col, '')`
(an expression a plain-column index cannot serve — and the COALESCE was a
no-op anyway, since `NULL ILIKE x` is NULL and NULL in a positive OR is
already false to a WHERE clause), and matching the project through the JOIN.
That second one is the subtle half: PostgreSQL can only fold an OR into a
BitmapOr while it can index EVERY branch, and a branch on a JOINED table is
never indexable — so one cross-table clause cost the six run columns beside
it their indexes too. The project match is resolved by its own query now and
arrives as `project_id = ANY($n::uuid[])`. Adding a column to that OR means
adding an index for it, or the whole predicate goes back to a sequential
scan.

`pg_trgm` IS A TRUSTED EXTENSION, AND THE FIRST VERSION OF THIS NOTE SAID
OTHERWISE. Migration `20260821200000_run_search_trigram` runs
`CREATE EXTENSION IF NOT EXISTS pg_trgm`, and it was written up — in the
migration's own comment and in the review that shipped it — as needing
"rights an unprivileged application role usually does not have". Measured on
`postgres:16-alpine`, that is false: `pg_available_extension_versions`
reports `trusted = t` for 1.3 through 1.6, and since PostgreSQL 13 a trusted
extension installs for a NON-SUPERUSER holding CREATE on the database. Both
sides were tested — a nosuperuser database owner succeeded; a nosuperuser
role without CREATE on the database got `permission denied to create
extension "pg_trgm"`.

So the failing shape is narrow (CREATE on the schema but not the database),
and any role that ran the twenty migrations before it already has broad DDL
rights. `infra/pg_trgm-preflight.sql` answers it for a specific database
without changing anything — run it AS THE ROLE THAT RUNS MIGRATIONS, or it
reports on the wrong identity. The onprem compose profile is settled either
way: `POSTGRES_USER` is created superuser by the official image, and the full
migration history was applied from scratch on an empty database on it.

THE GENERAL POINT IS WORTH MORE THAN THE EXTENSION. A privilege claim is
cheap to assert and cheap to TEST — `create role … nosuperuser`, a scratch
database, and the statement itself. Asserting one from memory is how a note
that reads like operational knowledge ends up overstating a deployment risk
by a wide margin.

EDITING AN ALREADY-APPLIED MIGRATION CHANGES ITS CHECKSUM, and correcting
that comment did exactly that — `_prisma_migrations.checksum` still holds the
hash of the original text. `prisma migrate deploy` and `prisma migrate status`
both tolerate it: verified against a database holding the OLD checksum, deploy
answered "No pending migrations to apply" and status answered "Database schema
is up to date!", with no warning. Since `deploy` is the only path this repo
uses (README, infra/README, infra/docker-compose.yml, and the command in this
file), a comment-only edit is safe.

NOT VERIFIED, and stated as such: `prisma migrate dev` detects modified
migrations and may offer to reset. It is not run here — it appears only in
historical planning docs — but if you ever do, expect it to notice.

Before that, the enterprise run
dashboard branch and the fifteen-finding review wave that followed it, which
between them added FIVE unit files — `RunDecisionBand.test.tsx` (7),
`assertionExport.test.ts` (2), `compareSummary.test.ts` (3),
`runBaseline.test.ts` (6) and `RunOverviewTab.baseline.test.tsx` (2) — plus
cases across `RunList.test.tsx`, `RunStats.test.tsx` and
`RunDetail.live.test.tsx`, from a floor of 118 / 1265. Its integration floor is
117 files / 1344 tests: no `.tsx` file runs there, but `assertionExport`,
`compareSummary` and `runBaseline` are all `.ts`, and
`apps/api/test/read.integration.test.ts` gained six cases for the new list
filters. Its e2e stays 93 — that suite gained no case, and the one spec it
touched was hardened rather than added to.

THREE THINGS FROM THAT REVIEW WAVE ARE WORTH KNOWING, and none of them was
visible to `pnpm test:unit`. FIRST, THE INTEGRATION SUITE CANNOT SHARE ITS
DATABASE WITH A RUNNING WORKER, which is the same hazard as the
cannot-race-itself rule below and reads identically: 73 failures across 13
files, `deadlock detected` on the setup `TRUNCATE`, unique-constraint
violations, and timeouts — none of them naming a cause. A `pnpm --filter
@perfportal/worker start` left running from an earlier session was holding
the `FOR UPDATE` rows the sweeper polls while the suite tried to truncate
underneath it. `pgrep -f vitest` is not enough on its own; check for a worker
and an API too (`pgrep -f 'perfportal/worker'`). Stopping it turned the same
tree green, 1344/1344, with no code change.

IT IS NOT ONLY POSTGRES. A running worker also holds a `LiveFoldOwner`
subscribed to `live:opened` on the SAME Redis, and that owner CLAIMS runs —
so it can win the claim a test is waiting for. Seen as
`fold-owner.integration.test.ts`'s "evaluates a rule for a run claimed via a
live:opened ping" failing with `expected null not to be null` from
`owner.snapshotOf(runId)`, deterministically, on a tree whose only change was
in an unrelated test. Nothing in that message points at a second worker. The
loop that finds it:

```
for p in $(pgrep -f "dist/main.js"); do
  printf '%s %s\n' "$p" "$(lsof -a -p "$p" -d cwd -Fn | sed -n 's/^n//p')"
done
```

SECOND, A SHELL COMPONENT MUST NOT CONTRIBUTE AN `<h2>`. `run-tables.spec.ts`
asserts the Overview tab's heading outline is EXACTLY
`['Assertions', 'Simulation assertions', 'Statistics']` and the Errors tab's
is exactly `['Errors']`. `RunShell` renders above the `<Outlet/>`, so
anything it draws is on all five tabs — `RunDecisionBand` shipped with an
`<h2>` carrying its verdict sentence and broke that outline on every one of
them, with a heading whose WORDS changed per run. `SlaBanner` and
`LiveStatusStrip` contribute no heading for exactly this reason; `RunHeader`
owns the one `<h1>`. Shell chrome is named by `aria-label` on its `<section>`.

THIRD, `page.mouse` DOES NOT SCROLL AND `locator.click()` DOES. The scrubber
drag in `run-charts.spec.ts` is the suite's only raw-mouse gesture, and it
takes VIEWPORT coordinates — as do `boundingBox()` and the in-page
`getBoundingClientRect()` it locates the handle with. Adding one more band of
chrome above the tab content pushed the brush below the fold at the default
1280x720, so the query still found the handle, the measurement still returned
a box, the drag landed on empty page, and the only symptom was the URL
assertion timing out five seconds later. It now calls
`scrollIntoViewIfNeeded()` before taking any geometry. Any test that drives
`page.mouse` needs the same line.

Before that, three review
follow-ups, which added ONE unit file —
`packages/persistence/test/project-repository.test.ts` (6) — and 4 cases to
the existing 409 case in `apps/api/test/projects.integration.test.ts`. Its
integration floor is 114 files / 1325 tests (the new `.ts` file runs there
too) and its e2e stays 93. The three: a duplicate-slug 409 now carries a
real `remediation` via a new `conflict()` helper beside `badRequest`,
because `ProblemFilter`'s fallback tells the user to consult the OpenAPI
document for a request that matches it perfectly; `formatStarted` became
`formatInstant` and `ProjectSetup` stopped carrying a third private
`toLocaleString()` copy; and `createInOrg` no longer maps EVERY P2002 to
"that slug is taken". THAT LAST ONE IS THE INTERESTING TEST. Only one
unique index exists on `project`, so the branch that matters — a P2002 that
is NOT the slug — cannot be produced against a live schema, which is why
its file stubs the client instead. The real `meta.target` shape
(`['org_id', 'slug']`, database column names rather than Prisma field
names) was OBSERVED by triggering a genuine duplicate before the cases were
written, not guessed. From a floor of 117 / 1259. Before that, the duplicate
"New project" link fix, which added no unit FILE and 1 unit case to
`ProjectRail.test.tsx` plus 1 E2E case to `run-list.spec.ts` — so its e2e
floor rises to 93, the first time that number has moved in several
sub-projects, and its integration floor stays 113 files / 1319 tests
(neither file is a `.ts` integration runs). The rail carried a "New project"
row while `RunList`'s heading rendered the same action, and because the rail
is on EVERY authenticated page the `/runs` document held two links with one
accessible name. THE UNIT SUITE COULD NOT SEE IT AND NEVER WILL: jsdom
renders one component at a time, so a collision BETWEEN two components in
one document is invisible there — the e2e case is the guard, and it failed
with "locator resolved to 2 elements" when verified red. The unit case
pins WHICH component dropped the row, so a re-add fails with its cause
attached rather than as a strict-mode error in an unrelated spec. From a
floor of 117 / 1258. Before that, the project setup
and token-management UI, which added two unit FILES —
`apps/web/test/NewProject.test.tsx` and `apps/web/test/ProjectSetup.test.tsx`
— covering the create-project form and the API-token screen, plus the
review-fix cases those two grew: a slug field that ate every typed hyphen
(the full `slugify` ran per keystroke and trims a trailing `-`, so
`checkout-api` became `checkoutapi`), a revoke that failed silently, a copy
button that claimed success with no clipboard, a one-click destructive
revoke, and `paths.test.ts`'s new guard that reads `App.tsx` and rejects any
literal segment under `/projects/` matching the slug grammar — `/projects/new`
had been permanently shadowing a project legitimately slugged `new`. Its
integration floor is 113 files / 1319 tests: no integration FILE was added,
but `apps/api/test/openapi.integration.test.ts` gained a third exception to
the never-declare-201 rule, and the two new `.tsx` files are unit-only, so
the file count holds while the test count moves. THAT 201 GATE IS WORTH
KNOWING ABOUT: it went red on CI for `POST /v1/projects` and is not
cosmetic — 201 is reserved here for operations that really do create
synchronously, and every other create is a 202 over a state machine. A new
201 has to be argued for, and it only runs under `test:integration`, so a
green `pnpm test:unit` says nothing about it. Its e2e stays 92: the specs
gained cases inside existing `test(` blocks (the Compare tab), not new ones.
From a floor of 115 / 1245. Before that, the header-height
token, which added no unit FILE and 2 cases to `tokens.test.ts` — the shell
header's 56px had been three hard-coded spellings in three files
(`AppShell`'s height, `ProjectRail`'s sticky offset AND its
`calc(100dvh - …)`, `RunTabs`' sticky offset) that had to agree with nothing
making them, and the failure when they stop is invisible to jsdom: the
tab strip slides UNDER a resized header as a blurry ghost band only a
scrolling browser shows. The two cases gate the declaration (once, and
aliased into the spacing namespace under a DIFFERENT name — `@theme`'s
self-reference trap) and the consumption (each dependent reads the token;
none still contains `h-14`, `top-14` or `3.5rem`). That second case scans
WHOLE FILES, comments included, which is deliberate — stale prose naming
the old spelling is exactly as misleading as a stale class, and it caught
its own author's comment first. Verified for real by BUILDING and grepping
the emitted CSS rather than trusting the token: `.h-header`,
`.top-header`, `.lg\:top-header` and `calc(100dvh - var(--header-height))`
all present. A token absent from `@theme` generates NO utility, silently,
so a source-only assertion would have passed against a page with no
height at all. The same build revealed a second thing worth knowing:
Tailwind v4 SCANS `apps/web/test`, so every class string a test quotes as
DATA became a real rule in the shipped bundle — the gate forbidding
`top-14` was itself emitting `.top-14`. `tokens.css` now carries
`@source not '../../test'`; the rebuild dropped exactly six rules, all six
verified test-injected by diffing the selector sets, with nothing from
`src` lost. From a floor of 115 / 1243. Its integration floor is 113 files
/ 1312 tests — the file count is unchanged but the TEST count moved,
because `tokens.test.ts` is a `.ts` file and the integration config runs
every one of those; its e2e stays 92, which runs no `.ts` unit file at
all. THE e2e-BEFORE-INTEGRATION TRAP BELOW CLAIMED THIS BRANCH TOO, which
is worth a second datapoint since the first cost two sessions: run in that
reverse order, integration came back `1 failed | 1311 passed` with no
failing assertion anywhere in the output, and re-run alone against an
untouched tree it was 1312/1312 green. Nothing about the failure named
itself; only the ORDER did. Before that, the UI
modernization branch (shadcn-style cva/cn foundation, lucide-react behind
`components/icons.tsx`'s unchanged exports, and the rail's desktop
collapse), which added no unit FILE and 3 cases to `ProjectRail.test.tsx`,
all pinning the collapse's one load-bearing decision: the collapsed state
is CSS-ONLY (`lg:sr-only` labels, `lg:hidden` badges), so every row's
accessible name and exact textContent — which this file already pins
verbatim — are IDENTICAL in both states, the toggle's own name flips to
the action it will perform, and the choice survives a remount via the same
storage discipline as `theme.ts`. Verified red: conditionally RENDERING
the name span instead — the obvious rewrite, and what the reference design
does — failed exactly the textContent case. Measured from a floor of
115 / 1240: the recorded floor below (112 / 1232) had gone stale against
main by three files and eight tests before this branch touched anything,
which is precisely the drift the parenthetical you are reading exists to
prevent. Its integration floor is 113 files / 1310 tests and its e2e is
92 — also both above their recorded values below, re-measured green on
this branch; `ProjectRail.test.tsx` is a `.tsx` file integration never
runs, so this branch's own cases move only the unit floor. Before that,
the two residual
fixes left before the five-tab live page branch merges, which added no unit
FILE and 2 unit cases: one each to `RunTelemetry.test.tsx` and
`RunCompare.test.tsx`, both pinning the SAME shape of gap. Every hook in
each component already sits above its own `!terminal` early return, correct
today — but nothing PINNED that shape, and this branch has already shipped
that exact class of bug twice, once in `RunTelemetry.tsx` itself. Each new
case mounts the component RUNNING, then re-renders the SAME instance
TERMINAL, the identical shape `RunTrends.live.test.tsx`'s own "survives a
running run finishing while the reader is on this tab" already used for
that tab; mounting each state SEPARATELY — what every other case in both
files does — cannot catch this, because the defect
("Rendered more hooks than during the previous render.") is in the
TRANSITION, not in either state alone. Verified red: moving `!terminal`
above one hook in each file (the `useState`/`useQuery` block that follows)
turned the new case red with that exact error, and reverting made it green
again. `RunTelemetry`'s case also re-proves CRITICAL 1 AT the transition
rather than only at either endpoint — `enabled: terminal` means
`/telemetry` never fires while running, so the flip has to trigger a FRESH
fetch rather than surface a cached `available: false`, and the case asserts
a `/telemetry` request lands only after the flip. The other half of this
residual fix touched no test: two comments — `LiveStatusStrip.tsx`'s own
docstring and `RunShell.tsx`'s echo of it — still claimed the strip "now
always has something to say about polling, capped or not," false in
exactly the state `streamed` was added for (a `running` run with no
evidence yet renders NOTHING there, deliberately, on a compact viewport and
on a desktop's first paint); both now say so instead. From a floor of
112 / 1230. Its integration floor stays 111 files / 1297 tests and its e2e
stays 90 — neither runs a `.tsx` file, and this fix touched no spec. Before
that, the five-tab live page branch's own final whole-branch review fix
wave, which fixed six
findings in one pass before merge: `RunTelemetry` was the one tab whose
query was never gated on `terminal` — `telemetryQuery` carries `staleTime:
Infinity` (`api/metrics.ts`), so a live run's honest `available: false` got
fetched, cached FOREVER, and silently relabelled as "no load generator
reported" the moment the run went terminal, with nothing ever refetching it;
`LiveStatusStrip` claimed "Reconnecting" with no evidence a socket had ever
delivered anything, true on every phone (§22.6 disables the socket below
768px) and on a desktop's first paint; `RunShell` re-derived `terminal` from
a `status` allowlist instead of receiving it as a prop, the exact
`statusFor` trap this file documents elsewhere; a stale doc comment in
`api/metrics.ts` still claimed charts could only mount under a `ready` run;
`RunCompare` — a sixth `<Outlet/>` child the five-tab audit missed — fired
`/trends` with no `terminal` gate at all; and a widened-202 test consumer in
`apps/api/test/telemetry.integration.test.ts` would have silently computed
against the Unix epoch (`new Date(null)`) rather than failing loudly. One
new file, `apps/web/test/RunCompare.test.tsx` (5: the withheld wording
across pending/parsing/running, and that `/trends` fires only once the run
is terminal), plus 2 cases each to `LiveStatusStrip.test.tsx` (a
disconnected, never-streamed run says nothing at all, not "Reconnecting" —
the exact prop combination a compact viewport produces) and
`RunShell.test.tsx` (the shell trusts the `terminal` PROP over `status` in
both directions, proving neither `complete` nor `running` predicts it any
more), and 1 case each to `RunTelemetry.test.tsx`, `RunOverviewTab.live.test.tsx`,
`RunChartsTab.live.test.tsx` and `RunErrorsTab.live.test.tsx` — the missing
per-tab fetch spy the review itself called out (before this, the rule was
pinned only in `RunShell.test.tsx` and `RunTrends.live.test.tsx`, and
`RunTelemetry` was exactly the tab no spy was watching) — from a floor of
111 / 1217. Its integration floor stays 110 files / 1298 tests: the one new
file is a `.tsx` component test integration never runs, and the one `.ts`
file this wave touched (`telemetry.integration.test.ts`) gained a defensive
throw in its own setup, not a new case. Its e2e stays 92, unchanged. Before
that, the five-tab live page sub-project itself, which made a run page
render its header and five tabs for EVERY run state rather than only a
terminal one — deleting three standalone
screens (`Processing`, `Live`, `LiveCapped`) and redistributing their
content into `RunShell`, `WaitingPanel`, and per-tab live branches.
`apps/web/test/run-detail.test.ts` is GONE: its four cases pinned the
polling-cap UI of the deleted `Processing` component; three are now covered
by `LiveStatusStrip.test.tsx`'s own capped-block cases, and the fourth —
that the cap's two sentences never coexist — became a real assertion there
("the capped block REPLACES the finalizing notice, never joins it").
`RunDetail.live.test.tsx` shrank from 19 cases to 9 the same way, not by
loss: most of what it pinned (a distinct `<h1>`, a standalone "still
processing" screen) no longer exists to assert on, and the file's own
docstring accounts for every remaining old case as moved, already covered
elsewhere, or left as an `it.todo` naming the task that will re-cover it.
Six new files carry what moved plus what is genuinely new:
`WaitingPanel.test.tsx` (4, the pending/parsing distinction, and that it
owns neither the page's `<h1>` nor its back link), `LiveStatusStrip.test.tsx`
(10, the strip every tab now mounts unconditionally —
streaming/reconnecting/frozen phrasing, the partial-seed notice ALONGSIDE
the finalizing one, and the capped block REPLACING either streaming
sentence rather than joining it), `RunOverviewTab.live.test.tsx` (5, the
live tiles, the withheld statistics table stated rather than omitted, and
`WaitingPanel` for a pending run with no delta yet),
`RunChartsTab.live.test.tsx` (3, the five live figures with the two
withheld ones named, gated behind `DesktopOnly`),
`RunErrorsTab.live.test.tsx` (2, the errors table kept live while its own
chart says it is not), and `RunTrends.live.test.tsx` (6, an `it.each` gate
across pending/parsing/running plus surviving a running run finishing
mid-read). Plus 13 cases to `RunShell.test.tsx` (mounting the strip above
the outlet, gating the time brush and the shared-metric fetch behind
liveness, and threading live state through the outlet context), 3 to
`RunHeader.test.tsx` for rendering off bare identity now that the header no
longer needs a whole run object, 2 to `RunTelemetry.test.tsx` for a
non-terminal run, and 4 to `packages/contracts/test/live.test.ts` for the
202 body's own identity fields — from a floor of 106 / 1179. Its
integration floor is 110 files / 1298 tests — one FEWER file than the unit
floor's rise would suggest, because `run-detail.test.ts` was the only
deleted file integration also ran; every new file above is a `.tsx`
component test integration never runs — and its e2e is 92. Before that, live
SLA signals' whole-branch review fixes, which added no unit FILE and 9 unit
cases: 6 to
`apps/web/test/SlaBanner.test.tsx` (the denominator naming what it counts, the
unchecked-rule count in both plurals and its absence at zero, and the two
rules-could-not-be-loaded cases — the one state where that banner renders with
nothing breaching), 2 to `packages/contracts/test/live-delta.test.ts` (a delta
written before `sla` existed, and an `sla` written before its two newer
fields did — a required field there blanks the live page for a whole rolling
deploy, because the browser drops any frame that fails the schema and the
gateway forwards stored bodies without validating them) and 2 to
`apps/worker/test/live-delta.test.ts`, MINUS one: `packages/sla/test/stats.test.ts`
lost the case claiming to pin batch/live agreement, whose two sides were the
identical expression. Its replacement is an integration file — see that
file's own note. Its integration floor is 111 files / 1297 tests and its e2e
is 90. Before that, live SLA signals itself —
the run page's own SLA breach banner — which added
`packages/sla/test/stats.test.ts` (4 at the time, `toEvaluableStats`'s field
mapping and its "does not carry an unrelated field" boundary — the fourth was
the tautology the whole-branch review removed),
`packages/sla/test/evidence-gate.test.ts` (6, the evidence floor a live tick
judges a metric against before it counts as evaluated — `not_applicable`
below the floor, a real breach once it clears, and absent by default for the
batch path) and `apps/web/test/SlaBanner.test.tsx` (5: the three
condition-not-event cases — renders on any non-empty `breaching`, nothing on
an empty one, and survives a re-render carrying the identical breach — plus
two the review's own fix round added, pinning that `frozen` flips the
banner's tense without ever showing both at once) as new files, plus 1 case
to `apps/worker/test/live-delta.test.ts` — the built delta carrying only the
breaching rules and a count of those evaluated — and, from that same fix
round, 4 cases to `apps/web/test/format.test.ts` for `formatOffset`'s own
boundaries (zero, sub-second rounding, and the minute rollover that must
never read "1m 60s") — from a floor of 103 / 1150. Its integration floor was
110 files / 1286 tests and its e2e 90 — neither of which `pnpm test:unit`
counts. Earlier: live run monitoring part 2b — the fan-out and the live
dashboard — which added
`packages/statistics/test/bucket-latency.test.ts` (4),
`apps/web/test/useLiveRun.test.tsx` (15), `apps/web/test/LiveNotice.test.tsx`
(4) and `apps/web/test/RunDetail.live.test.tsx` (14) as new files, plus cases
across `live-delta.test.ts`, `timeAxis.test.ts` and the two live integration
suites, from a floor of 99 / 1079. The last 19 of those tests came from the
whole-branch review's own fix wave, which is worth knowing: two of its
findings were defects no per-task review could see, and neither had ANY test
over it. Its integration floor is 108 files / 1269 tests and its e2e is 89 — neither of which `pnpm test:unit` counts. Earlier: the live dashboard
sub-project's task 1, the `bucketLatency` extraction, which added
`packages/statistics/test/bucket-latency.test.ts` (4, deriving min/max/mean
from the all-outcomes sketch, emitting every fixed band per outcome split,
and the empty-sketch asymmetry — {} for percentiles but 0 for min/max/mean)
as a new file — from a floor of 99 / 1079 — and that one from the fold
owner's whole-branch review fixes, which added
`packages/storage/test/blobs.test.ts`
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

**THE CONVERSE IS NOT TRUE, AND IT COSTS TIME: `pnpm test:integration`
RE-RUNS THE UNIT `.ts` FILES.** `vitest.integration.config.ts` includes
`packages/*/test/**/*.test.ts` and `apps/*/test/**/*.test.ts` with **no
`exclude` at all**, so its 111 files are 78 ordinary unit files, 32
`*.integration.test.ts`, and `apps/api/test/parity.e2e.test.ts` — which is why
its count is the unit count plus the integration one and not a separate
number, and why a unit-only change still moves the integration floor. Waiting
for an eight-minute integration run to re-prove a pure function is the
avoidable half of it; reading its total as "the integration tests" is the
expensive half.

It is **not** a superset either. That config's `include` has no `.tsx` entry
(the unit config lists `apps/*/test/**/*.test.tsx` separately, because those
28 files need jsdom), so every React component test runs under `test:unit`
ALONE. A component change verified only by `pnpm test:integration` has not
been verified at all.

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

**It also cannot race ITSELF, and that failure is the more likely one.** The
same setup truncation means two overlapping `pnpm test:integration`
invocations sabotage each other, and what you get back is not a timeout — it
is unique-constraint violations on slugs, null results mid-test, and
timing-sensitive assertions failing, i.e. a plausible-looking regression that
reproduces on nothing. This has already cost this project two separate
sessions. Before believing an integration failure, run
`ps aux | grep vitest` (or `pgrep -f vitest`) and confirm you are alone, then
re-run once.

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

**There is now a third toolchain, and `pnpm` is equally blind to it.** The
Gatling Gradle plugin lives at `clients/gatling-gradle/` — JVM/Kotlin, also
outside the pnpm workspace, so `pnpm lint`, `pnpm typecheck` and every
`pnpm test:*` see none of it, same as the Go agent above. Its gate:

```
cd clients/gatling-gradle && ./gradlew build --no-daemon
```

`build` runs its 38-test suite. Its real-stack e2e,
`clients/gatling-gradle/e2e/run-e2e.sh`, is manual and on demand — it needs
the local Docker stack plus the API and worker both running against it, and
is not part of any `pnpm` gate or the CI `plugin` job for that reason.

**BEING IN NO GATE IS EXACTLY WHY IT ROTTED.** That script hard-coded the
plugin version (`0.1.0-SNAPSHOT`) in its own log line and in
`e2e-project/build.gradle.kts`, while the plugin's default version had moved
to `0.2.0-SNAPSHOT`. Every invocation then died in Gradle's plugin-RESOLUTION
phase — "Plugin [id: 'dev.vantrix.gatling', version: '0.1.0-SNAPSHOT'] was not
found" — before Gatling, the platform, or anything this gate exists to prove.
The script now DERIVES the version from the plugin build the same way CI's own
`plugin-consume` job already did (`awk '/^version:/{print $2}'`) and passes it
as `-PvantrixPluginVersion`; `e2e-project` declares no version at all. It also
checks that the plugin MARKER artifact landed in `~/.m2`, because a missing
marker fails with the SAME message a wrong version does.

Anything else written down in two places here has the same half-life. Run
this gate after touching the plugin, its publishing, or the fixture
simulation.


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

**`text-transform` AND PLAYWRIGHT ACCESSIBLE NAMES — THIS NOTE WAS WRONG, AND
THE CORRECTION IS THE POINT.** It read: "Playwright computes accessible names
in its own injected script and applies `text-transform`, so a
`<th class="uppercase">Percentage</th>` is named `PERCENTAGE` and
`getByRole('columnheader', { name: 'Percentage', exact: true })` no longer
resolves… **Never put `uppercase` on anything queried by accessible name**."

MEASURED ON PLAYWRIGHT 1.62.1, TWICE, AND IT DOES NOT REPRODUCE. `uppercase`
was added to `tableStyles.ts`'s `TH` (every column heading in the app) and to
`components/Badge.tsx` (every status and verdict pill, including the ones
inside `<td>`s whose names come from content), then the whole e2e suite was
run against each change separately: **94 passed both times**, including
`run-tables.spec.ts`'s `getByRole('columnheader', { name, exact: true })`
sweep and `run-list.spec.ts`'s `expect(statusCell).toHaveAccessibleName('complete')`.

The reason is that `text-transform` is a RENDERING property and the DOM text
is untouched: `td.textContent` is still `●complete` with the pill drawn
`COMPLETE`. That is also why it is safe for real users — a screen reader
announces "complete", not the spelled-out capitals some readers produce for
all-caps strings.

WHAT REMAINS TRUE: whatever the accessible name is computed FROM must stay
put. Uppercase the RENDERING freely; do not uppercase the DATA (`marks.tsx`'s
labels) or an `aria-label`, because those are the name. And a `<th>` whose
name you change for real still breaks its query.

Do not restore the old prohibition without re-measuring — it cost the
control-room redesign its uppercase LED badges and column headings on a
constraint that no longer exists. If a future Playwright reinstates the
behaviour, the e2e suite says so in 90 seconds; that run is the arbiter, not
this paragraph.

**A token that is not in `@theme` produces NO utility, silently.** Tailwind v4
generates utilities only from `@theme` declarations, never from a bare `:root`
custom property. `text-accent-foreground` looked correct in the markup, matched
a real token in `tokens.css`, and emitted no CSS at all — so the skip link and
every primary button inherited `color` from `body` and rendered dark slate on
indigo at 2.84:1. Publish the alias under a DIFFERENT name than the runtime
token (`--color-on-accent: var(--color-accent-foreground)`), because a key that
reads a `var()` of its own name also resolves to nothing, equally silently.

**AN `<svg>` INSIDE A CHART `<figure>` USED TO BREAK NINE SPECS. IT NO LONGER
DOES, AND THE FIX IS THE INTERESTING PART.** This entry read: "a decorative
`<svg>` inside a chart `<figure>` breaks nine specs… icons are fine everywhere
else; not in there."

It was true, and it was a design rule handed down by a test convenience.
`run-charts.spec.ts` and `request-detail.spec.ts` proved a chart really drew by
counting SVG elements **within the whole figure** — `getByTestId('chart-x')
.locator('svg')`, `toHaveCount(1)`, in twenty-two places across seven files. So
any icon in a chart card corrupted the count, and the prohibition followed.

`Chart` now marks its ECharts container `data-chart-canvas`, and `helpers.ts`
exports `plot(scope)` for `scope.locator('[data-chart-canvas] svg')`. **The new
form is strictly HARDER to satisfy**: "this figure holds one SVG" could in
principle be answered by something that is not the plot; "the canvas holds one
SVG" cannot. Nothing was weakened to make room for the icons.

What survives: the invariant itself. A chart that failed to draw renders its
axes and nothing else, and only a mark count catches that — every `plot()` call
site still asserts `toHaveCount(1)` plus an attached `path`. And one
`locator('svg')` is deliberately still raw, in `run-live.spec.ts`: the SLA
banner asserts the WHOLE component carries no SVG, which is a claim about a
component rather than about a plot it does not have.

**The general lesson is worth more than the rule it replaces.** When a test
spells an invariant more broadly than it means, the extra breadth becomes a
constraint on the product — silently, and in a place nobody thinks to look for
one. The fix is to narrow the assertion to what it actually claims, not to
work around it.

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
