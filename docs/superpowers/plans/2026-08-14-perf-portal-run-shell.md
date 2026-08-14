# Run Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/runs/:runId` into a run shell — a header and three URL-addressable tabs — without moving a number the reader already trusts.

**Architecture:** `/runs/:runId` becomes a React Router layout route rendering the header, a tab nav, and an `<Outlet/>`. Three children: an index route holding assertions, stat tiles and the statistics table; `charts` holding the eight §13.2 figures; `errors` holding the errors table. `RunDetail`'s three-state branch is unchanged — only its `Ready` branch grows the shell.

**Tech Stack:** React 18, React Router 7, TanStack Query 5, Tailwind v4, Playwright, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-perf-portal-run-shell-design.md`

## Global Constraints

- Node 22 (`.nvmrc` pins 22.19.0). `export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"` before any pnpm command.
- Full gate before claiming done: `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`. Integration and e2e need the docker stack and the env vars in `infra/README.md`, and must NEVER run concurrently — both truncate the same database.
- Branch is `feat/run-shell`, already created, already carrying the spec commit. One PR to `main`, merged with `--merge`, never squashed.
- **Front-end only.** No migration, no contract change, no new endpoint. If a task appears to need one, stop and report.
- Expectations are computed from the payload, never written down. A test hard-coding a value `apps/web/test/fixtures/reference-run.json` supplies breaks on the next re-capture for a reason that is not a defect.
- Accessible-name assertions go in Playwright, never jsdom: `dom-accessibility-api` does not consult a descendant's `aria-hidden` and Chromium does.
- Use the Tailwind utilities sub-project 1 generated (`bg-surface`, `border-default`, `text-muted`, `bg-sunken`, `text-accent`…). `apps/web/test/tokens.test.ts` fails on the old `[var(--…)]` form outside its exempt paths.
- Status and verdict render through `Badge` from `apps/web/src/components/Badge.tsx`, taking a `Mark` from `routes/marks.tsx`. Never re-decide a glyph, word or colour.
- Do not change any existing `data-testid`. The e2e suite locates by them.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/App.tsx` | `/runs/:runId` becomes a layout route with three children |
| `apps/web/src/routes/paths.ts` | Tab path helpers, so no URL is spelled twice |
| `apps/web/src/routes/RunShell.tsx` | New: the `Ready` layout — header, tab nav, `<Outlet/>` |
| `apps/web/src/routes/RunHeader.tsx` | New: run identity and metadata |
| `apps/web/src/routes/RunTabs.tsx` | New: the nav of links |
| `apps/web/src/routes/RunDetail.tsx` | Three-state branch kept; `Tables`/`Overview` become tab children |
| `apps/web/src/routes/runUsers.ts` | New: `peakConcurrentUsers`, a pure function |
| `apps/web/e2e/*.spec.ts` | Migrated to the new URLs, plus four new specs |

---

### Task 1: The layout route and the split

**Files:**
- Modify: `apps/web/src/App.tsx:25`
- Modify: `apps/web/src/routes/paths.ts`
- Create: `apps/web/src/routes/RunShell.tsx`
- Modify: `apps/web/src/routes/RunDetail.tsx:198-271,371-382`
- Modify: `apps/web/e2e/run-charts.spec.ts`, `run-tables.spec.ts`, `run-detail.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `runPath(runId)`, `runChartsPath(runId)`, `runErrorsPath(runId)` from `paths.ts`. `RunShell` renders `<Outlet/>`; Task 2 adds the tab nav to it and Task 3 the header. Both edit `RunShell.tsx`, so leave its structure obvious.

- [ ] **Step 1: Verify falsification checkpoint 1 BEFORE building anything**

Spec §9-1 assumes React Router ranks `/runs/:runId/requests/:name` above a layout route at `/runs/:runId` whose children do not match. Prove it, or the rest of this task is built on sand.

Add the layout route with three placeholder children to `App.tsx`, replacing line 25:

```tsx
<Route path="/runs/:runId" element={<RunDetail />}>
  <Route index element={<p>overview</p>} />
  <Route path="charts" element={<p>charts</p>} />
  <Route path="errors" element={<p>errors</p>} />
</Route>
```

Then run the two detail suites, which must be completely unaffected:

```bash
pnpm build && pnpm exec playwright test apps/web/e2e/request-detail.spec.ts apps/web/e2e/group-detail.spec.ts
```

Expected: all pass, unchanged. **If either fails, STOP and report** — the layout route is swallowing its siblings and the spec's §3a assumption is wrong. Do not proceed by moving the request routes.

- [ ] **Step 2: Write the failing e2e for direct tab loads**

Add to `apps/web/e2e/run-detail.spec.ts`:

```ts
test('each tab is its own URL, reachable directly', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  // A hard load of each tab, never a click — this is what makes a link
  // pasted into an incident channel land where it says it will.
  await page.goto(`/runs/${runId}/charts`);
  await expect(page.getByTestId('chart-percentiles')).toBeVisible();
  await expect(page.getByTestId('stat-row-total')).toHaveCount(0);

  await page.goto(`/runs/${runId}/errors`);
  await expect(page.getByTestId('error-row').first()).toBeVisible();
  await expect(page.getByTestId('chart-percentiles')).toHaveCount(0);

  // The bare path is Overview, so every link that predates tabs still works.
  await page.goto(`/runs/${runId}`);
  await expect(page.getByTestId('stat-row-total')).toBeVisible();
  await expect(page.getByTestId('chart-percentiles')).toHaveCount(0);
});
```

- [ ] **Step 3: Run it to make sure it fails**

```bash
pnpm build && pnpm exec playwright test apps/web/e2e/run-detail.spec.ts -g 'each tab is its own URL'
```

Expected: FAIL — the placeholder children render the word "charts", not a chart.

- [ ] **Step 4: Add the path helpers**

In `apps/web/src/routes/paths.ts`:

```ts
/**
 * A run's three tabs. Spelled once here because `App.tsx` declares them,
 * `RunTabs` links to them and the e2e suite navigates to them — three places
 * that must agree about a string, which is two more than can be kept in step
 * by hand.
 */
