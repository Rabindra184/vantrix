# The five-tab live page — design

**Status:** design, approved 2026-08-20
**Builds on:** live run monitoring parts 1, 2a and 2b (M7, merged); live SLA
signals (merged).
**Closes:** the deferral recorded in
`2026-08-18-live-run-monitoring-part-2b-design.md` §4.3.

Part 2b shipped a **standalone** live page. Its own design section says why,
and calls it a design error rather than an implementation shortcut:

> `RunsService.statusFor` answers **202** for every status short of
> `complete`, and a 202's body is `RunProcessing { id, status, statusUrl }` —
> no project, no tool, no verdict. `RunShell` renders its header and tabs from
> a full `RunResponse`, so it cannot render for a running run at all.

This sub-project is the widening that note names. When it lands, a run page has
the same shape from the moment the run is opened to the moment its report is
read: one header, one tab strip, five URLs. What changes as the run progresses
is the *content*, never the *layout*.

---

## 0. What this is not

**It does not make Trends or Load generators live.** Both keep a stated
withheld notice for the whole non-terminal life of a run. Telemetry genuinely
does reach `telemetry_sample` during a run through the agent's own path, and
plotting it live is a real and reachable feature — it is simply not this one.
§4 records where it would go.

**It does not put a statistics table, a distribution chart, a
percentile-distribution chart or an errors-over-time chart on a live run.**
Part 2b §1.3 scopes the live wire, and none of those four have a live source on
any path. They keep the withheld notice they already have.

**It does not change `statusFor`.** A non-terminal run still answers 202 with
`Retry-After`. A CI script that polls on the status code needs no new branch,
which is the whole reason approach B below was rejected.

**It adds no migration and no new endpoint.** Every field it puts on the wire
is already on the `run` row and already joined into `RunRecord`.

---

## 1. Contracts

### 1.1 One identity schema, extended twice

`packages/contracts/src/run.ts` gains `RunIdentitySchema`: what a run knows
about itself from the moment it exists, independent of whether anything has
parsed it.

    id, project, tool, toolVersion, environment, branch, commitSha,
    simulation, description, durationMs, startedAt, toolStartedAt

`RunResponseSchema` and `RunProcessingSchema` both extend it. That is the
anti-drift device and the reason this is one schema rather than a copied field
list: adding a chip to the run header becomes one edit, not two edits that can
silently disagree about a field's nullability.

`RunResponseSchema` keeps `status`, `verdict`, `windowable`, `assertions`,
`toolAssertions`, `error` and `ingestedAt` to itself. A running run's type
therefore still cannot express a verdict or an assertion list — the "no
invented placeholders" rule is enforced by the compiler rather than by
discipline.

### 1.2 The two status enums stay independently declared

`RunProcessingSchema`'s `z.enum(['pending', 'parsing', 'running'])` is
deliberately not derived from `RunStatusSchema`; its existing doc comment
explains why and `packages/contracts/test/live.test.ts` pins it. Identity
carries no `status` field at all, so extending changes nothing about that
argument. Do not "tidy" the two into one.

### 1.3 Every field new to `RunProcessing` is optional — including `project`

Not for the reason `environment` is optional on `RunResponse` (a run may
genuinely carry none), but for the rolling-deploy reason. During a deploy a
new browser polls an old API pod and receives `{ id, status, statusUrl }`. A
required `project` there makes `RunProcessingSchema.parse` throw, and the run
page is blank for the whole rollout.

This is the same failure `packages/contracts/test/live-delta.test.ts` exists to
prevent one endpoint over, and CLAUDE.md states the general rule: *a required
field there blanks the live page for a whole rolling deploy, because the
browser drops any frame that fails the schema.*

So identity is optional on the wire in both directions, and the client treats
its absence as a **state**, not an error — §3.6.

---

## 2. The API

`respondWithRun`'s 202 branch spreads the identity fields off the `RunRecord`
it already holds instead of sending three. **Zero additional queries:**
`RunRecord` already carries `project` (joined — its own comment explains that
the worker pays that indexed join deliberately), `tool`, `toolVersion`,
`environment`, `branch`, `commitSha`, `simulation`, `description`,
`durationMs`, `startedAt` and `toolStartedAt`.

