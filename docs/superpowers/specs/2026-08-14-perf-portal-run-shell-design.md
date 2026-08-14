# Run shell: header and tabbed sections — design

Sub-project 3a of the enterprise-UI family, and the one that delivers the
visible half of the original ask. Sub-project 1 (design system) shipped the
surface, palette and primitives this builds on. The sidebar and the
`GET /v1/projects` it needs are sub-project 2 and 3b, and are not here.

Front-end only. No migration, no contract change, no new endpoint.

---

## 1. Scope

In:

- `/runs/:runId` becomes a layout route: a run header, a tab strip, an `<Outlet/>`
- Three tabs, each a real URL — Overview (index), `charts`, `errors`
- A run header carrying identity and context, built from payloads the page
  already holds
- The run-page e2e specs moved to their new URLs, plus four new ones

Out:

- The three ingest fields the API drops (§2) — they belong with a migration
- Project sidebar and `GET /v1/projects` — sub-projects 2 and 3b
- Request and group detail pages. Their §13.3 stack is a documented order and
  they are single-purpose already; adding tabs there is a separate argument
  nobody has made.

---

## 2. Why this header shows less than the reference does

The reference's header carries an environment chip and a git branch.
`IngestMetadataSchema` **already accepts** `environment`, `branch` and
`commitSha` — validated, bounded, documented. And then they are discarded:
nothing in `prisma/schema.prisma` stores them, nothing writes them. A CI
pipeline posting `branch=release/24.8` gets a 200 and the value evaporates,
with no comment in the contract marking those fields reserved.

That is worth fixing and it is **not fixed here**. Surfacing them means a
migration, a writer, a reader, a contract field and an OpenAPI change — the
class of change this repo treats most carefully, and the reason
`run_series_bucket`'s `family` column got a sub-project to itself. Sub-project 2
is already going near the run contract to add project identity; these belong
with it.

**Recorded so the gap is deliberate rather than forgotten**: until then, the
header shows no environment and no branch, because the platform does not know
them — not because the design omitted them.

---

## 3. Routing: a layout route, and what must not nest under it

```
/runs/:runId            → RunShell, index child: Overview
/runs/:runId/charts     → RunShell, child: Charts
/runs/:runId/errors     → RunShell, child: Errors
```

**A layout route, not three siblings each rendering `RunDetail` with a `tab`
prop.** The sibling shape looks simpler and is wrong: switching tabs would
unmount and remount the shell, so the header would flash and the run query
would re-run on every tab click. A layout route mounts the shell once and swaps
only the `<Outlet/>`.

### 3a. The two routes that must NOT inherit the shell

`App.tsx` already declares, as flat siblings:

```
/runs/:runId/requests/:name  → RequestDetail
/runs/:runId/groups/:name    → GroupDetail
```

Those are their own pages. Neither should render a run header or a tab strip.
React Router ranks a fully-specified path above a parent whose children do not
match, so declaring the layout route's children as exactly `index`, `charts`
and `errors` should leave both alone — **but this is an assumption about
matching precedence, not a guarantee, and it is falsification checkpoint 1.**
A request page that grew a run shell would be a visible regression that no
existing spec asserts against.

### 3a′. An unknown tab segment

`/runs/:runId/nonsense` matches no child. `App.tsx`'s existing catch-all `*`
route then redirects to `DEFAULT_ROUTE` — the run list — which loses the run
the reader was looking at.

That is the current behaviour for any unmatched path and this sub-project does
not change it, but the failure is newly reachable: before tabs, a typo after
the run id could only ever have been `requests/` or `groups/`. If it proves
annoying in practice the fix is a catch-all child redirecting to the run's own
index, not a change to the global route. Recorded, not built.

### 3b. Laziness arrives for free

`Overview` currently fires four metric queries — `stats`, `users`,
`distribution`, `series`. Under tabs, the Charts route is not rendered until it
is opened, so its payloads are not fetched. No `enabled` flags to write and no
decision to encode. `statsQuery` is asked for by both Overview and Charts under
one key, so the second is served from cache, exactly as the two current call
sites already are.

