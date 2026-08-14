# Group detail page — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the group detail page behind `/runs/:runId/groups/:name` (§13.4,
GR-01…GR-09), rendering six requirements against existing data and the two
percentiles-over-time charts as stated gaps.

**Architecture:** Tasks 1–2 generalise two components that were written
request-specific but never were. Tasks 3–5 build the page: a lookup that matches
on scope, name **and** family, then the two statistic sets, indicators and
distributions, then D-14's stated gaps. Task 6 removes `DetailPlaceholder` and
corrects §13.4's stale prose. Task 7 is the browser suite. No backend change —
every payload this page needs already exists.

**Tech Stack:** TypeScript, React 19, React Router 7, TanStack Query, ECharts,
Zod contracts, Vitest (jsdom + node), Playwright, pnpm workspaces.

## Global Constraints

- Node >= 22. Run `. "$HOME/.nvm/nvm.sh" && nvm use` before any pnpm command.
- **Charts never fetch.** A chart takes an already-validated payload as a prop;
  only route components call query factories.
- **Transforms are pure and DOM-free**, unit-tested in the node environment
  against `apps/web/test/fixtures/reference-run.json`.
- **Expectations are computed from the payload, never written down.**
- **Both `scope` and `name` on every scoped metrics call**, plus `family` for
  distribution. `?name=X` without `scope` is silently ignored and answers with
  the run's totals at a 200.
- **A group row needs three fields to identify it**: scope, name AND family.
- **Do not build GR-07** — no requests/responses-per-second charts at group
  scope (§A.9 F-4). Do not build a child-request breakdown (§3 of the spec).
- **Do not build an errors table.** Gatling's group page carries a
  `container_errors` shell, but it has no GR row, it is boilerplate emitted on
  every page regardless of content, and `errorsFor` is called for `'run'` and
  `'request'` only — the group branch `continue`s before reaching it.
- Colours come from tokens, never literals.
- Verify with `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration`;
  e2e with `pnpm test:e2e`. `test:unit` excludes the integration and e2e suites —
  see `CLAUDE.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/charts/transforms/indicators.ts` | **Modify.** Lookup moves out: `toRowIndicators(stats, row, label, noun)`. |
| `apps/web/src/charts/IndicatorsChart.tsx` | **Modify.** `path?: string` → `row?: StatRow` + `label?: string`. |
| `apps/web/src/tables/ScopedStatistics.tsx` | **Rename** from `RequestStatistics.tsx`. Never was request-specific. |
| `apps/web/src/routes/payload.tsx` | **Modify.** Export `Undrawn` so a chart with no query can still say why. |
| `apps/web/src/routes/GroupDetail.tsx` | **Create.** The page, and `groupRow`. |
| `apps/web/src/routes/DetailPlaceholder.tsx` | **Delete.** This piece takes its last route. |
| `apps/web/src/App.tsx` | **Modify.** Group route renders `GroupDetail`. |
| `PerfPortal_Enterprise_PRD.md` | **Modify.** §13.4's prose, which contradicts Appendix A. |
| `apps/web/e2e/group-detail.spec.ts` | **Create.** Mount, nested identity, stated gaps. |

---

## Task 1: The indicators lookup moves out of the transform

**Files:**
- Modify: `apps/web/src/charts/transforms/indicators.ts:185`
- Modify: `apps/web/src/charts/IndicatorsChart.tsx:23-35`
- Modify: `apps/web/src/routes/RequestDetail.tsx`
- Modify: `apps/web/test/transforms.indicators.test.ts`

**Interfaces:**
- Consumes: `bandChart(bands, stats, axisLabel, empty)` at `indicators.ts:116`,
  module-private and unchanged.
- Produces: `export function toRowIndicators(stats: StatsResponse, row: StatRow | undefined, label: string, noun: string): ChartData`.
  `toRequestIndicators(stats, path)` survives as a caller so the request page is
  untouched. `IndicatorsChart` takes `{ stats, row?, label? }`.

**Why:** `toRequestIndicators` folds a row's bands but *finds* the row itself, by
a hardcoded `scope === 'request'`. A group needs three fields to identify a row.
A transform growing a third argument to find something the caller already has is
the wrong boundary — so the caller finds it and the transform folds it.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/transforms.indicators.test.ts`:

```ts
describe('toRowIndicators', () => {
  it('folds whichever row it is handed, at any scope', () => {
    const row = stats.stats.find(
      (r) => r.scope === 'group' && r.name === 'Cart' && r.family === 'group_cumulated',
    )!;
    const data = toRowIndicators(stats, row, 'Cart', 'group');

    expect(data.rows.map((r) => r.values[0])).toEqual([
      row.indicators.under,
      row.indicators.between,
      row.indicators.over,
      row.indicators.failed,
    ]);
    expect(data.axisLabels).toEqual(['Cart']);
  });

  it('names the noun it was given when the row is absent', () => {
    const data = toRowIndicators(stats, undefined, 'Nope', 'group');
    expect(data.series).toEqual([]);
    expect(data.empty).toContain('group');
    expect(data.empty).toContain('Nope');
  });

  it('still reads bounds from the RESPONSE, not the row', () => {
    const row = stats.stats.find((r) => r.scope === 'group' && r.name === 'Cart')!;
    const data = toRowIndicators(stats, row, 'Cart', 'group');
    expect(data.rows[0]?.label).toContain(String(stats.bounds.lowerMs));
  });
});
```

Add `toRowIndicators` to the existing import.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/web/test/transforms.indicators.test.ts -t toRowIndicators
```