That cost is the concrete reason approach B was rejected. B — sending a full
`RunResponse` for every status — would run `runAssertion.findMany` and the
`isWindowable` EXISTS on **every poll**: every five seconds, per watcher, per
live run, where a 202 is one cheap row read today. B's second and larger
problem is `assertions: []` on a running run, a false zero that collapses "no
rule breached" into "not evaluated yet" — precisely the distinction `SlaBanner`
and `RunTabs`' `errorCount: number | null` exist to preserve.

Approach C — a separate `/identity` endpoint, or identity carried on the
gateway's snapshot frame — was rejected because the snapshot variant is
desktop-only (a compact viewport never opens the socket, §22.6), so a phone
would get a header with no name; and neither variant covers `pending`, which
has no socket at all.

`statusFor` is untouched. `apps/api/src/openapi/schemas.ts` and
`document.ts`'s `RunProcessing` response pick the widened schema up through the
same registration they already use.

---

## 3. The web app

### 3.1 No route changes

`App.tsx` already nests all five tabs under `/runs/:runId`. What breaks those
URLs today is that `RunDetail` returns `Processing` or `Live` **instead of**
`Ready`, so `RunShell` never mounts and its `<Outlet/>` never renders. Once
`RunDetail` renders the shell for every state, `/runs/:id/charts` on a running
run works with nothing added to the router.

### 3.2 The socket stays in `RunDetail`

`RunDetail` is already the layout route and already survives tab switches, and
its `useLiveRun(runId, running && !compact)` enablement is computed from the
same query that decides `running`. Moving the socket into `RunShell` would
split one decision across two components for no gain.

`RunShell` gains a `live: LiveRunState | null` prop instead. That is what
finally makes its `liveDurationMs: null` real — the one-line change its own
comment predicted — and lights up `useTimeDomainFromShell`'s growing-domain
branch for every tab at once, through the shared formula `growingDomainMs`
already holds and `timeAxis.test.ts` already pins.

### 3.3 `RunShell` and `RunHeader` stop taking a `RunResponse`

Both take identity, status, verdict and (for the shell) `live`. Each header
part renders only when its field is present — the same pattern the
environment/branch/commit chips already follow, extended to the breadcrumb and
the tool chip.

A running run therefore shows `Run 9b71f35` as its `<h1>` (identity's existing
fallback, unchanged), its tool, environment, branch, commit and start time,
a `running` status badge, and a duration filled from the delta's
`summary.durationMs` — a real measurement, not a placeholder.

**The verdict badge is omitted entirely for a non-terminal run**, which is a
change: `RunHeader` today always renders `VERDICT[run.verdict ?? 'none']`, so a
running run would show "no verdict". That reads as *evaluated, and nothing was
found* — a claim about a run nobody has finished measuring. Absence is the
honest rendering, and it is the same argument `errorCount: number | null`
already makes one line away in `RunTabs`.

### 3.4 The two shell queries become cache reads unless the run is terminal

`RunShell` fires `errorsQuery` (for the tab count) and `usersQuery` (for peak
users). While a run streams, `useLiveRun`'s `applyDelta` already writes both
keys directly; a live REST fetch would answer emptier and win the race for no
benefit. Both are enabled only when the run is terminal — the shell receives that as
its own prop rather than re-deriving it, since it no longer holds the
`RunDetail` union. This also correctly fires nothing for a pending run, which
has neither rows nor a socket.

The Errors tab's count then goes live for free, through a key that is already
shared. It stays `number | null` — `null` while unknown, never a confident
zero.

### 3.5 `TimeBrush` is absent while live, and that is not an oversight

Its gate is `run.windowable === true && run.durationMs != null`. Identity
carries neither field, so a live run is never offered a brush. This matches
`useLiveRun`'s own rule that a live view is never narrowed. Recorded here so a
later reader does not "fix" it by threading `windowable` onto identity.

### 3.6 Identity absent: one degraded path, not a second page

When the 202 carries no identity — an old API pod mid-deploy — the shell still
mounts. `RunHeader` omits the breadcrumb and the chips it has no values for and
renders the `<h1>` fallback and the status badge. The page is thin but
coherent, and it self-heals at the next poll that reaches a new pod, within
about five seconds.

