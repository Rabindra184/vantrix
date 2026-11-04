# Report pickers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group and Request pickers on the Report's Requests section and a Scenario picker on Virtual users, narrowing every chart the stored data can answer, exactly, with the pick in the URL.

**Architecture:** Group membership is one pure function in `@perfportal/contracts` shared by the API and the web. `/series` and `/distribution` gain a `group` parameter that merges the members' stored histograms (a pure merge in `packages/statistics`, fed by two new persistence reads). Everything the Report takes from `/stats` under a pick is additive and is narrowed in the browser; Virtual users narrows its existing per-scenario payload in the browser.

**Tech Stack:** NestJS API, Postgres via `pg`, zod 4 contracts, React + TanStack Query + React Router, ECharts, vitest (node + jsdom projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-04-report-pickers-design.md`

## Global Constraints

- Branch `feat/report-pickers`, cut from `main` (the spec is its first commit). One PR to `main`, merged with `--merge`.
- `nvm use` (Node 22) before every suite; read each gate's own exit code, never a pipeline's.
- Measure the unit, integration and e2e floors at the start of Task 1 (`pnpm test:unit`, `pnpm test:integration`, `pnpm exec playwright test --list` with `DATABASE_URL` exported) and predict each task's delta before running it.
- Suites run against a scratch database `perfportal_pickers`, Redis db 9 flushed through `infra-redis-1`, bucket `perfportal-pickers`, e2e port 3880. Never the developer database.
- URL keys, exactly: `requests-group`, `requests-request`, `users-scenario`. `requests-group=` (empty value) means "(no group)"; an absent key means "All".
- API parameter `group` on `/series` and `/distribution` only, with `scope=request` and no `name`. Conflicts are 400 `INVALID_QUERY`; a member without a histogram is 409 `GROUP_NOT_MERGEABLE`.
- Response field `group: string | null`, `.nullable().optional()` in the contract. For a group read: `scope: 'request'`, `name: ''`, `group` the path asked.
- Copy, exactly:
  - control labels: `Group` / `All groups` / `(no group)`, `Request` / `All requests`, `Scenario` / `All scenarios`
  - disabled Request reason: `Pick a group first.`
  - whole-run notes: `Shows the whole run: errors are not recorded per request.` and `Shows the whole run: status codes are not recorded per request.`
  - 409 state: `This run's group figures cannot be merged: it predates exact statistics.`
  - missing echo: `This server cannot narrow by group yet.`
  - ⓘ line: `Narrowed to the request <name>.` / `Narrowed to the group <name>.` / `Narrowed to the scenario <name>.` ("(no group)" as the name for `''`)
- A nested group or request is displayed with ` / ` between segments (`Catalog / Recommendations`); its value is the stored `/`-joined path.
- Every guard is red-verified from a committed checkpoint with the replacement count asserted (`CLAUDE.md`, "Red-verified").
- No attribution lines in commit messages.

## Review Focus

1. A top-level request whose name contains `/` (`/login`, `/order/1005`) must sit in "(no group)", never in a phantom group — pinned in Task 1.
2. A group whose members were bucketed at different widths, read under a time window: one merged width, the window snapped to it, nothing dropped — pinned in Tasks 2 and 4.
3. A link naming a group or request the run does not have (or a request outside the named group) reads as "All" with the note, and no figure request fires before `/stats` has answered — pinned in Task 7.
4. Changing the group must drop a request from the previous group from the URL — pinned in Task 7.
5. A pick combined with a window that selects nothing: the empty sentence names both ("for this group in the selected window"), never "this run" — pinned in Task 6.

---

### Task 1: Group membership in contracts

**Files:**
- Create: `packages/contracts/src/groups.ts`
- Modify: `packages/contracts/src/index.ts` (export it)
- Test: `packages/contracts/test/groups.test.ts`

**Interfaces:**
- Produces:
  - `requestsInGroup(requestNames: readonly string[], groupNames: readonly string[], group: string): string[]` — members in `requestNames` order; `group === ''` is "(no group)".
  - `innermostGroup(requestName: string, groupNames: readonly string[]): string` — the longest group path `G` with `requestName.startsWith(G + '/')`, or `''`.
  - `displayPath(path: string): string` — `''` → `'(no group)'`, else `/` replaced by ` / `.

- [ ] **Step 1: Write the failing tests.** Names from the reference run: groups `['Cart', 'Catalog', 'Catalog/Recommendations']`, requests `['Cart/Add To Cart', 'Cart/View Cart', 'Catalog/List Products', 'Catalog/Product Detail', 'Catalog/Recommendations/Related Items', 'Place Order', 'Search']`.

```ts
it('takes a group and its subgroups', () => {
  expect(requestsInGroup(REQ, GROUPS, 'Catalog')).toEqual(['Catalog/List Products', 'Catalog/Product Detail', 'Catalog/Recommendations/Related Items']);
});
it('answers the requests in no group', () => {
  expect(requestsInGroup(REQ, GROUPS, '')).toEqual(['Place Order', 'Search']);
});
it('keeps a slash-led top-level request in no group', () => {
  expect(requestsInGroup(['/login', '/order/1005', 'Cart/x'], ['Cart'], '')).toEqual(['/login', '/order/1005']);
});
it('pins the known limit: a top-level name starting with a group path is counted in it', () => {
  expect(requestsInGroup(['Cart/x'], ['Cart'], 'Cart')).toEqual(['Cart/x']);
});
it('answers nothing for an unknown group, and never matches a bare prefix', () => {
  expect(requestsInGroup(REQ, GROUPS, 'Car')).toEqual([]);
  expect(requestsInGroup(REQ, GROUPS, 'Nope')).toEqual([]);
});
it('finds the innermost group', () => {
  expect(innermostGroup('Catalog/Recommendations/Related Items', GROUPS)).toBe('Catalog/Recommendations');
  expect(innermostGroup('/login', GROUPS)).toBe('');
});
it('displays paths', () => { expect(displayPath('')).toBe('(no group)'); expect(displayPath('Catalog/Recommendations')).toBe('Catalog / Recommendations'); });
```

- [ ] **Step 2: Run** `pnpm exec vitest run packages/contracts/test/groups.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement the three functions.** `requestsInGroup` for `''`: a request is in no group when `innermostGroup(name, groupNames) === ''`. A group not in `groupNames` has no members.
- [ ] **Step 4: Run** the same command — expect PASS. Then rebuild (the package has no `build` script, so a `--filter` build does nothing): `find packages/contracts -name '*.tsbuildinfo' -delete && pnpm exec tsc -b packages/contracts`, and grep `packages/contracts/dist/src/groups.js` for `requestsInGroup` — the API resolves contracts through `dist`.
- [ ] **Step 5: Commit** `feat(contracts): one rule for which requests a group holds`.

### Task 2: The series merge

**Files:**
- Create: `packages/statistics/src/merge-series.ts`
- Modify: `packages/statistics/src/index.ts`
- Test: `packages/statistics/test/merge-series.test.ts`

**Interfaces:**
- Consumes: `bucketLatency` (`bucket-latency.ts`), `Histogram`, `inferBucketWidthMs` (`buckets.ts`).
- Produces:

```ts
export interface MemberBucket {
  startOffsetMs: number;
  startedCount: number; endedCount: number; okCount: number; koCount: number;
  startedOkCount: number | null; startedKoCount: number | null;
  histogramOk: Histogram; histogramKo: Histogram;
}
export interface MergedSeries {
  widthMs: number;
  buckets: Array<Omit<MemberBucket, 'histogramOk' | 'histogramKo'> & BucketLatency>;
  histograms: Map<number, { ok: Histogram; ko: Histogram }>;
}
export function mergeMemberSeries(members: readonly (readonly MemberBucket[])[]): MergedSeries;
```

- [ ] **Step 1: Write the failing tests.**
  - `merges two members of one width bucket by bucket`: counts summed, `percentiles.p95` equal to `bucketLatency` of the two histograms merged by hand.
  - `re-buckets a finer member into a coarser one`: member A at width 1000 (offsets 0, 1000, 2000, 3000), member B at width 2000 (offsets 0, 2000) → `widthMs` 2000, offsets `[0, 2000]`, bucket 0 holds A's 0 and 1000 plus B's 0.
  - `is exact against one series built from the union`: build A and B from known durations, then a single `BucketSeries` over the union at the coarser width; every merged bucket's counts, min, max, mean and percentile maps equal it.
  - `keeps a started split null when any contributing bucket's is null`.
  - `answers an empty series for no members`: `{ widthMs: 1000, buckets: [] }`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/statistics/test/merge-series.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Width = the max of `inferBucketWidthMs(member offsets)` over non-empty members; each bucket goes to `Math.floor(offset / width) * width`; counts sum (a started split is null if any contributor's is); OK and KO histograms merge into fresh `Histogram`s; latency fields from `bucketLatency({ histogramOk, histogramKo })`; output sorted by offset.
- [ ] **Step 4: Run** — expect PASS. Rebuild `packages/statistics` (`find packages/statistics -name '*.tsbuildinfo' -delete && pnpm exec tsc -b packages/statistics`) and grep its `dist` for `mergeMemberSeries`.
- [ ] **Step 5: Commit** `feat(statistics): merge request series into one, exactly`.

### Task 3: Member reads in persistence

**Files:**
- Modify: `packages/persistence/src/metrics/read.ts`
- Test: `packages/persistence/test/metrics.integration.test.ts`

**Interfaces:**
- Produces, on the existing reader class:
  - `memberSeries(scope: ProjectScope, runId: string, runStartedOn: Date, names: readonly string[], family: string): Promise<Array<StoredBucket & { name: string; histogramOk: Histogram | null; histogramKo: Histogram | null }>>` — one query, `MEMBER_SERIES_SQL` (exported), `scope = 'request' AND name = ANY($6::text[])`, keeping `run_started_on = $1` first, ordered by name then offset.
  - `memberHistograms(scope: ProjectScope, runId: string, names: readonly string[], family: string): Promise<Map<string, { ok: Histogram; ko: Histogram } | null>>` — `run_stat` rows for those names; a row missing either column maps to null; a name with no row is absent.

- [ ] **Step 1: Write the failing integration cases**, seeding through the file's existing helpers: `memberSeries` returns both members' buckets with their names and histograms in one call; `MEMBER_SERIES_SQL`'s `EXPLAIN` touches one partition (copy the file's existing pruning assertion over `SERIES_SQL`); `memberHistograms` maps a legacy row (histograms null) to null and leaves an unknown name out.
- [ ] **Step 2: Run** `pnpm exec vitest run -c vitest.integration.config.ts packages/persistence/test/metrics.integration.test.ts` — expect the new cases to FAIL.
- [ ] **Step 3: Implement both methods.** No backticks in any SQL comment (template literal).
- [ ] **Step 4: Run** — expect PASS. Rebuild persistence's `dist` the same way as Task 1 and grep for `memberSeries`.
- [ ] **Step 5: Commit** `feat(persistence): read a group's request series in one query`.

### Task 4: `group` on `/series` and `/distribution`

**Files:**
- Modify: `packages/contracts/src/metrics.ts` (`SeriesResponseSchema`, `DistributionResponseSchema` gain `group`)
- Modify: `apps/api/src/common/validation.ts` (add `parseGroupPick`)
- Modify: `apps/api/src/metrics/metrics.controller.ts` (`series`), `apps/api/src/metrics/parity.controller.ts` (`distribution`)
- Modify: `apps/api/src/openapi/document.ts`
- Test: create `apps/api/test/group-pick.integration.test.ts`; modify `apps/api/test/openapi.integration.test.ts`, `packages/contracts/test/contracts.test.ts`

**Interfaces:**
- Consumes: Task 1's `requestsInGroup`; Task 2's `mergeMemberSeries`; Task 3's `memberSeries`, `memberHistograms`.
- Produces:
  - `parseGroupPick(query: { scope?: unknown; name?: unknown; group?: unknown }): string | null` — `null` when `group` is absent; the group path (possibly `''`) when present; throws 400 `INVALID_QUERY` for a repeated `group` (via `singleValue`), for `group` with a `name`, or with a scope other than `request`.
  - Wire: `GET /v1/runs/{id}/series?scope=request&group=<path>&family=…[&from&to][&percentiles]` and `GET /v1/runs/{id}/distribution?scope=request&group=<path>&family=…[&from&to]`.

- [ ] **Step 1: Write the failing cases.** In `contracts.test.ts`: a series and a distribution body with no `group` key still parse (the rolling-deploy case). In `group-pick.integration.test.ts`, ingesting the reference bundle once per file and building an oracle in the test from that bundle's own `simulation.log` decoded with `parseSimulationLog` (per 1000 ms bucket keyed on each request's start offset from the run header: count, min, max, and nearest-rank p95 by sorting):
  - `series for Cart equals the oracle bucket by bucket` (counts, min, max, p95) and echoes `group: 'Cart'`, `name: ''`.
  - `series for Catalog includes its subgroup's requests`.
  - `series for (no group) merges Place Order and Search` (`group=`).
  - `a windowed group series equals the oracle over the same window` (`from=10000&to=30000`).
  - `a windowed group series over members of different widths` (Review Focus 2): seed `run_series_bucket` rows directly for two request names, one at 1000 ms and one at 2000 ms (the way `window-bench.integration.test.ts` seeds buckets), and require `bucketWidthMs` 2000, every bucket on a 2000 ms boundary, and the window snapped to that width.
  - `distribution for Cart equals the oracle's bins`, whole run and windowed.
  - `a group with no members` → `/series` 200 with `buckets: []`, `/distribution` 404.
  - `group with name`, `group with scope=group`, a repeated `group` → 400 `INVALID_QUERY`.
  - `a member without histograms` → 409 `GROUP_NOT_MERGEABLE` (null the member's `histogram_ok` with an UPDATE).
  - `an ordinary read echoes group: null`.
  In `openapi.integration.test.ts`: both operations document `group` and a 409.
- [ ] **Step 2: Run** `pnpm exec vitest run -c vitest.integration.config.ts apps/api/test/group-pick.integration.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Member names come from the run's `/stats` source (`reader.stats`): request-scope `response_time` names and group-scope names. Series: read `memberSeries`, and if any row has a null histogram answer 409 before merging; otherwise group the rows by name, merge the WHOLE member series with `mergeMemberSeries`, then filter `inRange`, `snapWindow` over the merged offsets, and apply `withExtraRanks(buckets, merged.histograms, requested)` when ranks are asked. Distribution: unwindowed merges `memberHistograms` (any null → 409); windowed filters `windowedBuckets` rows to the members. OpenAPI: the `group` parameter on both, the 409 response, the `group` property on both response schemas.
- [ ] **Step 4: Run** the new file and `apps/api/test/openapi.integration.test.ts` — expect PASS. Then `pnpm typecheck` and `pnpm lint`, each by its own exit code.
- [ ] **Step 5: Commit** `feat(api): series and distribution for a group's requests`.

### Task 5: The web's narrowed reads

**Files:**
- Modify: `apps/web/src/api/metricPaths.ts`, `apps/web/src/api/metrics.ts`
- Create: `apps/web/src/routes/report/narrow.ts`
- Test: `apps/web/test/metricPaths.test.ts`, create `apps/web/test/narrow.test.ts`, create `apps/web/test/groupReads.test.ts`

**Interfaces:**
- Consumes: Task 1's `requestsInGroup`.
- Produces:
  - `groupSeriesPath(id: string, group: string, family?: string, window?: Window | null): string` and `groupDistributionPath(id: string, group: string, family?: string, window?: Window | null): string`.
  - `groupSeriesQuery(id: string, group: string, window: Window | null)` and `groupDistributionQuery(id: string, group: string, window: Window | null)` — query options; the `queryFn` throws `GroupReadUnsupportedError` (exported from `metrics.ts`) when the parsed body's `group` is not exactly the group asked.
  - `narrowStats(stats: StatsResponse, names: readonly string[]): StatsResponse` — only those request rows and the group rows on their paths; no run row; `indicators` the sum of those request rows' `under`/`between`/`over`/`failed`; `bounds`, `configurable`, `window` kept.
  - `narrowUsers(users: UsersResponse, scenario: string): UsersResponse` — that scenario alone; `total` equal to its buckets.

- [ ] **Step 1: Write the failing tests.** `metricPaths.test.ts`: probe both new builders (its completeness case already fails until they are probed) and assert `groupSeriesPath('r', '')` carries `group=` with an empty value. `groupReads.test.ts`: a body without `group` rejects with `GroupReadUnsupportedError`; a body with `group: 'Cart'` for a `Cart` read resolves. `narrow.test.ts`, on the reference fixture: `narrowStats` for Cart's members sums indicators to the two rows' sums and drops the run row; `narrowUsers(…, 'Browse')` keeps one scenario and its total.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/metricPaths.test.ts apps/web/test/narrow.test.ts apps/web/test/groupReads.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(web): read and narrow the Report's figures for a pick`.

### Task 6: Charts say what they were narrowed to

**Files:**
- Create: `apps/web/src/charts/transforms/narrowed.ts`
- Modify: `rates.ts`, `percentiles.ts`, `distribution.ts`, `percentileDistribution.ts`, `indicators.ts` (`toIndicators`, `toRequestCounts`), `users.ts` (its three transforms), and the chart components that call them: `RatesChart.tsx` (`RequestsAndResponsesChart`), `PercentilesChart.tsx`, `DistributionChart.tsx`, `PercentileDistributionChart.tsx`, `IndicatorsChart.tsx`, `RequestCountChart.tsx`, `UsersChart.tsx`
- Test: `apps/web/test/ChartWindowSelected.test.tsx` (extend), the matching `transforms.*.test.ts` files

**Interfaces:**
- Produces:

```ts
export type Narrowed = { readonly kind: 'request' | 'group' | 'scenario'; readonly name: string } | null;
/** 'for this group in the selected window' | 'for this group' | 'in the selected window' | 'in this run' */
export function scopePhrase(opts: { readonly windowSelected: boolean; readonly narrowed?: Narrowed }): string;
export function narrowedLine(narrowed: Narrowed | undefined): string | undefined; // 'Narrowed to the group Cart.'
```

  Each listed transform's opts gains `narrowed?: Narrowed` (optional, as `agentChart.ts`'s `filter` is; the seam test is the guard), and each chart component gains a matching optional `narrowed` prop it passes through.

