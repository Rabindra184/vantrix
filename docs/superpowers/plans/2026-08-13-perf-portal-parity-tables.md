# Parity Tables — Statistics and Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render §13.2 ⑤ the statistics table and ⑥ the errors table on the run detail page, so it carries the whole Gatling overview rather than only its charts.

**Architecture:** A pure `buildTree` turns the flat `StatRow[]` into a hierarchy derived from `/`-separated group names, with sorting that keeps children under their parent and filtering that keeps ancestors of a match. React renders that tree; the rendered table is its own parity surface.

**Tech Stack:** React 18, TypeScript, Zod contracts, Vitest (node + jsdom), Playwright. **No new dependency.**

**Spec:** `docs/superpowers/specs/2026-08-13-perf-portal-parity-tables-design.md`

## Global Constraints

- Dependencies pinned EXACTLY — no `^`/`~`. **Add no new dependency**; in particular no table or virtualization library (D-9).
- `packages/contracts` is the single source of response schemas; never redeclare a shape it defines.
- Percentile columns are driven by the payload's `percentiles` keys, never hard-coded.
- Sorting keeps children with their parent; filtering keeps a match's ancestors.
- Groups start **collapsed**; the default sort is worst-first on the column the table opens on.
- Row links go to `/runs/:runId/requests/:name` and `/runs/:runId/groups/:name` (G-16).
- The rendered table is the parity surface — every number a person can read must be in the DOM, not only in a chart tooltip.
- `apps/web/test` is typechecked; test code must typecheck.
- Out of scope, and must not appear in any diff: charts of any kind, the latency family, trend strips, comparison, regression detection, live monitoring, saved views, custom dashboards, personalization, i18n, self-registration, any RBAC affordance.
- `. "$HOME/.nvm/nvm.sh" && nvm use` before `pnpm install` or the unit suite — jsdom 30 needs Node ≥ 22, and on Node 20 `.tsx` tests fail to load while the run still prints a passing count.
- Never run `pnpm test:integration` and Playwright concurrently. Before believing a queue-test failure, check `pgrep -fl "dist/main.js"` for a stray worker.
- e2e env: `DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal REDIS_URL=redis://localhost:6380 S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=perfportal S3_SECRET_KEY=perfportal123`

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/capture-chart-fixture.mjs` | extended to capture `/errors` |
| `apps/web/test/fixtures/reference-run.json` | re-captured, now five payloads |
| `apps/web/src/tables/buildTree.ts` | pure: `StatRow[]` → row tree; sort; filter |
| `apps/web/src/tables/StatisticsTable.tsx` | the rendered table, its controls and row links |
| `apps/web/src/tables/ErrorsTable.tsx` | distinct message, count, share of total |
| `apps/web/src/routes/RunDetail.tsx` | mounts both, above the chart stack |
| `apps/web/src/routes/DetailPlaceholder.tsx` | the not-yet-built destination for G-16's links |

**Shared types**, defined in Task 2 and used by every later task:

```ts
export interface TableRow {
  readonly key: string;          // stable across sort/filter: `${scope}:${family}:${name}`
  readonly scope: 'run' | 'group' | 'request';
  readonly name: string;         // the LEAF name, for display
  readonly path: string;         // the full name, for links and matching
  readonly depth: number;
  readonly row: StatRow;
  readonly children: readonly TableRow[];
}
```

---

### Task 1: re-capture the fixture, and settle the group-family question

**Files:**
- Modify: `scripts/capture-chart-fixture.mjs`, `apps/web/test/fixtures/reference-run.json`
- Test: `apps/web/test/reference-run.fixture.test.ts`

**Interfaces:**
- Produces: `fixture.errors` matching `ErrorsResponseSchema`

- [ ] **Step 1: Add `/errors` to the capture script**

Its `ENDPOINTS` list drives both the capture and the fixture's `_capture.endpoints`. Add `errors: '/v1/runs/:id/errors?scope=run&name='`, matching `apps/web/src/api/metrics.ts`'s own URL exactly — read that file, do not guess the query string.

- [ ] **Step 2: Re-capture**

Follow the script's header: it needs an `Origin` header (Better Auth 403s without one) and `node --experimental-strip-types`. Confirm the new file has five payload keys.

- [ ] **Step 3: Write the failing fixture test**

```ts
it('carries a real errors payload, not a hand-written one', () => {
  const parsed = ErrorsResponseSchema.parse(fixture.errors);
  expect(parsed.errors.length).toBeGreaterThan(0);
  // The reference run has 24 KO out of 895; every error must be attributable.
  const total = parsed.errors.reduce((n, e) => n + e.count, 0);
  const stats = fixture.stats as StatsResponse;
  const run = stats.stats.find((r) => r.scope === 'run')!;
  expect(total).toBe(run.koCount);
});
```

- [ ] **Step 4: Run it, confirm it passes against the re-captured file.**

If `total !== run.koCount`, that is a real finding about the endpoints disagreeing — report it, do not adjust the assertion to match.

- [ ] **Step 5: Settle which family the global group row uses — MEASURE, do not assert**

Open `fixtures/gatling-3.15.1.2/reference-report/index.html`, find the statistics-table row for `Cart`, and compare its numbers against both of the fixture's `Cart` rows (`group_cumulated` and `group_duration`). Record in your report: which matched, the numbers on both sides, and how you found them.

If neither matches, say so and use `group_cumulated` — it is the sum of child request durations and therefore comparable to the requests beneath it — and record it as a deviation.

- [ ] **Step 6: Commit**

```bash
git add scripts/capture-chart-fixture.mjs apps/web/test/fixtures/reference-run.json apps/web/test/reference-run.fixture.test.ts
git commit -m "test(web): capture the errors payload, and settle the group family"
```

---

### Task 2: the tree

**Files:**
- Create: `apps/web/src/tables/buildTree.ts`, `apps/web/test/buildTree.test.ts`

**Interfaces:**
- Produces: `TableRow` (see File Structure), `buildTree(stats: StatsResponse, family: MetricFamily): readonly TableRow[]`

- [ ] **Step 1: Write the failing tests**

```ts
import fixture from './fixtures/reference-run.json';
const stats = fixture.stats as unknown as StatsResponse;