export function runPath(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}
export function runChartsPath(runId: string): string {
  return `${runPath(runId)}/charts`;
}
export function runErrorsPath(runId: string): string {
  return `${runPath(runId)}/errors`;
}
```

- [ ] **Step 5: Split `RunDetail`'s content into the three children**

`RunDetail.tsx` keeps its three-state branch exactly as it is. Change only what `Ready` renders and how `Tables`/`Overview` are exported:

- `Ready` renders `<RunShell run={run} />` instead of the header markup plus `<Assertions/>`, `<Tables/>` and `<Overview/>`.
- Export three new components from `RunDetail.tsx`: `RunOverviewTab` (assertions + the stats `TableSection` carrying `RunStats` and `StatisticsTable`), `RunChartsTab` (the current `Overview` body), `RunErrorsTab` (the errors `TableSection`).
- **Delete `Overview`'s `<h2 id="overview-heading">Overview</h2>`** and move its `aria-labelledby` to an `aria-label="Charts"` on the same `<section>`. A tab named Overview directly above a heading that says Overview says it twice.

`RunShell.tsx` for now is just the outlet — Tasks 2 and 3 fill it in:

```tsx
import { Outlet } from 'react-router-dom';
import type { RunResponse } from '@perfportal/contracts';

/**
 * The chrome around one run's three tabs.
 *
 * A LAYOUT ROUTE, not three sibling routes each rendering the page with a
 * `tab` prop. The sibling shape looks simpler and remounts this component on
 * every tab click — the header would flash and the run query would re-run.
 * Here the shell mounts once and only the `<Outlet/>` swaps.
 */
