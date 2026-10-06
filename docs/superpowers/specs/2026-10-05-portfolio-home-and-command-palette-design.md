# Portfolio home page and ⌘K search — design

2026-10-05. Two features that answer one problem: PerfPortal has no place to
start and no way to jump. `/` redirects to the org-wide run list, the brand
link goes there too, and the only way to reach a test or a run in another
project is to click through the rail, the project and the list.

Decisions settled in brainstorming:

1. **The home page is triage first, then the portfolio.** A "Tests that need
   attention" card with a 7-day glance on top; every test in the org below it.
2. **Its shape is Gatling Enterprise's Home** (measured, below), not the run
   page's tile row. The campaign and credit cards have no equivalent here and
   are dropped.
3. **⌘K is "find and go".** Every result is a destination: projects, tests,
   runs, and each project's pages. No actions that are not navigation.
4. **Two new reads, everything else reused** (approach A). `GET /v1/tests`
   and `GET /v1/activity`; ⌘K reuses the cached project list and the existing
   run search.
5. **Two PRs, ⌘K first.** PR 1: `GET /v1/tests`, the `number=` run filter and
   the palette. PR 2: `GET /v1/activity` and the home page.
6. **The palette and themes stay, and the clean-UI text rule governs**
   (`2026-10-04-clean-ui-design.md`): labels and data visible, prose only where
   the reader must act.

## Measured on Gatling Enterprise first, read-only

2026-10-05, in the user's signed-in Chrome on cloud.gatling.io. The account
had no runs in the last 7 days, so the filled states were read out of the
app's own bundle rather than seen. Nothing was clicked that starts or changes
anything.

**Home** (`/o/<org>`), top to bottom:

| part | behaviour |
| --- | --- |
| heading | "Hello, *first name*!" then "Activity in the last 7 days (Sep 28 – Oct 5, 2026)" |
| Tests that need attention | Runs whose start is within the last 604,800,000 ms, grouped by test, sorted newest first, **latest run per test**, kept when that run is unsuccessful. Subtitle "N test(s) failed or broken – last 7 days". Table (`ProblematicTestsTable`): Name · Team · Last run · chevron, newest first; `noDataLabel` "No tests need attention". |
| … nothing failed | `CleanWeekEmptyState`: badge "CLEAN WEEK", "100% pass rate · N runs", "Every simulation passed across 7 consecutive days". |
| … nothing ran | `NoRunsEmptyState`: badge "COVERAGE GAP", "No runs in the last 7 days – your safety net is going cold.", "Without recent simulations, regressions can ship unnoticed.", a last-run box ("gold incredible octopus test – Run 1 · 51 days ago"), "Run one now →". |
| The last 7 days, at a glance | `WeeklyRunsOverview`: seven day columns (TUE … MON, ending today in the viewer's zone), bar height = that day's share, tooltip "N successful runs", empty days hatched. |
| right column | Plan & credits; Teams' share of credit consumption. |

**Tests list** (`/o/<org>/simulations`): Name with a copyable id · Campaign ·
Source · Team · **Last run** (`#1 Run 1`, date and zone, duration, a verdict
badge, the cell tinted green or red) · Start · ⋮. Every column sorts and
filters; "Search by Name"; 10–50 rows per page. No p95, no trend.

**No ⌘K or global search.** ⌘K does nothing, and the bundle has no
`metaKey`/`k` handler and no command-palette library. The only search is the
per-list filter box. So the palette below is our own design; there is nothing
to copy.

## Scope

**In:** the home page at `/`; a Home row in the rail; the ⌘K palette and its
header trigger; `GET /v1/tests`; `GET /v1/activity`; a `number=` filter on
`GET /v1/runs`; `needsAttention` moved into `@perfportal/contracts`;
`TestRepository.listForProject` re-implemented on the new latest-run query.

**Out, each a decision:** column sorting and per-column filters on the tests
table; a "Start" button per test (a test here groups runs, it is not a saved
launch configuration); campaign and credit cards; a recent-items list, ⌘Enter
to open in a new tab, and non-navigation actions in the palette; regression
detection (its own item).

## PR 1 — `GET /v1/tests`, `number=`, and the palette

### `GET /v1/tests`

**Credential.** The rule `GET /v1/runs` already follows: a session reads the
whole org, an API token reads its own project only. Scope `read`. Registered in
the OpenAPI document (the route-coverage guard derives its list from the
controllers and will fail until it is) and in the session cross-org isolation
cases.

**Query.**

| param | rule |
| --- | --- |
| `q` | Optional. Case-insensitive substring of test name, test slug, simulation class, project name or project slug. `%`, `_` and `\` are escaped, as the run search already does. |
| `limit` | Default 25, clamped to 1–100 the way `parseLimit` clamps elsewhere. |
| `cursor` | Opaque; pages through the order below. |

**Order.** By the latest run's arrival (`run.created_at`), newest first, then
`test.id`. Tests that have never run come last, by name. This is the default
the Gatling Enterprise list opens on ("Last run ↓"), and it puts what changed
recently at the top of the home table.

**Row.**

```ts
OrgTestSummary = {
  id, slug, name, simulationClass, runCount,
  project: { slug, name },
  latestRun: {
    id, runNumber, status, verdict, startedAt, durationMs,
    checks: { failed, total } | null,
    p95Ms: number | null,
  } | null,
  p95History: Array<{ runId, runNumber, p95Ms }>,   // ≤ 10, oldest → newest
}
OrgTestListResponse = { items: OrgTestSummary[], nextCursor: string | null }
```

- **"Latest run"** is ARRIVAL order, `created_at DESC, id DESC`: the order
  the project catalogue already uses. It is read per test with a
  `LATERAL … LIMIT 1` over the existing `run_test_id_created_at_idx`.
  - **It is USUALLY the test's highest-numbered run, not always** (corrected
    while planning PR 2; this bullet first said "always"). A run is numbered
    when it JOINS its test — an upload when the worker finalizes it, a live
    run when its log header arrives — so two overlapping ingests of one test
    can be numbered in the other order from the one they arrived in. Arrival
    stays the rule: PR 1 shipped it, and the home page's windows are about
    what arrived. `OrgTestLatestRun`'s docstring and the `listTests` OpenAPI
    text already say this.
  - **This is not the run list's order, and the spec first said it was.**
    `RunRepository.list` sorts by when the test RAN,
    `COALESCE(tool_started_at, started_at) DESC, id DESC`. The two differ only
    for a bundle uploaded after a newer one: it is the latest run here and sits
    lower in the run list.
  - `TestSummary.latestRun`'s docstring claims the run list's ordering; the
    code never used it. The docstring is corrected in PR 1.
- **`p95Ms` and `p95History`** are the run-scope response-time p95 the run
  list's `metrics.p95Ms` already returns, through the same expression,
  clamped against that run's own min and max (`clampPercentile`'s rule). A
  sparkline point therefore equals the number on that run's list row.
- **`p95History`** takes the test's last 10 runs with `status = 'complete'`
  and a run-scope statistics row, via `LEFT JOIN LATERAL … ORDER BY
  created_at DESC, id DESC LIMIT 10`, reversed to oldest first.
- **Indexing.** `test` holds one row per test, so a sequential scan there is
  fine. The lateral reads use `run`'s existing test-scoped indexes. Nothing is
  added to the run search's `OR`, so that query's index rule is untouched.

**`listForProject` follows.** It currently loads every run of every test in
the project to pick each test's latest one (`findMany` with no limit). It
moves onto the same latest-run query; its response shape is unchanged and its
existing integration cases are the proof.

### `number=` on `GET /v1/runs`

- `number=<positive integer>` narrows to `test_id = $ AND run_number = $`,
  which the unique index on `(test_id, run_number)` serves.
- Allowed only with `project` and `test`: a run number names a run only inside
  its test. Without them, 400 `NUMBER_NEEDS_TEST`, with a remediation naming
  both parameters. A non-integer is 400 `INVALID_RUN_NUMBER`.
- **Not** part of `q`. A branch the run search's indexes cannot serve would
  cost every other branch its index (the BitmapOr rule recorded in CLAUDE.md).

### The palette

**Trigger.** A "Search" field in `AppShell`'s header between the brand and the
account menu, showing `⌘K` on macOS and `Ctrl K` elsewhere (from
`navigator.platform`/`userAgentData`). Below 768px (`useIsCompact`) it is an
icon button named "Search". ⌘K / Ctrl+K opens the palette from any signed-in
page, including while focus is in a text field, which is the convention for
this shortcut. It is not mounted on `/login` or the no-org page, which do not
render `AppShell`.

**Component.** `cmdk`, with `shouldFilter={false}` because matching is the
server's, inside its Radix-Dialog-based `Command.Dialog`. One dependency; it
supplies arrow-key movement, Home/End, grouping and scroll-into-view, which
this repo has paid for hand-building before. `pnpm audit --prod` must stay
clean. The dialog is named "Search PerfPortal" and returns focus to the
trigger (or whatever had focus) on close.

**Empty query: "Go to".** All runs; New project; and, when the current route
is inside a project, that project's Tests, Runs, Packages, Add results, SLA
rules, API tokens and New on-prem run, labelled "<page> · <project>". Built
from `paths.ts`, never from string literals.

**Typing.** Queries fire 150 ms after the last keystroke. Groups, in this
order:

| group | source | each row shows | limit |
| --- | --- | --- | ---: |
| Projects | `GET /v1/projects`, already cached for the rail, matched in the browser | name, slug | 5 |
| Pages | the project pages above, matched by page name, for the current project, else the top matching project | "SLA rules · Checkout" | 5 |
| Tests | `GET /v1/tests?q=&limit=5` | name, project, latest outcome mark (`marks.tsx`) | 5 |
| Runs | `GET /v1/runs?q=&limit=5` (text and run-id prefix, as today) | run name (`runNumber.ts`), test or simulation, project, short start time, outcome mark | 5 |
| Run by number | input matching `^(.+?)\s*#(\d+)$`: `GET /v1/tests?q=<text>&limit=3`, then `GET /v1/runs?project=&test=&number=<n>&limit=1` for each | "Run 12 · Checkout smoke · Checkout" | 3 |

Enter, or a click, navigates to the highlighted row.

**States.**

- The previous results stay on screen while new ones load, so typing never
  flashes an empty list.
- Each group loads and fails on its own. A failed group shows one quiet line
  ("Couldn't search tests") and the others carry on.
- "No results for '<q>'" appears only once every group has settled.
- A polite live region inside the dialog announces "N results". It exists only
  while the dialog is mounted, so there is never more than one.

**Accessibility.** Results are ARIA options inside a modal dialog, not links,
so they cannot collide with the rail's "All runs" or a project name in an e2e
`getByRole('link', { name })` query. The combobox, listbox and option roles
and the dialog's name are verified in Chromium's real accessibility tree over
CDP, as the InfoTip branch did, not only through Playwright's own name
computation.

## PR 2 — `GET /v1/activity` and the home page

### `GET /v1/activity`

**Credential.** As `GET /v1/tests`. Scope `read`. Registered in the OpenAPI
document and the session isolation cases.

**Query.** `tz=<IANA zone>`. The browser sends
`Intl.DateTimeFormat().resolvedOptions().timeZone`. Absent, it is UTC; the
response echoes the zone used. A zone `Intl` rejects is 400
`INVALID_TIMEZONE`, with a remediation giving `Europe/London` as an example.

**Two windows, both copied from Gatling Enterprise, both on `run.created_at`**
(arrival: the order "latest run" follows. The per-test reads use the existing
`(test_id, created_at)` index and `running` the `(status, created_at)` one; the
org-wide day counts get a new `(org_id, created_at)` index, because nothing
served an org-wide arrival range and `AuthGate` asks this endpoint on every
cold load (corrected while planning PR 2). The run list itself sorts by when
the test ran, so a late upload counts here on the day it arrived):

- **Attention window:** the last 168 hours before now.
- **Glance days:** the 7 calendar days ending today in `tz`. Node computes the
  eight local-midnight boundaries with `Intl` (DST-correct) and passes them to
  SQL as UTC instants; SQL only counts runs between them. Postgres's own zone
  database is never consulted, so it cannot disagree with Node's.

**Response.**

```ts
ActivityResponse = {
  window: { from, to, tz },                 // the attention window
  days: Array<{ date: 'YYYY-MM-DD', total, successful, needsAttention }>,  // 7, oldest → newest
  runCount: number,                         // sum of days[].total
  passRate: number | null,                  // Σsuccessful ÷ (Σsuccessful + ΣneedsAttention); null when both are 0
  running: number,                          // status = 'running' now; not windowed
  byProject: Array<{ project: { slug, name }, runs: number }>,  // top 5 over the glance days
  attention: Array<{
    test: { slug, name } | null,
    project: { slug, name },
    run: { id, runNumber, status, verdict, startedAt, durationMs, checks, simulation },
    reasons: Array<'failed' | 'incomplete' | 'gate_failed' | 'assertion_failed'>,
  }>,                                        // ≤ 20, newest first
  lastRun: { id, runNumber, test: { slug, name } | null, project: { slug, name }, startedAt } | null,
}
```

**One definition of "needs attention".** `RunTally.tsx`'s `needsAttention` —
status `failed` or `incomplete`, SLA verdict `failed`, or a simulation
assertion failed (`checks.failed > 0`) — moves into `@perfportal/contracts`
and is imported by the run tally, the API and the home page. The day counts
are SQL and cannot import it, so an integration case runs the SQL predicate
over every combination of status, verdict and checks and requires agreement
with the TypeScript function.

`reasons` lists which of the four clauses held, so the UI can name the cause
("SLA failed", "1 assertion failed", "Could not be ingested", "Incomplete")
without re-deriving it.

**The attention rule is Gatling Enterprise's:** per test, the latest run in
the attention window; kept when it needs attention. A test that failed and
then passed is not listed. A run with no test (a failed upload that never
parsed a header) cannot be grouped, so each such run in the window is its own
row; these are the "stuck ingests". Its Test cell reads the run's simulation
when one was recorded, else "Upload" and the short id, linking to the run.

**`successful`** is finished (`complete`) and not needing attention. Runs still
in flight count toward `total` and neither class.

**`running` counts `status = 'running'` only**, so its link to
`/runs?status=running` shows exactly the runs it counted. (Section 3 of the
brainstorm said pending, parsing and running; narrowed while writing this,
because the run list's status filter takes one value and a count that its own
link cannot reproduce is a contradiction on one screen.)

### The page

**Routing.**

- `DEFAULT_ROUTE` becomes `/` and `/` renders `Home` inside `AppShell`; the
  brand link and the unknown-path fallback follow. `/runs` is unchanged.
- The rail gains a **Home** row above **All runs**. "Home" joins the rail's
  reserved vocabulary: no page may add a link with that name.
- `AuthGate`'s membership probe moves from the run list's first page to
  `GET /v1/activity` under Home's own query key, so the landing page renders
  from the probe's result. Its 401 / 403 / outage branches are unchanged.

**Layout (Gatling Enterprise's shape).**

- **Heading.** "Hello, <first word of `user.name`>" (the email's local part
  when the name is empty), then "Activity in the last 7 days (<from> – <to>)"
  with the dates in the viewer's zone. No exclamation mark.
- **Tests that need attention** card, full width of the main column, with the
  subtitle "N tests · last 7 days" and no link in its header: the "All tests"
  equivalent is the table further down this page, and "All runs" is reserved.
  - **Filled:** a table (Test · Project · Last run) beside the glance. The
    last-run cell is tinted by outcome and shows the run name, short start time
    and a badge per reason.
  - **Nothing needs attention:** a "CLEAN WEEK" badge, "<passRate>% pass rate
    · <runCount> runs" and "No test needs attention.", beside the glance.
  - **No runs in the window:** a "COVERAGE GAP" badge, "No runs in the last 7
    days", the last-run box (name · Run N · "51 days ago") and **Add results →**
    for that run's project. Gatling Enterprise's two further sentences are cut.
  - **No runs ever:** "No runs yet" with **Add results** (when a project
    exists) and **New project**.
  - **The glance:** seven columns, bar height = the day's share of the busiest
    day, stacked successful (passed colour) and needs attention (failed
    colour); a day with no runs is hatched. Its numbers are on screen as text
    for a screen reader (one sentence per day, visually hidden) and on hover,
    never through a `title` alone. The bars are not focusable: they are data,
    not controls.
- **Right column** (desktop only, beside the card):
  - **Running now:** `running`, linking to `/runs?status=running`.
  - **Runs by project:** `byProject`, each a project link with its count and
    a proportional bar.
- **Tests**: `GET /v1/tests`, 25 per page with previous and next, and a
  "Filter tests" box driving `q` (debounced, in the URL as `?q=` with
  `replace`, as the run list's filters are). Columns: Name, with the slug and
  `CopyIdButton` beneath · Project · Last run (the tinted cell) · "p95 · last
  10".
- **The sparkline** is an inline SVG polyline, not an ECharts instance:
  twenty-five chart instances on one page would cost more than ten points are
  worth. The line is `aria-hidden`; the cell carries the latest value as text
  and a visually hidden summary ("last 10 runs: 610–812 ms"). The last point
  takes the failed colour when that run needs attention.

**Phone (< 768px).** One column: heading, the attention card with its rows as
cards and the glance beneath them, Running now, Runs by project, then the
tests as cards (the run list's card pattern). Nothing is withheld: this page
carries no charts, so §22.6's desktop-only rule does not apply.

**Loading and errors.** Each card has its own skeleton shaped like it and its
own `ErrorState`; a failed tests table never blanks the attention card.
`activity` refetches every 30 s while `running > 0` and not otherwise.

## Testing

Every new case is red-verified by a mutation that lands on it alone, from a
checkpoint commit, with the replacement count asserted.

**PR 1**

- Contracts: `OrgTestListResponseSchema` round trip; `number` parsing.
- Integration, `GET /v1/tests`:
  - "latest run" is the newest ARRIVAL, including when an older-started
    bundle arrived last (the one case where it and the run list differ), and
    agrees with the project catalogue's `latestRun`;
  - `p95History` equals the list rows' `metrics.p95Ms`, a clamped value
    included;
  - another org's tests are invisible; a token sees its own project only;
  - `%` and `_` in `q` match literally;
  - the cursor is stable across pages; never-run tests come last.
- Integration, `number=`: 400 without `test`; 400 for `abc`; an `EXPLAIN`
  case proves the `(test_id, run_number)` index serves it.
- The OpenAPI route-coverage and session-isolation guards list the new
  operations (both derive their route lists; both fail until done).
- `listForProject`'s existing cases stay green unchanged.
- Unit, palette: ⌘K and Ctrl+K open it; Esc returns focus; "Go to" follows
  the current project; group order; the 150 ms debounce; one group failing
  leaves the others; "No results" only after every group settles;
  `checkout #12` parsing; the live region exists only while open.
- e2e: keyboard only — ⌘K, a test's name, Enter lands on the test; `<test>
  #N` lands on the run; the dialog's and options' roles read over CDP.

**PR 2**

- Unit: `needsAttention` from contracts, `RunTally`'s cases unchanged; day
  boundaries across a DST week (America/New_York, 1–7 Nov 2026, with a 25-hour
  day); the zone refusal.
- Integration, `GET /v1/activity`:
  - the SQL day counts agree with `needsAttention` over every status × verdict
    × checks combination;
  - a test that failed and then passed is not listed;
  - a failed upload with no test is listed;
  - a run at 167 h is in the window and one at 169 h is not;
  - `byProject` order and limit; another org's runs never counted;
  - `running` ignores the window.
- Unit, page: all four attention states; each card failing alone; `/` is
  Home; the brand link; the rail's Home row; `AuthGate` still sends a user with
  no org to the no-org page.
- e2e: Home over runs seeded in two projects, one with a 56-character class
  name; no horizontal scroll at 320, 375 and 414 px; no page link named
  "Home" or "All runs" besides the rail's.
- Known churn: 16 references to `DEFAULT_ROUTE` across `apps/web/src` and
  `apps/web/test`, and any spec expecting to land on `/runs` after signing in.
  `signIn` waits only for the URL to leave `/login`, so it is unaffected.

## Verification, both PRs

- Node 22. `typecheck`, `lint`, `test:unit`, `test:integration`, `test:e2e`,
  in that order, each read by its own exit code, against a scratch database and
  a scratch Redis index, every total predicted from the source first.
- Real Gatling runs through the Gradle plugin and the on-prem runner, including
  `ParitySimulation`'s deliberately failing assertion: that run must appear
  under "Tests that need attention" with "1 assertion failed", and `<test> #N`
  in ⌘K must open it.
- A three-engine `e2e-cross-browser` dispatch before merging.
- A final whole-branch review by the strongest model.
- A CLAUDE.md entry with the new floors; one PR per branch; merged with a merge
  commit once CI's checks on the head SHA are green.

## Risks

- **The landing page changes for everyone.** Bookmarks of `/` used to reach the
  run list. The rail's "All runs" is one click away and keeps its position.
- **`cmdk` is a new runtime dependency** on a security-gated install. If it
  fails `pnpm audit --prod` or the CDP check, the fallback is a hand-built
  combobox over Radix Dialog with the same behaviour; the plan says which.
- **`GET /v1/activity` is an aggregate on every landing.** It is bounded by the
  7-day window and the number of tests; the integration suite's window-bench
  shape is the place to add a budget if it is ever slow.