**Rejected: keeping `Processing` and `Live` alive as standalone fallbacks.**
It preserves two tested components at the cost of two renderings of the same
states, which is a drift risk that outlives the deploy window that motivated
it by a very long way. `Processing` and `Live` as *page* components are
deleted; their content is redistributed by §4 and their tests move with it
(§7.1).

### 3.7 Two shell-level bands, between `RunTabs` and the `<Outlet/>`

**The status strip** (`role="status"`): the connection sentence — "Live —
updating as the run streams", "Reconnecting — showing the last update
received", "Streaming has stopped. The numbers below are its last update." —
plus the finalizing, capped and partial notices.

**`SlaBanner`**, at shell level rather than on Overview. A rule breaching right
now is a fact about the run, not about the tab the reader happens to be on, and
a reader watching Charts is exactly who needs to see it. It stays ungated by
viewport for the reason its own docstring already gives.

### 3.8 The polling cap hoists into the strip

`capReached` and `onRetry` are `RunDetail` state. Tab children read `runId`
from `useParams` and cannot see that state without threading it through the
Outlet context. But the cap is a fact about **the page having stopped
polling**, not about Overview — so it belongs beside the connection sentence,
and `LiveCapped` merges into the strip. Tab children then need nothing from
`RunDetail` at all.

**Precedence, since three things compete for the strip:** capped beats
finalizing, because `LiveNotice[kind="finalizing"]` promises "this page will
refresh with the full report once they are ready", which is a lie the moment
polling has stopped — the existing comment already establishes this. `partial`
renders *alongside* rather than instead, because a partial seed is a fact about
the data, not about the connection.

---

## 4. What the five tabs render

**One rule, applied per slot.** A section draws its real content when its data
exists; a **withheld notice** when the run is live and the live wire
structurally cannot carry it; and the shared **`WaitingPanel`** when nothing has
arrived at all.

**A withheld notice goes where its real section lives.** This corrects
something the standalone page gets wrong by necessity: it stacks all three
withheld chart notices together, including "Errors per second", whose real
chart is on the Errors tab.

| Tab | pending / never-streamed | running / frozen | terminal |
|---|---|---|---|
| **Overview** | `WaitingPanel` | `LiveSummary` tiles; Statistics withheld inside `DesktopOnly` | assertions, tool assertions, tiles, statistics table |
| **Charts** | `WaitingPanel` | 5 live figures; Distribution and Percentile-distribution withheld | 8 figures |
| **Load generators** | existing `available: false` empty state, live-aware wording | same | 6 telemetry charts |
| **Errors** | `WaitingPanel` | live errors table; Errors-per-second withheld | errors-over-time chart + table |
| **Trends** | withheld | withheld | trends |

**The five live figures** are the ones part 2b already established: concurrent
users, user start rate, response-time percentiles, request rate, response rate.

**Load generators needs no new capability.** `GET /v1/runs/:id/telemetry`
already returns `available: false` when `run.toolStartedAt` is null — which is
every non-terminal run — and `RunTelemetry` already renders an `EmptyState` for
exactly that. What changes is the sentence: for a live run the honest statement
is that telemetry appears once the run finishes, not that the agent never
reported. If live telemetry is built later, this is the tab and
`TelemetryStore.forRun` is the read that already exists to serve it.

**Where `Processing`'s content goes.** The component itself is deleted (§3.6);
its `<h1>` and its `BackToRuns` are now the header's and the breadcrumb's job.
What survives — the pulsing status mark, the `Marked` status line, "this run is
still processing" — becomes `WaitingPanel`, which Overview, Charts and Errors
share. The mark's colour still
arrives as data through an inline `style` off `routes/marks.tsx`, which is what
keeps it exempt from the arbitrary-value gate in `test/tokens.test.ts`.

---

## 5. The transition

A run ending becomes a **data** swap. A reader on Charts when the run ends
stays on Charts: five live figures become eight, and the two withheld notices
become real charts. Nothing about the page's shape moves.

The state sequence and its rendering:

    pending   -> shell + tabs, WaitingPanel
    running   -> shell + tabs, live content, status strip says "Live"
    parsing   -> shell + tabs, last delta frozen on screen,
                 strip says "Streaming has stopped"
    complete  -> shell + tabs, full report from REST

`RunDetail`'s existing retained-delta rule is unchanged and still does the
work: `live.lastDelta` is never cleared, so the frozen tail renders the same
components with the same numbers under a different sentence.

