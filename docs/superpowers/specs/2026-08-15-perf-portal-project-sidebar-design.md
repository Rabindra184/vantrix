# The project rail — design

Sub-project 3b, and the last of the enterprise-UI family. Sub-project 1
shipped the design system, 3a the run shell, and 2 the API this consumes.

**Front-end only.** No contract change, no migration, no new endpoint. That
is not a happy accident: sub-project 2's `GET /v1/projects` was shaped to
carry exactly what a rail needs, so this one would not have to reopen the
server. If a requirement here turns out to need a new field, the right move
is to stop and say so, not to quietly widen the API.

---

## 1. Scope

In:

- `AppShell` becomes a two-column layout with a persistent project rail
- The rail: brand, an **All runs** entry, one row per project with a badge
- Loading, error and empty states for the rail
- A narrow-screen layout for the same nav, without a drawer

Out:

- **Team, run counts and relative timestamps.** The reference's row reads
  `team · N runs`; `Project` has no team column, and `ProjectListResponse`
  carries no count and no timestamp. Each would reopen the API (§2)
- **A search box.** §4.4
- Any change to what a project page or run page renders

---

## 2. What already exists, and what deliberately does not

Checked against the code rather than assumed:

**The data is already there and already reachable.**
`apps/web/src/api/projects.ts` exports `fetchProjects` and `projectsQueryKey`,
shipped in sub-project 2 for `/projects/:slug`'s heading. The rail reuses
both; there is no new fetcher to write.

**`projectPath(slug)` already exists** in `apps/web/src/routes/paths.ts`, and
`RunHeader` already links to it. The rail is a second consumer, not the
first.

**`Badge` and the `STATUS`/`VERDICT` mark tables already exist**
(`apps/web/src/components/Badge.tsx`, `apps/web/src/routes/marks.tsx`) and
are what the run list and run header render. The rail uses the same
vocabulary, so a status that changes a word or a glyph updates three screens
from one edit.

**What does NOT exist, and is not being added:** `ProjectListResponse` is
`{ id, slug, name, latestRun: { id, status, verdict } | null }`. No team, no
run count, no timestamp. The reference sidebar shows all three. Rendering
`team · 12 runs · 2h ago` would mean a column, an aggregate and a contract
field respectively — and this sub-project's whole premise is that the
previous one already paid the API cost.

---

## 3. Shell structure

```
<div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
  <div>                              {/* the rail */}
    <Link to={DEFAULT_ROUTE}>PerfPortal</Link>
    <nav aria-label="Projects">…</nav>
  </div>
  <div>
    <header>…SignOutButton…</header>
    <main><Outlet/></main>
  </div>
</div>
```

### 3.1 `SignOutButton` renders exactly once

The tempting shape is two copies — one in the rail for narrow screens, one
in the header for wide — each hidden by a `lg:` class. **That breaks
`apps/web/e2e/auth.spec.ts`.** Playwright's strict mode counts DOM matches,
not visible ones, so `getByRole('button', { name: 'Sign out' })` resolving
to two nodes throws rather than passing, and that spec both asserts the
button is visible and clicks it.

The constraint and the right answer agree: two identical controls with the
same accessible name is an accessibility defect regardless of CSS. One
button, in the header, always.

This is falsification checkpoint 1, and it is asserted as a **count**, not a
visibility check — `toHaveCount(1)`. `toBeVisible()` would pass on a single
button and throw on two, which reports the regression as a harness error
rather than as the assertion failing.

### 3.2 The wrapper is a `<div>`, not an `<aside>`

`<aside>` carries the `complementary` role, meaning content tangentially
related to the page. A primary navigation rail is not that. The landmark
that matters is `<nav aria-label="Projects">`; wrapping it in a
`complementary` would add a landmark that describes the rail wrongly.

The brand is a `<Link>`, not a heading: it must not compete with the `<h1>`
each page renders inside `<main>`, and as a link it doubles as the way back
to the org-wide list.

### 3.3 Narrow screens get the same nav, not a drawer

Below `lg` the grid collapses to one column and the rail stacks above the
content. The same `<nav>` lays out horizontally with `overflow-x-auto`.