Expected: FAIL — `toRowIndicators is not a function`.

- [ ] **Step 3: Implement it, and reduce the request version to a caller**

Replace `toRequestIndicators` at `indicators.ts:185` with:

```ts
/**
 * The bands for a row the CALLER has already found.
 *
 * The lookup lives outside deliberately. A request is identified by (scope,
 * name); a group by (scope, name, family), because one group name carries both
 * `group_cumulated` and `group_duration`. A transform that grew a third
 * argument to re-find a row its caller is already holding would be the wrong
 * boundary — and getting that lookup wrong renders one family's numbers under
 * the other's heading, which nothing about the output looks wrong for.
 *
 * BOUNDS AND THE FIXED-BANDS CAVEAT COME FROM THE RESPONSE, never the row: they
 * are a project setting and a property of the run's storage. `noun` is what the
 * subject is called when there is nothing to fold — "request", "group".
 */
export function toRowIndicators(
  stats: StatsResponse,
  row: StatRow | undefined,
  label: string,
  noun: string,
): ChartData {
  if (row === undefined) {
    return bandChart(
      { under: 0, between: 0, over: 0, failed: 0 },
      stats,
      label,
      `This run recorded no ${noun} named ${label}, so there are no response-time bands to show.`,
    );
  }
  return bandChart(
    row.indicators,
    stats,
    label,
    `No requests were recorded for ${label}, so there are no response-time bands to show.`,
  );
}

/** §13.3 ② — the same bands for one request. */
export function toRequestIndicators(stats: StatsResponse, path: string): ChartData {
  const row = stats.stats.find((r) => r.scope === 'request' && r.name === path);
  return toRowIndicators(stats, row, path, 'request');
}
```

Add `StatRow` to the `@perfportal/contracts` type import at the top of the file.

- [ ] **Step 4: Run the whole indicators suite**

```bash
pnpm vitest run apps/web/test/transforms.indicators.test.ts
```

Expected: PASS, including every pre-existing `toIndicators` and
`toRequestIndicators` test unchanged.

- [ ] **Step 5: Let the chart take a row**

In `apps/web/src/charts/IndicatorsChart.tsx`, replace the signature at `:23`:

```tsx
export default function IndicatorsChart({
  stats,
  row,
  label,
}: {
  readonly stats: StatsResponse;
  /** A specific row's bands. Absent on the run's own overview, which folds the
   *  response-level `indicators` — the run row's — instead. */
  readonly row?: StatRow;
  /** What that row is called on the axis. Required whenever `row` is given. */
  readonly label?: string;
}) {
  const data = useMemo(
    () =>
      label === undefined
        ? toIndicators(stats)
        : toRowIndicators(stats, row, label, 'request'),
    [stats, row, label],
  );
```

Import `toRowIndicators` and the `StatRow` type. Note the branch keys on
`label`, not `row`: a row that is genuinely absent must still render its named
empty state rather than silently falling back to the run's bands.

- [ ] **Step 6: Update the one call site that passes a path**

In `apps/web/src/routes/RequestDetail.tsx`, the `IndicatorsChart` call becomes:

```tsx
          {(data) => (
            <IndicatorsChart stats={data} row={requestRow(data, name)} label={name} />
          )}
```

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add apps/web/src/charts/transforms/indicators.ts apps/web/src/charts/IndicatorsChart.tsx apps/web/src/routes/RequestDetail.tsx apps/web/test/transforms.indicators.test.ts
git commit -m "refactor(web): the indicators transform folds a row the caller found"
```

---

## Task 2: `RequestStatistics` becomes `ScopedStatistics`

**Files:**
- Rename: `apps/web/src/tables/RequestStatistics.tsx` → `apps/web/src/tables/ScopedStatistics.tsx`
- Rename: `apps/web/test/RequestStatistics.test.tsx` → `apps/web/test/ScopedStatistics.test.tsx`
- Modify: `apps/web/src/routes/RequestDetail.tsx`

**Interfaces:**
- Produces: `ScopedStatistics`, props unchanged — `{ row: StatRow; rows: readonly StatRow[] }`.

**Why:** it renders §A.5's column set for one `StatRow` and never reads `scope`.
The group page calls it twice. Renaming now keeps the group page from importing
something called `RequestStatistics` to render a group.

This is a rename with no behaviour change. If anything about the component's
logic seems to need altering, stop and report.

- [ ] **Step 1: Rename both files, preserving history**

```bash
git mv apps/web/src/tables/RequestStatistics.tsx apps/web/src/tables/ScopedStatistics.tsx
git mv apps/web/test/RequestStatistics.test.tsx apps/web/test/ScopedStatistics.test.tsx
```

- [ ] **Step 2: Rename the symbol and update the import**

In `ScopedStatistics.tsx`, `export default function RequestStatistics(` becomes
`export default function ScopedStatistics(`. Update the doc comment's opening
line to say it renders §A.5's set for **one row at any scope**, and that the
group page calls it once per metric family.

In `ScopedStatistics.test.tsx` and `apps/web/src/routes/RequestDetail.tsx`,
update the import and every usage.

- [ ] **Step 3: Confirm nothing still refers to the old name**

```bash
grep -rn "RequestStatistics" apps/web/src apps/web/test apps/web/e2e
```

Expected: no output.

- [ ] **Step 4: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

Expected: PASS, same counts as before — a rename changes no behaviour.

```bash
git add -A apps/web/src/tables apps/web/test apps/web/src/routes/RequestDetail.tsx
git commit -m "refactor(web): RequestStatistics is ScopedStatistics — it never read scope"
```

---

## Task 3: The page, its lookup, and GR-01/GR-02

**Files:**
- Create: `apps/web/src/routes/GroupDetail.tsx`
- Modify: `apps/web/src/App.tsx:44`
- Create: `apps/web/test/GroupDetail.test.tsx`

**Interfaces:**
- Consumes: `statsQuery(id)` (unfiltered — every row plus response-level
  `indicators`/`bounds`/`configurable`), `ScopedStatistics`, `TableSection` and
  `Slot` from `apps/web/src/routes/payload.tsx`.
- Produces: `export default function GroupDetail()`, and
  `export function groupRow(stats: StatsResponse, path: string, family: string): StatRow | undefined`.

**The trap this task exists to avoid:** `requestRow` matches scope and name. A
group has **two rows under one name**. Matching on two fields returns whichever
`find` reaches first and renders cumulated numbers under the duration heading,
with a plausible count and a plausible mean and nothing looking wrong.

**Fixture values for the tests** (`Cart`, chosen because its families diverge):

| family | count | min | max | mean |
|---|---|---|---|---|
| `group_cumulated` | 85 | 106 | 179 | 141.1 |
| `group_duration` | 85 | 188 | 264 | 224.7 |

**Never use `Catalog/Recommendations` for a families-differ assertion** — its two
families agree to within 1 ms (241.8 vs 242.5), so it passes against an
implementation that fetched one family twice.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/GroupDetail.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { groupRow } from '../src/routes/GroupDetail';
import fixture from './fixtures/reference-run.json';

const stats = fixture.stats as Parameters<typeof groupRow>[0];

describe('groupRow', () => {
  it('distinguishes the two families under one name', () => {
    const c = groupRow(stats, 'Cart', 'group_cumulated')!;
    const d = groupRow(stats, 'Cart', 'group_duration')!;

    // THE discriminating assertion: a lookup matching only (scope, name)
    // returns the same row twice and this fails.
    expect(c.meanMs).not.toBe(d.meanMs);
    expect(c.family).toBe('group_cumulated');
    expect(d.family).toBe('group_duration');
  });

  it('does not match a request of the same name', () => {
    // `Catalog` is a group; a request could plausibly be called that too.
    expect(groupRow(stats, 'Catalog', 'response_time')).toBeUndefined();
  });

  it('finds a nested group by its full path', () => {
    const row = groupRow(stats, 'Catalog/Recommendations', 'group_cumulated');
    expect(row?.name).toBe('Catalog/Recommendations');
  });

  it('is undefined for a name the run never recorded', () => {
    expect(groupRow(stats, 'Nope', 'group_cumulated')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/web/test/GroupDetail.test.tsx
```

Expected: FAIL — cannot resolve `../src/routes/GroupDetail`.

- [ ] **Step 3: Create the page**

Create `apps/web/src/routes/GroupDetail.tsx`:

```tsx
import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { statsQuery } from '../api/metrics';
import ScopedStatistics from '../tables/ScopedStatistics';
import { TableSection } from './payload';

/**
 * §13.4 — one group's page.
 *
 * EVERYTHING HERE IS DOUBLED. A request carries one measure; a group carries
 * two — cumulated response time (the sum of its child requests' durations) and
 * duration (its own wall clock) — and they diverge whenever requests inside the
 * group overlap. On the reference run `Cart` is 141 ms cumulated against 225 ms
 * duration. Gatling reports both, so this page shows both.
 *
 * The name is a full path arriving as ONE encoded segment, decided in piece 2:
 * `Catalog%2FRecommendations` reaches here as `Catalog/Recommendations`.
 */

/**
 * The row for one group AND one family.
 *
 * THREE FIELDS, NOT TWO. One group name carries both families, so a lookup that
 * matched only (scope, name) would return whichever `find` reached first and
 * render cumulated numbers under the duration heading — a plausible count, a
 * plausible mean, and nothing about the page looking wrong.
 */
export function groupRow(
  stats: StatsResponse,
  path: string,
  family: string,
): StatRow | undefined {
  return stats.stats.find(
    (r) => r.scope === 'group' && r.name === path && r.family === family,
  );
}

const FAMILIES = [
  { family: 'group_cumulated', title: 'Cumulated response time' },
  { family: 'group_duration', title: 'Duration' },
] as const;

export default function GroupDetail() {
  const { runId, name } = useParams<{ runId: string; name: string }>();
  const stats = useQuery({ ...statsQuery(runId ?? ''), enabled: runId !== undefined });

  // Not reachable through the router — the route cannot match without both.
  if (runId === undefined || name === undefined) {
    return (
      <Link to="/runs" className="underline">
        Back to all runs
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Rendered as text through React, which escapes it: a group name comes
          out of an uploaded simulation log. */}
      <h1 className="text-2xl font-semibold">{name}</h1>
      <Link to={`/runs/${encodeURIComponent(runId)}`} className="underline">
        Back to this run
      </Link>

      {FAMILIES.map(({ family, title }) => (
        <TableSection key={family} title={title} query={stats}>
          {(data) => {
            const row = groupRow(data, name, family);
            return row === undefined ? (
              <p role="status">This run recorded no {title.toLowerCase()} for {name}.</p>
            ) : (
              <ScopedStatistics row={row} rows={data.stats} />
            );
          }}
        </TableSection>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

```bash
pnpm vitest run apps/web/test/GroupDetail.test.tsx
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Point the route at the page**

In `apps/web/src/App.tsx`, add `import GroupDetail from './routes/GroupDetail';`
and replace the group route at `:44`:

```tsx
          <Route path="/runs/:runId/groups/:name" element={<GroupDetail />} />
```

Leave the block comment above the two routes intact — it explains the
single-segment encoding both still rely on.

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add apps/web/src/routes/GroupDetail.tsx apps/web/src/App.tsx apps/web/test/GroupDetail.test.tsx
git commit -m "feat(web): GR-01/GR-02, a group's two statistic sets"
```

---

## Task 4: GR-09 indicators and GR-03/GR-05 distributions

**Files:**
- Modify: `apps/web/src/routes/GroupDetail.tsx`
- Modify: `apps/web/test/GroupDetail.test.tsx`

**Interfaces:**
- Consumes: `IndicatorsChart` with `{ stats, row, label }` (Task 1),
  `distributionQuery(id, scope, name, family)` at `metrics.ts:117`,
  `DistributionChart`, `Payload` and `Slot` from `./payload`.
- Produces: nothing new.

**The distributions need no backend work.** Histograms are stored per
`(scope, name, family)` — `packages/persistence/src/metrics/write.ts:53-69`
persists `histogram_ok`/`histogram_ko` on every stat row, and `RollupBuilder`
builds them unconditionally for every scope. The endpoint already takes `family`
(`parity.controller.ts:30`).

- [ ] **Step 0: Fix a Task 3 test that guards nothing**

`GroupDetail.test.tsx`'s `'does not match a request of the same name'` passes
trivially. It calls `groupRow(stats, 'Catalog', 'response_time')`, and **no row
in the fixture is named `Catalog` with family `response_time`** — so the family
predicate rejects it and the scope predicate is never reached. Deleting
`r.scope === 'group'` leaves the test green.

Point it at a row that actually exists at another scope:

```tsx
  it('does not match a request, even on an exact name and family', () => {
    // `Cart/Add To Cart` IS a row in this run — scope 'request', family
    // 'response_time'. Without the scope predicate this lookup returns it, so
    // this is the assertion that pins scope rather than family.
    expect(groupRow(stats, 'Cart/Add To Cart', 'response_time')).toBeUndefined();
  });
```

Verify it discriminates: delete `r.scope === 'group' &&` from `groupRow`, run
the test, confirm it FAILS, then restore. Report both outputs.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/GroupDetail.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import GroupDetail from '../src/routes/GroupDetail';

it('asks for both families at group scope', () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    urls.push(String(input));
    return Promise.resolve(new Response('{}', { status: 500 }));
  });

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/runs/r1/groups/Catalog%2FRecommendations']}>
        <Routes>
          <Route path="/runs/:runId/groups/:name" element={<GroupDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  const dist = urls.filter((u) => u.includes('/distribution'));
  expect(dist).toHaveLength(2);
  // Both parameters on every scoped call, and a DIFFERENT family on each —
  // two calls carrying the same family is the bug this asserts against.
  for (const url of dist) {
    expect(url).toContain('scope=group');
    expect(url).toContain(`name=${encodeURIComponent('Catalog/Recommendations')}`);
  }
  expect(dist.some((u) => u.includes('family=group_cumulated'))).toBe(true);
  expect(dist.some((u) => u.includes('family=group_duration'))).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/web/test/GroupDetail.test.tsx -t 'both families'
```

Expected: FAIL — `expected [] to have a length of 2`.

- [ ] **Step 3: Add the slots, the queries and the charts**

In `GroupDetail.tsx`, extend the `FAMILIES` constant so each family carries its
own slots, and add the queries. Replace the `FAMILIES` declaration with:

```tsx
/**
 * §13.4's five containers, two per family plus the shared ranges chart. Ids
 * match what each chart component passes to `Chart`, suffixed per family so the
 * two never collide.
 */
const FAMILIES = [
  {
    family: 'group_cumulated',
    title: 'Cumulated response time',
    distribution: {
      id: 'distribution-group_cumulated',
      title: 'Cumulated response time distribution',
    },
  },
  {
    family: 'group_duration',
    title: 'Duration',
    distribution: { id: 'distribution-group_duration', title: 'Duration distribution' },
  },
] as const;

const INDICATORS: Slot = { id: 'indicators', title: 'Response time ranges' };
```

**First, `IndicatorsChart` needs a `noun`.** Task 1 left it hardcoding
`'request'` when it calls `toRowIndicators`, so a group whose row is absent
would render "This run recorded no **request** named Cart". Add the prop:

```tsx
  /** What the subject is called when there is nothing to fold. */
  readonly noun?: string;
```

and use it in the transform call, defaulting so the request page is unchanged:

```tsx
        : toRowIndicators(stats, row, label, noun ?? 'request'),
```

adding `noun` to the `useMemo` dependency array. The group page passes
`noun="group"` in Step 3 below.

Inside the component, beside the `stats` query:

```tsx
  const cumulated = useQuery({
    ...distributionQuery(runId ?? '', 'group', name ?? '', 'group_cumulated'),
    enabled: runId !== undefined && name !== undefined,
  });
  const duration = useQuery({
    ...distributionQuery(runId ?? '', 'group', name ?? '', 'group_duration'),
    enabled: runId !== undefined && name !== undefined,
  });
  const distributions = { group_cumulated: cumulated, group_duration: duration };
```

Then render the indicators once and a distribution per family, beneath the
statistics sections:

```tsx
      <Payload query={stats} slots={[INDICATORS]}>
        {(data) => (
          <IndicatorsChart
            stats={data}
            row={groupRow(data, name, 'group_cumulated')}
            label={name}
            noun="group"
          />
        )}
      </Payload>

      {FAMILIES.map(({ family, distribution }) => (
        <Payload key={family} query={distributions[family]} slots={[distribution]}>
          {(data) => <DistributionChart distribution={data} />}
        </Payload>
      ))}
```

**GR-09 folds the cumulated row deliberately.** Gatling's group page has one
`RangesContainerId`, not two, and cumulated response time is the group measure
its statistics table leads with. Say so in a comment where the row is chosen.

Import `Payload`, `Slot`, `IndicatorsChart`, `DistributionChart` and
`distributionQuery`.

- [ ] **Step 4: Run the test**

```bash
pnpm vitest run apps/web/test/GroupDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add apps/web/src/routes/GroupDetail.tsx apps/web/test/GroupDetail.test.tsx
git commit -m "feat(web): GR-09 and GR-03/GR-05, group ranges and both distributions"
```

---

## Task 4b: `DistributionChart` takes its identity from the caller

**Files:**
- Modify: `apps/web/src/charts/DistributionChart.tsx:28-32`
- Modify: `apps/web/src/routes/GroupDetail.tsx`
- Modify: `apps/web/test/GroupDetail.test.tsx`

**Interfaces:**
- Produces: `DistributionChart` gains `id?: string` and `title?: string`,
  defaulting to `'distribution'` and `'Response time distribution'` so the run
  and request pages are unchanged.

**Why this task exists and is not in the original plan:** Task 4's implementer
found it. `DistributionChart` hardcodes `id="distribution"` and
`title="Response time distribution"`. The group page is the first to render two
of them, so once both payloads load:

- both figures carry `data-testid="chart-distribution"` — **duplicate DOM ids**,
  which is invalid HTML and makes `getByTestId` ambiguous;
- both are headed "Response time distribution", so nothing on screen tells
  cumulated from duration;
- the per-family `Slot` ids this plan defined (`distribution-group_cumulated`,
  `distribution-group_duration`) apply **only** in `Payload`'s undrawn branch,
  so Task 7's e2e would look for figures that vanish the moment data arrives.

This is the same shape as the `title` prop the rate charts took in piece 3, and
the `noun` prop `IndicatorsChart` took in Task 4: a component that was written
when only one instance could exist, meeting its second caller.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/GroupDetail.test.tsx`, alongside the existing render
tests:

```tsx
it('gives each distribution its own figure identity', async () => {
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    const url = String(input);
    if (url.includes('/distribution')) {
      const family = url.includes('group_duration') ? 'group_duration' : 'group_cumulated';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            runId: '00000000-0000-4000-8000-000000000000',
            scope: 'group',
            name: 'Cart',
            family,
            labels: ['0'],
            okCounts: [1],
            koCounts: [0],
            okPercent: [100],
            koPercent: [0],
            exactValues: true,
            overflowCount: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response('{}', { status: 500 }));
  });

  const { findByTestId } = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/runs/r1/groups/Cart']}>
        <Routes>
          <Route path="/runs/:runId/groups/:name" element={<GroupDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  // Both DRAWN, each under its own id — not one id rendered twice.
  await findByTestId('chart-distribution-group_cumulated');
  await findByTestId('chart-distribution-group_duration');
  expect(document.querySelectorAll('[data-testid="chart-distribution"]')).toHaveLength(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/web/test/GroupDetail.test.tsx -t 'own figure identity'
```

Expected: FAIL — `Unable to find an element by: [data-testid="chart-distribution-group_cumulated"]`,
because both charts render as `chart-distribution`.

- [ ] **Step 3: Let the caller name it**

In `apps/web/src/charts/DistributionChart.tsx`, replace the signature and the
two hardcoded props:

```tsx
/**
 * `id` and `title` are props because the GROUP page renders TWO of these — one
 * per metric family — and a component that names itself cannot appear twice on
 * a page: two figures would share a DOM id and a heading, and nothing on screen
 * would distinguish cumulated response time from duration. Defaults keep the run
 * and request pages, which render exactly one, unchanged.
 */
export default function DistributionChart({
  distribution,
  id = 'distribution',
  title = 'Response time distribution',
}: {
  readonly distribution: DistributionResponse;
  readonly id?: string;
  readonly title?: string;
}) {
```

and pass them through to `Chart`:

```tsx
      id={id}
      title={title}
```

- [ ] **Step 4: Pass each family's slot through**

In `GroupDetail.tsx`, the distribution render becomes:

```tsx
          <Payload query={distributions[family]} slots={[distribution]}>
            {(data) => (
              <DistributionChart
                distribution={data}
                id={distribution.id}
                title={distribution.title}
              />
            )}
          </Payload>
```

so the drawn figure and its undrawn placeholder are the same figure — which is
the property `Payload`'s whole design depends on.

- [ ] **Step 5: Run the tests**

```bash
pnpm vitest run apps/web/test/GroupDetail.test.tsx
```

Expected: PASS.

The run and request pages render one distribution each and pass no `id` or
`title`, so their figures keep the default identity:

```bash
pnpm vitest run apps/web/test/RequestDetail.test.tsx apps/web/test/transforms.distribution.test.ts
```

Expected: PASS, unchanged.

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add apps/web/src/charts/DistributionChart.tsx apps/web/src/routes/GroupDetail.tsx apps/web/test/GroupDetail.test.tsx
git commit -m "fix(web): a distribution takes its figure identity from the caller"
```

---

## Task 5: D-14 — GR-04 and GR-06 as stated gaps

**Files:**
- Modify: `apps/web/src/routes/payload.tsx:78`
- Modify: `apps/web/src/routes/GroupDetail.tsx`
- Modify: `apps/web/test/GroupDetail.test.tsx`

**Interfaces:**
- Consumes: `Undrawn`, newly exported from `payload.tsx`.
- Produces: nothing new.

**Why there is no query to hang these on.** `seriesFor` is called exactly twice
in the engine — `packages/statistics/src/engine.ts:172` for `'run'` and `:175`
for `'request'`. The group branch calls only `rollupFor` and `continue`s. No
group buckets exist, so GR-04 and GR-06 have nothing to draw. That is piece 5.

**They still render.** §13.4's element order is itself information, and a page
silently missing two of five containers is indistinguishable from a group whose
percentiles were measured and found empty. `Undrawn` renders `Chart`'s own empty
branch, so the figure, heading and data table are the same markup a real chart
produces — including the data table, which is the parity surface.

**The wording must name the cause**, not merely report absence. This is the
distinction `SPLIT_UNAVAILABLE` was written to make for `started_ok_count`: "not
recorded for this run" is a different sentence from "there was nothing".

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/GroupDetail.test.tsx`:

```tsx
it('renders both percentile charts, saying the series was never recorded', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 500 })));

  const { findByTestId } = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/runs/r1/groups/Cart']}>
        <Routes>
          <Route path="/runs/:runId/groups/:name" element={<GroupDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  // Present, in their §13.4 positions — not omitted.
  for (const id of ['percentiles-group_cumulated', 'percentiles-group_duration']) {
    const figure = await findByTestId(`chart-${id}`);
    // The data table is the parity surface and must exist even undrawn.
    expect(figure).toBeInTheDocument();
    // Names the CAUSE, not merely the absence.
    expect(figure.textContent).toMatch(/not recorded/i);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/web/test/GroupDetail.test.tsx -t 'never recorded'
```

Expected: FAIL — `Unable to find an element by: [data-testid="chart-percentiles-group_cumulated"]`.

- [ ] **Step 3: Export `Undrawn`**

In `apps/web/src/routes/payload.tsx:78`, change `function Undrawn(` to
`export function Undrawn(` and extend its doc comment:

```tsx
/**
 * …existing comment…
 *
 * EXPORTED for charts that have no query at all. Deviation D-14: a group's
 * percentiles-over-time have no group-scoped series to fetch — the engine has
 * never emitted one — so there is no `UseQueryResult` for `Payload` to key off.
 * The figure must still appear in its §13.4 position, saying why, for exactly
 * the reason a failed fetch must: a silently missing chart is indistinguishable
 * from one that was measured and found empty.
 */
```

- [ ] **Step 4: Render the two gaps**

In `GroupDetail.tsx`, give each `FAMILIES` entry a `percentiles` slot alongside
its `distribution`. The constant becomes:

```tsx
const FAMILIES = [
  {
    family: 'group_cumulated',
    title: 'Cumulated response time',
    distribution: {
      id: 'distribution-group_cumulated',
      title: 'Cumulated response time distribution',
    },
    percentiles: {
      id: 'percentiles-group_cumulated',
      title: 'Cumulated response time percentiles over time',
    },
  },
  {
    family: 'group_duration',
    title: 'Duration',
    distribution: { id: 'distribution-group_duration', title: 'Duration distribution' },
    percentiles: {
      id: 'percentiles-group_duration',
      title: 'Duration percentiles over time',
    },
  },
] as const;

/**
 * D-14. Not "no data" — the platform never recorded it for this run. Naming the
 * cause is the whole point: "no percentiles" would read as a group whose
 * response times were measured and found empty, which is a different and false
 * claim. Same distinction `SPLIT_UNAVAILABLE` makes for `started_ok_count`.
 */
const NO_GROUP_SERIES =
  'This platform does not yet record per-group time series, so percentiles over time cannot be ' +
  'drawn for a group. The statistics and distribution above are computed from the same ' +
  'measurements and are complete.';
```

Then widen the existing `FAMILIES.map` so each family's two charts stay
adjacent:

```tsx
      {FAMILIES.map(({ family, distribution, percentiles }) => (
        <Fragment key={family}>
          <Payload query={distributions[family]} slots={[distribution]}>
            {(data) => (
              <DistributionChart
                distribution={data}
                id={distribution.id}
                title={distribution.title}
              />
            )}
          </Payload>
          <Undrawn slot={percentiles} reason={NO_GROUP_SERIES} />
        </Fragment>
      ))}
```

Import `Fragment` from `react` and `Undrawn` from `./payload`. The `key` moves
to the `Fragment`, so remove it from the `Payload`.

**Keep the `id` and `title` props on `DistributionChart`** — Task 4b added them
so each family's drawn figure matches its own undrawn placeholder. Dropping them
here would put both distributions back on one DOM id and one heading.

- [ ] **Step 5: Run the test**

```bash
pnpm vitest run apps/web/test/GroupDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add apps/web/src/routes/payload.tsx apps/web/src/routes/GroupDetail.tsx apps/web/test/GroupDetail.test.tsx
git commit -m "feat(web): D-14, GR-04/GR-06 render as stated gaps"
```

---

## Task 6: Delete `DetailPlaceholder`, correct §13.4

**Files:**
- Delete: `apps/web/src/routes/DetailPlaceholder.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `PerfPortal_Enterprise_PRD.md:1092-1101`

**Interfaces:** none.

**Why now:** `DetailPlaceholder`'s `request` branch went unreachable when piece 3
shipped, and Task 3 took its last route. A component no route renders is dead
code that still reads as a live promise — its text says the group page "will
show" things that now exist.

- [ ] **Step 1: Confirm nothing renders it**

```bash
grep -rn "DetailPlaceholder" apps/web/src apps/web/test apps/web/e2e
```

Expected: **no output.** Task 3 already removed `App.tsx`'s import — lint fails
on a dangling one — so the file is orphaned, imported by nothing, and rendered
by no route. If the grep does return something, that reference is a live use and
this task's premise is wrong: stop and report rather than deleting the file.

- [ ] **Step 2: Delete it**

```bash
git rm apps/web/src/routes/DetailPlaceholder.tsx
```

Leave the block comment above the two detail routes in `App.tsx` — it still
explains the single-segment encoding both rely on.

- [ ] **Step 3: Correct §13.4's prose**

In `PerfPortal_Enterprise_PRD.md`, the §13.4 element table lists
"requests/s, responses/s" and a child request breakdown. Appendix A deleted
GR-07 (§A.9 F-4: the group page has exactly five containers) and has no row for
a child breakdown. Replace the two offending rows:

```markdown
| Full chart set | Distribution and percentiles over time, applied to both cumulated response time and duration. **No per-second charts** — §A.9 F-4 records that Gatling's group page has none |
| Group indicators / ranges | `RangesContainerId`, folded from the cumulated row (GR-09) |
```

and delete the "Child request breakdown" row. Gatling's group page has no such
table, so building one would be beyond parity in a parity page.

- [ ] **Step 4: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add -A apps/web/src PerfPortal_Enterprise_PRD.md
git commit -m "chore(web): delete DetailPlaceholder, and correct §13.4's stale prose"
```

---

## Task 7: e2e — the page mounts and a nested group is reachable

**Files:**
- Create: `apps/web/e2e/group-detail.spec.ts`

**Interfaces:**
- Consumes: `seedAdmin`, `seedRunWithData` from `apps/web/e2e/fixtures.ts`,
  `signIn` from `apps/web/e2e/helpers.ts`.

The stack must be up:

```bash
docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal REDIS_URL=redis://localhost:6380 S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=perfportal S3_SECRET_KEY=perfportal123
```

- [ ] **Step 1: Write the spec**

Create `apps/web/e2e/group-detail.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { signIn } from './helpers.js';

/**
 * §13.4 in a real browser. The unit suites pin the lookup and the scoped URLs
 * in jsdom; what only exists here is the MOUNT — that the page fetches, that
 * both families draw, and that a NESTED group's encoded path survives a hard
 * load through the real server.
 */

const NESTED = 'Catalog/Recommendations';

test('a nested group page loads from a pasted URL', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  // goto, NOT a click: a click is pushState and never reaches the server, so it
  // would pass whether or not %2F survives.
  await page.goto(`/runs/${runId}/groups/${encodeURIComponent(NESTED)}`);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NESTED);
  expect(new URL(page.url()).pathname).not.toBe('/runs');
});

test('both families and both distributions are on the page', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}/groups/Cart`);

  await expect(page.getByRole('heading', { name: 'Cumulated response time' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Duration', exact: true })).toBeVisible();

  for (const id of ['indicators', 'distribution-group_cumulated', 'distribution-group_duration']) {
    await expect(page.getByTestId(`chart-${id}`)).toBeVisible();
    await expect(page.getByTestId(`chart-data-${id}`)).toHaveCount(1);
  }

  // GR-07 does not exist (§A.9 F-4).
  await expect(page.getByText('per second')).toHaveCount(0);
});

test('the percentile charts say the series was never recorded', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}/groups/Cart`);

  for (const id of ['percentiles-group_cumulated', 'percentiles-group_duration']) {
    const figure = page.getByTestId(`chart-${id}`);
    await expect(figure).toBeVisible();
    await expect(figure).toContainText(/not .*record/i);
  }
});
```

If a locator does not match what the app renders, check whether the app or this
spec is wrong before assuming the spec is — and say which in your report.

- [ ] **Step 2: Run it**

```bash
pnpm build && pnpm test:e2e apps/web/e2e/group-detail.spec.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 3: Run every suite and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

```bash
git add apps/web/e2e/group-detail.spec.ts
git commit -m "test(web): the group detail page in a browser"
```

---

## Falsification checkpoints

Run each after Task 7. Break the code as named, confirm the named test fails,
revert.

| # | Break this | This must fail |
|---|---|---|
| 1 | swap the cumulated and duration rows in `FAMILIES` | each family's statistics are its own |
| 2 | drop `family` from `groupRow`'s predicate | the two families are distinct rows |
| 3 | pass the same `family` to both `distributionQuery` calls | each distribution is its own family's |
| 4 | replace `Undrawn` with `null` for GR-04/GR-06 | a missing chart says why it is missing |
| 5 | change `groupRow`'s scope predicate to `'request'` | scope is part of the match |
| 6 | add a requests-per-second chart to the page | no per-second chart appears at group scope |
| 7 | rewrite checkpoint 1's assertion to use `Catalog/Recommendations` | **it must still pass** — proving that group cannot discriminate, which is why 1 and 2 use `Cart` |

Checkpoints 4 and 6 are the non-numeric ones. Checkpoint 7 is a test of the
tests: run it against a *correct* implementation and confirm it passes anyway.

---

## Done when

A person clicks a group row in a run's statistics table and lands on that
group's page: cumulated and duration statistics side by side, both
distributions, its response-time bands, and the two percentiles-over-time charts
in their §13.4 positions stating that this run has no group series recorded. A
nested group is reachable by pasted URL. `pnpm typecheck`, `pnpm lint`,
`pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` are green, and
every checkpoint above has been run and shown to behave as named.

`DetailPlaceholder` is gone, §13.4's prose no longer contradicts Appendix A, and
D-14 is recorded — piece 5, group series in the engine, is what closes it.
