# Summary and Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the run page's Overview · Charts · Load generators · Errors tabs with Gatling Enterprise's Summary (always the whole run) and Report (time window plus collapsible sections), as the spec describes.

**Architecture:** Front-end only — no API, contract or database change. Two new route components (`RunSummary`, `RunReport`) replace four tab components in `RunDetail.tsx`; one shared `CollapsibleSection` (a heading holding a button, closed content unmounted) serves both the Report's five sections and the Summary's two assertion bars. `RunShell` keeps the tab strip in one place and renders the lifecycle strip and verdict band only on the Summary's path and the time window only on the Report's. Old tab URLs redirect.

**Tech Stack:** React 19, React Router 7, TanStack Query 5, ECharts via `apps/web/src/charts/Chart.tsx`, Tailwind 4, Vitest (two projects: node + jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-01-summary-report-design.md` (d63db98, Virtual users order corrected in the commit that adds this plan).

## Global Constraints

- Work in `/Users/rabindrabiswal/Workspace/perf-dashboard-summary` on `feat/summary-report`. Run `source ~/.nvm/nvm.sh && nvm use` before any `pnpm` command (Node 22; on Node 20 every jsdom file silently fails to load).
- One unit file: `pnpm exec vitest run <path-from-worktree-root>`. Gates: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` — each redirected to a file and judged by its OWN exit code (`cmd > /tmp/x.txt 2>&1; echo "exit=$?"`), never through a pipe.
- Never run `prettier` (the repo has no formatter; `eslint` is the only style gate). Never `git add -A` — name the paths. Commit with `git commit -F -` and a quoted heredoc (`<<'MSG'`). No attribution lines in commits.
- RED-VERIFY every new test: commit a checkpoint first, apply ONE mutation with a scripted replacement whose match count is asserted to be exactly 1, run the file, confirm the named case fails for the named reason, restore with `git checkout HEAD -- <file>`. Commit again after any material change before the next mutation.
- No workspace package changes, so no `dist` rebuilds. No new dependency.
- Comment style: this codebase argues each non-obvious decision in a short comment where the next reader will be. Do that for every decision the plan calls out; do not restate code.
- Exact strings, copied from the spec:
  - Tabs, in order: `Summary`, `Report`, `Logs` (runner runs only), `Trends`, `Compare`.
  - Paths: Summary `/runs/:id`, Report `/runs/:id/report`. Redirects: `/charts` → `/report`; `/load-generators` → `/report#load-generators`; `/errors` → `/runs/:id#errors`; every query parameter kept.
  - Report sections (id / title / open by default): `requests` / `Requests` / open; `groups` / `Groups`; `virtual-users` / `Virtual users`; `connections` / `Connections`; `load-generators` / `Load generators`.
  - Summary bars (id / title): `platform-gates` / `Platform gates`; `simulation-assertions` / `Simulation assertions`.
  - New charts (id / title): `requests-and-responses` / `Requests and responses per second over time` (lines `Requests`, `Total`, `Responses OK`, `Responses KO`, y-axis `Count/s`); `user-end-rate` / `Users ended per second`.
  - Headline tiles, in order: `Error rate` (`stat-error-rate`), `Requests` (`stat-total-requests`), `Peak users` (`stat-peak-users`), `p95` (`stat-p95`). Live: `Error rate`, `Requests so far`, `Peak users`, `p95` with `live-stat-*` ids.
  - Heading outlines: Summary `Platform gates · Simulation assertions · Over time · Errors` (Over time visually hidden). Report `Time window · Requests · Groups · Virtual users · Connections · Load generators` (Time window visually hidden), chart titles and the Statistics heading one level below their section.
  - Gates wording, verbatim from `RunDecisionBand`: `not reported yet`; `not evaluated — the run left nothing to judge`; `not configured — no SLA rule judged this run`.
  - Groups empty state: `This run has no groups.`
- The Summary never sends a window: every query it makes passes `null`.

## Review Focus

Failure modes the spec implies that no task's happy-path test reaches, each pinned by a test in the task named:

1. **A run ingested before per-bucket histograms (`windowable: false`) opened on the Report** — sections render, no time window is offered, nothing errors. (Task 6, RunShell test.)
2. **An incomplete run that retained nothing opened on the Summary** — the tiles say statistics were not retained (not a blank), and the Platform gates bar says `not evaluated — the run left nothing to judge`. (Task 5.)
3. **A phone** — the Summary mounts no full chart (the sparklines stand in), and every Report chart section sits behind its own desktop-only gate. (Tasks 3 and 5.)
4. **A fragment naming no section** (`/report#nope`) — nothing opens, nothing breaks, Requests is still open. (Task 1.)
5. **An old `/errors?request=Place%20Order` link** — lands on the Summary's errors section with the filter still applied. (Task 3 redirect test, Task 7 browser.)

## File map

| File | Change | Responsibility |
|---|---|---|
| `apps/web/src/components/SectionHeading.tsx` | modify | `level?: 2 \| 3` |
| `apps/web/src/routes/fragment.ts` | create | `FRAGMENT_SCROLL_MARGIN`, moved from `RunDetail.tsx` |
| `apps/web/src/components/CollapsibleSection.tsx` | create | heading-holding-a-button section, closed content unmounted, opened by a matching URL fragment |
| `apps/web/src/charts/crosshair.ts` | create | `RUN_TIME_GROUP` — the one crosshair group string both pages use |
| `apps/web/src/charts/transforms/rates.ts` | modify | `toRequestsAndResponses`, `REQUESTS_AND_RESPONSES_ROLES` |
| `apps/web/src/charts/transforms/users.ts` | modify | `toUserEndRate` |
| `apps/web/src/charts/RatesChart.tsx` | modify | `RequestsAndResponsesChart` |
| `apps/web/src/charts/UsersChart.tsx` | modify | `UserEndRateChart` |
| `apps/web/src/charts/TelemetryCharts.tsx` | modify | `only` filter, no section/heading of its own |
| `apps/web/src/routes/RunTelemetry.tsx` | modify | a section BODY taking `only`, no longer a route |
| `apps/web/src/routes/payload.tsx` | modify | `TableSection` `headingLevel` |
| `apps/web/src/tables/StatisticsTable.tsx` | modify | `headingLevel`; exported `StatisticsEmpty`; Cnt/s hint re-pointed |
| `apps/web/src/routes/GroupsList.tsx` | create | `groupRows` + the Groups table |
| `apps/web/src/routes/RunSectionRedirect.tsx` | create | old tab URL → new place, query kept |
| `apps/web/src/routes/RunReport.tsx` | create | the Report page |
| `apps/web/src/routes/AssertionBars.tsx` | create | `PlatformGatesBar`, `SimulationAssertionsBar` |
| `apps/web/src/routes/RunSummary.tsx` | create | the Summary page, `LiveSummary`, `Sparklines`, errors section |
| `apps/web/src/routes/runSlots.ts` | create (Task 5) | the two chart `Slot`s both pages draw, one spelling of each title |
| `apps/web/src/routes/RunStats.tsx` | modify | four tiles, `peakUsers`, `runStatus`; `windowed` removed |
| `apps/web/src/routes/RunDetail.tsx` | modify | the four tab components and their helpers removed |
| `apps/web/src/routes/useRunWindow.ts` | modify | `useWholeRunDomainFromShell` |
| `apps/web/src/routes/RunShell.tsx` | modify | tabs before the bands; bands on Summary only; window on Report only; error-count query gone |
| `apps/web/src/routes/RunHeader.tsx` | modify | Peak users chip removed |
| `apps/web/src/routes/RunTabs.tsx` | modify | the five tabs |
| `apps/web/src/components/icons.tsx` | modify | `SummaryTabIcon`, `ReportTabIcon` |
| `apps/web/src/routes/paths.ts` | modify | `runReportPath`; three old helpers removed |
| `apps/web/src/charts/TimeBrush.tsx` | modify | always open; hidden `Time window` heading |
| `apps/web/src/routes/RunSectionNotFound.tsx` | modify | "Back to the summary" |
| `apps/web/src/routes/RunGlossary.tsx` | modify | the Cnt/s entry's prose |
| `apps/web/src/App.tsx` | modify | routes |
| `apps/web/e2e/*` | modify / create | Task 7 |

---

### Task 1: The collapsible section, and a heading that can sit one level down

**Files:**
- Modify: `apps/web/src/components/SectionHeading.tsx`
- Create: `apps/web/src/routes/fragment.ts`
- Modify: `apps/web/src/routes/RunDetail.tsx` (import `FRAGMENT_SCROLL_MARGIN` from `./fragment` instead of declaring it)
- Create: `apps/web/src/components/CollapsibleSection.tsx`
- Test: `apps/web/test/CollapsibleSection.test.tsx`

**Interfaces:**
- Produces: `SectionHeading` accepts `level?: 2 | 3` (default `2`). `FRAGMENT_SCROLL_MARGIN: string` from `apps/web/src/routes/fragment.ts`. `CollapsibleSection` default export with props `{ id: string; title: string; defaultOpen?: boolean; summary?: ReactNode; actions?: ReactNode; children: () => ReactNode }`. The section element carries `id={id}` and `data-testid={\`section-${id}\`}`; its heading's id is `${id}-heading`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/CollapsibleSection.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CollapsibleSection from '../src/components/CollapsibleSection';
import SectionHeading from '../src/components/SectionHeading';

afterEach(cleanup);

/**
 * GE's report sections and assertion bars, measured: they open and close
 * independently, start with only Requests open, and remember nothing. What GE
 * does NOT do and this does: a real heading holding a real button, and a
 * closed section that builds nothing — its queries never run and its charts
 * are never drawn into a hidden box.
 */
function renderAt(url: string, ui: React.ReactNode) {
  return render(<MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>);
}

describe('CollapsibleSection', () => {
  it('starts shut, builds nothing, and says so to assistive technology', () => {
    const build = vi.fn(() => <p>body</p>);
    renderAt('/r', <CollapsibleSection id="groups" title="Groups">{build}</CollapsibleSection>);

    const button = screen.getByRole('button', { name: 'Groups' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    const region = document.getElementById(button.getAttribute('aria-controls')!);
    expect(region, 'aria-controls must name an element that exists').not.toBeNull();
    expect(region).not.toBeVisible();
    expect(build).not.toHaveBeenCalled();
  });

  it('opens on click, and unmounts its content again when shut', async () => {
    renderAt('/r', <CollapsibleSection id="groups" title="Groups">{() => <p>body</p>}</CollapsibleSection>);
    const button = screen.getByRole('button', { name: 'Groups' });

    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('body')).toBeVisible();

    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('body')).toBeNull();
  });

  it('opens on arrival when asked to', () => {
    renderAt('/r', <CollapsibleSection id="requests" title="Requests" defaultOpen>{() => <p>body</p>}</CollapsibleSection>);
    expect(screen.getByRole('button', { name: 'Requests' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('body')).toBeVisible();
  });

  it('opens independently of its neighbours, as GE’s sections do', async () => {
    renderAt(
      '/r',
      <>
        <CollapsibleSection id="requests" title="Requests" defaultOpen>{() => <p>a</p>}</CollapsibleSection>
        <CollapsibleSection id="groups" title="Groups">{() => <p>b</p>}</CollapsibleSection>
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Groups' }));
    expect(screen.getByRole('button', { name: 'Requests' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Groups' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens when the URL’s fragment names it', () => {
    renderAt('/r#load-generators', <CollapsibleSection id="load-generators" title="Load generators">{() => <p>body</p>}</CollapsibleSection>);
    expect(screen.getByRole('button', { name: 'Load generators' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('ignores a fragment naming some other section, or none at all', () => {
    renderAt(
      '/r#nope',
      <>
        <CollapsibleSection id="requests" title="Requests" defaultOpen>{() => <p>a</p>}</CollapsibleSection>
        <CollapsibleSection id="groups" title="Groups">{() => <p>b</p>}</CollapsibleSection>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Requests' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Groups' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps its heading exactly its title, with the summary and actions beside it', () => {
    renderAt(
      '/r',
      <CollapsibleSection id="platform-gates" title="Platform gates" summary="1 failed, 2 passed" actions={<button type="button">Export CSV</button>}>
        {() => null}
      </CollapsibleSection>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'Platform gates' });
    expect(heading.textContent?.trim()).toBe('Platform gates');
    const section = screen.getByTestId('section-platform-gates');
    expect(within(section).getByText('1 failed, 2 passed')).toBeVisible();
    expect(heading).not.toContainElement(within(section).getByRole('button', { name: 'Export CSV' }));
  });
});

describe('SectionHeading', () => {
  it('renders one level down when asked, for a heading inside a section', () => {
    render(<SectionHeading level={3}>Statistics</SectionHeading>);
    expect(screen.getByRole('heading', { level: 3, name: 'Statistics' })).toBeVisible();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run apps/web/test/CollapsibleSection.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/components/CollapsibleSection"`.

- [ ] **Step 3: Give `SectionHeading` a level**

In `apps/web/src/components/SectionHeading.tsx`, add `level` to the props (`readonly level?: 2 | 3;`, default `2`) and render the heading through one element choice used by both branches. The `<h3>` rung is 15px — the ladder `SectionHeading`'s own docstring states (20/24 → 16 → 15px):

```tsx
  const Heading = level === 3 ? 'h3' : 'h2';
  const size = level === 3 ? 'text-[0.9375rem]' : 'text-base';
```

and replace both `<h2 id={id} className="text-base font-semibold tracking-tight text-primary">` elements with `<Heading id={id} className={\`${size} font-semibold tracking-tight text-primary\`}>` (closing tag `</Heading>`). Add one sentence to the docstring: a section nested inside another section's heading takes `level={3}`, so the outline says it belongs to that section.

- [ ] **Step 4: Move the fragment margin into its own module**

Create `apps/web/src/routes/fragment.ts`, moving the constant AND its whole docstring from `RunDetail.tsx` (the block above `const FRAGMENT_SCROLL_MARGIN` at about line 692):

```ts
/** (the moved docstring, unchanged) */
export const FRAGMENT_SCROLL_MARGIN = 'calc(var(--header-height) + 2.625rem)';
```

In `RunDetail.tsx`, delete the declaration and its docstring and add `import { FRAGMENT_SCROLL_MARGIN } from './fragment';`.

- [ ] **Step 5: Write `CollapsibleSection`**

Create `apps/web/src/components/CollapsibleSection.tsx`:

```tsx
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { cn } from '../lib/cn';
import { FRAGMENT_SCROLL_MARGIN } from '../routes/fragment';
import { ChevronDownIcon } from './icons';
import SectionHeading from './SectionHeading';

/**
 * One of Gatling Enterprise's collapsible sections — the Report's Requests,
 * Groups and the rest, and the Summary's two assertion bars.
 *
 * MEASURED ON GE: sections open and close independently (opening Groups left
 * Requests open), only Requests starts open, and which are open is kept
 * nowhere — not in the URL, not across a reload. This copies that behaviour
 * and declines GE's markup, whose headers are clickable `div`s with no button
 * role and no heading: here the title is a real heading holding a real button,
 * the WAI-ARIA disclosure shape, so the outline still lists the section and a
 * keyboard reaches it.
 *
 * A CLOSED SECTION BUILDS NOTHING. `children` is a function and is called only
 * while open, so a shut Connections section runs no query and draws no chart.
 * `<details>` was declined for exactly this: it keeps closed content mounted,
 * so every chart in every closed section would fetch and lay out into a hidden
 * 0x0 box, a heading inside its `<summary>` leaves the outline, and nested
 * disclosures have already broken a WebKit case here. The REGION stays in the
 * DOM (empty and `hidden`) so `aria-controls` always names an element.
 *
 * A URL FRAGMENT NAMING THE SECTION OPENS IT — the one exception to "kept
 * nowhere", and the reason an old `/load-generators` link can land on that
 * section's content. `AppShell` already scrolls to and focuses a fragment's
 * target; the section only has to be open by then.
 *
 * `summary` and `actions` sit BESIDE the heading, never inside it: the heading
 * text is exactly `title`, which e2e specs compare verbatim. The button's
 * `::after` covers the whole row so the row is the click target, and the
 * actions sit above that layer.
 */
export default function CollapsibleSection({
  id,
  title,
  defaultOpen = false,
  summary,
  actions,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly defaultOpen?: boolean;
  readonly summary?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: () => ReactNode;
}) {
  const { hash } = useLocation();
  const named = hash === `#${id}`;
  const [open, setOpen] = useState(defaultOpen || named);
  // A later navigation to this section's fragment opens it too — the decision
  // band's link to `#simulation-assertions` lands on a page already mounted.
  useEffect(() => {
    if (named) setOpen(true);
  }, [named]);
  const regionId = useId();
  const headingId = `${id}-heading`;

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      data-testid={`section-${id}`}
      className="rounded-xl border border-default bg-surface shadow-panel"
      style={{ scrollMarginTop: FRAGMENT_SCROLL_MARGIN }}
    >
      <div className="relative flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
        <SectionHeading id={headingId}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={regionId}
            onClick={() => setOpen((was) => !was)}
            className="flex items-center gap-2 text-left after:absolute after:inset-0 after:content-['']"
          >
            {title}
            <ChevronDownIcon
              className={cn('h-4 w-4 text-muted transition-transform', open && 'rotate-180')}
            />
          </button>
        </SectionHeading>
        {summary !== undefined && <div className="text-[0.8125rem] text-muted">{summary}</div>}
        {actions !== undefined && (
          <div className="relative z-10 ml-auto flex items-center gap-2">{actions}</div>
        )}
      </div>
      <div id={regionId} hidden={!open} className="border-t border-default px-4 py-4">
        {open && children()}
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Run the test, typecheck and lint**

Run: `pnpm exec vitest run apps/web/test/CollapsibleSection.test.tsx` → PASS (8 tests).
Run: `pnpm typecheck > /tmp/t1-tc.txt 2>&1; echo "exit=$?"` → `exit=0`; `pnpm lint > /tmp/t1-lint.txt 2>&1; echo "exit=$?"` → `exit=0`.

- [ ] **Step 7: Commit the checkpoint**

```bash
git add apps/web/src/components/SectionHeading.tsx apps/web/src/routes/fragment.ts apps/web/src/routes/RunDetail.tsx apps/web/src/components/CollapsibleSection.tsx apps/web/test/CollapsibleSection.test.tsx
git commit -q -F - <<'MSG'
Add the collapsible section GE's Report and assertion bars are built from

A heading holding a button, opened independently of its neighbours, its
closed content never built, and opened by a URL fragment naming it. GE's
behaviour, measured; its markup declined for a real heading and button.
SectionHeading gains a level so a heading inside a section can sit under it.
MSG
```

- [ ] **Step 8: Red-verify, one mutation at a time, restoring after each**

| Mutation (in `CollapsibleSection.tsx`) | Must fail |
|---|---|
| `{open && children()}` → `{children()}` | "starts shut, builds nothing…" (`build` called) |
| delete the `aria-expanded={open}` line | "starts shut…" and "opens on click…" on `aria-expanded` |
| `useState(defaultOpen \|\| named)` → `useState(defaultOpen)` | "opens when the URL’s fragment names it" |
| add `let shut: (() => void) \| null = null;` at module level and change the button's `onClick` to `() => { shut?.(); shut = () => setOpen(false); setOpen((was) => !was); }` | "opens independently of its neighbours" |
| move `{summary}`'s `<div>` inside `<SectionHeading>` after the button | "keeps its heading exactly its title…" |

Restore after each: `git checkout HEAD -- apps/web/src/components/CollapsibleSection.tsx`, then re-run the file green.

---

### Task 2: GE's combined rate chart, and users ended per second

**Files:**
- Create: `apps/web/src/charts/crosshair.ts`
- Modify: `apps/web/src/charts/transforms/rates.ts`, `apps/web/src/charts/transforms/users.ts`
- Modify: `apps/web/src/charts/RatesChart.tsx`, `apps/web/src/charts/UsersChart.tsx`
- Test: `apps/web/test/transforms.rates.test.ts`, `apps/web/test/transforms.users.test.ts`, `apps/web/test/RatesChart.combined.test.tsx` (new)

**Interfaces:**
- Produces: `RUN_TIME_GROUP = 'run-time'` (`charts/crosshair.ts`); `toRequestsAndResponses(series: SeriesResponse): ChartData`; `REQUESTS_AND_RESPONSES_ROLES: readonly StatusRole[]`; `toUserEndRate(u: UsersResponse, opts?: { x?: 'index' | 'ms' }): ChartData`; `<RequestsAndResponsesChart series domainMs? warmupMs? />` (chart id `requests-and-responses`); `<UserEndRateChart users group? domainMs? warmupMs? />` (chart id `user-end-rate`).

- [ ] **Step 1: Write the failing transform tests**

Append to `apps/web/test/transforms.rates.test.ts` (it already imports `fixture` and `SeriesResponse`; add `toRequestsAndResponses` to the import from `../src/charts/transforms/rates`):

```ts
describe('toRequestsAndResponses — GE’s "Requests and Responses per Second"', () => {
  const series = fixture.series as SeriesResponse;
  const perSecond = series.bucketWidthMs / 1000;

  it('draws GE’s four lines, in GE’s order', () => {
    expect(toRequestsAndResponses(series).series.map((s) => s.name)).toEqual([
      'Requests',
      'Total',
      'Responses OK',
      'Responses KO',
    ]);
  });

  it('reads each line off its own counter, per second, at the bucket’s offset', () => {
    const data = toRequestsAndResponses(series);
    const counters = ['startedCount', 'endedCount', 'okCount', 'koCount'] as const;
    counters.forEach((counter, s) => {
      expect(data.series[s]!.data).toEqual(
        series.buckets.map((b) => [b.startOffsetMs, b[counter] / perSecond]),
      );
    });
  });

  it('splits the RESPONSES by outcome, never the requests as they started', () => {
    // One bucket where the two edges disagree, so reading the start-edge split
    // cannot pass: 4 requests started (all OK as they began), 3 finished — 1 OK, 2 KO.
    const disagreeing: SeriesResponse = {
      ...series,
      bucketWidthMs: 1000,
      buckets: [{ ...series.buckets[0]!, startOffsetMs: 0, startedCount: 4, startedOkCount: 4, startedKoCount: 0, endedCount: 3, okCount: 1, koCount: 2 }],
    };
    const [, total, ok, ko] = toRequestsAndResponses(disagreeing).series;
    expect(total!.data).toEqual([[0, 3]]);
    expect(ok!.data).toEqual([[0, 1]]);
    expect(ko!.data).toEqual([[0, 2]]);
  });

  it('divides by the payload’s own bucket width', () => {
    const wide: SeriesResponse = {
      ...series,
      bucketWidthMs: 2000,
      buckets: [{ ...series.buckets[0]!, startOffsetMs: 0, startedCount: 8, endedCount: 6, okCount: 6, koCount: 0 }],
    };
    expect(toRequestsAndResponses(wide).series[0]!.data).toEqual([[0, 4]]);
  });

  it('says there is nothing to draw rather than drawing flat lines', () => {
    const data = toRequestsAndResponses({ ...series, buckets: [] });
    expect(data.series).toEqual([]);
    expect(data.empty).toMatch(/no requests were recorded/i);
  });
});
```

Append to `apps/web/test/transforms.users.test.ts` (add `toUserEndRate` to its import):

```ts
describe('toUserEndRate — GE’s "Users Termination Rate"', () => {
  const users = fixture.users as UsersResponse;

  it('has a bucket where users started and ended differently, or this proves nothing', () => {
    expect(users.total.some((b) => b.started !== b.ended)).toBe(true);
  });

  it('plots users ENDED per second, totalled across scenarios', () => {
    const data = toUserEndRate(users, { x: 'ms' });
    const total = data.series.find((s) => s.name === 'All users');
    const widthS = (users.total[1]!.startOffsetMs - users.total[0]!.startOffsetMs) / 1000;
    expect(total!.data).toEqual(users.total.map((b) => [b.startOffsetMs, b.ended / widthS]));
  });
});
```

Before writing it, confirm the total series' name in `users.ts` (`ALL_USERS`) and use that exact string in place of `'All users'` if it differs.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/web/test/transforms.rates.test.ts apps/web/test/transforms.users.test.ts`
Expected: FAIL — `toRequestsAndResponses is not a function` / `toUserEndRate is not a function`.

- [ ] **Step 3: Write the transforms**

In `rates.ts`, after `toResponseRate`, add (and update the module docstring's "WHY THESE ARE TWO CHARTS AND NOT ONE" paragraph with one sentence: GE's own Summary and Report draw both edges on ONE chart, and the divergence §13.2 ⑪ wants is just as visible between two lines on one axis — so the run page now draws GE's combined chart, and the two single-edge charts remain for the request and group pages):

```ts
/**
 * GE's "Requests and Responses per Second", measured on its Summary and its
 * Report: four lines on one axis — requests STARTED, responses ENDED, and the
 * responses split by outcome.
 *
 * THE OUTCOME SPLIT IS THE END EDGE'S. `okCount`/`koCount` count responses as
 * they finish, so OK + KO is the Total line in every bucket; the start-edge
 * split (`startedOkCount`/`startedKoCount`) would put a request's outcome in
 * the second it began, which is a different chart and the one GE does not draw.
 */
export const REQUESTS_AND_RESPONSES_ROLES: readonly StatusRole[] = [
  'neutral',
  // GE draws Total in orange. The amber status token is the nearest the
  // palette has, and no line on this chart is an outcome that could be
  // "pending" — the legend names every line.
  'pending',
  'passed',
  'failed',
];

const COMBINED_LINES = ['Requests', 'Total', 'Responses OK', 'Responses KO'] as const;

export function toRequestsAndResponses(series: SeriesResponse): ChartData {
  const columns = [TIME_COLUMN, ...COMBINED_LINES];
  if (series.buckets.length === 0) {
    return {
      series: [],
      axisLabels: [],
      columns,
      rows: [],
      empty: 'No requests were recorded for this run, so there are no request or response rates to show.',
    };
  }
  // The payload's own width — see `rateChart`'s divisor note.
  const perSecond = series.bucketWidthMs / 1000;
  const measured: readonly (readonly number[])[] = [
    series.buckets.map((b) => b.startedCount / perSecond),
    series.buckets.map((b) => b.endedCount / perSecond),
    series.buckets.map((b) => b.okCount / perSecond),
    series.buckets.map((b) => b.koCount / perSecond),
  ];
  return {
    series: COMBINED_LINES.map((name, s) => ({
      name,
      data: series.buckets.map((b, i) => [b.startOffsetMs, measured[s]![i]!] as [number, number]),
    })),
    // Pairs on a value axis carry their own x, so there are no category labels.
    axisLabels: [],
    columns,
    rows: series.buckets.map((b, i) => ({
      label: String(b.startOffsetMs / 1000),
      values: measured.map((line) => line[i]!),
    })),
    limitation:
      series.bucketWidthMs === 1000
        ? undefined
        : widthNote(series.bucketWidthMs, 'requests and responses were counted'),
  };
}
```

In `users.ts`, after `toUserStartRate`, add — widening the spec's `measure` field type to include `'ended'` if it does not already:

```ts
/**
 * GE's "Users Termination Rate" — users ENDED per second, the twin of
 * `toUserStartRate`. Read off the same bucket's `ended` count the users
 * payload has always carried, live and finished.
 */
export function toUserEndRate(
  u: UsersResponse,
  opts: { readonly x?: 'index' | 'ms' } = {},
): ChartData {
  return usersChart(u, {
    measure: 'ended',
    perSecond: true,
    empty: 'No user activity was recorded for this run, so there is no termination rate to show.',
  }, opts);
}
```

- [ ] **Step 4: Write the crosshair constant and the two chart components**

Create `apps/web/src/charts/crosshair.ts`:

```ts
/**
 * THE ONE CROSSHAIR. Every chart whose x-axis is elapsed time carries this
 * `group`, and `Chart` calls `echarts.connect` with it, so hovering one moves
 * the pointer on all of them — the "read these together" affordance §22.4's
 * ban on dual axes would otherwise cost (PRD Appendix A). Both run pages draw
 * time charts now, so the string lives here rather than in either.
 */
export const RUN_TIME_GROUP = 'run-time';
```

In `RatesChart.tsx`, import `REQUESTS_AND_RESPONSES_ROLES, toRequestsAndResponses` and add:

```tsx
/** GE's combined chart — see `toRequestsAndResponses`. `Count/s` is GE's own
 *  axis name for it: the four lines are not all requests. */
export function RequestsAndResponsesChart({
  series,
  domainMs,
  warmupMs,
}: {
  readonly series: SeriesResponse;
  readonly domainMs?: TimeDomainMs;
  readonly warmupMs?: number;
}) {
  const data = useMemo(() => toRequestsAndResponses(series), [series]);
  return (
    <Chart
      id="requests-and-responses"
      title="Requests and responses per second over time"
      data={data}
      kind="line"
      roles={REQUESTS_AND_RESPONSES_ROLES}
      yAxis={{ name: 'Count/s' }}
      pairValue="y"
      xAxis={{ type: 'value', tickUnit: 'ms-as-s', min: domainMs?.[0], max: domainMs?.[1], warmupMs }}
      unit="/s"
      group={RUN_TIME_GROUP}
    />
  );
}
```

In `UsersChart.tsx`, import `toUserEndRate` and add, modelled exactly on `UserStartRateChart`:

```tsx
/** GE's "Users Termination Rate". Plots `ended` per second; see `toUserEndRate`. */
export function UserEndRateChart({ users, group, domainMs, warmupMs }: UsersChartProps) {
  const data = useMemo(() => toUserEndRate(users, { x: 'ms' }), [users]);
  return (
    <Chart
      id="user-end-rate"
      title="Users ended per second"
      data={data}
      group={group}
      yAxis={{ name: 'Users/s' }}
      pairValue="y"
      xAxis={{ type: 'value', tickUnit: 'ms-as-s', min: domainMs?.[0], max: domainMs?.[1], warmupMs }}
      unit="users/s"
    />
  );
}
```

- [ ] **Step 5: Write the colour test**

`roles` is silently optional on `Chart`, and a chart that forgets it draws KO in a categorical hue (CLAUDE.md, "Sharing a transform does NOT share its colours"). Create `apps/web/test/RatesChart.combined.test.tsx`, copying the technique `apps/web/test/TimeBrush.test.tsx` uses to read the `color` array the component hands ECharts (its "draws in the status colours" case), and assert:

```ts
it('draws Responses KO in the failed status colour and OK in the passed one', () => {
  // render <RequestsAndResponsesChart series={fixture.series as SeriesResponse} />,
  // read the emitted option's `color` array as TimeBrush.test.tsx does, then:
  expect(colors[2]).toBe(STATUS_COLORS.light.passed);
  expect(colors[3]).toBe(STATUS_COLORS.light.failed);
  expect(colors).not.toContain(CATEGORICAL.light[0]);
});
```

using the same imports (`STATUS_COLORS`, the categorical palette constant) and the same mode setup that file uses. If `TimeBrush.test.tsx` names the categorical constant differently, use its name.

- [ ] **Step 6: Run the three files, typecheck and lint**

Run: `pnpm exec vitest run apps/web/test/transforms.rates.test.ts apps/web/test/transforms.users.test.ts apps/web/test/RatesChart.combined.test.tsx` → PASS. Also run `apps/web/test/timeAxis.test.ts` (its per-file `tickUnit` pairing guard must still pass). `pnpm typecheck` and `pnpm lint` → `exit=0`.

- [ ] **Step 7: Commit the checkpoint**

```bash
git add apps/web/src/charts/crosshair.ts apps/web/src/charts/transforms/rates.ts apps/web/src/charts/transforms/users.ts apps/web/src/charts/RatesChart.tsx apps/web/src/charts/UsersChart.tsx apps/web/test/transforms.rates.test.ts apps/web/test/transforms.users.test.ts apps/web/test/RatesChart.combined.test.tsx
git commit -q -F - <<'MSG'
Draw GE's combined requests-and-responses chart and users ended per second

Both from data the API already serves: the series bucket's four counters
(requests started, responses ended, and the responses' own OK/KO split), and
the users bucket's ended count. No backend change.
MSG
```

- [ ] **Step 8: Red-verify**

| Mutation | Must fail |
|---|---|
| in `toRequestsAndResponses`, `b.okCount` → `(b.startedOkCount ?? 0)` | "splits the RESPONSES by outcome…" |
| `series.bucketWidthMs / 1000` → `1` in `toRequestsAndResponses` | "divides by the payload’s own bucket width" |
| `measure: 'ended'` → `measure: 'started'` in `toUserEndRate` | "plots users ENDED per second…" |
| delete `roles={REQUESTS_AND_RESPONSES_ROLES}` | the colour case |

---

### Task 3: The Report page, its redirects, and the Groups list

**Files:**
- Modify: `apps/web/src/routes/paths.ts` (add `runReportPath`)
- Create: `apps/web/src/routes/RunSectionRedirect.tsx`
- Create: `apps/web/src/routes/GroupsList.tsx`
- Modify: `apps/web/src/routes/payload.tsx` (`TableSection` `headingLevel`)
- Modify: `apps/web/src/tables/StatisticsTable.tsx` (`headingLevel`)
- Modify: `apps/web/src/charts/TelemetryCharts.tsx`, `apps/web/src/routes/RunTelemetry.tsx` (`only`)
- Create: `apps/web/src/routes/RunReport.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/routes/RunDetail.tsx` (delete `RunChartsTab`, `ChartGroup`, the chart `Slot` constants and the `RUN_TIME` constant; import `RUN_TIME_GROUP` wherever `RUN_TIME` is still read)
- Test: `apps/web/test/RunReport.test.tsx` (new), `apps/web/test/groupRows.test.ts` (new), `apps/web/test/RunSectionRedirect.test.tsx` (new); `apps/web/test/RunChartsTab.live.test.tsx` → rename to `apps/web/test/RunReport.live.test.tsx` and re-point; `apps/web/test/RunTelemetry.test.tsx` (re-point)

**Interfaces:**
- Consumes: `CollapsibleSection` (Task 1); `RequestsAndResponsesChart`, `UserEndRateChart`, `RUN_TIME_GROUP` (Task 2).
- Produces: `runReportPath(runId: string): string` = `${runPath(runId)}/report`. `RunSectionRedirect` default export, props `{ to: 'summary' | 'report'; hash?: string }`. `groupRows(stats: StatsResponse): readonly GroupRow[]` with `GroupRow = { name: string; count: number; okCount: number; koCount: number; cumulatedP95: number | null; durationP95: number | null }`. `RunReport` default export (route component). `TableSection` and `StatisticsTable` accept `headingLevel?: 2 | 3`. `RunTelemetry` default export with props `{ only: readonly TelemetryChartId[] }`; `TelemetryCharts` takes `only`; `TelemetryChartId` exported from `TelemetryCharts.tsx` = `'telemetry-cpu' | 'telemetry-memory' | 'telemetry-bandwidth' | 'telemetry-connection-events' | 'telemetry-segment-events' | 'telemetry-tcp-states'`.

- [ ] **Step 1: Write the failing pure test for the Groups rows**

Create `apps/web/test/groupRows.test.ts`:

```ts
import type { StatsResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { groupRows } from '../src/routes/GroupsList';
import reference from './fixtures/reference-run.json';

const stats = reference.stats as StatsResponse;

describe('groupRows', () => {
  it('is one row per group, joining its cumulated and its wall-clock row', () => {
    const rows = groupRows(stats);
    expect(rows.map((r) => r.name)).toEqual(['Cart', 'Catalog', 'Catalog/Recommendations']);
    for (const row of rows) {
      const cumulated = stats.stats.find((s) => s.scope === 'group' && s.name === row.name && s.family === 'group_cumulated')!;
      const duration = stats.stats.find((s) => s.scope === 'group' && s.name === row.name && s.family === 'group_duration')!;
      expect(row.count).toBe(cumulated.count);
      expect(row.okCount).toBe(cumulated.okCount);
      expect(row.koCount).toBe(cumulated.koCount);
      expect(row.cumulatedP95).toBe(Math.min(Math.max(cumulated.percentiles.p95!, cumulated.minMs), cumulated.maxMs));
      expect(row.durationP95).toBe(Math.min(Math.max(duration.percentiles.p95!, duration.minMs), duration.maxMs));
    }
  });

  it('has none for a run with no groups', () => {
    expect(groupRows({ ...stats, stats: stats.stats.filter((s) => s.scope !== 'group') })).toEqual([]);
  });
});
```

If the fixture's group order differs from the payload's own row order, assert the payload's own order (the order the cumulated rows appear in `stats.stats`) — never a re-sorted one.

- [ ] **Step 2: Write the failing redirect test**

Create `apps/web/test/RunSectionRedirect.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import RunSectionRedirect from '../src/routes/RunSectionRedirect';

afterEach(cleanup);

function Where() {
  const { pathname, search, hash } = useLocation();
  return <p data-testid="where">{`${pathname}${search}${hash}`}</p>;
}

function landAt(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/runs/:runId" element={<Where />} />
        <Route path="/runs/:runId/report" element={<Where />} />
        <Route path="/runs/:runId/charts" element={<RunSectionRedirect to="report" />} />
        <Route path="/runs/:runId/load-generators" element={<RunSectionRedirect to="report" hash="load-generators" />} />
        <Route path="/runs/:runId/errors" element={<RunSectionRedirect to="summary" hash="errors" />} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByTestId('where').textContent;
}

describe('RunSectionRedirect — old tab URLs land on their new place', () => {
  it('sends Charts to the Report, window kept', () => {
    expect(landAt('/runs/r1/charts?from=1000&to=5000')).toBe('/runs/r1/report?from=1000&to=5000');
  });
  it('sends Load generators to the Report with that section named', () => {
    expect(landAt('/runs/r1/load-generators?from=1000&to=5000')).toBe('/runs/r1/report?from=1000&to=5000#load-generators');
  });
  it('sends Errors to the Summary’s errors section, filter kept', () => {
    expect(landAt('/runs/r1/errors?request=Place%20Order')).toBe('/runs/r1?request=Place%20Order#errors');
  });
});
```

- [ ] **Step 3: Write the failing Report test**

Create `apps/web/test/RunReport.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResponse } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import { runQueryKey } from '../src/api/run';
import RunReport from '../src/routes/RunReport';
import type { RunWindowContext } from '../src/routes/useRunWindow';
import useIsCompact from '../src/useIsCompact';

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(useIsCompact).mockReturnValue(false);
});

const RUN_ID = '00000000-0000-4000-8000-000000000001';

function readyRun(): RunResponse {
  return {
    id: RUN_ID,
    project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
    status: 'complete',
    verdict: 'passed',
    tool: 'gatling',
    toolVersion: '3.15.1',
    simulation: 'example.ParitySimulation',
    description: null,
    durationMs: 63161,
    startedAt: '2026-08-14T10:43:49.546Z',
    toolStartedAt: '2026-08-07T05:30:02.171Z',
    assertions: [],
    toolAssertions: [],
  };
}

/** Answers each endpoint from the captured fixture; anything else is a 404,
 *  which `Payload` renders as an undrawn slot — still a figure with its id. */
function stubFetch(): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const path = new URL(url, 'http://x').pathname;
    const body = path.endsWith('/users')
      ? reference.users
      : path.endsWith('/series')
        ? reference.series
        : path.endsWith('/distribution')
          ? reference.distribution
          : path.endsWith('/stats')
            ? reference.stats
            : path.endsWith('/telemetry')
              ? { runId: RUN_ID, available: false, bucketWidthMs: 1000, window: null, hosts: [] }
              : null;
    return Promise.resolve(
      body === null
        ? new Response(JSON.stringify({ status: 404, title: 'Not Found', code: 'NOT_FOUND', detail: 'stub', remediation: 'stub' }), {
            status: 404,
            headers: { 'content-type': 'application/problem+json' },
          })
        : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  });
  return seen;
}

function renderReport({
  url = `/runs/${RUN_ID}/report`,
  window = null,
}: { url?: string; window?: RunWindowContext['window'] } = {}) {
  const seen = stubFetch();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runQueryKey(RUN_ID), { state: 'ready', run: readyRun() });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/runs/:runId"
            element={<Outlet context={{ window, durationMs: 63161, liveDurationMs: null, warmupMs: null, live: null } satisfies RunWindowContext} />}
          >
            <Route path="report" element={<RunReport />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return seen;
}

const SECTIONS = ['Requests', 'Groups', 'Virtual users', 'Connections', 'Load generators'];

describe('RunReport — GE’s sections', () => {
  it('lists GE’s sections in GE’s order, with only Requests open', () => {
    renderReport();
    const h2 = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.trim());
    expect(h2).toEqual(SECTIONS);
    for (const title of SECTIONS) {
      expect(screen.getByRole('button', { name: title })).toHaveAttribute('aria-expanded', String(title === 'Requests'));
    }
  });

  it('asks for nothing a shut section would show', async () => {
    const seen = renderReport();
    await screen.findByTestId('chart-requests-and-responses');
    expect(seen.some((u) => u.includes('/users'))).toBe(false);
    expect(seen.some((u) => u.includes('/telemetry'))).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Virtual users' }));
    await waitFor(() => expect(seen.some((u) => u.includes('/users'))).toBe(true));
  });

  it('opens Requests on Charts, in GE’s order with this product’s two after', async () => {
    renderReport();
    const section = screen.getByTestId('section-requests');
    await within(section).findByTestId('chart-requests-and-responses');
    const ids = [...section.querySelectorAll('figure[data-testid^="chart-"]')].map((f) => f.getAttribute('data-testid'));
    expect(ids).toEqual([
      'chart-requests-and-responses',
      'chart-percentiles',
      'chart-distribution',
      'chart-percentile-distribution',
      'chart-errors-over-time',
      'chart-indicators',
      'chart-request-counts',
    ]);
    expect(within(section).getByRole('button', { name: 'Charts' })).toHaveAttribute('aria-pressed', 'true');
  });

  it.each(['?sort=p99&dir=desc', '?q=Search'])('opens straight on Table for a link carrying the table’s view (%s)', async (search) => {
    renderReport({ url: `/runs/${RUN_ID}/report${search}` });
    const section = screen.getByTestId('section-requests');
    expect(within(section).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    expect(await within(section).findByRole('heading', { level: 3, name: 'Statistics' })).toBeVisible();
  });

  it('narrows every Requests query to the window', async () => {
    const seen = renderReport({ window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 } });
    await screen.findByTestId('chart-requests-and-responses');
    const metric = seen.filter((u) => /\/(series|stats|distribution|errors\/series)/.test(u));
    expect(metric.length).toBeGreaterThan(3);
    for (const url of metric) expect(url).toMatch(/[?&]from=10000/);
  });

  it('lists the run’s groups, each linked to its own page', async () => {
    renderReport();
    await userEvent.click(screen.getByRole('button', { name: 'Groups' }));
    const section = screen.getByTestId('section-groups');
    const link = await within(section).findByRole('link', { name: 'Catalog/Recommendations' });
    expect(link).toHaveAttribute('href', `/runs/${RUN_ID}/groups/${encodeURIComponent('Catalog/Recommendations')}`);
  });

  it('opens the section a URL fragment names', () => {
    renderReport({ url: `/runs/${RUN_ID}/report#load-generators` });
    expect(screen.getByRole('button', { name: 'Load generators' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('withholds every chart on a phone until asked, and fetches nothing for it', async () => {
    vi.mocked(useIsCompact).mockReturnValue(true);
    const seen = renderReport();
    const section = screen.getByTestId('section-requests');
    expect(within(section).queryByTestId('chart-requests-and-responses')).toBeNull();
    expect(within(section).getByRole('button', { name: /open the charts/i })).toBeVisible();
    expect(seen.some((u) => u.includes('/series'))).toBe(false);
  });
});
```

`Window` (from `@perfportal/contracts`) is exactly `{ fromMs, toMs, bucketWidthMs }`, which is why the literal above needs no cast.

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm exec vitest run apps/web/test/groupRows.test.ts apps/web/test/RunSectionRedirect.test.tsx apps/web/test/RunReport.test.tsx`
Expected: FAIL — unresolved imports for `GroupsList`, `RunSectionRedirect`, `RunReport`.

- [ ] **Step 5: Add `runReportPath`**

In `paths.ts`, after `runPath`:

```ts
/** GE's Report — the time window and the run's charts, in collapsible sections. */
export function runReportPath(runId: string): string {
  return `${runPath(runId)}/report`;
}
```

- [ ] **Step 6: Write `RunSectionRedirect`**

Create `apps/web/src/routes/RunSectionRedirect.tsx`:

```tsx
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { runPath, runReportPath } from './paths';

/**
 * An old run tab's URL, sent to where its content lives now (backlog #7).
 *
 * EVERY QUERY PARAMETER TRAVELS. A link pasted into a ticket carries the
 * window it was looking at (`from`/`to`) or the request it narrowed to
 * (`request`), and dropping either lands the reader somewhere that looks
 * right and answers a different question. `replace`, so Back does not bounce
 * the reader into the redirect again.
 *
 * The fragment is how a section is named — `CollapsibleSection` opens the one
 * a fragment matches, and `AppShell` scrolls to it.
 */
export default function RunSectionRedirect({
  to,
  hash,
}: {
  readonly to: 'summary' | 'report';
  readonly hash?: string;
}) {
  const { runId } = useParams<{ runId: string }>();
  const { search } = useLocation();
  if (runId === undefined) return null;
  const base = to === 'report' ? runReportPath(runId) : runPath(runId);
  return <Navigate replace to={`${base}${search}${hash === undefined ? '' : `#${hash}`}`} />;
}
```

- [ ] **Step 7: Write `GroupsList`**

Create `apps/web/src/routes/GroupsList.tsx`:

```tsx
import { Link } from 'react-router-dom';
import type { StatsResponse } from '@perfportal/contracts';
import TableFrame from '../components/TableFrame';
import { ROW, TABLE, TD, TD_NUM, TH, THEAD } from '../components/tableStyles';
import { clampPercentile } from '../percentile';
import { formatCount, formatMs } from '../tables/StatisticsTable';

export interface GroupRow {
  readonly name: string;
  readonly count: number;
  readonly okCount: number;
  readonly koCount: number;
  /** The p95 of the group's summed request time (`group_cumulated`). */
  readonly cumulatedP95: number | null;
  /** The p95 of the group's wall-clock span (`group_duration`). */
  readonly durationP95: number | null;
}

/**
 * One row per group, in the payload's own order. The engine files each group
 * twice — under `group_cumulated` and `group_duration`, the pair the PRD's
 * GR-01/GR-02 name — and this joins them by name. Counts come from the
 * cumulated row; both rows count the same executions.
 *
 * Each p95 is projected onto its own row's measured range, the rule
 * `clampPercentile` states: a percentile outside its own min and max is an
 * estimate that escaped, and the statistics table already shows the clamped one.
 */
export function groupRows(stats: StatsResponse): readonly GroupRow[] {
  const p95 = (family: 'group_cumulated' | 'group_duration', name: string): number | null => {
    const row = stats.stats.find((s) => s.scope === 'group' && s.family === family && s.name === name);
    const value = row?.percentiles.p95;
    return row === undefined || value === undefined ? null : clampPercentile(value, row);
  };
  return stats.stats
    .filter((s) => s.scope === 'group' && s.family === 'group_cumulated')
    .map((s) => ({
      name: s.name,
      count: s.count,
      okCount: s.okCount,
      koCount: s.koCount,
      cumulatedP95: p95('group_cumulated', s.name),
      durationP95: p95('group_duration', s.name),
    }));
}

/* No "statistics", "errors" or "request" in this caption: a caption is a
   table's accessible name, Playwright matches names as a case-insensitive
   substring, and the e2e suite reaches three other tables by those words. */
const CAPTION = 'Every group this run recorded, with the p95 of its summed time and of its wall-clock span.';

/**
 * The Report's Groups section — this product's own design, because GE's
 * populated Groups section could not be measured (neither run in the account
 * has a group). Each name links to its existing group page, which holds the
 * group's charts.
 */
export default function GroupsList({
  runId,
  stats,
}: {
  readonly runId: string;
  readonly stats: StatsResponse;
}) {
  const rows = groupRows(stats);
  if (rows.length === 0) {
    return <p className="text-[0.8125rem] text-muted">This run has no groups.</p>;
  }
  const ms = (value: number | null) => (value === null ? '—' : `${formatMs(value)} ms`);
  return (
    <TableFrame caption={CAPTION} label="Groups table">
      <table className={TABLE}>
        <caption className="sr-only">{CAPTION}</caption>
        <thead className={THEAD}>
          <tr>
            <th scope="col" className={TH}>Group</th>
            <th scope="col" className={TH}>Count</th>
            <th scope="col" className={TH}>OK</th>
            <th scope="col" className={TH}>KO</th>
            <th scope="col" className={TH}>p95 cumulated</th>
            <th scope="col" className={TH}>p95 duration</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} data-testid="group-row" className={ROW}>
              <td className={TD}>
                <Link
                  to={`/runs/${encodeURIComponent(runId)}/groups/${encodeURIComponent(row.name)}`}
                  className="text-accent underline-offset-2 hover:underline"
                >
                  {row.name}
                </Link>
              </td>
              <td className={TD_NUM}>{formatCount(row.count)}</td>
              <td className={TD_NUM}>{formatCount(row.okCount)}</td>
              <td className={TD_NUM}>{formatCount(row.koCount)}</td>
              <td className={TD_NUM}>{ms(row.cumulatedP95)}</td>
              <td className={TD_NUM}>{ms(row.durationP95)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}
```

The group link carries no window suffix on purpose: the group page's figures are whole-run (`WholeRunNotice` exists to say so), and the Report's own window is in the URL the reader can return to. If `TableFrame`'s props differ from `{ caption, label }`, use the props `RunDetail.tsx`'s gates table passed it.

- [ ] **Step 8: Give `TableSection` and `StatisticsTable` a heading level, and share `explain`**

In `payload.tsx`, export the private `explain(error, what)` (`function explain` → `export function explain`) — the Report's Groups section explains a failed read the same way every table does, and a second copy would drift. Then add `headingLevel?: 2 | 3` (default `2`) to `TableSection`'s props and render `<SectionHeading level={headingLevel}>{title}</SectionHeading>`. In `StatisticsTable.tsx`, add `readonly headingLevel?: 2 | 3;` (default `2`) to its props and pass `level={headingLevel}` to both `<SectionHeading id={headingId} overline="Run telemetry">Statistics</SectionHeading>` occurrences. The Statistics heading sits inside the Report's Requests section, so it belongs one level under it.

- [ ] **Step 9: Make the telemetry charts a filterable section body**

In `TelemetryCharts.tsx`:
- export `type TelemetryChartId` (the union in this task's Interfaces);
- add `readonly only: readonly TelemetryChartId[];` to the props;
- replace the `<section aria-labelledby="load-generators-heading" …>` wrapper and its `sr-only` `<h2>` with `<div className="grid grid-cols-1 gap-6 2xl:grid-cols-2">`, because the Report's section heading now names these charts and a second heading inside would duplicate it;
- render each `<Chart id="telemetry-…">` only when `only.includes('telemetry-…')`.

In `RunTelemetry.tsx`:
- change the signature to `export default function RunTelemetry({ only }: { readonly only: readonly TelemetryChartId[] })`, and update its docstring's first line: it is a Report section's BODY now, not a route (Connections and Load generators each mount one with their own charts);
- filter `TELEMETRY_SLOTS` to `only` everywhere it is used (`const slots = TELEMETRY_SLOTS.filter((s) => only.includes(s.id as TelemetryChartId));`);
- in the `hosts.length === 0` branch, replace the `<section aria-labelledby="load-generators-heading">` and its `sr-only` `<h2>` with a plain grid `<div>`, for the same reason;
- pass `only` to `<TelemetryCharts host={host} domainMs={domainMs} only={only} />`.

Everything else (the three states, the host picker, the clock-skew notice, the phone gate, the terminal gate) is unchanged.

- [ ] **Step 10: Write `RunReport`**

Create `apps/web/src/routes/RunReport.tsx`. It reads the window from the shell, as the tabs it replaces did, and every section body is its own component so its hooks run only while the section is open:

```tsx
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { RunResponse } from '@perfportal/contracts';
import CollapsibleSection from '../components/CollapsibleSection';
import { ErrorState, LoadingState } from '../components/States';
import { distributionQuery, errorSeriesQuery, seriesQuery, statsQuery, usersQuery } from '../api/metrics';
import { RUN_TIME_GROUP } from '../charts/crosshair';
import DistributionChart from '../charts/DistributionChart';
import ErrorsChart from '../charts/ErrorsChart';
import IndicatorsChart from '../charts/IndicatorsChart';
import PercentileDistributionChart from '../charts/PercentileDistributionChart';
import PercentilesChart from '../charts/PercentilesChart';
import { RequestsAndResponsesChart } from '../charts/RatesChart';
import RequestCountChart from '../charts/RequestCountChart';
import type { TelemetryChartId } from '../charts/TelemetryCharts';
import { ConcurrentUsersChart, UserEndRateChart, UserStartRateChart } from '../charts/UsersChart';
import StatisticsTable, { STATISTICS_SKELETON_COLUMNS } from '../tables/StatisticsTable';
import useIsCompact from '../useIsCompact';
import DesktopOnly from './DesktopOnly';
import GroupsList from './GroupsList';
import LiveNotice from './LiveNotice';
import { Payload, TableSection, explain, type Slot } from './payload';
import RunGlossary from './RunGlossary';
import RunTelemetry from './RunTelemetry';
import {
  useLiveFromShell,
  useRunTerminal,
  useTimeDomainFromShell,
  useWarmupFromShell,
  useWindowFromShell,
} from './useRunWindow';
import WaitingPanel from './WaitingPanel';

/* The Requests charts, in GE's measured order (Requests and Responses per
   Second, Response Time Percentiles, Response Time Distribution, Response
   Time Percentiles Distribution, Errors per Second), then this product's two
   (Gatling's own open-source report has both). GE's "Responses per Second by
   Status" is not drawn: a `simulation.log` carries no HTTP status code. */
const REQUESTS_AND_RESPONSES: Slot = { id: 'requests-and-responses', title: 'Requests and responses per second over time' };
const PERCENTILES: Slot = { id: 'percentiles', title: 'Response time percentiles over time' };
const DISTRIBUTION: Slot = { id: 'distribution', title: 'Response time distribution' };
const PERCENTILE_DISTRIBUTION: Slot = { id: 'percentile-distribution', title: 'Response time percentiles distribution' };
const ERRORS_PER_SECOND: Slot = { id: 'errors-over-time', title: 'Errors per second' };
const INDICATORS: Slot = { id: 'indicators', title: 'Response time ranges' };
const REQUEST_COUNTS: Slot = { id: 'request-counts', title: 'Number of requests' };
const USER_START_RATE: Slot = { id: 'user-start-rate', title: 'Users started per second' };
const USER_END_RATE: Slot = { id: 'user-end-rate', title: 'Users ended per second' };
const CONCURRENT_USERS: Slot = { id: 'concurrent-users', title: 'Concurrent users over time' };

/* GE's Connections section holds Bandwidth and TCP Connection By State among
   its nine; those two are what the load-generator agent collects. The rest of
   the agent's charts are GE's Load Generators section. */
const CONNECTION_CHARTS: readonly TelemetryChartId[] = ['telemetry-bandwidth', 'telemetry-tcp-states'];
const LOAD_GENERATOR_CHARTS: readonly TelemetryChartId[] = [
  'telemetry-cpu',
  'telemetry-memory',
  'telemetry-connection-events',
  'telemetry-segment-events',
];

const GRID = 'grid grid-cols-1 gap-6 2xl:grid-cols-2';

/**
 * `/runs/:runId/report` — GE's Report (backlog #7): the time window, which
 * the shell draws above this page and nowhere else, then GE's sections in
 * GE's order. DNS is left out: nothing this product collects could fill it,
 * and a section that can only be empty is a false claim about the run.
 */
export default function RunReport() {
  const { runId } = useParams<{ runId: string }>();
  const { detail: run } = useRunTerminal(runId);
  const live = useLiveFromShell();
  if (runId === undefined || run.data === undefined) return null;
  // An honest wait until there is something live to draw — the condition the
  // Charts tab this replaces used: no delta yet this session.
  if (run.data.state === 'processing' && live?.lastDelta == null) {
    return <WaitingPanel status={run.data.run.status} />;
  }
  const runStatus = run.data.run.status;

  return (
    <div className="flex flex-col gap-4">
      <CollapsibleSection id="requests" title="Requests" defaultOpen>
        {() => <RequestsSection runId={runId} runStatus={runStatus} />}
      </CollapsibleSection>
      <CollapsibleSection id="groups" title="Groups">
        {() => <GroupsSection runId={runId} />}
      </CollapsibleSection>
      <CollapsibleSection id="virtual-users" title="Virtual users">
        {() => <VirtualUsersSection runId={runId} />}
      </CollapsibleSection>
      <CollapsibleSection id="connections" title="Connections">
        {() => <RunTelemetry only={CONNECTION_CHARTS} />}
      </CollapsibleSection>
      <CollapsibleSection id="load-generators" title="Load generators">
        {() => <RunTelemetry only={LOAD_GENERATOR_CHARTS} />}
      </CollapsibleSection>
    </div>
  );
}
```

Then, in the same file, the section bodies. `RequestsSection`:

```tsx
/**
 * GE's Charts / Table switch. Charts by default, as GE opens. ONE DEVIATION,
 * for this repository's shareable-view rule (AC-DASH-4): a URL carrying the
 * table's own sort (`sort`) or filter (`q`) opens straight on Table, so a
 * shared sorted view lands on what was shared. The choice itself stays out
 * of the URL, as GE keeps it.
 */
function RequestsSection({ runId, runStatus }: { readonly runId: string; readonly runStatus: RunResponse['status'] }) {
  const [params] = useSearchParams();
  const [view, setView] = useState<'charts' | 'table'>(() =>
    params.has('sort') || params.has('q') ? 'table' : 'charts',
  );
  return (
    <div className="flex flex-col gap-4">
      <div role="group" aria-label="Requests view" className="flex gap-1">
        {(['charts', 'table'] as const).map((which) => (
          <button
            key={which}
            type="button"
            aria-pressed={view === which}
            onClick={() => setView(which)}
            className="rounded-md border border-default px-2.5 py-1 text-[0.8125rem] aria-pressed:bg-sunken aria-pressed:font-semibold"
          >
            {which === 'charts' ? 'Charts' : 'Table'}
          </button>
        ))}
      </div>
      {view === 'charts' ? <RequestsCharts runId={runId} /> : <RequestsTable runId={runId} runStatus={runStatus} />}
    </div>
  );
}
```

`RequestsCharts` — the terminal and live branches and the phone gate copy `RunChartsTab`'s exactly (its `compact`/`shown`/`on` pattern, `enabled: on`, the live branch reading the cache the live delta writes):

```tsx
function RequestsCharts({ runId }: { readonly runId: string }) {
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  const domainMs = useTimeDomainFromShell();
  const warmupMs = useWarmupFromShell() ?? undefined;
  const compact = useIsCompact();
  const [shown, setShown] = useState(false);
  const on = (!compact || shown) && terminal;
  const series = useQuery({ ...seriesQuery(runId, 'run', '', 'response_time', window), enabled: on });
  const stats = useQuery({ ...statsQuery(runId, window), enabled: on });
  const distribution = useQuery({ ...distributionQuery(runId, 'run', '', 'response_time', window), enabled: on });
  const errorSeries = useQuery({ ...errorSeriesQuery(runId, window), enabled: on });

  if (compact && !shown) {
    return (
      <DesktopOnly compact what="Seven charts of this run" action="Open the charts" onShow={() => setShown(true)}>
        {() => null}
      </DesktopOnly>
    );
  }

  if (!terminal) {
    // While a run streams only the series has a live source (the delta writes
    // its cache key); the other five are stated, never left as a silent gap.
    return (
      <div className={GRID}>
        {series.data !== undefined && (
          <>
            <RequestsAndResponsesChart series={series.data} domainMs={domainMs} warmupMs={warmupMs} />
            <PercentilesChart series={series.data} domainMs={domainMs} warmupMs={warmupMs} />
          </>
        )}
        <LiveNotice kind="withheld" subject="Response time distribution" />
        <LiveNotice kind="withheld" subject="Response time percentiles distribution" />
        <LiveNotice kind="withheld" subject="Errors per second" />
        <LiveNotice kind="withheld" subject="Response time ranges" />
        <LiveNotice kind="withheld" subject="Number of requests" />
      </div>
    );
  }

  return (
    <div className={GRID}>
      <Payload query={series} slots={[REQUESTS_AND_RESPONSES, PERCENTILES]}>
        {(data) => (
          <>
            <RequestsAndResponsesChart series={data} domainMs={domainMs} warmupMs={warmupMs} />
            <PercentilesChart series={data} domainMs={domainMs} warmupMs={warmupMs} />
          </>
        )}
      </Payload>
      <Payload query={distribution} slots={[DISTRIBUTION, PERCENTILE_DISTRIBUTION]}>
        {(data) => (
          <>
            <DistributionChart distribution={data} />
            <PercentileDistributionChart distribution={data} />
          </>
        )}
      </Payload>
      <Payload query={errorSeries} slots={[ERRORS_PER_SECOND]}>
        {(data) => <ErrorsChart data={data} domainMs={domainMs} warmupMs={warmupMs} />}
      </Payload>
      <Payload query={stats} slots={[INDICATORS, REQUEST_COUNTS]}>
        {(data) => (
          <>
            <IndicatorsChart stats={data} />
            <RequestCountChart stats={data} />
          </>
        )}
      </Payload>
    </div>
  );
}
```

`RequestsTable` — the statistics table as the Overview drew it, one heading level down, with the glossary under it:

```tsx
function RequestsTable({ runId, runStatus }: { readonly runId: string; readonly runStatus: RunResponse['status'] }) {
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  const compact = useIsCompact();
  const stats = useQuery({ ...statsQuery(runId, window), enabled: terminal });
  // The table needs per-endpoint rows the live wire excludes on every path.
  if (!terminal) return <LiveNotice kind="withheld" subject="Statistics" />;
  return (
    <>
      <TableSection title="Statistics" headingLevel={3} query={stats} columns={STATISTICS_SKELETON_COLUMNS}>
        {(data) => (
          <DesktopOnly compact={compact} what="The per-request statistics table" action="Open detailed table">
            {() => <StatisticsTable stats={data} runId={runId} runStatus={runStatus} headingLevel={3} />}
          </DesktopOnly>
        )}
      </TableSection>
      {/* Every word the glossary defines is in the table above, which is why
          it moved here with it. */}
      <RunGlossary />
    </>
  );
}
```

`GroupsSection` and `VirtualUsersSection`:

```tsx
function GroupsSection({ runId }: { readonly runId: string }) {
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  const stats = useQuery({ ...statsQuery(runId, window), enabled: terminal });
  if (!terminal) return <LiveNotice kind="withheld" subject="Groups" />;
  if (stats.data !== undefined) return <GroupsList runId={runId} stats={stats.data} />;
  if (stats.isPending) return <LoadingState label="Loading this run’s groups…" />;
  return <ErrorState title="This run’s groups could not be loaded" detail={explain(stats.error, 'table')} />;
}

function VirtualUsersSection({ runId }: { readonly runId: string }) {
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  const domainMs = useTimeDomainFromShell();
  const warmupMs = useWarmupFromShell() ?? undefined;
  const compact = useIsCompact();
  const [shown, setShown] = useState(false);
  const on = (!compact || shown) && terminal;
  // Read even while live: the live delta writes this same cache key.
  const users = useQuery({ ...usersQuery(runId, window), enabled: on });

  if (compact && !shown) {
    return (
      <DesktopOnly compact what="Three charts of this run" action="Open the charts" onShow={() => setShown(true)}>
        {() => null}
      </DesktopOnly>
    );
  }
  const draw = (data: NonNullable<typeof users.data>) => (
    <>
      {/* GE's measured order: Arrival Rate, Termination Rate, Concurrent Users. */}
      <UserStartRateChart users={data} group={RUN_TIME_GROUP} domainMs={domainMs} warmupMs={warmupMs} />
      <UserEndRateChart users={data} group={RUN_TIME_GROUP} domainMs={domainMs} warmupMs={warmupMs} />
      <ConcurrentUsersChart users={data} group={RUN_TIME_GROUP} domainMs={domainMs} warmupMs={warmupMs} />
    </>
  );
  if (!terminal) return <div className={GRID}>{users.data !== undefined && draw(users.data)}</div>;
  return (
    <div className={GRID}>
      <Payload query={users} slots={[USER_START_RATE, USER_END_RATE, CONCURRENT_USERS]}>{draw}</Payload>
    </div>
  );
}
```

`ErrorState` takes `{ title, detail? }` and `LoadingState` `{ label }` (`apps/web/src/components/States.tsx`).

- [ ] **Step 11: Wire the routes, and take `RunChartsTab` out**

In `App.tsx`:
- add `const RunReport = lazy(() => import('./routes/RunReport'));` and `const RunSectionRedirect = lazy(() => import('./routes/RunSectionRedirect'));`;
- delete the `RunChartsTab` and `RunTelemetry` lazies;
- under `/runs/:runId`, replace `<Route path="charts" element={<RunChartsTab />} />` with `<Route path="report" element={<RunReport />} />` and `<Route path="charts" element={<RunSectionRedirect to="report" />} />`, and replace `<Route path="load-generators" element={<RunTelemetry />} />` with `<Route path="load-generators" element={<RunSectionRedirect to="report" hash="load-generators" />} />`.

In `RunDetail.tsx`, delete `RunChartsTab`, `ChartGroup`, their docstrings, the chart `Slot` constants (`INDICATORS` … `RESPONSES_PER_SECOND`) and `RUN_TIME` with its docstring (now `RUN_TIME_GROUP`, Task 2); then delete imports `lint` reports unused. `RunOverviewTab`'s `Sparklines` still uses `RequestRateChart` and `PercentilesChart` — keep those imports.

- [ ] **Step 12: Re-point the two existing test files**

- `git mv apps/web/test/RunChartsTab.live.test.tsx apps/web/test/RunReport.live.test.tsx`. Mount `RunReport` at `/runs/:runId/report` instead of `RunChartsTab`; every claim keeps its meaning but moves: the live figures it expects are now `chart-requests-and-responses` and `chart-percentiles` inside `section-requests`, plus — after clicking the `Virtual users` button — `chart-user-start-rate`, `chart-user-end-rate`, `chart-concurrent-users`; the two withheld notices become the five listed in `RequestsCharts`' live branch. Keep its phone-gate and waiting-panel cases.
- `apps/web/test/RunTelemetry.test.tsx`: render `<RunTelemetry only={ALL} />` with `const ALL = ['telemetry-cpu', 'telemetry-memory', 'telemetry-bandwidth', 'telemetry-connection-events', 'telemetry-segment-events', 'telemetry-tcp-states'] as const;`; a case that found the charts by the `load-generators-heading` heading or region now finds them by their chart test ids; add one case: `only={['telemetry-bandwidth', 'telemetry-tcp-states']}` draws exactly those two figures.

- [ ] **Step 13: Run, typecheck, lint, then the whole unit suite**

Run the five files named in this task → PASS. `pnpm typecheck`, `pnpm lint` → `exit=0`. `pnpm test:unit > /tmp/t3-unit.txt 2>&1; echo "exit=$?"` → `exit=0`, and `grep -c "^ *Errors" /tmp/t3-unit.txt` → `0`. Any other unit file that imported `RunChartsTab` fails here — re-point it the same way.

- [ ] **Step 14: Commit the checkpoint**

```bash
git add apps/web/src/routes/paths.ts apps/web/src/routes/RunSectionRedirect.tsx apps/web/src/routes/GroupsList.tsx apps/web/src/routes/payload.tsx apps/web/src/tables/StatisticsTable.tsx apps/web/src/charts/TelemetryCharts.tsx apps/web/src/routes/RunTelemetry.tsx apps/web/src/routes/RunReport.tsx apps/web/src/App.tsx apps/web/src/routes/RunDetail.tsx apps/web/test/groupRows.test.ts apps/web/test/RunSectionRedirect.test.tsx apps/web/test/RunReport.test.tsx apps/web/test/RunReport.live.test.tsx apps/web/test/RunChartsTab.live.test.tsx apps/web/test/RunTelemetry.test.tsx
git commit -q -F - <<'MSG'
Add GE's Report: Requests, Groups, Virtual users, Connections, Load generators

The Charts and Load generators tabs fold into the Report's sections, in GE's
order, Requests open. Requests has GE's Charts / Table switch, and opens on
Table for a link carrying the table's own sort or filter. Old /charts and
/load-generators URLs redirect with every parameter kept.
MSG
```

- [ ] **Step 15: Red-verify**

| Mutation | Must fail |
|---|---|
| `RunReport`: `defaultOpen` removed from Requests | "lists GE’s sections… only Requests open" |
| `RequestsSection`: initial view always `'charts'` | both `it.each` cases |
| `RequestsCharts`: `seriesQuery(…, window)` → `seriesQuery(…, null)` | "narrows every Requests query to the window" |
| `RunSectionRedirect`: drop `${search}` | the three redirect cases |
| `groupRows`: counts from the `group_duration` row instead | `groupRows` case (only if the fixture's two rows differ — if they don't, record that this mutation is unobservable and pick `koCount` → `okCount` instead) |
| `VirtualUsersSection`: `enabled: on` → `enabled: true` | none expected to fail on a desktop — instead confirm "asks for nothing a shut section would show" still passes (a shut section mounts no body at all); then mutate `CollapsibleSection`'s `{open && children()}` to `{children()}` and confirm THAT case fails |

---

### Task 4: The two assertion bars

**Files:**
- Create: `apps/web/src/routes/AssertionBars.tsx`
- Test: `apps/web/test/AssertionBars.test.tsx`

**Interfaces:**
- Consumes: `CollapsibleSection` (Task 1).
- Produces: `outcomeSummary(items: readonly { readonly outcome: 'passed' | 'failed' | 'not_applicable' }[]): string`; `PlatformGatesBar` props `{ runId: string; projectSlug?: string; assertions: readonly Assertion[] | undefined; ran: boolean }`; `SimulationAssertionsBar` props `{ runId: string; assertions: readonly ToolAssertion[] | null | undefined; stats: readonly StatRow[] | null }`. Section ids `platform-gates`, `simulation-assertions`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/AssertionBars.test.tsx`. Reuse `ToolAssertions.test.tsx`'s fixtures verbatim (`details(...)`, `PLATFORM_GATE`, `GLOBAL_ASSERTION`, `UNDECODED_ASSERTION`, `STATS`) by copying them into this file — that file is deleted in Task 5 and these are the claims it carried that survive:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { Assertion, StatsResponse, ToolAssertion } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import { PlatformGatesBar, SimulationAssertionsBar, outcomeSummary } from '../src/routes/AssertionBars';

afterEach(cleanup);

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const STATS = reference.stats as StatsResponse;
// details(), PLATFORM_GATE, GLOBAL_ASSERTION, UNDECODED_ASSERTION: copied from ToolAssertions.test.tsx

const PASSED_GATE: Assertion = { ...PLATFORM_GATE, ruleId: '33333333-3333-4333-8333-333333333333', outcome: 'passed', actualValue: 400 };

function at(url: string, ui: React.ReactNode) {
  return render(<MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>);
}

describe('outcomeSummary', () => {
  it('names what failed first, in the product’s words, and skips a zero', () => {
    expect(outcomeSummary([{ outcome: 'passed' }, { outcome: 'failed' }, { outcome: 'passed' }])).toBe('1 failed, 2 passed');
    expect(outcomeSummary([{ outcome: 'not_applicable' }])).toBe('1 not applicable');
  });
});

describe('PlatformGatesBar', () => {
  it('opens on arrival when a gate failed, failures first', () => {
    at('/r', <PlatformGatesBar runId={RUN_ID} assertions={[PASSED_GATE, PLATFORM_GATE]} ran />);
    expect(screen.getByRole('button', { name: 'Platform gates' })).toHaveAttribute('aria-expanded', 'true');
    const cards = screen.getAllByTestId('gate-card');
    expect(within(cards[0]!).getByTestId('gate-outcome')).toHaveTextContent(/failed/i);
  });

  it('stays shut when every gate passed, and opens to one card per gate', async () => {
    at('/r', <PlatformGatesBar runId={RUN_ID} assertions={[PASSED_GATE]} ran />);
    const button = screen.getByRole('button', { name: 'Platform gates' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(button);
    expect(screen.getAllByTestId('gate-card')).toHaveLength(1);
  });

  it.each([
    [undefined, true, 'not reported yet'],
    [[], false, 'not evaluated — the run left nothing to judge'],
    [[], true, 'not configured — no SLA rule judged this run'],
  ] as const)('says why it has nothing to show (%#)', (assertions, ran, words) => {
    at('/r', <PlatformGatesBar runId={RUN_ID} projectSlug="checkout" assertions={assertions} ran={ran} />);
    expect(within(screen.getByTestId('section-platform-gates')).getByText(words)).toBeVisible();
  });

  it('keeps the way to configure a rule when none is configured', async () => {
    at('/r', <PlatformGatesBar runId={RUN_ID} projectSlug="checkout" assertions={[]} ran />);
    await userEvent.click(screen.getByRole('button', { name: 'Platform gates' }));
    expect(screen.getByRole('link', { name: 'Configure SLA rules' })).toHaveAttribute('href', '/projects/checkout/rules');
  });

  it('keeps the CSV export beside a populated bar', () => {
    at('/r', <PlatformGatesBar runId={RUN_ID} assertions={[PLATFORM_GATE]} ran />);
    expect(screen.getByRole('button', { name: /export csv/i })).toBeVisible();
  });
});

describe('SimulationAssertionsBar', () => {
  it('counts its own system, never the platform’s', () => {
    at(
      '/r',
      <>
        <PlatformGatesBar runId={RUN_ID} assertions={[PLATFORM_GATE, PASSED_GATE, PASSED_GATE]} ran />
        <SimulationAssertionsBar runId={RUN_ID} assertions={[details(['Search'], 'failed'), GLOBAL_ASSERTION]} stats={STATS.stats} />
      </>,
    );
    expect(within(screen.getByTestId('section-platform-gates')).getByText('1 failed, 2 passed')).toBeVisible();
    expect(within(screen.getByTestId('section-simulation-assertions')).getByText('1 failed, 1 passed')).toBeVisible();
  });

  it('shows the tool’s own sentence verbatim on each card, with the actual and its unit', () => {
    at('/r', <SimulationAssertionsBar runId={RUN_ID} assertions={[details(['Search'], 'failed')]} stats={STATS.stats} />);
    const card = screen.getByTestId('simulation-card');
    expect(card).toHaveTextContent('Search: 95th percentile of response time is less than 100.0');
    expect(card).toHaveTextContent('572 ms');
  });

  it('links a check to the request or group it names, and to nothing it cannot find', () => {
    at(
      '/r',
      <SimulationAssertionsBar
        runId={RUN_ID}
        assertions={[details(['Search'], 'failed'), details(['Catalog'], 'failed'), details(['Ghost'], 'failed')]}
        stats={STATS.stats}
      />,
    );
    expect(screen.getByRole('link', { name: 'Search' })).toHaveAttribute('href', `/runs/${RUN_ID}/requests/Search`);
    expect(screen.getByRole('link', { name: 'Catalog' })).toHaveAttribute('href', `/runs/${RUN_ID}/groups/Catalog`);
    expect(screen.queryByRole('link', { name: 'Ghost' })).toBeNull();
  });

  it('says nothing at all for a run whose assertions were never decoded (null)', () => {
    const { container } = at('/r', <SimulationAssertionsBar runId={RUN_ID} assertions={null} stats={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says the simulation declared none ([])', async () => {
    at('/r', <SimulationAssertionsBar runId={RUN_ID} assertions={[]} stats={null} />);
    expect(within(screen.getByTestId('section-simulation-assertions')).getByText('none declared')).toBeVisible();
  });

  it('opens when the decision band’s link names it', () => {
    at('/r#simulation-assertions', <SimulationAssertionsBar runId={RUN_ID} assertions={[GLOBAL_ASSERTION]} stats={STATS.stats} />);
    expect(screen.getByRole('button', { name: 'Simulation assertions' })).toHaveAttribute('aria-expanded', 'true');
  });
});
```

Check `paths.ts` for `projectRulesPath` and use its output in the link assertion if it is not `/projects/checkout/rules`. Check the `Catalog` group: `details(['Catalog'], …)` must be a name the stats have as a GROUP and not as a request; if `Catalog` is also a request name in the fixture, use a group name that is not.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run apps/web/test/AssertionBars.test.tsx` → FAIL, unresolved import.

- [ ] **Step 3: Write `AssertionBars`**

Create `apps/web/src/routes/AssertionBars.tsx`. Move `AssertionTarget` here from `RunDetail.tsx` unchanged EXCEPT that it takes no `windowSuffix` (the Summary is whole-run, so a drill-down from it introduces no window); keep its docstring. Then:

```tsx
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { describeSlaOutcome, formatSlaValue } from '@perfportal/contracts';
import type { Assertion, StatRow, ToolAssertion } from '@perfportal/contracts';
import Button from '../components/Button';
import CollapsibleSection from '../components/CollapsibleSection';
import { DownloadIcon } from '../components/icons';
import { downloadCsv } from '../tables/csv';
import { assertionsCsv } from './assertionExport';
import { describeAssertionRuleForReader } from './assertions';
import { ASSERTION_OUTCOME, Marked } from './marks';
import { projectRulesPath } from './paths';
import { formatActual, toolAssertionParts } from './toolAssertion';

type Outcome = 'passed' | 'failed' | 'not_applicable';

/**
 * GE's bar text ("1 assertion failed, 1 assertion successful"), in this
 * product's words (review N01: passed / failed / not applicable). Failed first
 * because it is what the reader opened the run to find; a zero is not said.
 */
export function outcomeSummary(items: readonly { readonly outcome: Outcome }[]): string {
  const count = (o: Outcome) => items.filter((i) => i.outcome === o).length;
  return (
    [
      [count('failed'), 'failed'],
      [count('passed'), 'passed'],
      [count('not_applicable'), 'not applicable'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(', ');
}

/** Failed first, then the rest in the order the run recorded them. */
function failedFirst<T extends { readonly outcome: Outcome }>(items: readonly T[]): readonly T[] {
  return [...items.filter((i) => i.outcome === 'failed'), ...items.filter((i) => i.outcome !== 'failed')];
}

/**
 * The organisation's SLA rules, as GE's collapsible bar — one of TWO bars,
 * never merged with the simulation's own (review N01: two systems, decided by
 * different people).
 *
 * ONE DEVIATION FROM GE, AND IT IS THE POINT OF THE BAR: GE keeps its bar shut
 * even when an assertion failed (measured). Here a bar holding a failure opens
 * itself, so a failed gate is never a click away.
 *
 * Nothing to show keeps the decision band's three distinctions word for word,
 * because they are three different facts: not reported yet (live), not
 * evaluated (nothing ran — `rulesRan`), not configured (the project has no rule).
 */
export function PlatformGatesBar({
  runId,
  projectSlug,
  assertions,
  ran,
}: {
  readonly runId: string;
  readonly projectSlug?: string;
  readonly assertions: readonly Assertion[] | undefined;
  readonly ran: boolean;
}) {
  if (assertions === undefined || !ran || assertions.length === 0) {
    const words =
      assertions === undefined
        ? 'not reported yet'
        : !ran
          ? 'not evaluated — the run left nothing to judge'
          : 'not configured — no SLA rule judged this run';
    return (
      <CollapsibleSection id="platform-gates" title="Platform gates" summary={words}>
        {() =>
          assertions !== undefined && ran ? (
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[0.8125rem] text-muted">
              <span>No SLA rules judged this run — adding one affects future runs, not this one.</span>
              {projectSlug !== undefined && (
                <Link to={projectRulesPath(projectSlug)} className="font-medium text-accent underline-offset-2 hover:underline">
                  Configure SLA rules
                </Link>
              )}
            </p>
          ) : (
            <p className="text-[0.8125rem] text-muted">
              {assertions === undefined
                ? 'Platform gates are judged once the run finishes.'
                : 'The run stopped before anything could be processed, so no SLA rule ran.'}
            </p>
          )
        }
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection
      id="platform-gates"
      title="Platform gates"
      defaultOpen={assertions.some((a) => a.outcome === 'failed')}
      summary={outcomeSummary(assertions)}
      actions={
        <Button size="sm" onClick={() => downloadCsv(`run-${runId}-assertions.csv`, assertionsCsv(assertions))}>
          <DownloadIcon className="h-3.5 w-3.5" />
          Export CSV
        </Button>
      }
    >
      {() => (
        <ul className="flex flex-col gap-2">
          {failedFirst(assertions).map((a) => (
            <li key={a.ruleId} data-testid="gate-card" className="flex flex-col gap-1 rounded-lg border border-default bg-sunken px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-primary">{describeAssertionRuleForReader(a.rule)}</span>
                <span data-testid="gate-outcome"><Marked mark={ASSERTION_OUTCOME[a.outcome]} /></span>
              </div>
              {/* The same two cells the gates table carried: the measured
                  value through the rule's own formatter, and the outcome in
                  words — the stored message only for a not-applicable gate. */}
              <p className="text-[0.8125rem] tabular-nums text-primary">
                Actual: {a.actualValue === null ? '—' : formatSlaValue(a.rule.metric, a.actualValue)}
              </p>
              <p className="text-[0.8125rem] text-muted">{describeSlaOutcome(a) ?? a.message}</p>
            </li>
          ))}
        </ul>
      )}
    </CollapsibleSection>
  );
}
```

And `SimulationAssertionsBar` — a card is GE's card ("Global: 95th percentile … — Succeeded with value 20"): the tool's own sentence verbatim (G-05's tolerance is exact wording), then the outcome, the actual, and the target link:

```tsx
export function SimulationAssertionsBar({
  runId,
  assertions,
  stats,
}: {
  readonly runId: string;
  readonly assertions: readonly ToolAssertion[] | null | undefined;
  readonly stats: readonly StatRow[] | null;
}) {
  // (the `recorded` useMemo, moved verbatim from `ToolAssertions` in
  //  RunDetail.tsx with its docstring — before the early returns below)
  if (assertions === null || assertions === undefined) return null;

  if (assertions.length === 0) {
    return (
      <CollapsibleSection id="simulation-assertions" title="Simulation assertions" summary="none declared">
        {() => (
          <p className="text-[0.8125rem] text-muted">
            This simulation declared no assertions. Assertions are written in the simulation itself
            and read from the result file; this run’s tool reported none.
          </p>
        )}
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection
      id="simulation-assertions"
      title="Simulation assertions"
      defaultOpen={assertions.some((a) => a.outcome === 'failed')}
      summary={outcomeSummary(assertions)}
    >
      {() => (
        <ul className="flex flex-col gap-2">
          {failedFirst(assertions).map((a, i) => (
            <li key={`${a.expression}-${i}`} data-testid="simulation-card" className="flex flex-col gap-1 rounded-lg border border-default bg-sunken px-3 py-2">
              <p className="font-mono text-[0.75rem] text-primary">{a.expression}</p>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[0.8125rem]">
                <span data-testid="simulation-outcome"><Marked mark={ASSERTION_OUTCOME[a.outcome]} /></span>
                <span className="tabular-nums text-primary">Actual: {formatActual(a)}</span>
                {toolAssertionParts(a).target !== null && (
                  <span className="text-muted">
                    Target: <AssertionTarget assertion={a} runId={runId} recorded={recorded} />
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </CollapsibleSection>
  );
}
```

`describeAssertionRuleForReader` must still produce the limit (it did in the gates table's Rule column); if it does not include the comparator and threshold, add `· {formatSlaValue(...)}` the way that table's Rule cell did.

- [ ] **Step 4: Run, typecheck, lint**

`pnpm exec vitest run apps/web/test/AssertionBars.test.tsx` → PASS. `pnpm typecheck`, `pnpm lint` → `exit=0`. (`RunDetail.tsx` still has its own `AssertionTarget` until Task 5 deletes it — the duplicate is temporary, and Task 5 removes it in the same change that removes its last caller.)

- [ ] **Step 5: Commit the checkpoint**

```bash
git add apps/web/src/routes/AssertionBars.tsx apps/web/test/AssertionBars.test.tsx
git commit -q -F - <<'MSG'
Add GE's assertion bars: one for platform gates, one for the simulation's

Each GE's collapsible bar and cards, the two systems kept apart as review
N01 argued. One deviation: a bar holding a failure opens itself. The empty
states keep the decision band's three distinctions word for word.
MSG
```

- [ ] **Step 6: Red-verify**

| Mutation | Must fail |
|---|---|
| `PlatformGatesBar`: `defaultOpen={…}` removed | "opens on arrival when a gate failed…" |
| `SimulationAssertionsBar`: `summary={outcomeSummary(assertions)}` → `summary={outcomeSummary([...assertions, ...assertions])}` | "counts its own system…" |
| `'not evaluated — the run left nothing to judge'` → `'not configured — no SLA rule judged this run'` | the `it.each` row 2 |
| `failedFirst(assertions)` → `assertions` in `PlatformGatesBar` | "opens on arrival… failures first" |
| delete the `<p className="font-mono …">{a.expression}</p>` line | "shows the tool’s own sentence…" |

---

### Task 5: The Summary page

**Files:**
- Modify: `apps/web/src/routes/useRunWindow.ts` (add `useWholeRunDomainFromShell`)
- Modify: `apps/web/src/tables/StatisticsTable.tsx` (export `StatisticsEmpty`; re-point the Cnt/s hint)
- Modify: `apps/web/src/routes/RunStats.tsx`
- Create: `apps/web/src/routes/RunSummary.tsx`
- Create: `apps/web/src/routes/runSlots.ts` (`REQUESTS_AND_RESPONSES`, `PERCENTILES`, moved out of `RunReport.tsx`, which then imports them)
- Modify: `apps/web/src/routes/RunReport.tsx` (import the two slots)
- Modify: `apps/web/src/routes/RunDetail.tsx` (delete `RunOverviewTab`, `RunErrorsTab`, `LiveSummary`, `livePercentileValue`, `Sparklines`, `ErrorRequestFilter`, `OVERVIEW_TRENDS_STALE_MS`, `Assertions`, `formatAssertionValue`, `ToolAssertions`, `AssertionTarget`, `TOOL_ASSERTIONS_CAPTION`, `ASSERTIONS_CAPTION`)
- Modify: `apps/web/src/App.tsx`, `apps/web/src/routes/RunGlossary.tsx`
- Test: `apps/web/test/RunSummary.test.tsx` (new); `git mv` `RunOverviewTab.live.test.tsx` → `RunSummary.live.test.tsx` and fold `RunErrorsTab.live.test.tsx` into it; `git mv` `RunOverviewTab.baseline.test.tsx` → `RunSummary.baseline.test.tsx`; `git rm` `ToolAssertions.test.tsx`; modify `RunStats.test.tsx`, `RunGlossary.test.tsx`, `StatisticsTable.test.tsx`, `RunDetail.live.test.tsx`

**Interfaces:**
- Consumes: `PlatformGatesBar`, `SimulationAssertionsBar` (Task 4); `RequestsAndResponsesChart`, `RUN_TIME_GROUP` (Task 2); `RunSectionRedirect` (Task 3).
- Produces: `useWholeRunDomainFromShell(): readonly [number, number] | undefined`; `StatisticsEmpty({ runStatus })`; `RunStats` props `{ stats; peakUsers: number | null; runStatus: RunResponse['status']; baseline?; current?; assertions? }` (no `windowed`); `RunSummary` default export; `LiveSummary` exported from `RunSummary.tsx`.

- [ ] **Step 1: Write the failing Summary test**

Create `apps/web/test/RunSummary.test.tsx` with the harness of `RunReport.test.tsx` (Task 3, Step 3) — same `stubFetch`, `readyRun` (accepting `assertions`, `toolAssertions` and `status` overrides), mounting `<Route index element={<RunSummary />} />` under the `/runs/:runId` outlet — and the stub additionally answering `/errors` with `reference.errors` and `/trends` with `{ runs: [] }`:

```tsx
describe('RunSummary — always the whole run', () => {
  it('asks for nothing narrowed, whatever window the URL carries', async () => {
    const seen = renderSummary({
      url: `/runs/${RUN_ID}?from=10000&to=20000`,
      window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 },
    });
    await screen.findByTestId('stat-p95');
    const metric = seen.filter((u) => /\/v1\/runs\//.test(u));
    expect(metric.length).toBeGreaterThan(2);
    for (const url of metric) expect(url).not.toMatch(/[?&](from|to)=/);
  });

  it('leads with GE’s four numbers, in GE’s order', async () => {
    renderSummary();
    await screen.findByTestId('stat-p95');
    const ids = [...document.querySelectorAll('section[aria-label="Run totals"] dd[data-testid^="stat-"]')].map((d) => d.getAttribute('data-testid'));
    expect(ids).toEqual(['stat-error-rate', 'stat-total-requests', 'stat-peak-users', 'stat-p95']);
    expect(screen.getByTestId('stat-peak-users')).toHaveTextContent(String(peakConcurrentUsers(reference.users as UsersResponse)));
  });

  it('reads as Platform gates, Simulation assertions, Over time, Errors', async () => {
    renderSummary({ toolAssertions: [GLOBAL_ASSERTION] });
    await screen.findByTestId('stat-p95');
    await screen.findByRole('heading', { level: 2, name: 'Errors' });
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.trim())).toEqual([
      'Platform gates',
      'Simulation assertions',
      'Over time',
      'Errors',
    ]);
  });

  it('draws GE’s two charts, side by side', async () => {
    renderSummary();
    await screen.findByTestId('chart-requests-and-responses');
    const charts = [...document.querySelectorAll('figure[data-testid^="chart-"]')].map((f) => f.getAttribute('data-testid'));
    expect(charts).toEqual(['chart-requests-and-responses', 'chart-percentiles']);
  });

  it('mounts no full chart on a phone, where the sparklines stand in', async () => {
    vi.mocked(useIsCompact).mockReturnValue(true);
    renderSummary();
    await screen.findByTestId('stat-p95');
    expect(screen.queryByTestId('chart-requests-and-responses')).toBeNull();
    expect(await screen.findByTestId('chart-requests-per-second')).toBeVisible(); // the sparkline
  });

  it('says an incomplete run kept nothing, and that no gate ran', async () => {
    renderSummary({ status: 'incomplete', durationMs: null, statsBody: { ...reference.stats, stats: [] }, assertions: [] });
    expect(await screen.findByText('No statistics were retained for this run')).toBeVisible();
    expect(within(screen.getByTestId('section-platform-gates')).getByText('not evaluated — the run left nothing to judge')).toBeVisible();
  });

  it('narrows the errors table to the request a link names', async () => {
    const seen = renderSummary({ url: `/runs/${RUN_ID}?request=Search` });
    await screen.findByRole('heading', { level: 2, name: 'Errors' });
    expect(seen.some((u) => u.includes('/errors?scope=request&name=Search'))).toBe(true);
  });
});
```

Add one more case, which pins the Summary's AXIS (jsdom lays nothing out, so no chart case can see it):

```tsx
it('draws its charts on the run’s own span, whatever the window', () => {
  let domain: readonly [number, number] | undefined;
  function Probe() {
    domain = useWholeRunDomainFromShell();
    return null;
  }
  render(
    <MemoryRouter initialEntries={['/r']}>
      <Routes>
        <Route
          path="/r"
          element={<Outlet context={{ window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 }, durationMs: 63161, liveDurationMs: null, warmupMs: null, live: null } satisfies RunWindowContext} />}
        >
          <Route index element={<Probe />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  expect(domain).toEqual([0, 63161]);
});
```

(`useWholeRunDomainFromShell` from `../src/routes/useRunWindow`.) `peakConcurrentUsers` comes from `../src/routes/runUsers`. Let `renderSummary` take `status`, `durationMs`, `statsBody` (what `/stats` answers) and `assertions`/`toolAssertions` overrides and build the `RunResponse` from them. Confirm `errorsQuery`'s URL spelling by reading `api/metrics.ts` and match the substring.

- [ ] **Step 2: Run it to see it fail**

`pnpm exec vitest run apps/web/test/RunSummary.test.tsx` → FAIL, unresolved import.

- [ ] **Step 3: A whole-run time domain**

In `useRunWindow.ts`, after `useTimeDomainFromShell`:

```ts
/**
 * The run's own span, IGNORING any window — the Summary's axis. GE's Summary
 * stayed the whole run with a 30-second window in its URL (measured), and so
 * does this one; `useTimeDomainFromShell` narrows to the window, which is
 * right for the Report and wrong here.
 */
export function useWholeRunDomainFromShell(): readonly [number, number] | undefined {
  const { durationMs, liveDurationMs } = useOutletContext<RunWindowContext>();
  const span = durationMs ?? liveDurationMs;
  return span === null ? undefined : growingDomainMs(span);
}
```

- [ ] **Step 4: Share the table's empty sentence, and re-point its Cnt/s hint**

In `StatisticsTable.tsx`, lift the two `EmptyState`s of the empty branch (about line 819, `runStatus === 'incomplete' ? … : …`) into an exported component, moving the "RECORDED IS FALSE FOR A RUN WHOSE STREAM STOPPED" comment with them, and render it in their place:

```tsx
/** The table's empty branch, shared with the Summary's headline numbers so the
 *  two can never describe one empty run two ways. */
export function StatisticsEmpty({ runStatus }: { readonly runStatus: RunResponse['status'] | undefined }) {
  return runStatus === 'incomplete' ? (
    <EmptyState
      title="No statistics were retained for this run"
      body="This run's stream stopped before it finished, and figures measured while it was live are not kept. Re-run the test for a complete set."
    />
  ) : (
    <EmptyState title="No statistics were recorded for this run" />
  );
}
```

(use the existing `runStatus` prop's type there). Change the Cnt/s hint (about line 174) from `'Count of events per second — the same measurement the run totals call Requests/s'` to `'Count of events per second — the same measurement the requests-and-responses chart plots as Count/s'`, and update the comment above it: the run totals no longer carry a rate tile, so the bridge now points at the chart that draws the same quantity.

- [ ] **Step 5: Four tiles**

In `RunStats.tsx`:
- props: add `readonly peakUsers: number | null;` and `readonly runStatus: RunResponse['status'] | undefined;`; delete `windowed` and every branch reading it (`windowed === true ? undefined : assertions` becomes `assertions`; the empty-window sentence goes; the percentile note's window wording goes);
- when the run-scope row is missing, render `<section aria-label="Run totals" data-testid="stats-empty"><StatisticsEmpty runStatus={runStatus} /></section>` instead of `null` — the Summary has no statistics table beside it any more, so this is the only place the empty run is said (Review Focus 2);
- the `<dl>` becomes `grid grid-cols-2 gap-3 @xl:grid-cols-4` with exactly four tiles, in this order: the existing `Error rate` tile; the existing `Requests` tile; a new Peak users tile; the existing `p95` tile. Delete the `Requests/s`, `p99` and `Mean` tiles. The new tile:

```tsx
<StatTile
  /* GE's "Max. concurrent V.U", in this product's words. From the users
     series (the Summary fetches it whole-run), not the statistics row, which
     carries no user count. No "vs previous": a cohort row records no peak,
     so there is nothing honest to compare against. */
  label="Peak users"
  value={peakUsers === null ? '—' : formatCount(peakUsers)}
  hint="concurrent, at the busiest moment"
  data-testid="stat-peak-users"
/>
```

- rewrite the order comment above the `<dl>`: GE's Summary shows exactly four numbers — error ratio, total requests, max concurrent users, p95 — and this row shows the same four in the same order, so a reader moving between the two products finds each number in the same place; throughput, p99 and mean are in the Report's table.

- [ ] **Step 6: Write `RunSummary`**

Create `apps/web/src/routes/RunSummary.tsx`. Move `LiveSummary` and `livePercentileValue` here from `RunDetail.tsx` (exported, docstrings kept and corrected — the live row now carries the same four tiles as the finished one, so the transition substitutes nothing) with the live tiles in the same order: `Error rate` (`live-stat-error-rate`), `Requests so far` (`live-stat-total-requests`), `Peak users` (`live-stat-peak-users`), `p95` (`live-stat-p95`); delete the live p99 and Duration tiles. Move `Sparklines` and `ErrorRequestFilter` here unchanged. Then:

```tsx
/**
 * `/runs/:runId` — GE's Summary (backlog #7): always the WHOLE run. With a
 * 30-second window in its URL GE's Summary still read the run's 900 requests
 * (measured), so every query here passes `null` and the axis is the run's own
 * span. The window belongs to the Report.
 *
 * Above this page the shell draws the header, the tabs, the lifecycle strip
 * and the verdict band (Summary only); then GE's four numbers, the two
 * assertion bars, GE's two charts, and the errors table.
 */
export default function RunSummary() {
  const { runId } = useParams<{ runId: string }>();
  const { detail: run, terminal } = useRunTerminal(runId);
  const live = useLiveFromShell();
  const domainMs = useWholeRunDomainFromShell();
  const warmupMs = useWarmupFromShell() ?? undefined;
  const compact = useIsCompact();
  const id = runId ?? '';
  const stats = useQuery({ ...statsQuery(id, null), enabled: terminal });
  const users = useQuery({ ...usersQuery(id, null), enabled: terminal });
  // Read live too: the delta writes this same key, and a live view has no window.
  const series = useQuery({ ...seriesQuery(id, 'run', '', 'response_time', null), enabled: terminal });
  // (the `trends` query moved verbatim from RunOverviewTab, with its docstring
  //  and its five-minute staleTime constant, now `enabled: terminal`)

  if (runId === undefined || run.data === undefined) return null;

  if (run.data.state === 'processing') {
    const delta = live?.lastDelta ?? null;
    if (delta === null) return <WaitingPanel status={run.data.run.status} />;
    return (
      <div className="flex flex-col gap-6">
        <LiveSummary summary={delta.summary} frozen={run.data.run.status !== 'running'} />
        <PlatformGatesBar runId={runId} assertions={undefined} ran />
        {!compact && series.data !== undefined && (
          <OverTimeSection>
            <OverTimeCharts series={series.data} domainMs={domainMs} warmupMs={warmupMs} />
          </OverTimeSection>
        )}
        <ErrorsSection runId={runId} terminal={false} />
      </div>
    );
  }

  const body = run.data.run;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        {stats.data !== undefined && (
          <RunStats
            stats={stats.data}
            peakUsers={users.data === undefined ? null : peakConcurrentUsers(users.data)}
            runStatus={body.status}
            baseline={baselineRun(trends.data, runId)}
            current={cohortRun(trends.data, runId)}
            assertions={body.assertions}
          />
        )}
        {compact && <Sparklines series={series} />}
      </div>
      <PlatformGatesBar
        runId={runId}
        projectSlug={body.project.slug}
        assertions={body.assertions}
        ran={rulesRan(body.status, body.durationMs)}
      />
      <SimulationAssertionsBar runId={runId} assertions={body.toolAssertions} stats={stats.data?.stats ?? null} />
      {!compact && (
        <OverTimeSection>
          <Payload query={series} slots={[REQUESTS_AND_RESPONSES, PERCENTILES]}>
            {(data) => <OverTimeCharts series={data} domainMs={domainMs} warmupMs={warmupMs} />}
          </Payload>
        </OverTimeSection>
      )}
      <ErrorsSection runId={runId} terminal />
    </div>
  );
}

/**
 * GE's Summary pair, side by side from `2xl` — the width this repo measured
 * two charts needing before a 60-bucket axis drops labels. "Over time" is a
 * visually hidden `<h2>`: GE draws none, but without it these charts' own
 * `<h3>`s would sit under "Simulation assertions" in a screen reader's outline.
 */
function OverTimeSection({ children }: { readonly children: ReactNode }) {
  return (
    <section aria-labelledby="summary-over-time" className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
      <h2 id="summary-over-time" className="sr-only">Over time</h2>
      {children}
    </section>
  );
}

function OverTimeCharts({ series, domainMs, warmupMs }: { readonly series: SeriesResponse; readonly domainMs?: readonly [number, number]; readonly warmupMs?: number }) {
  return (
    <>
      <RequestsAndResponsesChart series={series} domainMs={domainMs} warmupMs={warmupMs} />
      <PercentilesChart series={series} domainMs={domainMs} warmupMs={warmupMs} />
    </>
  );
}
```

Its imports: `useId`, `useMemo`, `type ReactNode` from `react`; `useParams`, `useSearchParams` from `react-router-dom`; `useQuery`, `type UseQueryResult` from `@tanstack/react-query`; `LiveDelta`, `SeriesResponse` (types) from `@perfportal/contracts`; `errorsQuery`, `seriesQuery`, `statsQuery`, `trendsQuery`, `usersQuery` from `../api/metrics`; `PercentilesChart`; `RequestRateChart`, `RequestsAndResponsesChart` from `../charts/RatesChart`; `StatTile`; `ErrorsTable`, `ERRORS_TABLE_COLUMNS`; `formatCount`, `formatMs` from `../tables/StatisticsTable`; `useIsCompact`; `PlatformGatesBar`, `SimulationAssertionsBar` from `./AssertionBars`; `rulesRan` from `./decision`; `failingRequestNames` from `./errorRequestFilter`; `FRAGMENT_SCROLL_MARGIN` from `./fragment`; `Payload`, `TableSection`, `type Slot` from `./payload`; `baselineRun`, `cohortRun` from `./runBaseline`; `RunStats`; `peakConcurrentUsers` from `./runUsers`; `useLiveFromShell`, `useRunTerminal`, `useWarmupFromShell`, `useWholeRunDomainFromShell` from `./useRunWindow`; `WaitingPanel`. Let `lint` arbitrate: whatever it reports unused goes, whatever `tsc` reports missing is added.

`REQUESTS_AND_RESPONSES` and `PERCENTILES` are the same two `Slot`s Task 3 declared in `RunReport.tsx`. Move those two into `apps/web/src/routes/runSlots.ts` (exported) and import them in both pages — one spelling of a chart's title, which `Payload` uses for its placeholder. The heading sits OUTSIDE `Payload`, so "Over time" is in the outline while the charts load or fail too.

`ErrorsSection` is `RunErrorsTab` without its chart (Errors per second is in the Report's Requests section now), under an anchor the `/errors` redirect names:

```tsx
/**
 * The errors table, moved from the Errors tab — its endpoint takes no window,
 * so it was always the whole run, which is why it sits on the Summary as GE's
 * does. `id="errors"` is what an old `/errors` link lands on; the request
 * filter (review 09-13 M15) stays in the URL as `request`.
 */
function ErrorsSection({ runId, terminal }: { readonly runId: string; readonly terminal: boolean }) {
  // (RunErrorsTab's `params`/`requestFilter`/`setRequestFilter`, its `errors`
  //  query and its whole-run `stats` query, moved verbatim)
  return (
    <div id="errors" className="flex flex-col gap-3" style={{ scrollMarginTop: FRAGMENT_SCROLL_MARGIN }}>
      {terminal && (
        <ErrorRequestFilter
          names={stats.data === undefined ? [] : failingRequestNames(stats.data)}
          value={requestFilter}
          onChange={setRequestFilter}
        />
      )}
      <TableSection title="Errors" query={errors} columns={ERRORS_TABLE_COLUMNS}>
        {(data) => <ErrorsTable errors={data} scopeLabel={requestFilter ?? undefined} />}
      </TableSection>
    </div>
  );
}
```

(`errors` is `enabled: terminal`, read live from the cache the delta writes, as `RunErrorsTab` did; `windowSelected` is no longer passed — the Summary is whole-run.)

- [ ] **Step 7: Route it, and empty `RunDetail.tsx` of the old tabs**

In `App.tsx`: add `const RunSummary = lazy(() => import('./routes/RunSummary'));`; replace `<Route index element={<RunOverviewTab />} />` with `<Route index element={<RunSummary />} />` and `<Route path="errors" element={<RunErrorsTab />} />` with `<Route path="errors" element={<RunSectionRedirect to="summary" hash="errors" />} />`; delete the `RunOverviewTab` and `RunErrorsTab` lazies.

In `RunDetail.tsx`, delete the functions and constants listed under Files for this task, with their docstrings, then the imports `lint` reports unused.

In `RunGlossary.tsx`, update the `Cnt/s, Requests/s` entry's prose: `Requests/s` is now the axis of the request-rate charts on the request and group pages, and the Summary's combined chart plots the same per-second count as `Count/s` — read the entry and correct every sentence that names "the run totals".

- [ ] **Step 8: Re-point the existing tests**

- `RunStats.test.tsx`: every `renderStats(<RunStats … />)` passes `peakUsers={12}` and `runStatus="complete"`. Delete the cases whose claim died with the tiles or the window: `gives throughput one name…`, `withholds the tint while a window is applied`, the empty-window case, and the p99/mean/throughput parts of `names each response-time tile…` and `judges error rate and throughput…` (keep the error-rate half). Replace `leads with p95, error rate, throughput and requests` with `leads with GE’s four, in GE’s order` asserting `['stat-error-rate', 'stat-total-requests', 'stat-peak-users', 'stat-p95']`. Rewrite `keeps the four shared tiles in the places the live row uses` so the live ids are read from `apps/web/src/routes/RunSummary.tsx` and the claim is now EXACT agreement: `live.map((id) => id.replace('live-', ''))` equals the terminal list. Move `keeps the statistics table’s bridge pointing at a label this row renders` into `StatisticsTable.test.tsx` as `keeps its Count/s bridge pointing at an axis the combined chart draws`: regex `/hint:\s*'[^']*plots as ([^']+)'/` over `StatisticsTable.tsx`, and `expect(readFileSync(fromRepo('apps/web/src/charts/RatesChart.tsx'), 'utf8')).toContain(\`name: '${named}'\`)`. Add `renders the table’s own empty sentence when the run kept nothing` (`runStatus="incomplete"`, no run row → `No statistics were retained for this run`).
- `RunGlossary.test.tsx`: `RENDERED_IN['Requests/s']` → `'apps/web/src/charts/RatesChart.tsx'`; `'Platform gates'` and `'Simulation assertions'` → `'apps/web/src/routes/AssertionBars.tsx'`.
- `git mv apps/web/test/RunOverviewTab.live.test.tsx apps/web/test/RunSummary.live.test.tsx`: mount `RunSummary`; the live tiles it expects become the four, in the four's order; the withheld "Statistics" notice is gone (the table is on the Report). Bring `RunErrorsTab.live.test.tsx`'s cases in (the live-fed errors table) and `git rm` that file; its "Errors per second withheld" case moves to `RunReport.live.test.tsx` (the chart lives in Requests now).
- `git mv apps/web/test/RunOverviewTab.baseline.test.tsx apps/web/test/RunSummary.baseline.test.tsx`: mount `RunSummary`; claims unchanged.
- `git rm apps/web/test/ToolAssertions.test.tsx` — its surviving claims are in `AssertionBars.test.tsx` (Task 4). Before removing it, list its case names and check each is carried there or died with the table (the wording toggle, the forced column, the table caption); record the mapping in the commit message.
- `RunDetail.live.test.tsx`: every reference to the Overview or Errors tab becomes the Summary; every expectation of six live tiles becomes the four.

- [ ] **Step 9: Run, typecheck, lint, the unit suite**

The new and moved files → PASS. `pnpm typecheck`, `pnpm lint` → `exit=0`. `pnpm test:unit > /tmp/t5-unit.txt 2>&1; echo "exit=$?"` → `exit=0`, zero `Errors` lines.

- [ ] **Step 10: Commit the checkpoint**

```bash
git add apps/web/src/routes/useRunWindow.ts apps/web/src/tables/StatisticsTable.tsx apps/web/src/routes/RunStats.tsx apps/web/src/routes/RunSummary.tsx apps/web/src/routes/RunDetail.tsx apps/web/src/App.tsx apps/web/src/routes/RunGlossary.tsx apps/web/test/RunSummary.test.tsx apps/web/test/RunSummary.live.test.tsx apps/web/test/RunSummary.baseline.test.tsx apps/web/test/RunStats.test.tsx apps/web/test/RunGlossary.test.tsx apps/web/test/StatisticsTable.test.tsx apps/web/test/RunDetail.live.test.tsx apps/web/test/RunReport.live.test.tsx
git add -u apps/web/test
git commit -q -F - <<'MSG'
Add GE's Summary: four numbers, two assertion bars, two charts, the errors

Always the whole run, as GE's is measured to be. Overview and Errors fold
into it; an old /errors link redirects to its errors table, filter kept.
The tiles become GE's four in GE's order, the same live and finished.
(List here which ToolAssertions.test.tsx cases moved to AssertionBars and
which died with the table.)
MSG
```

(`git add -u apps/web/test` stages the `git mv`/`git rm` changes under `apps/web/test` only.)

- [ ] **Step 11: Red-verify**

| Mutation | Must fail |
|---|---|
| `RunSummary`: `statsQuery(id, null)` → `statsQuery(id, useWindowFromShell())` (import it) | "asks for nothing narrowed…" |
| `RunStats`: swap the Peak users and Requests tiles | "leads with GE’s four…" (both files) |
| `RunStats`: the missing-row branch returns `null` | "says an incomplete run kept nothing…" |
| `RunSummary`: `ErrorsSection`'s `requestFilter === null ? 'run' : 'request'` → always `'run'` | "narrows the errors table…" |
| `useWholeRunDomainFromShell`: return `[window.fromMs, window.toMs]` when a window is set | "draws its charts on the run’s own span, whatever the window" |

---

### Task 6: The shell, the tabs, the header and the window

**Files:**
- Modify: `apps/web/src/routes/RunShell.tsx`, `apps/web/src/routes/RunHeader.tsx`, `apps/web/src/routes/RunTabs.tsx`, `apps/web/src/components/icons.tsx`, `apps/web/src/routes/paths.ts`, `apps/web/src/charts/TimeBrush.tsx`, `apps/web/src/routes/RunSectionNotFound.tsx`
- Test: `apps/web/test/RunShell.test.tsx`, `apps/web/test/RunHeader.test.tsx`, `apps/web/test/RunTabs.test.tsx`, `apps/web/test/TimeBrush.test.tsx`, `apps/web/test/paths.test.ts`, `apps/web/test/RunSectionNotFound.test.tsx`

**Interfaces:**
- Consumes: `runReportPath` (Task 3).
- Produces: `RunTabs` props `{ runId: string; hasLogs: boolean }` (no `errorCount`); `RunHeader` without `peakUsers`; `SummaryTabIcon`, `ReportTabIcon`.

- [ ] **Step 1: Write the failing shell and tab tests**

In `RunShell.test.tsx`, add `<Route path="report" element={<div />} />` to `renderShellWith`'s routes, then add:

```tsx
describe('RunShell — GE’s Summary and Report around the tab strip', () => {
  it('draws the lifecycle strip and the verdict band on the Summary only, below the tabs', () => {
    renderShellWith(`/runs/${RUN_ID}`, READY_PROPS);
    const tabs = screen.getByRole('navigation', { name: 'Run sections' });
    const band = screen.getByRole('region', { name: 'Release decision' });
    expect(tabs.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(['report', 'logs', 'trends', 'compare'])('draws no lifecycle strip or band on %s', (section) => {
    renderShellWith(`/runs/${RUN_ID}/${section}`, READY_PROPS);
    expect(screen.queryByRole('region', { name: 'Release decision' })).toBeNull();
    expect(screen.queryByTestId('run-lifecycle')).toBeNull();
  });

  it('offers the time window on the Report and nowhere else', async () => {
    renderShellWith(`/runs/${RUN_ID}/report`, WINDOWABLE_PROPS);
    expect(await screen.findByTestId('time-brush')).toBeInTheDocument();
    cleanup();
    renderShellWith(`/runs/${RUN_ID}`, WINDOWABLE_PROPS);
    expect(screen.queryByTestId('time-brush')).toBeNull();
  });

  it('renders the Report with no time window for a run that cannot honour one', () => {
    renderShellWith(`/runs/${RUN_ID}/report`, { ...WINDOWABLE_PROPS, windowable: false });
    expect(screen.queryByTestId('time-brush')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeVisible();
  });
});
```

Use the file's existing prop fixtures in place of `READY_PROPS`/`WINDOWABLE_PROPS` (read the file's top — it has a ready run's props and a windowable variant used by its brush cases), and the lifecycle strip's real test id (read `RunLifecycle.tsx`). In `RunTabs.test.tsx`, add:

```tsx
it('offers GE’s run sections: Summary, Report, then Logs, Trends, Compare', () => {
  renderAt({ hasLogs: true });
  expect(screen.getAllByRole('link').map((a) => a.textContent?.trim())).toEqual(['Summary', 'Report', 'Logs', 'Trends', 'Compare']);
  expect(screen.getByRole('link', { name: 'Report' })).toHaveAttribute('href', `/runs/${RUN_ID}/report`);
});
```

- [ ] **Step 2: Run them to see them fail**

`pnpm exec vitest run apps/web/test/RunShell.test.tsx apps/web/test/RunTabs.test.tsx` → the new cases FAIL.

- [ ] **Step 3: Tabs and icons**

In `icons.tsx`, replace the four tab icons with `export const SummaryTabIcon = icon(FileText);` (GE's `summarize` glyph) and `export const ReportTabIcon = icon(ChartArea);` (GE's `area_chart`), add `FileText` and `ChartArea` to the lucide import, and remove `Gauge`, `Server`, `CircleAlert` from it if nothing else uses them. In `RunTabs.tsx`: drop `errorCount`; the tabs become `Summary` (`runPath`, `end`, `SummaryTabIcon`), `Report` (`runReportPath`, `ReportTabIcon`), `Logs` (unchanged condition), `Trends`, `Compare`. Rewrite the Logs comment ("after Report") and the last-pair comment (Summary and Report answer questions about this run; Logs too for a runner run; Trends and Compare leave it).

- [ ] **Step 4: The header loses Peak users**

In `RunHeader.tsx`, delete the `peakUsers` prop, its docstring, and the `Chip name="Peak users"` block; correct any comment that names the chip. Peak users is a Summary tile now (Task 5).

- [ ] **Step 5: The shell**

In `RunShell.tsx`:
- delete the `errors` query and its comment; `<RunTabs runId={…} hasLogs={…} />`;
- compute the section once: `const here = pathname.replace(/\/$/, '');`, `const onSummary = here === runPath(identity.id);`, `const onReport = here === runReportPath(identity.id);` — and delete `windowFreeSections`/`windowApplies` with their comment block, replacing it with: the window applies only on the Report, where GE puts it; every other section answers a whole-run question, so a control over it would be a claim about a page that ignores it (C03);
- `const users = useQuery({ ...usersQuery(identity.id, window), enabled: terminal && onReport });` — it now exists only for the brush's `applied` window; rewrite its comment to say so;
- render order inside the outer `<div className="flex flex-col gap-6">`: `<RunHeader … />` (no `peakUsers`), `<RunTabs … />`, the `LiveStatusStrip` block, the `SlaBanner` block, then `{onSummary && (<><RunLifecycle … /><RunDecisionBand … /></>)}`, then the brush block gated on `onReport` instead of `windowApplies`, then the outlet. Rewrite the lifecycle comment: GE draws its strip on the Summary only, under the run's title and page buttons; here it sits under the tab strip so the strip stays in one place on every page;
- the header's wrapper `<div className={compact ? 'flex flex-col gap-2' : 'flex flex-col gap-3'}>` now holds only `RunHeader`, so remove the wrapper.

- [ ] **Step 6: The window is always open**

In `TimeBrush.tsx`: delete `open`/`setOpen` and the effect that opens it, delete the `<details>`/`<summary>` wrapper (keep everything that was inside it, in place), and replace the outer element's `aria-label="Time window"` with `aria-labelledby={headingId}` plus `<h2 id={headingId} className="sr-only">Time window</h2>` as its first child (`const headingId = useId();`). Rewrite the comment that argued the collapse (review M01): that trade was made so the run's totals fit above the fold on the page that carried them; the Report carries no totals, and GE's window bar is always shown.

- [ ] **Step 7: Paths and the not-found page**

In `paths.ts`, delete `runChartsPath`, `runErrorsPath` and `runTelemetryPath` — nothing calls them after Step 3 (confirm with `grep -rn "runChartsPath\|runErrorsPath\|runTelemetryPath" apps/web/src apps/web/test`). Keep the `load-generators` naming note by moving its point into `RunSectionRedirect`'s docstring (that URL still resolves, as a redirect). In `RunSectionNotFound.tsx`, "Back to the overview" → "Back to the summary".

- [ ] **Step 8: Re-point the existing tests**

- `RunShell.test.tsx`: delete the three error-count cases (`renders a bare Errors tab…`, `shows the resolved distinct-message count…`, `renders a bare Errors tab when the errors fetch fails…`) — the count died with the tab. The brush cases (`offers the brush on the tabs that honour a window`, `does not announce a window over the Logs tab…`, `carries the window into the tabs…`, `leaves the brush in place on a wide viewport`, `does not mount the brush` on a phone) navigate to `/runs/${RUN_ID}/report`. The lifecycle-strip cases (`mounts the lifecycle strip between the header and the release decision` → "below the tabs, above the release decision", `says the Duration chip’s number and the band’s word`) render at `/runs/${RUN_ID}`. Any peak-users expectation on the header goes.
- `RunHeader.test.tsx`: delete the peak-users cases; drop `peakUsers` from every render.
- `RunTabs.test.tsx`: rewrite the six-link cases to the five links; `errorCount` disappears; Logs sits after Report.
- `TimeBrush.test.tsx`: delete the cases whose claim is the collapse (starts collapsed, opens itself for an applied window, names the window from outside when shut, the effect on a URL change); keep every other case. Add `it('is always open, with a hidden "Time window" heading')`.
- `paths.test.ts`: delete the three old helpers' cases; add `runReportPath('r1')` → `/runs/r1/report`.
- `RunSectionNotFound.test.tsx`: the new link text.

- [ ] **Step 9: Run, typecheck, lint, the unit suite**

The six test files → PASS; `pnpm typecheck`, `pnpm lint` → `exit=0`; `pnpm test:unit` → `exit=0`, zero `Errors` lines.

- [ ] **Step 10: Commit the checkpoint**

```bash
git add apps/web/src/routes/RunShell.tsx apps/web/src/routes/RunHeader.tsx apps/web/src/routes/RunTabs.tsx apps/web/src/components/icons.tsx apps/web/src/routes/paths.ts apps/web/src/charts/TimeBrush.tsx apps/web/src/routes/RunSectionNotFound.tsx apps/web/src/routes/RunSectionRedirect.tsx apps/web/test/RunShell.test.tsx apps/web/test/RunHeader.test.tsx apps/web/test/RunTabs.test.tsx apps/web/test/TimeBrush.test.tsx apps/web/test/paths.test.ts apps/web/test/RunSectionNotFound.test.tsx
git commit -q -F - <<'MSG'
Make the tabs Summary, Report, Logs, Trends, Compare

The lifecycle strip and verdict band draw on the Summary only, under the
tab strip so it stays put on every page; the time window draws on the
Report only, always open. The header's Peak users chip and the Errors tab's
count go with what replaced them.
MSG
```

- [ ] **Step 11: Red-verify**

| Mutation | Must fail |
|---|---|
| `RunShell`: `{onSummary && (…)}` → `{(…)}` | the `it.each` "draws no lifecycle strip or band on %s" |
| `RunShell`: move `<RunTabs …/>` after the band | "draws the lifecycle strip and the verdict band on the Summary only, below the tabs" |
| `RunShell`: brush gate `onReport` → `true` | "offers the time window on the Report and nowhere else" |
| `RunShell`: drop `windowable === true &&` from the brush gate | "renders the Report with no time window for a run that cannot honour one" |
| `RunTabs`: put Trends before Report | "offers GE’s run sections…" |

---

### Task 7: The browser suite

**Files:**
- Modify: `apps/web/e2e/helpers.ts`
- Modify: `apps/web/e2e/run-tables.spec.ts`, `run-detail.spec.ts`, `run-charts.spec.ts`, `run-live.spec.ts`, `time-window.spec.ts`, `run-telemetry.spec.ts`, `mobile.spec.ts`, `run-logs.spec.ts`, `run-compare.spec.ts`, `acceptance.spec.ts`
- Create: `apps/web/e2e/run-summary-report.spec.ts`

**Interfaces:**
- Produces: `openTimeWindow(page)` (now only waits for the always-open window) and `openSection(page, id, title)` in `helpers.ts`.

- [ ] **Step 1: Bring the stack up on scratch stores**

Per CLAUDE.md, never the developer database: create and migrate a scratch database `perfportal_summary` (as previous branches did — `createdb` via `docker exec <postgres container> psql`, then `prisma migrate deploy` with `DATABASE_URL` pointing at it), use Redis index 8 (`REDIS_URL=redis://localhost:6380/8`), flush it, and set `PERFPORTAL_E2E_PORT=3800` (it moves all four port uses). Confirm nothing else runs against them: `pgrep -f "vitest|playwright|dist/main.js"` empty.

- [ ] **Step 2: The helpers**

In `helpers.ts`, replace `openTimeWindow`'s body (the window has no disclosure any more; callers must be on the Report):

```ts
/** The Report's time window is always open now (backlog #7) — this waits for
 *  it, on the Report, where it lives. A caller on any other page fails here,
 *  which is the point: the window is drawn nowhere else. */
export async function openTimeWindow(page: Page): Promise<void> {
  await expect(page.getByTestId('window-from')).toBeVisible();
}

/** Opens a Report section (or Summary bar) by its id, if it is shut. */
export async function openSection(page: Page, id: string, title: string): Promise<void> {
  const button = page.locator(`section#${id}`).getByRole('button', { name: title, exact: true });
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
}
```

- [ ] **Step 3: Update the specs — the translation**

Apply this table everywhere it matches; each spec's comments that describe the old tabs are corrected in the same edit, never left describing them:

| Old | New |
|---|---|
| `${runPath(id)}/charts`, `runChartsPath(id)` | `${runPath(id)}/report` |
| `${runPath(id)}/load-generators`, `runTelemetryPath(id)` | `${runPath(id)}/report#load-generators` (or `/report` then `openSection(page, 'load-generators', 'Load generators')`) |
| `${runPath(id)}/errors`, `runErrorsPath(id)` | `runPath(id)` (the errors table is on the Summary, `#errors`) |
| tab link names `Overview`, `Charts`, `Load generators`, `Errors (N)`/`Errors` | `Summary`, `Report`, (section) `Load generators`, (none — the Summary) |
| a time-window step on the run's index page | navigate to `/report` first |
| the six live tiles, `live-stat-p99`, `live-stat-duration` | the four live tiles |
| `stat-throughput`, `stat-p99`, `stat-mean-response` | gone — read the Report's table if the case needs those numbers |
| the header's peak-users chip | `stat-peak-users` on the Summary |
| a chart in Offered load (`concurrent-users`, `user-start-rate`) | Report › Virtual users (open it first) |
| `requests-per-second`, `responses-per-second` on the run page | `requests-and-responses` (Report › Requests, and the Summary) |
| the statistics table, `stat-row*`, the glossary | Report › Requests › Table (click `Table` in `section#requests`) |
| `tool-assertion-row`, `tool-assertion-outcome`, `tool-assertions-toggle`, `platform-gates-toggle`, `assertion-row` | `simulation-card`, `simulation-outcome`, (none — the bar), (none), `gate-card` |

Then the cases that pin structure, file by file:

- `run-charts.spec.ts`: `CHART_IDS` becomes the Report's charts in document order with every section open: `requests-and-responses, percentiles, distribution, percentile-distribution, errors-over-time, indicators, request-counts, user-start-rate, user-end-rate, concurrent-users`. Every case that counted all charts first opens Virtual users. `every chart sits under the question it answers` becomes `every chart sits in its GE section`, mapping Requests → the first seven, Virtual users → the last three. `the requests/s and responses/s tables carry the API's own numbers…` becomes the combined chart's data table: its four columns against `/series`' `startedCount`, `endedCount`, `okCount`, `koCount` per bucket width. `the time-linked charts share one crosshair` uses the time charts now on the Report (`requests-and-responses`, `percentiles`, and the three Virtual users charts once opened).
- `run-tables.spec.ts`: the heading-outline case becomes two: the Summary's `['Platform gates', 'Simulation assertions', 'Over time', 'Errors']` and the Report's `['Time window', 'Requests', 'Groups', 'Virtual users', 'Connections', 'Load generators']` (h2 only). `the run totals come before the assertions, and near the top` checks `stat-error-rate`, `stat-total-requests`, `stat-p95`. Every statistics-table case opens Report › Requests › Table first. The errors cases run on the Summary. `the evidence sections say their verdicts are the whole run’s under a window` is deleted — the Summary never has a window; replace it with `the Summary ignores a window in its URL` (see Step 4). `the band’s link to a failed assertion names what it lands on` asserts the bar `section#simulation-assertions` is open after the click and its heading reads `Simulation assertions`.
- `run-detail.spec.ts`: `each tab is its own URL…` iterates the five tabs and asserts the three old URLs redirect (to `/report`, `/report#load-generators`, `/runs/:id#errors`) keeping `?from=&to=`. `the header states the run’s identity and its own peak` asserts the peak on `stat-peak-users`. `the errors tab counts distinct messages…` becomes `the errors table counts distinct messages, not failed requests` on the Summary (no tab count). `an unknown run section keeps the run on screen…` clicks `Report` instead of `Load generators`. `switching tabs does not remount the shell` clicks `Report`.
- `run-live.spec.ts`: the live tour visits Summary (four tiles, two live charts, live errors table) and Report (Requests' two live charts and five withheld notices; Virtual users' three live charts after opening it). The SLA-banner-follows-the-reader case uses Report as "the furthest page from the Summary".
- `time-window.spec.ts`, `acceptance.spec.ts`: navigate to `/report` where they used the run page or `/charts`; `acceptance.spec.ts`'s keyboard case targets `chart-data-requests-and-responses`.
- `run-telemetry.spec.ts`: open `/report#load-generators` (and `connections` for Bandwidth / Connections by state); the six figures now sit in two sections.
- `mobile.spec.ts`: the run-page cases run on the Summary; re-measure the 812 bound's anchor — it reads the first `section[aria-label="Run totals"] dd[data-testid^="stat-"]`, which is now `stat-error-rate`. Never loosen a bound: if the measured value moved, record old and new in the comment beside it.
- `run-logs.spec.ts`, `run-compare.spec.ts`: the `Overview` link name becomes `Summary`.

- [ ] **Step 4: Write the new spec**

Create `apps/web/e2e/run-summary-report.spec.ts`. `seedRunWithData` seeds the reference bundle (`ParitySimulation`, whose own `Search` p95 assertion fails), the same run `run-tables.spec.ts`' `openRun` uses:

```ts
import { expect, test, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { signIn } from './helpers.js';
import { runPath, runReportPath } from '../src/routes/paths.js';

/**
 * What only a browser can prove about backlog #7: GE's Summary ignores a
 * window (measured on GE), the Report's sections open by keyboard and reset on
 * reload (measured on GE), old tab URLs land where their content went, a
 * failing assertion bar is open on arrival (this product's one deviation), and
 * the Report's first charts begin on the first screen.
 */

async function seeded(page: Page): Promise<string> {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  return runId;
}

const TOTAL = 'stat-total-requests';

test('the Summary reads the same with a narrow window in its URL, as GE’s does', async ({ page }) => {
  const runId = await seeded(page);
  await page.goto(runPath(runId));
  const whole = (await page.getByTestId(TOTAL).textContent())?.trim() ?? '';
  expect(whole, 'the tile must read a number for this to compare anything').toMatch(/\d/);

  // The vacuity guard: the same window really does narrow the Report's table,
  // so a Summary that ignored it is ignoring something real.
  await page.goto(`${runReportPath(runId)}?from=0&to=5000`);
  await page.locator('section#requests').getByRole('button', { name: 'Table', exact: true }).click();
  const narrowed = (await page.getByTestId('stat-row-total').locator('td').first().textContent())?.trim();
  expect(narrowed).not.toBe(whole.match(/\d+/)?.[0]);

  await page.goto(`${runPath(runId)}?from=0&to=5000`);
  await expect(page.getByTestId(TOTAL)).toHaveText(whole);
});

const SECTIONS = [
  ['requests', 'Requests', true],
  ['groups', 'Groups', false],
  ['virtual-users', 'Virtual users', false],
  ['connections', 'Connections', false],
  ['load-generators', 'Load generators', false],
] as const;

test('a Report section opens by keyboard, and only Requests is open after a reload', async ({ page }) => {
  const runId = await seeded(page);
  await page.goto(runReportPath(runId));
  const groups = page.locator('section#groups').getByRole('button', { name: 'Groups', exact: true });
  // focus() then Enter, not Tab: whether Tab reaches a control is a macOS
  // keyboard preference in WebKit (CLAUDE.md, the skip-link case).
  await groups.focus();
  await page.keyboard.press('Enter');
  await expect(groups).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('section#groups').getByTestId('group-row').first()).toBeVisible();

  await page.reload();
  for (const [id, title, open] of SECTIONS) {
    await expect(page.locator(`section#${id}`).getByRole('button', { name: title, exact: true })).toHaveAttribute(
      'aria-expanded',
      String(open),
    );
  }
});

for (const [old, rest, hash] of [
  ['charts', '/report', ''],
  ['load-generators', '/report', '#load-generators'],
  ['errors', '', '#errors'],
] as const) {
  test(`the old /${old} URL lands on its new place, window kept`, async ({ page }) => {
    const runId = await seeded(page);
    await page.goto(`${runPath(runId)}/${old}?from=0&to=10000`);
    await expect(page).toHaveURL(new RegExp(`${runPath(runId)}${rest}\\?from=0&to=10000${hash}$`));
    if (old === 'load-generators') {
      await expect(
        page.locator('section#load-generators').getByRole('button', { name: 'Load generators', exact: true }),
      ).toHaveAttribute('aria-expanded', 'true');
    }
  });
}

test('an old /errors link keeps the request it was narrowed to', async ({ page }) => {
  const runId = await seeded(page);
  await page.goto(`${runPath(runId)}/errors?request=Place%20Order`);
  await expect(page).toHaveURL(new RegExp(`${runPath(runId)}\\?request=Place%20Order#errors$`));
  await expect(page.getByTestId('errors-request-filter')).toHaveValue('Place Order');
});

test('a failing simulation assertion is open on arrival', async ({ page }) => {
  const runId = await seeded(page);
  await page.goto(runPath(runId));
  const bar = page.locator('section#simulation-assertions');
  await expect(bar.getByRole('button', { name: 'Simulation assertions', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(bar.getByTestId('simulation-outcome').first()).toContainText(/failed/i);
});

test('the Report’s first Requests chart begins on the first 1440x900 screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const runId = await seeded(page);
  await page.goto(runReportPath(runId));
  const first = page.locator('section#requests').getByTestId('chart-requests-and-responses');
  await expect(first).toBeVisible();
  const box = await first.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  // MEASURED <write both numbers here>. The spec asks for the first chart ROW
  // inside 900px; the bound asserts what was measured, never a goal — if the
  // bottom is past 900, keep this `top` bound, record the bottom here, and
  // state the gap in the CLAUDE.md entry rather than loosening anything.
  expect(box.top).toBeLessThan(900);
});
```

Confirm `Place Order` is a request the reference run failed (its errors include it — `run-tables.spec.ts`' filter case narrows to it); if the fixture names it differently, use the name that case uses. Red-verify each case against one product mutation, restoring after each:

| Mutation | Must fail |
|---|---|
| `RunSummary`'s `statsQuery(id, null)` → the shell's window | the Summary-ignores-a-window case |
| `CollapsibleSection`: `useState(defaultOpen \|\| named)` → `useState(true)` | the keyboard-and-reload case |
| `RunSectionRedirect`: drop `${search}` | the three old-URL cases and the `/errors?request=` case |
| `SimulationAssertionsBar`: remove `defaultOpen` | the failing-assertion case |

- [ ] **Step 5: Run the suite**

`pnpm test:e2e > /tmp/t7-e2e.txt 2>&1; echo "exit=$?"` — from the worktree root, after `pnpm build`, against the scratch stores. Expected `exit=0` with the predicted count (168 − removed + added; count `test(`/`test.each` rows from the source before running and write the prediction down first). A failure that looks like missing data: re-run at `--workers=2`, per CLAUDE.md, before believing it.

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/helpers.ts apps/web/e2e/run-tables.spec.ts apps/web/e2e/run-detail.spec.ts apps/web/e2e/run-charts.spec.ts apps/web/e2e/run-live.spec.ts apps/web/e2e/time-window.spec.ts apps/web/e2e/run-telemetry.spec.ts apps/web/e2e/mobile.spec.ts apps/web/e2e/run-logs.spec.ts apps/web/e2e/run-compare.spec.ts apps/web/e2e/acceptance.spec.ts apps/web/e2e/run-summary-report.spec.ts
git commit -q -F - <<'MSG'
Move the browser suite to Summary and Report

Every spec that pinned the old tabs follows its content to its new place;
headings, chart lists and geometry are re-measured, not loosened. A new spec
proves what jsdom cannot: the Summary ignores a window, sections open by
keyboard and reset on reload, old URLs land where they should, a failing
assertion bar is open, and the Report's first charts fit the fold.
MSG
```

---

### Task 8: Verification, the CLAUDE.md entry, and the PR

**Files:** `CLAUDE.md`

- [ ] **Step 1: Predict the floors from the source, before any suite runs**

Count, and write down: unit = 181 files / 2313 tests + new unit files − removed unit files, and the case deltas (`grep -cE "^\s*(it|test)(\.each)?\("` per changed file, expanding each `it.each` by its rows); integration = 170 / 2086 + the `.ts` unit files added/removed and their cases (no `.integration.test.ts` changes); e2e = the Task 7 prediction.

- [ ] **Step 2: The five gates, in order, by their own exit codes**

`pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (zero `Errors` lines; then the zone-sensitive files under `TZ=UTC`), `pnpm test:integration`, `pnpm test:e2e` — the last two against the scratch database and Redis index, load gated (1-minute < 8 and 5-minute < 10, and `vm_stat` free pages checked) before each. Every total must equal its prediction; a mismatch is chased before anything else.

- [ ] **Step 3: A dispatched cross-browser run**

Push the branch, then `gh workflow run ci.yml --ref feat/summary-report` and read the `e2e-cross-browser` job's result for the pushed head — collapsible sections are where WebKit's visibility workaround has bitten this repository before.

- [ ] **Step 4: A real Gatling run through both pages**

Per the memory note on verifying with real runs: run a real Gatling simulation through the on-prem runner (or the Gradle plugin) against the developer database on its own Redis index, then open its Summary and Report in a browser at 1440×900 and at 375 px, in both themes: the four tiles, both bars (one open on a failure), the two charts, the errors table; each Report section opened in turn; an old `/charts` link. Revoke any token minted for it.

- [ ] **Step 5: The CLAUDE.md entry**

Update the floor sentence (`if a run reports fewer than **N files / M tests**`) to the measured unit floor, and add the branch's entry above the run-logs one, in this file's style: what GE was measured doing, the decisions and deviations, what moved and what died, the red-verify table, the geometry measured before and after, what was run and against which stores, and what is known and left (the pickers, the AI analysis #11, Groups unmeasured on GE, DNS/status/GC omitted).

- [ ] **Step 6: Commit, push, open the PR**

```bash
git add CLAUDE.md
git commit -q -F - <<'MSG'
Record the summary-report branch: <unit>, <integration>, <e2e>
MSG
git push -u origin feat/summary-report
```

Open one PR to `main` (`gh pr create --base main`), body summarising the change and the measured floors, no attribution lines. Merge only when the user says so, with `--merge`, after a SHA-pinned CI read.