**No drawer, deliberately.** A toggle overlay needs focus management, an
escape handler, a scrim and return-focus-on-close to be correct, and this
repo has no harness that would catch any of those being wrong —
`playwright.config.ts` defines a single `chromium` project at
`Desktop Chrome`. Shipping a focus trap that nothing tests is worse than
shipping a nav that is merely plainer.

DOM order is rail → header → main, which matches the visual order in both
layouts. No CSS reordering, so a screen reader and a sighted user traverse
the same sequence.

**That ordering has a cost, and this sub-project pays it with a bypass.**
Before this branch a keyboard user reached page content after one tab stop.
Rail → header → main now puts brand, **All runs** and one link per project
ahead of everything else, on every authenticated page — 2 + N identical stops
for a sighted keyboard user who wants none of them. `AppShell` answers this
with a skip link (`<a href="#main">Skip to content</a>`, visually hidden until
focused) as its first child, jumping to `<main id="main" tabIndex={-1}>` so
activating it actually moves focus onto the content rather than only
scrolling to it.

---

## 4. What the rail contains

### 4.1 All runs

The first item, `<NavLink to={DEFAULT_ROUTE} end>`, current on `/runs`.
Without it, a reader who clicks into a project can only leave by the browser
back button or the brand.

`end` is required: without it, React Router marks `/runs` active for
`/runs/:runId` as well, so the rail would claim the reader is on the
org-wide list while they are reading one run.

**The brand and All runs share a destination, deliberately.** Both go to
`DEFAULT_ROUTE`. A logo that returns home is the convention readers already
have, and **All runs** is the labelled, `aria-current`-bearing version of the
same move for anyone navigating by landmark or keyboard. They are not
redundant so much as the same destination offered at two levels of
explicitness — but only **All runs** lives inside the `<nav>`, so a screen
reader enumerating the navigation hears it once, not twice.

### 4.2 One row per project

`<NavLink to={projectPath(p.slug)}>` with the project name and a badge.
Ordered as the API returns them — `ORDER BY p.name ASC`, decided in
sub-project 2 because the rail is a list a human scans.

Long names truncate rather than wrap: a rail whose rows are two lines tall
holds half as many projects, and the full name is available on the project
page it links to.

### 4.3 The badge reads status first, verdict second

```
latestRun === null        → no badge at all
latestRun.status ≠ complete → STATUS[status]
latestRun.status = complete → VERDICT[verdict ?? 'none']
```

`ProjectListResponse` carries both fields precisely so this decision can be
made here. A pending run has `verdict: null`, and rendering that as *not
evaluated* would state a fact about a run nobody has measured yet — the
failure the D-14 sentence fix corrected on the run page and the reason
sub-project 2's contract docstring says to read `status` first.

**A project with no runs shows no badge**, not an empty or neutral one.
Absence is the honest rendering of "nothing has been ingested here".