it('nests a slash-separated group under its parent', () => {
  const tree = buildTree(stats, 'group_cumulated');
  const catalog = tree.find((r) => r.path === 'Catalog')!;
  expect(catalog.children.map((c) => c.path)).toContain('Catalog/Recommendations');
  // Displayed leaf name, not the full path — the parent supplies the context.
  expect(catalog.children.find((c) => c.path === 'Catalog/Recommendations')!.name)
    .toBe('Recommendations');
});

it('shows an orphaned path at root rather than dropping it', () => {
  // A payload whose child exists without its parent. Dropping it loses a row
  // silently, which is worse than showing it unnested.
  const orphaned = {
    ...stats,
    stats: stats.stats.filter((r) => r.name !== 'Catalog'),
  };
  const tree = buildTree(orphaned, 'group_cumulated');
  expect(tree.map((r) => r.path)).toContain('Catalog/Recommendations');
});

it('carries every row of the requested family, and none of the other', () => {
  const tree = buildTree(stats, 'group_cumulated');
  const flat = (rs: readonly TableRow[]): TableRow[] =>
    rs.flatMap((r) => [r, ...flat(r.children)]);
  const families = new Set(flat(tree).map((r) => r.row.family));
  expect(families.has('group_duration')).toBe(false);
  // A group appears twice in the payload; the table shows one row per group.
  const groups = flat(tree).filter((r) => r.scope === 'group');
  expect(new Set(groups.map((r) => r.path)).size).toBe(groups.length);
});
```

**Before writing these, measure whether request rows carry a group path** (spec §3). If they do in this payload, add a test that a request nests under its group; if they do not, add a test asserting they sit at root, and say which you found.

- [ ] **Step 2: Run, confirm they fail.** `pnpm test:unit -- buildTree`

- [ ] **Step 3: Implement `buildTree`.**

- [ ] **Step 4: Verify green.**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(web): build the statistics row tree from slash-separated names"
```

---

### Task 3: sorting that keeps children with their parent

**Files:**
- Modify: `apps/web/src/tables/buildTree.ts`, `apps/web/test/buildTree.test.ts`

**Interfaces:**
- Produces: `sortTree(rows, column, direction): readonly TableRow[]`, `type SortColumn`, `type SortDirection`

- [ ] **Step 1: Write the failing tests**