- [ ] **Step 1: Write the failing tests.** In each transform test, an empty payload with `narrowed: { kind: 'group', name: 'Cart' }` gives an `empty` sentence containing `for this group` and not `this run`; with `windowSelected: true` as well it contains `for this group in the selected window`; a non-empty payload carries `limitation` containing `Narrowed to the group Cart.` (joined with any existing limitation). In `ChartWindowSelected.test.tsx`, render each of the nine charts with an empty payload and each `kind`, and assert the rendered status sentence names it — the seam case that fails when a component drops the prop.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/ChartWindowSelected.test.tsx apps/web/test/transforms.*.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `scopePhrase` and `narrowedLine`, and route every listed sentence through `scopePhrase`. A sentence about ingestion or storage stays as it is (the rule the window branch already follows).
- [ ] **Step 4: Run** — expect PASS, then the whole `pnpm test:unit` with zero `Errors` lines.
- [ ] **Step 5: Commit** `feat(web): a narrowed chart says what it was narrowed to`.

### Task 7: Picker state and controls

**Files:**
- Create: `apps/web/src/routes/report/useRequestsPick.ts`
- Modify: `apps/web/src/routes/report/useReportFilter.ts` (param union gains `'users-scenario'`), `apps/web/src/routes/report/ReportFilterControl.tsx`
- Test: create `apps/web/test/useRequestsPick.test.tsx`; modify `apps/web/test/useReportFilter.test.tsx`, add a `ReportFilterControl` case file if none exists (`apps/web/test/ReportFilterControl.test.tsx`)