### 3c. The processing branch grows no tabs

`RunDetail` has three states, and its 202 branch deliberately renders no header
shell — a table of dashes reads as a run that was measured and found empty
rather than one nobody has looked at yet. A tab strip over a processing run is
the same mistake with more chrome. The shell renders only in the `Ready`
branch; `Processing` and the error branch keep their current standalone
rendering.

---

## 4. What the header carries

| Field | Source |
|---|---|
| Simulation (heading) | `run.simulation`, fully qualified, falling back to the short id |
| Description | `run.description` when non-empty |
| Tool and version | `run.tool`, `run.toolVersion` |
| Started | `run.toolStartedAt ?? run.startedAt`, with the existing ingest-time note |
| Duration | `run.durationMs`, whole seconds, dash when null |
| Status | `Badge` on `STATUS[run.status]` |
| Verdict | `Badge` on `VERDICT[run.verdict ?? 'none']` |
| Peak concurrent users | `/users`, see below |

Status and verdict become `Badge` pills rather than `Marked` inline text.
`Badge` was built for exactly this in sub-project 1, takes the same `Mark`, and
the run list already went there — so the vocabulary stays in one module.

### 4a. Peak users has a trap, and the contract names it

`UsersResponse` carries both `scenarios[].buckets[]` and a `total[]` series.
Peak concurrent users is:

```
Math.max(...users.total.map((b) => b.maxConcurrent))
```

**Not** the sum of each scenario's own maximum. The contract states why:
Gatling's "All users" series is the per-scenario sum *at each offset*, and
`max(a+b) ≠ max(a)+max(b)` in general — two scenarios peaking at different
moments would report a peak the run never reached. `total` already holds the
per-offset sum, so the max over it is the answer and no summing happens here.

### 4b. The honest cost of that one line

`/users` exists for two charts that live one tab away. Putting peak users in
the header means Overview fetches a payload whose only consumer there is a
single line of text. It is cached and shared, so opening Charts then costs
nothing — but Overview's first paint makes one request it otherwise would not.

Stated rather than discovered. If that request ever matters, the honest fix is
to drop the peak-users line, not to fetch it lazily and have the header flicker
a value in.

---

## 5. The tab strip is navigation, not ARIA tabs

A `<nav>` of `<Link>`s styled as tabs, with `aria-current="page"` on the active
one. **Not** `role="tablist"` / `role="tab"` / `role="tabpanel"`.

The ARIA tab pattern describes in-page panels that swap without navigation, and
it promises a screen-reader user that arrow keys move between them. Ours change
the URL and the browser navigates. Wearing the pattern's roles would make a
promise the implementation cannot keep — the most common way this control is
built wrong.

### 5a. The Errors tab carries a count; Charts does not

`Errors (2)` versus `Errors (0)` is the glance a header exists for. The count
is the number of **distinct error messages**, which only the errors payload
knows — `koCount` from the stats row is failed *requests*, a different number,
and using it would put a plausible wrong figure on screen.

So the shell fetches `errorsQuery` for the count, and the Errors tab then reads
it from cache. That is one bounded payload spent on chrome, and it buys the
reader knowing whether the tab is worth opening.

No count on Charts. Eight is eight.

---

## 6. The tab split preserves a reading order the reference reverses

| Tab | Holds |
|---|---|
| Overview (index) | Assertions, the six stat tiles, the statistics table |
| Charts | The eight §13.2 figures |
| Errors | The errors table |

The reference puts charts on its Overview and the requests table behind a
click. `RunDetail.tsx` argues the opposite, and it is right about this app:
*"scrolling past eight figures to reach the p99 of one request is the reading
order nobody wants."* Tabs are a better version of that argument, not a reason
to abandon it — so the numbers a reader came for stay on the landing tab and
the figures move behind the click.