```ts
it('reorders siblings without moving a child away from its parent', () => {
  const tree = buildTree(stats, 'group_cumulated');
  const sorted = sortTree(tree, 'p95', 'desc');
  const catalog = sorted.find((r) => r.path === 'Catalog')!;
  // The child is still under Catalog, not promoted to root by the sort.
  expect(catalog.children.map((c) => c.path)).toContain('Catalog/Recommendations');
  expect(sorted.map((r) => r.path)).not.toContain('Catalog/Recommendations');
});

it('sorts siblings by the requested column, descending', () => {
  const sorted = sortTree(buildTree(stats, 'group_cumulated'), 'p95', 'desc');
  const p95 = (r: TableRow) => r.row.percentiles.p95 ?? 0;
  for (let i = 1; i < sorted.length; i++) {
    expect(p95(sorted[i - 1]!)).toBeGreaterThanOrEqual(p95(sorted[i]!));
  }
});

it('is stable for equal values, so a re-sort does not shuffle', () => {
  const tree = buildTree(stats, 'group_cumulated');
  const once = sortTree(tree, 'count', 'desc').map((r) => r.path);
  const twice = sortTree(sortTree(tree, 'count', 'desc'), 'count', 'desc').map((r) => r.path);
  expect(twice).toEqual(once);
});
```

- [ ] **Step 2: Run, confirm they fail.**

- [ ] **Step 3: Implement.** Sort each sibling list, recurse into children, never flatten.

- [ ] **Step 4: Verify green.**

- [ ] **Step 5: Falsification checkpoint (§9 checkpoint 1)**

Flatten the tree before sorting and re-nest afterwards by path.
Expected: **"reorders siblings without moving a child away from its parent" FAILS.** Paste the output. Restore and verify byte-identical.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(web): sort the statistics tree without breaking parentage"
```

---

### Task 4: filtering that keeps ancestors

**Files:**
- Modify: `apps/web/src/tables/buildTree.ts`, `apps/web/test/buildTree.test.ts`

**Interfaces:**
- Produces: `filterTree(rows, query: string): readonly TableRow[]`

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps the ancestors of a match, so the match keeps its context', () => {
  const filtered = filterTree(buildTree(stats, 'group_cumulated'), 'Recommendations');
  expect(filtered.map((r) => r.path)).toEqual(['Catalog']);
  expect(filtered[0]!.children.map((c) => c.path)).toEqual(['Catalog/Recommendations']);
});

it('keeps a matching parent whole, with its children', () => {
  const filtered = filterTree(buildTree(stats, 'group_cumulated'), 'Catalog');
  const catalog = filtered.find((r) => r.path === 'Catalog')!;
  expect(catalog.children.length).toBeGreaterThan(0);
});

it('returns nothing for a query that matches nothing', () => {
  expect(filterTree(buildTree(stats, 'group_cumulated'), 'zzz-no-such-row')).toEqual([]);
});

it('is case-insensitive', () => {
  const lower = filterTree(buildTree(stats, 'group_cumulated'), 'catalog');
  const upper = filterTree(buildTree(stats, 'group_cumulated'), 'CATALOG');
  expect(lower.map((r) => r.path)).toEqual(upper.map((r) => r.path));
});
```

- [ ] **Step 2: Run, confirm they fail.**

- [ ] **Step 3: Implement.** A node survives if it matches or any descendant does.

- [ ] **Step 4: Verify green.**

- [ ] **Step 5: Falsification checkpoint (§9 checkpoint 2)**

Drop ancestors — keep only matching nodes, promoted to root.
Expected: **"keeps the ancestors of a match" FAILS.** Paste, restore, verify.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(web): filter the statistics tree without orphaning matches"
```

---

### Task 5: the statistics table

**Files:**
- Create: `apps/web/src/tables/StatisticsTable.tsx`, `apps/web/test/StatisticsTable.test.tsx`

**Interfaces:**
- Consumes: `buildTree`, `sortTree`, `filterTree`
- Produces: `<StatisticsTable stats={…} runId={…} />`

- [ ] **Step 1: Write the failing tests**

```tsx
it('drives its percentile columns off the payload, not a hard-coded list', () => {
  const odd = {
    ...stats,
    stats: stats.stats.map((r) => ({ ...r, percentiles: { p50: 1, p90: 2, 'p99.9': 3 } })),
  };
  render(<StatisticsTable stats={odd} runId={RUN_ID} />);
  expect(screen.getByRole('columnheader', { name: /99\.9/ })).toBeTruthy();
  expect(screen.queryByRole('columnheader', { name: /^95th$/ })).toBeNull();
});