`failed` is unaffected — `respondWithRun`'s own `run.status === 'failed'`
branch answers `application/problem+json` before any of this applies, and
`RunDetail`'s error branch renders `ErrorState` as it does today. `incomplete`
is terminal and answers 200 with a full `RunResponse`; it needs no branch here,
and `statusFor` already has its own line for it.

---

## 6. Edge cases

**Deep link to `/runs/:id/charts` on a pending run.** Works, and shows
`WaitingPanel` under a real header. This is new — today it renders nothing.

**Compact viewport.** Unchanged in kind: `useIsCompact()` still decides, the
socket still never opens below 768px, and the charts still never mount.
`DesktopOnly` keeps taking its children as a function so the withheld content
is never built. The header, the tab strip, the status strip, the SLA banner and
the errors table are all cheap and all stay.

**Document title.** `useDocumentTitle(identity.simulation ?? 'Run <short id>')`
— identical to today's expression, now reachable for a non-terminal run.

**A run whose simulation arrives mid-life.** `simulation` is null until the
worker parses, so the `<h1>` changes from `Run 9b71f35` to the qualified
simulation name at the `parsing` -> `complete` transition. That is a real fact
becoming known, not a placeholder being replaced, and the document title
follows it.

---

## 7. Testing

### 7.1 Unit

New and changed component tests live where the content now lives.
`apps/web/test/RunDetail.live.test.tsx`'s cases move to the tabs and the shell
rather than being deleted — the behaviour they pin (frozen banner, partial
seed, withheld notices, retained delta) is unchanged; only its address is.

New coverage this design requires:

- `RunShell` mounts for each of `pending`, `running`, frozen `parsing`, and
  terminal, and renders the tab strip in all four.
- `RunHeader` with identity missing `project` and `tool` renders the `<h1>`
  fallback and the status badge and omits the breadcrumb and chips — the
  §3.6 rolling-deploy render.
- The two shell queries are `enabled: false` for a non-terminal run (the §3.4
  race), and enabled once terminal.
- Strip precedence: capped beats finalizing; partial renders alongside either.
- `contracts`: a narrow 202 body parses under the widened schema, and a wide
  body parses under a client that knows only the old fields — both directions
  of the rolling deploy, the shape `live-delta.test.ts` already uses.

### 7.2 Integration

`apps/api/test`: a `running` run's 202 body carries `project` and `tool`, still
carries no `verdict` key, and still carries `Retry-After`.

### 7.3 e2e

`run-detail.spec.ts` gains a live run whose five tab URLs are each reachable
directly, matching the existing "each tab is its own URL" assertion for a
terminal run.

**Watch the two naming traps.** A new caption must share no distinctive word
with an existing table's — `getByRole('table', { name })` is a
case-insensitive substring match in Playwright — and no `uppercase` may land on
anything queried by accessible name, because Playwright applies
`text-transform` when computing one and jsdom does not.

### 7.4 The gate

Run it in the documented order, integration **before** e2e:

    pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e

`nvm use` first — on Node 20 roughly two thirds of the suite silently fails to
load and the run still prints a green summary above the error line.

**Update CLAUDE.md's floors in the same change**, from measured output, not
from an estimate: the current unit floor is 106 files / 1179 tests, integration
111 / 1297, e2e 90. This sub-project moves all three. The `agent/` Go gate is
untouched — nothing here reaches it.

---

## 8. Files

**Contracts.** `packages/contracts/src/run.ts` — `RunIdentitySchema`, both
extensions.

**API.** `apps/api/src/runs/runs.controller.ts` — `respondWithRun`'s 202
branch. `apps/api/src/openapi/` — no logic change; the widened schema flows
through the existing registration.

**Web.** `apps/web/src/routes/RunDetail.tsx` — the three-state branch renders
the shell in every case; `Processing` and `Live` as page components go away.
`RunShell.tsx` — new props, the status strip, `SlaBanner`, the real
`liveDurationMs`, the two `enabled` flags. `RunHeader.tsx` — takes identity,
guards the breadcrumb and the tool chip. `RunTabs.tsx` — unchanged.
`apps/web/src/api/run.ts` — the `RunDetail` union keeps both arms; only
`RunProcessing` widens. New: the status strip component and `WaitingPanel`.
