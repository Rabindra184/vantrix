import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveDelta, RunProcessing, RunResponse } from '@perfportal/contracts';
import { fetchRun, runQueryKey } from '../src/api/run';
import { useLiveRun } from '../src/api/live';
import useIsCompact from '../src/useIsCompact';
import RunDetail from '../src/routes/RunDetail';
import RunSummary from '../src/routes/RunSummary';

/**
 * `RunDetail`'s own remaining job (Task 7, design part 2b): choosing what
 * `identity`/`status`/`verdict`/`windowable`/`live` to hand `RunShell`, which
 * it now renders for EVERY resolved, non-error state — and gating the live
 * socket on the same `running && !compact` rule it always has.
 *
 * WHAT USED TO BE HERE. Before Task 7, a processing run rendered a whole
 * standalone `Processing` or `Live` screen INSTEAD of `RunShell` — no
 * `<Outlet/>` anywhere in either, which is what made the run-section URLs
 * resolve to nothing while a run was live. Both components, and the branch
 * that chose between them, are gone, and most of this file's old cases
 * asserted on UI (a distinct `<h1>`, a "still processing" screen with no tab
 * strip at all) that no longer exists to assert on.
 *
 * Every one of those old cases is accounted for in Task 7's report: moved
 * into `LiveStatusStrip.test.tsx` where the behaviour it pinned now lives,
 * confirmed already covered by an existing case there, or left below as an
 * `it.todo` naming the task that will re-cover it once the corresponding page
 * (the Summary, which the Overview and Errors tabs became, and the Report, which
 * the Charts tab did) wires in `WaitingPanel`/`LiveSummary`/the live
 * charts. None were silently dropped.
 *
 * FIX ROUND 1. `mountRun`'s index child is the REAL `RunSummary`, not a
 * placeholder — a placeholder could never have caught this tab rendering
 * BLANK for a processing run, which is exactly what it did until this round
 * wired `WaitingPanel` into it. Two of the `it.todo`s below are resolved by
 * that wiring and replaced with real cases; the rest still have no tab to
 * render against.
 */

vi.mock('../src/api/run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/run.js')>()),
  fetchRun: vi.fn(),
}));
vi.mock('../src/api/live.js', () => ({ useLiveRun: vi.fn() }));
vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));

const fetchRunMock = vi.mocked(fetchRun);
const useLiveRunMock = vi.mocked(useLiveRun);
const useIsCompactMock = vi.mocked(useIsCompact);

const RUN_ID = '00000000-0000-4000-8000-000000000001';

function processingBody(status: 'pending' | 'parsing' | 'running') {
  return { state: 'processing' as const, run: { id: RUN_ID, status, statusUrl: `/v1/runs/${RUN_ID}` } };
}

const RUNNING_IDENTITY: RunProcessing = {
  id: RUN_ID,
  status: 'running',
  statusUrl: `/v1/runs/${RUN_ID}`,
};