export default function RunShell({ run }: { readonly run: RunResponse }) {
  return (
    <div className="flex flex-col gap-6">
      <Outlet />
    </div>
  );
}
```

A bare `<Outlet/>`, with no `context`: the three tab components each read `runId` from `useParams`, which is the pattern `RequestDetail` and `GroupDetail` already use, and it keeps them renderable without a provider in unit tests. `run` is a prop here because Task 3's header needs it, not because the children do.

Wire the children in `App.tsx` to the three exported tab components.

- [ ] **Step 6: Run the new test to green**

```bash
pnpm build && pnpm exec playwright test apps/web/e2e/run-detail.spec.ts -g 'each tab is its own URL'
```

Expected: PASS.

- [ ] **Step 7: Migrate the existing specs to their new URLs**

Every `page.goto(\`/runs/${runId}\`)` whose test then asserts on a chart becomes `page.goto(runChartsPath(runId))`; the errors-table test becomes `runErrorsPath(runId)`. Counts to expect: `run-charts.spec.ts` has 15 `page.goto` calls, `run-tables.spec.ts` 3, `run-detail.spec.ts` 8.

Import the helpers rather than building strings, so a later rename is one edit.

**Do not weaken an assertion to make it pass.** A chart test that now fails because it is on the wrong tab needs its URL fixed, not its expectation.

- [ ] **Step 8: Full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
pnpm build && pnpm test:e2e
```

Expected: unit unchanged at 659; e2e 51 (50 + the new one).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src apps/web/e2e
git commit -m "feat(web): a run's sections become three addressable tabs"
```

---

### Task 2: The tab nav

**Files:**
- Create: `apps/web/src/routes/RunTabs.tsx`
- Create: `apps/web/test/RunTabs.test.tsx`
- Modify: `apps/web/src/routes/RunShell.tsx`
- Modify: `apps/web/e2e/run-detail.spec.ts`

**Interfaces:**
- Consumes: `runPath`/`runChartsPath`/`runErrorsPath` from Task 1
- Produces: `RunTabs({ runId, errorCount })`, a `<nav>` of three `<Link>`s. Task 3 adds the header above it in `RunShell`.

- [ ] **Step 1: Write the failing unit test**

`apps/web/test/RunTabs.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import RunTabs from '../src/routes/RunTabs';

const RUN = 'a66548b7-2962-43ff-8b93-7149a6f2a1b8';

function renderAt(path: string, errorCount: number) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RunTabs runId={RUN} errorCount={errorCount} />
    </MemoryRouter>,
  );
}

describe('RunTabs', () => {
  /**
   * LINKS, not role="tab". The ARIA tab pattern describes in-page panels that
   * swap without navigation and promises arrow-key movement between them.
   * These change the URL and the browser navigates; wearing the roles would
   * make a promise the implementation cannot keep.
   */
  it('renders navigation links, not ARIA tabs', () => {
    renderAt(`/runs/${RUN}`, 2);
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('marks the current tab with aria-current', () => {
    renderAt(`/runs/${RUN}/errors`, 2);
    expect(screen.getByRole('link', { name: /Errors/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  /** The bare run path is Overview, so it is current there too. */
  it('treats the index path as Overview', () => {
    renderAt(`/runs/${RUN}`, 0);
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });

  it('shows the error count, including zero', () => {
    renderAt(`/runs/${RUN}`, 0);
    expect(screen.getByRole('link', { name: /Errors/ })).toHaveTextContent('0');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm vitest run apps/web/test/RunTabs.test.tsx
```

Expected: FAIL — cannot resolve `../src/routes/RunTabs`.

- [ ] **Step 3: Write `RunTabs.tsx`**

```tsx
import { NavLink } from 'react-router-dom';
import { runChartsPath, runErrorsPath, runPath } from './paths';

/**
 * A run's three sections, as navigation.
 *
 * `NavLink` supplies `aria-current="page"` itself when its `to` matches — and
 * `end` on the Overview link is what stops it matching `/charts` and
 * `/errors` too, since both start with the run's own path.
 *
 * The error count is DISTINCT MESSAGES, which only `/errors` knows. The stats
 * row's `koCount` is failed requests — 24 where this is 2 on the reference
 * run — so using it would put a plausible wrong number on screen.
 */
export default function RunTabs({
  runId,
  errorCount,
}: {
  readonly runId: string;
  readonly errorCount: number;
}) {
  const base = 'border-b-2 px-3 py-2 text-sm';
  const style = ({ isActive }: { isActive: boolean }) =>
    isActive
      ? `${base} border-accent text-primary font-semibold`
      : `${base} border-transparent text-muted`;

  return (
    <nav aria-label="Run sections" className="flex gap-1 border-b border-default">
      <NavLink to={runPath(runId)} end className={style}>
        Overview
      </NavLink>
      <NavLink to={runChartsPath(runId)} className={style}>
        Charts
      </NavLink>
      <NavLink to={runErrorsPath(runId)} className={style}>
        Errors ({errorCount})
      </NavLink>
    </nav>
  );
}
```

- [ ] **Step 4: Run it to make sure it passes**

```bash
pnpm vitest run apps/web/test/RunTabs.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Render it in `RunShell`, fetching the count**

`RunShell` calls `useQuery(errorsQuery(run.id))` and passes `data?.errors.length ?? 0`. The Errors tab then reads the same key from cache.

Render `<RunTabs/>` above the `<Outlet/>`.

- [ ] **Step 6: Add the two e2e specs this enables**

```ts
test('switching tabs does not remount the shell', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  // The heading is the shell's, not the panel's. If the layout route were
  // three sibling routes instead, this node would be destroyed and rebuilt on
  // every tab click — which is the whole reason for the layout route.
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toBeVisible();
  const before = await heading.textContent();

  await page.getByRole('link', { name: 'Charts' }).click();
  await expect(page.getByTestId('chart-percentiles')).toBeVisible();
  expect(await heading.textContent()).toBe(before);
});