**Assertions stay on Overview, above the tiles.** The header's verdict badge
answers "did the gate pass"; the assertions table answers "which rule, and by
how much." A breached run is exactly the case where someone opened this page in
a hurry.

**`Overview`'s own `<h2>Overview</h2>` goes.** With a tab of the same name
directly above it, it says the word twice; its `aria-labelledby` anchor moves
to the panel region.

---

## 7. Architecture

| File | Change |
|---|---|
| `apps/web/src/App.tsx` | `/runs/:runId` becomes a layout route with three children |
| `apps/web/src/routes/RunShell.tsx` | New: header, tab strip, `<Outlet/>` |
| `apps/web/src/routes/RunHeader.tsx` | New: the §4 header |
| `apps/web/src/routes/RunTabs.tsx` | New: the §5 nav |
| `apps/web/src/routes/RunDetail.tsx` | Keeps the three-state branch; `Ready` renders the shell, and its `Tables`/`Overview` split becomes the tab children |
| `apps/web/src/routes/paths.ts` | Tab paths, so nothing spells them twice |
| `apps/web/e2e/*.spec.ts` | §9 |

`RunDetail`'s existing division of labour holds: components fetch, presentation
takes payloads. The tab children are the current `Tables` and `Overview`
functions, moved rather than rewritten.

---

## 8. Testing

**Moved, not rewritten.** `run-charts.spec.ts` navigates to `/runs/:id/charts`,
`run-tables.spec.ts` splits — statistics stays on the index, errors moves to
`/runs/:id/errors` — and `run-detail.spec.ts` gains the header assertions.
Nearly every change is a `page.goto` gaining a segment rather than a click
being inserted, which is the payoff for putting tab state in the path.

**Four new specs**, each pinning something a click-through would not catch:

1. Each tab URL renders its own content on a direct load, without passing
   through Overview.
2. The bare `/runs/:runId` renders Overview, so every existing link still
   works.
3. Switching tabs does not remount the shell — asserted by the header
   persisting while the panel changes, which is what the layout route exists to
   guarantee.
4. A processing run shows no tab strip.

**Accessible names go in Playwright, not jsdom.** The rule this repo has now
paid for twice: `dom-accessibility-api` does not consult a descendant's
`aria-hidden` the way a browser's accessibility tree does. A tab link whose
count badge leaks into its name — "Errors 2 errors" — passes every jsdom
assertion and fails in Chromium.

**Unit tests** cover the peak-users derivation against the captured fixture,
computed from the payload rather than written down, and the header's null
branches (no description, no duration, no verdict).

---

## 9. Falsification checkpoints

1. **A request detail URL does not render the run shell.** §3a assumes React
   Router ranks `/runs/:runId/requests/:name` above the layout route when no
   child matches. Verify before building the header: add the layout route with
   its three children, load a request page, confirm no header and no tab strip.
   If the assumption fails, the layout route's path must be narrowed rather
   than the request routes moved.
2. **Peak users matches the fixture's own maximum.** Assert
   `max(total[].maxConcurrent)` against the captured payload, and confirm it
   differs from the sum of per-scenario maxima on a multi-scenario run — if
   those two are equal in the fixture, the test proves nothing about §4a and
   needs a synthetic case.
3. **The shell survives a tab switch.** If the header refetches or flashes,
   §3's layout route is not doing its job and the three-sibling shape has crept
   back in.
4. **The errors count is distinct messages, not failed requests.** On the
   reference run those are 2 and 24. A test asserting the tab reads `(2)`
   catches the wrong-field mistake; one asserting `(24)` enshrines it.

---

## 10. Success criteria

- `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e` all green
- Every existing run-page e2e assertion still passes, under its new URL
- The four new specs in §8 pass
- A processing run renders no tab strip and no header shell
- The header renders nothing it cannot source from a payload the page already
  holds — no field invented, none silently blank
- `/runs/:runId/requests/:name` and `/runs/:runId/groups/:name` render exactly
  as they do today