**Interfaces:**
- Consumes: Task 1's `requestsInGroup`, `innermostGroup`, `displayPath`.
- Produces:

```ts
export interface RequestsPick {
  group: string | '*';           // '*' = All groups; '' = (no group)
  request: string | '*';         // '*' = All requests (or none picked)
  members: string[];             // requestsInGroup for the effective group; [] for '*'
  setGroup(next: string | '*'): void;    // also deletes requests-request
  setRequest(next: string | '*'): void;
  namedGroup: string | null; namedRequest: string | null;   // what a link asked for that the run lacks
}
export default function useRequestsPick(
  names: { requests: readonly string[]; groups: readonly string[] } | undefined,
): RequestsPick;
```

  `ReportFilterControl` gains optional `labelOf?: (value: string) => string` (used for option text and the read-only field) and `disabledReason?: string` (renders the select disabled with that line beside it, associated by `aria-describedby`).

- [ ] **Step 1: Write the failing tests** (`MemoryRouter` with an initial URL, as `useReportFilter.test.tsx` does):
  - `reads a group and a request from the URL`.
  - `takes a request's innermost group when the URL names no group`: `?requests-request=Catalog%2FRecommendations%2FRelated%20Items` → `group` `Catalog/Recommendations`.
  - `answers the single member of a one-request group as the request`: `?requests-group=Catalog%2FRecommendations` → `request` `Catalog/Recommendations/Related Items`.
  - `reads an unknown group as All and names it`; `reads a request outside the named group as All and names it`.
  - `answers All while the names are not yet known` (`names` undefined).
  - `setGroup drops the previous request from the URL` (Review Focus 4), keeps `from`/`to`, writes `#requests`, uses `replace`.
  - `setGroup('') writes requests-group= with an empty value`; `setGroup('*') deletes it`.
  - `ReportFilterControl` with `disabledReason` renders a disabled select described by `Pick a group first.`; with `labelOf` the option for `''` reads `(no group)`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/useRequestsPick.test.tsx apps/web/test/useReportFilter.test.tsx apps/web/test/ReportFilterControl.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement**, keeping `useReportFilter`'s rules (`replace: true`, every other parameter kept, `#<section>`, `FRAGMENT_IN_PLACE`).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(web): the Report's group and request pick, in the URL`.

### Task 8: The Requests section narrows

**Files:**
- Modify: `apps/web/src/routes/RunReport.tsx` (`RequestsSection`, `RequestsCharts`, `RequestsTable`)
- Create: `apps/web/src/routes/report/WholeRunNote.tsx`
- Test: `apps/web/test/RunReport.test.tsx`, `apps/web/test/RunReport.live.test.tsx`

**Interfaces:**
- Consumes: Task 5's `groupSeriesQuery`, `groupDistributionQuery`, `GroupReadUnsupportedError`, `narrowStats`; Task 6's `Narrowed` and the charts' `narrowed` prop; Task 7's `useRequestsPick` and `ReportFilterControl`.
- Produces: `WholeRunNote({ note, children }: { note: string; children: ReactNode })` — a flex column cell holding the visible line (`data-testid="whole-run-note"`) above the chart.

- [ ] **Step 1: Write the failing cases** (the file's existing render harness and fetch stubs):
  - `draws Group and Request beside Charts | Table`, with `All groups`, the three groups and `(no group)` as options.
  - `a group pick reads the group series and distribution` — the stubbed fetch sees `/series?scope=request&group=Cart` and `/distribution?scope=request&group=Cart`, and no run-scope `/series`.
  - `a request pick reads that request's series and distribution` — `scope=request&name=Cart%2FAdd%20To%20Cart`.
  - `ranges and number of requests read the narrowed stats` — the ranges chart's data equal `narrowStats`' summed indicators.
  - `errors per second and responses by status carry their whole-run notes under a pick`, exact copy, and no note without a pick.
  - `a group read without its echo draws "This server cannot narrow by group yet."`; `a 409 draws "This run's group figures cannot be merged: it predates exact statistics."`
  - `the Table view lists only the pick's rows, with no All Requests row`.
  - `no figure request fires until /stats has answered` (Review Focus 3).
  - `a run with no groups shows (no group) read-only and the Request picker enabled`.
  - In `RunReport.live.test.tsx`: `a streaming run shows no pickers`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/RunReport.test.tsx apps/web/test/RunReport.live.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement.** Names for the picker come from the section's `statsQuery(runId, window)` (request-scope `response_time` rows and group-scope `group_cumulated` rows). The pickers sit inside the same `DesktopOnly` gate as the charts and are not rendered while `!terminal`. Each chart gets `narrowed` from the pick: a request → `{ kind: 'request', name }`, a group → `{ kind: 'group', name: group }`.