test('a processing run shows no tab strip', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedPendingRun(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  // A tab strip over a run nobody has parsed yet is three doors onto three
  // empty rooms — the same mistake the Processing branch already refuses to
  // make with a table of dashes.
  await expect(page.getByRole('navigation', { name: 'Run sections' })).toHaveCount(0);
  await expect(page.getByText(/still processing/i)).toBeVisible();
});

test('the errors tab counts distinct messages, not failed requests', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  // Spec §9-4. On the reference run these are 2 and 24 — distinct error
  // messages versus failed requests. Both are derived from the page's own
  // payloads rather than written down, so a re-captured fixture moves them
  // together: the count must follow the errors table's row count, and must
  // NOT follow the statistics row's KO column.
  const tab = page.getByRole('link', { name: /Errors/ });
  await page.goto(`/runs/${runId}/errors`);
  const distinct = await page.getByTestId('error-row').count();
  const ko = Number(
    (await page.getByTestId('stat-row-total').locator('td').nth(2).textContent())?.trim(),
  );
  expect(distinct).toBeGreaterThan(0);
  expect(distinct).not.toBe(ko);

  await page.goto(`/runs/${runId}`);
  await expect(tab).toHaveText(`Errors (${distinct})`);
});
```

`seedPendingRun` is real — `fixtures.ts:427`, already used at `run-detail.spec.ts:216`.

The KO figure in that second test comes from the totals row's third `<td>`; confirm that index against `StatisticsTable`'s column order before trusting it, and fix the index rather than the assertion if it is off.

- [ ] **Step 7: Full gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
pnpm build && pnpm test:e2e
git add apps/web/src apps/web/test apps/web/e2e
git commit -m "feat(web): the run's sections get a nav, not an ARIA tablist"
```

Expected: unit 663 (659 + 4); e2e 53 (51 + 2).

---

### Task 3: The run header

**Files:**
- Create: `apps/web/src/routes/RunHeader.tsx`
- Create: `apps/web/src/routes/runUsers.ts`
- Create: `apps/web/test/runUsers.test.ts`
- Create: `apps/web/test/RunHeader.test.tsx`
- Modify: `apps/web/src/routes/RunShell.tsx`
- Modify: `apps/web/e2e/run-detail.spec.ts`

**Interfaces:**
- Consumes: `Badge`, `STATUS`, `VERDICT`, `formatStarted`, `formatDuration`
- Produces: `peakConcurrentUsers(users: UsersResponse): number | null`; `RunHeader({ run, peakUsers })`

- [ ] **Step 1: Write the failing test for the derivation**