it('starts with groups collapsed', () => {
  render(<StatisticsTable stats={stats} runId={RUN_ID} />);
  expect(screen.queryByText('Recommendations')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /expand Catalog/i }));
  expect(screen.getByText('Recommendations')).toBeTruthy();
});

it('links each row to its detail page (G-16)', () => {
  render(<StatisticsTable stats={stats} runId={RUN_ID} />);
  const link = screen.getByRole('link', { name: /List Products/ });
  expect(link.getAttribute('href')).toBe(`/runs/${RUN_ID}/requests/List%20Products`);
});
```

Wrap in a `MemoryRouter` — see `apps/web/test/RunDetail.polling.test.tsx` for the established pattern.

- [ ] **Step 2: Run, confirm they fail.**

- [ ] **Step 3: Implement.** A real `<table>` with `<th scope="col">`, one `<caption>`, expand/collapse buttons with accessible names, and the §13.2 ⑤ column set: Total, OK, KO, %KO, Cnt/s, Min, then one column per payload percentile key, then Max, Mean, Std Dev.

- [ ] **Step 4: Verify green.**

- [ ] **Step 5: Falsification checkpoints (§9 checkpoints 4 and 6) — BOTH NON-NUMERIC for 4**

(a) Render groups expanded by default. Expected: **"starts with groups collapsed" FAILS.**
(b) Hard-code the percentile columns to p50/p75/p95/p99. Expected: **"drives its percentile columns off the payload" FAILS.**
Paste both, restore each, verify byte-identical.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(web): the statistics table, hierarchical and sortable"
```

---

### Task 6: sort and filter controls, and the default direction

**Files:**
- Modify: `apps/web/src/tables/StatisticsTable.tsx`, `apps/web/test/StatisticsTable.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
it('opens worst-first, not alphabetically', () => {
  render(<StatisticsTable stats={stats} runId={RUN_ID} />);
  const first = screen.getAllByTestId('stat-row')[0]!;
  // The slowest row, not the first alphabetically. A default of ascending
  // would put the fastest at the top, which is the opposite of the question.
  expect(first.getAttribute('data-path')).toBe(slowestPathIn(stats));
});

it('toggles direction when the same column is clicked twice', () => {
  render(<StatisticsTable stats={stats} runId={RUN_ID} />);
  const header = screen.getByRole('button', { name: /sort by 95th/i });
  fireEvent.click(header);
  const asc = screen.getAllByTestId('stat-row').map((r) => r.getAttribute('data-path'));
  fireEvent.click(header);
  const desc = screen.getAllByTestId('stat-row').map((r) => r.getAttribute('data-path'));
  expect(desc).toEqual([...asc].reverse());
});

it('filters as you type, keeping ancestors', () => {
  render(<StatisticsTable stats={stats} runId={RUN_ID} />);
  fireEvent.change(screen.getByLabelText(/filter/i), { target: { value: 'Recommend' } });
  expect(screen.getByText('Catalog')).toBeTruthy();
  expect(screen.queryByText('List Products')).toBeNull();
});
```

Write `slowestPathIn` in the test file from the payload, so it cannot drift from the fixture.

- [ ] **Step 2: Run, confirm they fail.**

- [ ] **Step 3: Implement**, with `aria-sort` on the sorted column.

- [ ] **Step 4: Verify green.**

- [ ] **Step 5: Falsification checkpoint (§9 checkpoint 3) — NON-NUMERIC**

Default the sort direction to ascending.
Expected: **"opens worst-first, not alphabetically" FAILS.** Paste, restore, verify.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(web): sort and filter controls for the statistics table"
```

---

### Task 7: the errors table

**Files:**
- Create: `apps/web/src/tables/ErrorsTable.tsx`, `apps/web/test/ErrorsTable.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
it('shares are of the TOTAL errors, so they sum to 100', () => {
  render(<ErrorsTable errors={errors} />);
  const shares = screen.getAllByTestId('error-share')
    .map((el) => Number(el.getAttribute('data-value')));
  expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 1);
});

it('shows every distinct message with its count', () => {
  render(<ErrorsTable errors={errors} />);
  for (const e of errors.errors) {
    expect(screen.getByText(e.message)).toBeTruthy();
  }
});