- [ ] **Step 4: Run** — expect PASS, then `pnpm test:unit`, `pnpm typecheck`, `pnpm lint`, each by exit code.
- [ ] **Step 5: Commit** `feat(web): the Requests section narrows to a group or a request`.

### Task 9: Virtual users narrows by scenario

**Files:**
- Modify: `apps/web/src/routes/RunReport.tsx` (`VirtualUsersSection`)
- Test: `apps/web/test/RunReport.test.tsx`

**Interfaces:**
- Consumes: `useReportFilter('users-scenario', scenarios, 'virtual-users')`, `ReportFilterControl`, Task 5's `narrowUsers`, Task 6's `narrowed`.

- [ ] **Step 1: Write the failing cases:** `draws Scenario with All scenarios, Browse and Checkout`; `a scenario pick draws only that scenario's users` (the concurrent-users chart's series equal `narrowUsers(…, 'Browse')`'s); `one scenario shows a read-only Scenario field`; `the pick is written as users-scenario=Browse with #virtual-users`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/RunReport.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement.** No new request: the existing `/users` payload is narrowed in the browser.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(web): Virtual users narrows to a scenario`.

### Task 10: The browser spec

**Files:**
- Create: `apps/web/e2e/report-pickers.spec.ts`

**Interfaces:**
- Consumes: `seedRunWithData` (reference bundle: groups `Cart`, `Catalog`, `Catalog/Recommendations`; scenarios `Browse`, `Checkout`), `openLiveRun`, the helpers in `apps/web/e2e/helpers.ts`.

- [ ] **Step 1: Write the cases:**
  - `a group, then a request, narrow the charts and survive a reload`: pick `Cart`; the URL carries `requests-group=Cart` and `#requests`; the percentiles chart's data table equals what `GET /v1/runs/{id}/series?scope=request&group=Cart` answers; pick `Cart / Add To Cart`; reload; both picks and the open section are back.
  - `a one-request group selects its request`: `Catalog / Recommendations` shows `Catalog / Recommendations / Related Items` read-only.
  - `the whole-run notes show under a pick`, exact copy.
  - `Virtual users narrows by scenario`: `users-scenario=Browse`, the concurrent-users data table equals Browse's buckets from `/users`.
  - `a stale link names what it asked for`: `?requests-group=Nope` shows the note and all groups.
  - `a streaming run shows no pickers` (`openLiveRun` plus a snapshot).