`apps/web/test/runUsers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { UsersResponse } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import { peakConcurrentUsers } from '../src/routes/runUsers';

const users = reference.users as UsersResponse;

describe('peakConcurrentUsers', () => {
  it('is the maximum of the payload’s own total series', () => {
    const expected = Math.max(...users.total.map((b) => b.maxConcurrent));
    expect(peakConcurrentUsers(users)).toBe(expected);
  });

  /**
   * THE TRAP THE CONTRACT NAMES. Gatling's "All users" is the per-scenario sum
   * AT EACH OFFSET, and `max(a+b) != max(a)+max(b)`: two scenarios peaking at
   * different moments would report a peak the run never reached. Synthetic,
   * because the fixture's scenarios may happen to peak together — in which
   * case a test built only on it would prove nothing.
   */
  it('is not the sum of per-scenario maxima', () => {
    const staggered: UsersResponse = {
      runId: users.runId,
      scenarios: [
        { scenario: 'a', buckets: [bucket(0, 10), bucket(1000, 0)] },
        { scenario: 'b', buckets: [bucket(0, 0), bucket(1000, 10)] },
      ],
      total: [bucket(0, 10), bucket(1000, 10)],
    };
    // Per-scenario maxima sum to 20; the run never had more than 10 at once.
    expect(peakConcurrentUsers(staggered)).toBe(10);
  });

  it('is null when the run recorded no users at all', () => {
    expect(peakConcurrentUsers({ runId: users.runId, scenarios: [], total: [] })).toBeNull();
  });
});

function bucket(startOffsetMs: number, maxConcurrent: number) {
  return { startOffsetMs, started: 0, ended: 0, maxConcurrent };
}
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm vitest run apps/web/test/runUsers.test.ts
```

Expected: FAIL — cannot resolve `../src/routes/runUsers`.

- [ ] **Step 3: Write the derivation**

```ts
import type { UsersResponse } from '@perfportal/contracts';

/**
 * The highest number of users the run had running at once.
 *
 * READS `total`, NEVER SUMS THE SCENARIOS. The payload's `total` is already
 * the per-scenario sum at each offset — the contract says so, and says why:
 * `max(a+b) != max(a)+max(b)`, so summing each scenario's own maximum reports
 * a peak the run never reached whenever two scenarios peak at different
 * moments.
 *
 * Null, not zero, for a run with no buckets: zero is a measurement.
 */
export function peakConcurrentUsers(users: UsersResponse): number | null {
  if (users.total.length === 0) return null;
  return Math.max(...users.total.map((bucket) => bucket.maxConcurrent));
}
```

- [ ] **Step 4: Run it to make sure it passes**

```bash
pnpm vitest run apps/web/test/runUsers.test.ts
```

Expected: PASS, all three.

- [ ] **Step 5: Write `RunHeader`**

```tsx
import type { RunResponse } from '@perfportal/contracts';
import Badge from '../components/Badge';
import { formatStarted } from './format';
import { STATUS, VERDICT } from './marks';

/**
 * What this run IS, before anything about how it went.
 *
 * Everything here comes from payloads the page already holds. There is no
 * environment and no branch: `IngestMetadataSchema` accepts both and nothing
 * stores them, so the platform does not know them — see the spec's §2. Adding
 * a blank chip would claim we asked and got nothing back.
 */
export default function RunHeader({
  run,
  peakUsers,
}: {
  readonly run: RunResponse;
  readonly peakUsers: number | null;
}) {
  const startedAt = run.toolStartedAt ?? run.startedAt;
  const isIngestTime = run.toolStartedAt == null;

  return (
    <header className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold">{run.simulation ?? `Run ${run.id.slice(0, 8)}`}</h1>
      {run.description != null && run.description !== '' && (
        <p className="text-muted">{run.description}</p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
        <span>{run.toolVersion ? `${run.tool} ${run.toolVersion}` : run.tool}</span>
        <span>
          <time dateTime={startedAt}>{formatStarted(startedAt)}</time>
          {isIngestTime && <span className="ml-1">(ingest time — the tool reported no start)</span>}
        </span>
        <span data-testid="run-duration">{formatDuration(run.durationMs)}</span>
        {peakUsers !== null && <span>{peakUsers.toLocaleString()} peak users</span>}
        <span data-testid="run-status">
          <Badge mark={STATUS[run.status]} />
        </span>
        <span data-testid="run-verdict">
          <Badge mark={VERDICT[run.verdict ?? 'none']} />
        </span>
      </div>
    </header>
  );
}
```

**Move `formatDuration` into `apps/web/src/routes/format.ts`**, taking its docstring with it, and import it from there in both `RunDetail.tsx` and `RunHeader.tsx`.

Not exported from `RunDetail.tsx`, which is what it might look like it wants: `RunDetail` renders `RunShell`, which renders `RunHeader`, so importing back into `RunHeader` from `RunDetail` closes a cycle — `RunDetail → RunShell → RunHeader → RunDetail`. ES modules will often tolerate that and it is still a trap laid for whoever adds the next import.