const COMPLETE_RUN: RunResponse = {
  id: RUN_ID,
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
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

function liveState(
  overrides: Partial<{
    connected: boolean;
    lastDelta: LiveDelta | null;
    unauthorized: boolean;
    partial: boolean;
  }> = {},
) {
  return { connected: true, lastDelta: null, unauthorized: false, partial: false, ...overrides };
}

/**
 * Mounts `RunDetail` inside a route WITH tab children — the shape that
 * actually exercises the reachability fix (Task 7's whole point): a tab URL
 * that resolves to something is only provable if there is a child route for
 * it to resolve TO. The index child is the REAL `RunSummary` (fix round
 * 1, IMPORTANT 4) — a placeholder div here could never catch this tab
 * rendering blank for a processing run, which is exactly the regression this
 * fix round closed by wiring `WaitingPanel` into it. `RunSummary`'s own
 * `run` query resolves from the SAME cache entry seeded below, so it does not
 * need `fetchRun` mocked any differently than `RunDetail`'s own.
 *
 * The query cache is SEEDED with `body` before the first render, rather than
 * mocking `fetchRun` and awaiting the fetch — `useQuery` reads pre-populated
 * cache data synchronously on first paint, so the assertions in the three new
 * cases below need no `await` at all, matching how they read in Task 7's
 * brief. `fetchRunMock` is still set (to the same body) so the background
 * refetch every un-`staleTime`'d query fires on mount resolves to something
 * consistent rather than to a stale mock from an earlier test.
 */
function mountRun(body: { state: 'processing' | 'ready'; run: unknown }) {
  fetchRunMock.mockResolvedValue(body as never);
  useLiveRunMock.mockReturnValue(liveState());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runQueryKey(RUN_ID), body);
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}`]}>
        <Routes>
          <Route path="/runs/:runId" element={<RunDetail />}>
            <Route index element={<RunSummary />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return {
    ...utils,
    /**
     * Re-seeds the SAME client's cache with a new body and flushes the
     * resulting re-render — `runQueryKey` never changes (one run, one page),
     * so this is exactly what a poll or a live-status transition does in the
     * running app, just driven directly instead of through a fake timer.
     */
    async rerenderAs(nextBody: { state: 'processing' | 'ready'; run: unknown }) {
      fetchRunMock.mockResolvedValue(nextBody as never);
      await act(async () => {
        client.setQueryData(runQueryKey(RUN_ID), nextBody);
      });
    },
  };
}

afterEach(() => {
  cleanup();
  fetchRunMock.mockReset();
  useLiveRunMock.mockReset();
  useIsCompactMock.mockReset();
  useIsCompactMock.mockReturnValue(false);
  vi.unstubAllGlobals();
});

describe('RunDetail — one shell, for every state', () => {
  it('renders the tab strip for a run that is only pending', () => {
    // Before Task 7 this rendered the standalone Processing screen and the
    // tab URLs resolved to nothing at all.
    mountRun({ state: 'processing', run: { id: RUN_ID, status: 'pending', statusUrl: '/x' } });
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
    // The tab is not BLANK either — the real `RunSummary` this test
    // mounts (fix round 1, IMPORTANT 4) shows `WaitingPanel`'s own sentence
    // rather than nothing.
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
  });

  it('keeps the tab strip across running -> parsing -> complete', async () => {
    // A terminal run's shell fetches `/users` and `/errors` (RunShell's own
    // `terminal` gate), and `RunSummary`'s own `/stats` once `ready` —
    // stubbed here so the `ready` transition below doesn't reach for a real
    // network in jsdom.
    vi.stubGlobal(
      'fetch',
      () => Promise.resolve(new Response(JSON.stringify({ runId: RUN_ID, errors: [] }), { status: 200 })),
    );

    const { rerenderAs } = mountRun({ state: 'processing', run: RUNNING_IDENTITY });
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();

    await rerenderAs({ state: 'processing', run: { ...RUNNING_IDENTITY, status: 'parsing' } });
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();

    await rerenderAs({ state: 'ready', run: COMPLETE_RUN });
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
    // The page has left `WaitingPanel` behind now that the run is `ready` —
    // the Platform gates bar's own summary renders instead (`COMPLETE_RUN`
    // declares no rule), which is proof this is the real content branch, not a
    // stale waiting screen.
    expect(screen.queryByText(/still processing/i)).not.toBeInTheDocument();
    /* SCOPED TO THE BAR, because the decision band at the top of the same page
       says the identical words ("Platform gates: not configured — no SLA rule
       judged this run") and a page-wide query would find both. The assertion
       still proves this is the real content branch — it just names the bar that
       holds it. */
    expect(
      within(screen.getByTestId('section-platform-gates')).getByText('not configured — no SLA rule judged this run'),
    ).toBeInTheDocument();
  });

  it('renders the shell even when the 202 carried no identity', () => {
    // An old API pod mid-deploy. Thin header, real tabs, no crash.
    mountRun({ state: 'processing', run: { id: RUN_ID, status: 'running', statusUrl: '/x' } });
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Run /);
  });

  /**
   * The exact expression design §4.1 names: `run.status === 'running' &&
   * !useIsCompact()`. Table-driven so the four combinations this boolean can
   * take are all pinned in one place, rather than trusted to hold by
   * induction from the one or two cases a narrower test would cover.
   *
   * KEPT FROM THE OLD FILE, adapted only in what it waits on: this claim is
   * about the ARGUMENTS `RunDetail` calls `useLiveRun` with, a piece of
   * wiring Task 7 left completely unchanged, not about which screen renders.
   */
  it.each([
    { status: 'running' as const, compact: false, expected: true },
    { status: 'running' as const, compact: true, expected: false },
    { status: 'pending' as const, compact: false, expected: false },
    { status: 'parsing' as const, compact: false, expected: false },
  ])('gates the socket on running && !compact ($status, compact=$compact) -> $expected', async ({
    status,
    compact,
    expected,
  }) => {
    useIsCompactMock.mockReturnValue(compact);
    mountRun(processingBody(status));

    await screen.findByRole('navigation', { name: 'Run sections' });

    expect(useLiveRunMock).toHaveBeenCalledWith(RUN_ID, expected);
  });

  /**
   * Fix round 1's Ruling: `WaitingPanel` is wired into `RunSummary` now,
   * closing two of the `it.todo`s the original Task 7 report left behind —
   * this and the case below replace them (their names are preserved in a
   * comment at the old `it.todo` site so the history stays legible).
   */
  it('shows WaitingPanel, not a live summary, while running with no delta yet', () => {
    useLiveRunMock.mockReturnValue(liveState({ lastDelta: null }));
    mountRun({ state: 'processing', run: RUNNING_IDENTITY });
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
    // No live tiles either — `LiveSummary` is not wired in yet (Task 8);
    // asserting its absence here is what stops that wiring landing silently
    // duplicated, unnoticed, beside `WaitingPanel`.
    expect(screen.queryByTestId('live-stat-total-requests')).not.toBeInTheDocument();
  });

  it('shows WaitingPanel for a run never live this session (pending)', () => {
    mountRun({ state: 'processing', run: { id: RUN_ID, status: 'pending', statusUrl: '/x' } });
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
  });

  /**
   * A completed run carrying three platform gates, ONE of them failed.
   *
   * Shared by the two cases below because they assert different halves of one
   * render — that the evidence is stated once, as a card per gate, and that the
   * bar opens on the failure. Seeding it twice would let the two drift into
   * disagreeing about what "three gates" means.
   */
  function seedThreeGates() {
    vi.stubGlobal(
      'fetch',
      () => Promise.resolve(new Response(JSON.stringify({ runId: RUN_ID, errors: [] }), { status: 200 })),
    );

    mountRun({
      state: 'ready',
      run: {
        ...COMPLETE_RUN,
        verdict: 'failed',
        assertions: [
          {
            ruleId: '22222222-2222-4222-8222-222222222222',
            outcome: 'failed',
            actualValue: 1830,
            message: 'p99 breached its threshold.',
            rule: {
              scope: 'run',
              targetName: null,
              family: 'response_time',
              metric: 'p99',
              comparator: 'lte',
              threshold: 750,
            },
          },
          {
            ruleId: '33333333-3333-4333-8333-333333333333',
            outcome: 'passed',
            actualValue: 92,
            message: 'Throughput stayed above target.',
            rule: {
              scope: 'run',
              targetName: null,
              family: 'response_time',
              metric: 'throughput_rps',
              comparator: 'gte',
              threshold: 80,
            },
          },
          {
            ruleId: '44444444-4444-4444-8444-444444444444',
            outcome: 'not_applicable',
            actualValue: null,
            message: 'No matching request was measured.',
            rule: {
              scope: 'request',
              targetName: 'POST /checkout',
              family: 'response_time',
              metric: 'p95',
              comparator: 'lte',
              threshold: 500,
            },
          },
        ],
      },
    });
  }

  /**
   * ═══ ONE EVIDENCE SURFACE, NOT THREE (review.md 9) ═══
   *
   * This asserted an `assertion-evidence-panel` above the gates table, carrying
   * the failure's message and three count tiles. Every one of those facts is
   * stated elsewhere on the same screen — the decision band spells the counts
   * as a sentence AND as tiles and links to the first failure, and the evidence
   * below carries the message — so the panel was length without information,
   * and it is gone.
   *
   * The CLAIM survives and is what is asserted now: the evidence is on the
   * page, as one card per gate, exactly once. The panel's absence sits beside
   * the cards' presence, because an absence alone passes against a page that
   * rendered nothing at all.
   *
   * WHAT THIS CASE IS FOR NOW IS THE SEAM. The gate card's own wording — the
   * rule title, the not-applicable reason and its dash — is pinned where
   * the card is built (`AssertionBars.test.tsx`), which is where it died with
   * the table that used to hold it here. This mounts the real run page, so it is
   * the one place that proves `RunSummary` hands the run's own gates to the bar.
   */
  it('states the SLA evidence once, as a card per gate, with no summary repeating it', () => {
    seedThreeGates();

    // `getAllBy…`, not `getBy…`: three gates, three cards. The failed gate
    // sorts first, so the first card is the failure — named in the reader's
    // vocabulary, never the stored `p99 breached its threshold.`, and carrying
    // the run's own actual. Since the clean-UI pass a judged gate states its
    // rule and its actual and no sentence restating both (`AssertionBars`).
    const cards = screen.getAllByTestId('gate-card');
    expect(cards).toHaveLength(3);
    const failure = within(cards[0]!);
    expect(failure.getByText('Whole-run p99 response time ≤ 750 ms')).toBeInTheDocument();
    expect(cards[0]).toHaveTextContent(/Actual:\s*1830 ms/);
    expect(failure.getByTestId('gate-outcome')).toHaveTextContent(/failed/);
    expect(cards[0]).not.toHaveTextContent(/breached its threshold/);
    expect(screen.queryByTestId('assertion-evidence-panel')).toBeNull();
  });

  /**
   * ═══ AND THE BAR OPENS ON THE FAILURE (review.md 9, and GE's own bar) ═══
   *
   * "Collapse passed checks by default" used to be a table that filed the
   * passing gates behind an `Other gates (N)` control. A bar is the collapse
   * now — one disclosure over all of them — so the claim is that the page
   * arrives with the failure already on screen and the bar saying what the
   * three gates came to, which is how a reader meets a failed gate on a run
   * they did not watch finish.
   *
   * ITS OWN CASE, not folded into the one above. Both claims were asserted
   * together at first, and both mutations — restoring the panel, and shutting
   * the bar — then failed the same case, which proves one thing twice.
   */
  it('arrives open on a failed gate, and says what the gates came to', () => {
    seedThreeGates();

    const bar = screen.getByTestId('section-platform-gates');
    expect(within(bar).getByRole('button', { name: 'Platform gates' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(bar).getByText('1 failed, 1 passed, 1 not applicable')).toBeInTheDocument();
  });
});

/* ======================================================================== *
 * Cases from the pre-Task-7 file, accounted for individually.
 *
 * Every one below asserted on `Processing` or `Live`, both deleted. None of
 * them can be adapted to render the deleted component, so none can be
 * literally "moved" the way a claim about `LiveStatusStrip` can — a target
 * that does not exist yet cannot receive a test. Where the CLAIM is already
 * proven by an existing case elsewhere, that is noted and the case is not
 * reproduced (a passing duplicate is not extra coverage). Where it is not,
 * it is left here as `it.todo`, named for the task that will give it a real
 * home: Task 8 (the Summary, then the Overview tab: `WaitingPanel`,
 * `LiveSummary`), Task 9 (the Report, then the Charts tab: the live charts, the
 * DesktopOnly-gated withheld notices for distribution/percentile-distribution),
 * or Task 10 (the Summary's errors table, then the Errors tab's, and the
 * Report's errors-per-second withheld notice).
 * ======================================================================== */

/**
 * Every claim below is now RESOLVED — Tasks 8, 9 and 10 each wired a real
 * page and each has its own `*.live.test.tsx` file (the Overview and Errors
 * tabs' two became `RunSummary.live.test.tsx`), so nothing here still needs a
 * target that does not exist. Kept as a plain comment block, not a `describe`
 * with no `it`s inside it, so the history of what moved where stays legible
 * without an empty suite in the file.
 *
 * Old: "renders the live page once a delta has arrived for a running run".
 * Its connection-message and finalizing-notice-absent halves are now
 * `LiveStatusStrip.test.tsx`'s "says the run is live while it streams and
 * the socket is up" (extended in Task 7 to also assert the finalizing
 * notice's absence). The remaining claim — exactly four withheld-chart
 * notices appear once a delta has arrived — RESOLVED across the pages that now
 * split it: `RunReport.live.test.tsx`'s "draws the live figures and states the
 * five that are withheld" (five now: the Charts tab's two, Errors per second's,
 * and the two charts it used to omit). The Summary withholds nothing it never
 * drew: the statistics table the first notice named is in the Report, and the
 * errors chart the last one named is in the Report's Requests section — while
 * the errors TABLE stays live on the Summary, `RunSummary.live.test.tsx`'s
 * "keeps the errors table live, off the cache the delta writes".
 *
 * Old: "keeps the ordinary Processing screen while running with no delta
 * yet" / "...for a run never live this session". RESOLVED in fix round 1:
 * `WaitingPanel` is wired into `RunSummary` now — see "shows
 * WaitingPanel, not a live summary, while running with no delta yet" and
 * "shows WaitingPanel for a run never live this session (pending)" above.
 *
 * Old: "freezes the dashboard under a finalizing banner once streaming
 * stops". The banner itself is `LiveStatusStrip.test.tsx`'s "says streaming
 * stopped once the run leaves running"; the remaining claim — the live
 * tiles (`LiveSummary`) stay on screen, unblanked, underneath that banner —
 * RESOLVED in Task 8: `RunSummary.live.test.tsx`'s "keeps the tiles on
 * screen, unblanked, once the run has left running" mounts the real page
 * with the socket down, so a tile read off the connection would vanish.
 *
 * Old: "reads its headline tiles straight off the delta summary, not a
 * StatRow" / "drops the 'still streaming' hint once the run has frozen".
 * The first is `LiveSummary`'s own behaviour — RESOLVED:
 * `RunSummary.live.test.tsx`'s "shows GE’s four live tiles, in GE’s order,
 * while a run streams" (reads `count`/`errorRate`/`maxUsers`/`percentiles`
 * straight off a `LiveDelta` fixture, never a `StatRow`). The second died with
 * the live Duration tile that carried the hint: the live row is GE's four now,
 * the same as the finished one, and duration is `RunHeader`'s chip.
 *
 * Old: "draws the live charts from whatever the socket already wrote to the
 * cache" / "gates the charts and the three withheld notices behind
 * DesktopOnly on a narrow viewport". RESOLVED in Task 9:
 * `RunReport.live.test.tsx`'s "draws the live figures and states the five that
 * are withheld" (seeds the cache directly, at the SAME keys
 * `applyDelta` writes, rather than mocking a fetch) and "gates the live
 * charts behind DesktopOnly on a narrow viewport".
 *
 * Old: "draws the live-fed errors table" / "states the errors-over-time
 * chart is withheld". RESOLVED in Task 10: the table half is
 * `RunSummary.live.test.tsx`'s "keeps the errors table live, off the cache the
 * delta writes" (folded in from the Errors tab's own file); the chart half is
 * the Report's "Errors per second" notice above.
 *
 * NOT carried forward, and deliberately never given an `it.todo`: "renders
 * nothing if handed a null lastDelta" defended `Live`'s own `if (delta ===
 * null) return null` branch, which no longer exists anywhere — nothing in
 * the new architecture renders a whole page conditionally on `lastDelta`, so
 * there is no successor branch for any task to guard either.
 */