**`STATUS.failed` and `VERDICT.failed` collide, and the rail is the one place
that matters.** Both are `{ glyph: '✕', label: 'failed', colour:
var(--color-status-failed) }` in `routes/marks.tsx`, identically, by design —
`RunList` renders them under separate "Status" and "Verdict" columns and
`RunHeader` renders them as two separately-named `NamedBadge` groups, so the
column header or the group's accessible name disambiguates "could not be
ingested" (`status: 'failed'`) from "ingested and failed its SLA" (`status:
'complete', verdict: 'failed'`) in both places that already existed. The rail
has one badge and no column header, so a project whose latest run could not
be ingested and a project whose latest run completed and failed its SLA
render **the same row**.

The fix is rail-local, not a change to `marks.tsx`: `ProjectRail.tsx` defines
`RAIL_INGEST_FAILED`, a `Mark` with `STATUS.failed`'s glyph and colour but the
label `'ingest failed'`, and `badgeFor` renders it instead of `STATUS.failed`
specifically when `status === 'failed'`. `marks.tsx`'s own two fields are
untouched — the run list and the run header still say plain "failed" in both
columns, which is correct there. `pending` and `parsing` need no equivalent
override: neither word or glyph collides with anything `VERDICT` renders.

### 4.4 No search box

The reference has one. An org has a handful of projects — the same fact that
made `GET /v1/projects` unpaginated. A filter over four items is chrome.

The trigger for adding one is the same as the trigger for paginating the
endpoint: when the list is long enough to scroll past, it is long enough to
filter. One change, both parts.

---

## 5. States

| State | Rail renders | Copy |
|---|---|---|
| Loading | Brand, **All runs**, nothing else | — |
| Error, no cached rows | Brand, **All runs**, one quiet line | "Projects could not be loaded." |
| Error, cached rows present | Brand, **All runs**, the STALE rows, one quiet line | "Projects may be out of date." |
| Empty (no projects) | Brand, **All runs**, one line | "No projects yet." |
| Loaded | Brand, **All runs**, the rows | — |

The error line says what failed and nothing more. It does not offer a retry
the rail cannot perform, and it does not apologise on behalf of a page that
is working: everything in `<main>` rendered fine, and a rail that implied
otherwise would be the same overclaim §5.1 exists to prevent.

**Two error rows, not one, because TanStack Query keeps last-known-good
`data` across a failed refetch.** A rail that loaded fine and then had ONE
refetch fail is `isError` and non-empty `items` at the same time — and
rendering "Projects could not be loaded." over a visibly-populated list would
be a false statement, the exact overclaim §5.1 exists to prevent, just
inverted: instead of the rail implying `<main>` broke, it would be claiming
its own rows do not exist while they sit on screen. The rows are kept rather
than blanked — a transient blip should not throw away information the reader
can still act on — and the copy is chosen to match what is actually true:
"may be out of date" when there is something to be out of date about,
"could not be loaded" only when there is nothing on screen at all.

**No skeleton.** The list is short; four shimmering placeholders for
something that resolves in one round trip is noise, and it makes the rail
appear to contain projects that may not exist.

### 5.1 The rail must never break the page

Its query is independent of everything in `<main>`. A failed
`GET /v1/projects` degrades the rail to brand plus **All runs**; the run
list or run detail underneath renders exactly as it would have.

This is falsification checkpoint 3, and it matters because the rail is now
on every authenticated page: a rail that threw would take the whole app
down rather than one region of it.

### 5.2 Every authenticated page now fetches `/v1/projects`

Previously only `/projects/:slug` did. One small query under a shared key,
and deliberately without `staleTime` — sub-project 2 established that, since
`latestRun` moves as runs are ingested and as the worker completes them.
Caching it indefinitely would freeze the badge the rail exists to show.

Stated rather than discovered. If that request ever matters, the honest fix
is a `staleTime` with a refetch interval, not removing the badge.

---

## 6. Active state, and the one place it is silent

`NavLink` supplies `aria-current="page"`. On `/runs` the **All runs** entry
is current; on `/projects/:slug` the matching project is.

**On a run detail page, nothing in the rail is current.** The rail knows
project slugs; it does not know which project a run belongs to without
fetching that run, and it has no run id to fetch with — `AppShell` sits
above the route that owns one.

Recorded as a deliberate silence rather than a bug. The information is not
lost: `RunHeader` names the run's project and links to it, which is where a
reader looking for "what project is this?" already goes. Making the rail
answer it would mean either lifting run state into the shell or giving the
rail a second query keyed on a route param it does not own — both worse than
a rail that highlights nothing.

---

## 7. Architecture

| File | Change |
|---|---|
| `apps/web/src/AppShell.tsx` | Two-column layout; renders the rail |
| `apps/web/src/ProjectRail.tsx` | New: brand, All runs, the nav, its states |
| `apps/web/src/api/projects.ts` | Unchanged — reused as-is |
| `apps/web/src/routes/paths.ts` | Unchanged — `projectPath` reused as-is |

The rail is its own file rather than inline in `AppShell`: it owns a query,
four states and the badge rule, while `AppShell` owns layout. Keeping them
separate means the rail can be unit-tested against a stubbed `fetch` without
mounting the whole shell.

---

## 8. Testing

**Unit** (`apps/web/test/ProjectRail.test.tsx`), against a stubbed `fetch`
so the real `fetchProjects` and the real `ProjectListResponseSchema` both
run:

- The badge rule, all four branches of §4.3, each asserted positively — the
  fourth (`complete` + `verdict: null` → "no verdict yet") was previously
  claimed but not actually covered; it is now
- The `STATUS.failed` / `VERDICT.failed` collision (§4.3): an ingest failure
  and an SLA failure render differently in the same test
- The four non-loaded states of §5, by their exact copy, including the
  cached-rows-plus-failed-refetch sequence that produces "Projects may be
  out of date." with the rows still on screen
- **All runs** carries `aria-current="page"` on `/runs` and not on
  `/projects/:slug`
- The rail degrading without taking `<main>` with it (checkpoint 3)

**Playwright** for what jsdom cannot answer:

- `Sign out` resolves to exactly one node (§3.1) — a DOM-count fact that
  depends on the real CSS being applied, which jsdom does not do
- The rail's links navigate and the destination renders
- At a narrow viewport, with enough projects seeded to actually force
  `overflow-x-auto` to scroll, the nav is still present and its last link is
  still reachable and clickable
- At a wide viewport, the rail's bounding box sits left of `<main>`'s —
  the two-column grid's central structural claim, asserted for the first
  time
- A skip link is the first Tab stop from a fresh page load, and activating
  it moves focus onto `<main>`, not just scrolls to it

**One trap this family has paid for seven times.** Several assertions here
are about ABSENCE — no badge when `latestRun` is null, nothing current on a
run page, no drawer. An absence assertion passes when the feature is
correctly hidden AND when it was never built, so **every absence assertion
in this sub-project must be paired with a positive one in the same file**
that fails if the element stops rendering at all.

**And one this family paid for once.** `getByRole(role, { name })` is exact
in Testing Library and a case-insensitive substring in Playwright
(`CLAUDE.md`). Project fixture names must not be substrings or case variants
of each other or of their slugs, and Playwright assertions on them pass
`exact: true`.

---

## 9. Falsification checkpoints

1. **`Sign out` resolves to exactly one DOM node.** Asserted with
   `toHaveCount(1)`, not `toBeVisible()`. Fails if a second CSS-hidden copy
   is ever introduced — which is the shape a narrow-screen layout invites.
2. **A pending run's project shows its STATUS, never a verdict.** Seed a
   project whose `latestRun.status` is `pending` and `verdict` is null;
   assert the badge reads the pending mark and does NOT read *not
   evaluated*. Fails against the obvious wrong implementation, which reads
   `VERDICT[verdict ?? 'none']` unconditionally.
3. **A failing `/v1/projects` leaves the page intact.** Mount `AppShell` in
   jsdom with a stubbed `fetch` that fails `/v1/projects` and succeeds for
   the run list, then assert the run rows render AND the rail shows its
   error line. Fails if the rail's error propagates.

   **In jsdom, not Playwright**, and the reason is what is already here:
   `vi.stubGlobal('fetch', …)` is this repo's established way to control a
   response — fourteen uses across `apps/web/test` — while `page.route`
   appears in no e2e spec at all. Introducing request interception to the
   browser harness for one assertion means maintaining a second stubbing
   technique, when the failure under test is a React error boundary
   question that jsdom answers exactly as well.
4. **A project with no runs renders no badge, while a sibling with runs
   renders one — in the same test.** The paired positive is what stops this
   passing against a rail that renders no badges at all.
5. **At a narrow viewport the project nav is present and navigable.**
   Resize, click a project link, assert the destination rendered. Fails if
   the responsive layout hides the nav rather than reflowing it.

---

## 10. Success criteria

- `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration &&
  pnpm test:e2e` all green, under Node 22.19.0
- Every existing e2e assertion still passes — in particular `auth.spec.ts`'s
  Sign out button and the three specs asserting `navigation` named
  *Run sections* has count 0 on request and group pages
- The rail renders on every authenticated page and on none of `/login`,
  `/no-organisation`
- A failed projects query degrades the rail and nothing else
- No contract, OpenAPI, persistence or API change in the diff