`format.ts` is where it belongs anyway, and that module's own docstring makes the argument: it exists because the run list and the run page each held a byte-identical private copy of the start-time formatter, and "two copies of a rule that must not drift is the setup for the drift, not a defence against it." `formatDuration` is the same rule in the same position — its `Math.round`-not-`floor` reasoning and its dash-for-null branch must not be re-derived.

Keep `data-testid="run-duration"`, `"run-status"` and `"run-verdict"` on the same values they carry today; `run-detail.spec.ts` asserts all three.

- [ ] **Step 5b: Write its test**

`apps/web/test/RunHeader.test.tsx` covers the four null branches, using the fixture's own run payload as the base and overriding one field per case:

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunResponse } from '@perfportal/contracts';
import RunHeader from '../src/routes/RunHeader';

const RUN: RunResponse = {
  id: 'a66548b7-2962-43ff-8b93-7149a6f2a1b8',
  status: 'complete',
  verdict: 'not_evaluated',
  tool: 'gatling',
  toolVersion: '3.15.1',
  simulation: 'example.ParitySimulation',
  description: null,
  durationMs: 63161,
  startedAt: '2026-08-14T10:43:49.546Z',
  toolStartedAt: '2026-08-07T05:30:02.171Z',
  assertions: [],
};

describe('RunHeader', () => {
  it('names the run by its fully-qualified simulation', () => {
    render(<RunHeader run={RUN} peakUsers={42} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('example.ParitySimulation');
  });

  it('falls back to the short id when the tool reported no simulation', () => {
    render(<RunHeader run={{ ...RUN, simulation: null }} peakUsers={null} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Run a66548b7');
  });

  /** Zero is a measurement; a run with no user buckets had none taken. */
  it('omits peak users entirely when there are none', () => {
    render(<RunHeader run={RUN} peakUsers={null} />);
    expect(screen.queryByText(/peak users/)).toBeNull();
  });

  it('says the start is ingest time when the tool reported none', () => {
    render(<RunHeader run={{ ...RUN, toolStartedAt: null }} peakUsers={null} />);
    expect(screen.getByText(/ingest time/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Render it in `RunShell`**

`RunShell` fetches `usersQuery(run.id)` for the peak, passes it to `RunHeader`, and renders the header above `RunTabs`.

Note in a comment that this is the one fetch Overview makes whose only consumer there is a line of header text — the charts that pay for it properly live one tab away, it is cached and shared, and the honest alternative if it ever matters is to drop the line rather than make the header flicker a value in.

- [ ] **Step 7: Assert the header in e2e**

```ts
test('the header states the run’s identity and its own peak', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('example.ParitySimulation');

  // Computed from the payload the page itself fetched, never written down —
  // a re-captured fixture moves both sides together.
  const users = await apiJson<{ total: { maxConcurrent: number }[] }>(
    page,
    `/v1/runs/${runId}/users`,
  );
  const peak = Math.max(...users.total.map((b) => b.maxConcurrent));
  await expect(page.getByText(`${peak.toLocaleString()} peak users`)).toBeVisible();

  // Chromium, not jsdom: dom-accessibility-api does not consult a
  // descendant's aria-hidden the way a real AT tree does, so a badge whose
  // glyph leaks into its name passes every unit assertion and fails here.
  await expect(page.getByTestId('run-status')).toHaveAccessibleName('complete');
});
```

`apiJson` already exists **twice** — `run-charts.spec.ts:123` and `group-detail.spec.ts:34`, byte-identical. Do not write a third. Move it to `apps/web/e2e/helpers.ts`, import it in all three specs, and delete both local copies. That is a small cleanup this task earns the right to do because it is the third caller; it is not scope creep, and leaving it would make the duplication the convention.

- [ ] **Step 8: Full gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
pnpm test:integration
pnpm build && pnpm test:e2e
git add apps/web/src apps/web/test apps/web/e2e
git commit -m "feat(web): a run says what it is before it says how it went"
```

---

## Final verification

- [ ] Full gate from a clean build:

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

- [ ] Look at it in a browser, in both themes, on all three tabs.
- [ ] Confirm `/runs/:runId/requests/:name` and `/runs/:runId/groups/:name` still render with no run shell — spec §9-1, re-checked at the end as well as the start.
- [ ] Confirm the spec's §10 criteria, item by item.
- [ ] One PR to `main`. Merge with `--merge`, never squash.