it('says so when a run had no errors, rather than rendering an empty table', () => {
  render(<ErrorsTable errors={{ runId: RUN_ID, errors: [] }} />);
  expect(screen.getByText(/no errors/i)).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
});
```

- [ ] **Step 2: Run, confirm they fail.**

- [ ] **Step 3: Implement.** Message, count, share. **No affected-endpoint column** (D-8) — and say in a comment why it is absent, citing the spec, so its absence reads as a decision rather than an oversight.

- [ ] **Step 4: Verify green.**

- [ ] **Step 5: Falsification checkpoint (§9 checkpoint 5)**

Compute each share against its own count instead of the total.
Expected: **"shares are of the TOTAL errors" FAILS.** Paste, restore, verify.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(web): the errors table, shares of the run total"
```

---

### Task 8: mount both, and prove the behaviours in a browser

**Files:**
- Modify: `apps/web/src/routes/RunDetail.tsx`, `apps/web/src/App.tsx`
- Create: `apps/web/src/routes/DetailPlaceholder.tsx`, `apps/web/e2e/run-tables.spec.ts`

- [ ] **Step 1: Write the failing e2e tests**

```ts
test('a completed run shows every request and group in one table', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  await expect(page.getByRole('table', { name: /statistics/i })).toBeVisible();
  for (const name of ['List Products', 'Search', 'Place Order']) {
    // rowheader, NOT cell: a row's name is a <th scope="row">, which
    // Playwright's roleUtils maps to `rowheader` before any other rule, and
    // `cell` does not match it. Measured — the brief's original `cell`
    // assertion cannot pass against a correct implementation.
    await expect(page.getByRole('rowheader', { name })).toBeVisible();
  }
});

test('a group expands to its children and collapses again', async ({ page }) => {
  // ... sign in and open the run
  await expect(page.getByText('Recommendations')).toHaveCount(0);
  await page.getByRole('button', { name: /expand Catalog/i }).click();
  await expect(page.getByText('Recommendations')).toBeVisible();
  await page.getByRole('button', { name: /collapse Catalog/i }).click();
  await expect(page.getByText('Recommendations')).toHaveCount(0);
});

test('filtering keeps the match in its group', async ({ page }) => {
  // ... sign in and open the run
  await page.getByLabel(/filter/i).fill('Recommend');
  await expect(page.getByText('Catalog')).toBeVisible();
  await expect(page.getByText('List Products')).toHaveCount(0);
});

test('a row links to its detail page', async ({ page }) => {
  // ... sign in and open the run
  await page.getByRole('link', { name: /List Products/ }).click();
  await expect(page).toHaveURL(/\/requests\/List%20Products$/);
  // Piece 3 builds this page; today it must say so rather than 404.
  await expect(page.getByText(/not built yet|coming/i)).toBeVisible();
});
```

- [ ] **Step 2: Run, confirm they fail.**

- [ ] **Step 3: Implement.** Mount both tables **above** the chart stack, inside the `ready` branch. Add the two placeholder routes.

- [ ] **Step 4: Full verification, sequentially**

```bash
. "$HOME/.nvm/nvm.sh" && nvm use
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
npx playwright test
```

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(web): the statistics and errors tables on the run detail page"
```

---

## Verification

**Definition of done:** a person opens a completed run and sees, above the charts, every request and group in a table they can sort, filter and expand, each row linking to its detail page; and beneath it the distinct errors with counts and shares. All suites green.

**The six falsification checkpoints, two of them non-numeric:**

| Task | Break this | This must fail |
|---|---|---|
| 3 | flatten the tree before sorting | children stay with their parent |
| 4 | drop ancestors from a filtered result | a filtered match keeps its context |
| 5 | render groups expanded by default *(non-numeric)* | groups start collapsed |
| 5 | hard-code the percentile columns | columns follow the payload's keys |
| 6 | default the sort direction to ascending *(non-numeric)* | the table opens worst-first |
| 7 | compute each error share against its own count | shares sum to 100 |

A checkpoint that stays green is a finding, not a formality. The previous sub-project ran nine falsifications and found eight tests that could not fail — several written by the controller — and the ninth escaped because every checkpoint named a numeric mutation while the defect was an interactive default. That is why two of these six are non-numeric.

**Assume every example test in this plan is non-discriminating until you have measured otherwise.** In the previous sub-project that assumption was correct eight times out of eight.