- [ ] **Step 2: Run** `PERFPORTAL_E2E_PORT=3880 pnpm exec playwright test apps/web/e2e/report-pickers.spec.ts` — expect PASS on Chromium; then `PERFPORTAL_E2E_BROWSERS=all` for this spec alone, three engines.
- [ ] **Step 3: Red-verify** from a committed checkpoint: the group read sent as a run read (the data-table case fails), `setGroup` keeping the old request (a case added for it fails), the notes removed (their case fails). Restore each with `git checkout HEAD --`.
- [ ] **Step 4: Commit** `test(e2e): the Report's pickers in a browser`.

### Task 11: Gates, the real check, the record

**Files:**
- Modify: `CLAUDE.md` (a new entry at the top of the floors history, in the house style: floors moved, what was measured, red-verified table, what was run, known and left)

- [ ] **Step 1: Run every gate** on the final tree: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (zero `Errors` lines), `pnpm test:integration`, `PERFPORTAL_E2E_PORT=3880 pnpm test:e2e --workers=2` (read back `Running N tests`). Each total must equal the prediction from Task 1's floors plus every task's delta.
- [ ] **Step 2: The real check.** On a stack of its own (`perfportal_pickers_real`, Redis db 13, bucket `perfportal-pickers-real`, API and worker from `dist`), run `ParitySimulation` through the Gradle plugin, then compare with an independent decode of the local `simulation.log`: `/series` and `/distribution` for `Cart`, `Catalog` (with its subgroup) and `''`, one request, whole run and `from=10000&to=30000`, plus the summed ranges for `Cart` and the `Browse` users. Record every figure. The signed-in browser half is the user's.
- [ ] **Step 3: Write the `CLAUDE.md` entry** with the measured floors and the real check's table; update the floor sentence near the top of "Verification".
- [ ] **Step 4: Commit** `docs: record the Report pickers`, push, open the PR to `main`, and read CI with the SHA pinned on both sides.
