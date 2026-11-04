import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunProcessing, RunResponse } from '@perfportal/contracts';
import { runQueryKey } from '../src/api/run';
import RunCompare from '../src/routes/RunCompare';
import { runMinuteLabel } from '../src/charts/transforms/runLabel';
import { formatCell } from '../src/charts/DataTable';
import type { RunWindowContext } from '../src/routes/useRunWindow';
import { UNKNOWN_ACCESS } from './support/access';
import fixture from './fixtures/reference-run.json';

/**
 * MINOR 5. `/runs/:runId/compare` is a sixth `<Outlet/>` child under
 * `RunShell`, and it has to follow the same terminal gate as the rest of the
 * run sections. Before this fix, `trendsQuery` fired with no `terminal` gate
 * at all — the same class of defect the other sections were audited for, just
 * on the compare route.
 *
 * Mounted the same way `RunTrends.live.test.tsx` mounts its own tab, under a
 * stand-in for `RunShell`'s `<Outlet context={{...}} />` with the `run`
 * query cache pre-seeded so `useRunTerminal`'s read resolves synchronously.
 */

const RUN_ID = '00000000-0000-4000-8000-000000000002';

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

// `test` is REQUIRED by TrendsResponseSchema, and `apiFetch` parses through
// it — a fixture missing it fails validation and the component renders its
// error state, which is why leaving it out made two cases fail looking for
// prose that was never reached.
const EMPTY_TRENDS = {
  runId: RUN_ID,
  simulation: COMPLETE_RUN.simulation,
  test: { id: '99999999-9999-4999-8999-999999999999', slug: 'example-paritysimulation', name: 'example.ParitySimulation' },
  cohortSize: 1,
  runs: [],
};

function processing(status: RunProcessing['status']) {
  return { state: 'processing' as const, run: { id: RUN_ID, status, statusUrl: `/v1/runs/${RUN_ID}` } };
}

/** Reports the live query string, so a URL write can be asserted — and how
 *  the last navigation was made, so `replace: true` can be. */
const Where = () => (
  <>
    <span data-testid="where">{useLocation().search}</span>
    <span data-testid="how">{useNavigationType()}</span>
  </>
);

function renderCompare(
  body: ReturnType<typeof processing> | { state: 'ready'; run: RunResponse },
  trends: unknown = EMPTY_TRENDS,
  search = '',
  /** What `/stats` answers for every selected run. Unset, it falls through to
   *  the run body below, which fails the stats schema — every case before the
   *  ≈ cases relied on that and drew no summary or matrix. */
  stats?: unknown,
  /** Answers any other URL a case cares about; `undefined` falls through. A
   *  promise is awaited, so a case can hold one read open and release it. */
  answer?: (url: string) => unknown,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runQueryKey(RUN_ID), body);

  // `current` is what the `/v1/runs/:id` stub answers with — a MUTABLE
  // reference, not the `body` parameter closed over at call time, because
  // `runQueryKey` has no `staleTime` (`pollIntervalFor` needs it
  // refetchable) and mounting this component fires a background refetch
  // immediately. Without this, that refetch resolves with the ORIGINAL body
  // some time after `rerenderAs` has already written the NEW one, and
  // "whichever write resolves last" wins — silently reverting the
  // transition `rerenderAs` exists to prove survives.
  // `RunTrends.live.test.tsx`'s `renderTrends` solves the identical race the
  // identical way.
  let current = body;
  const fetchSpy = vi.fn<(input: RequestInfo) => Promise<Response>>(async (input) => {
    const url = String(input);
    if (url.includes('/trends')) {
      return new Response(JSON.stringify(trends), { status: 200 });
    }
    if (stats !== undefined && url.includes('/stats')) {
      return new Response(JSON.stringify(stats), { status: 200 });
    }
    const answered = await answer?.(url);
    if (answered !== undefined) {
      return new Response(JSON.stringify(answered), { status: 200 });
    }
    // Reads `current` AFTER a microtask, not at call time — see the comment
    // above on why the read has to be deferred for a same-tick `rerenderAs`
    // to win the race.
    await Promise.resolve();
    return new Response(JSON.stringify(current.run), { status: current.state === 'ready' ? 200 : 202 });
  });
  vi.stubGlobal('fetch', fetchSpy);

  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}/compare${search}`]}>
        <Routes>
          <Route
            path="/runs/:runId"
            element={
              <Outlet
                context={
                  { window: null, durationMs: null, liveDurationMs: null, warmupMs: null, live: null, projectAccess: UNKNOWN_ACCESS } satisfies RunWindowContext
                }
              />
            }
          >
            <Route path="compare" element={<RunCompare />} />
          </Route>
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return {
    ...utils,
    client,
    fetchSpy,
    /** Re-seeds the SAME client's cache and flushes the resulting re-render —
     *  exactly what `RunDetail`'s own poll does when a run's status changes. */
    async rerenderAs(nextBody: ReturnType<typeof processing> | { state: 'ready'; run: RunResponse }) {
      current = nextBody;
      await act(async () => {
        client.setQueryData(runQueryKey(RUN_ID), nextBody);
      });
    },
  };
}

afterEach(cleanup);

describe('RunCompare — terminal gate (MINOR 5)', () => {
  it.each(['pending', 'parsing', 'running'] as const)(
    'withholds the comparison while the run is %s, the same wording RunTrends uses',
    (status) => {
      renderCompare(processing(status));
      expect(screen.getByTestId('live-notice-withheld')).toHaveTextContent(/compare/i);
    },
  );

  it('does not fetch /trends while the run this page compares FROM is not terminal', () => {
    const { fetchSpy } = renderCompare(processing('running'));
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/trends'))).toBe(false);
  });

  it('fetches /trends once the run is terminal', async () => {
    const { fetchSpy } = renderCompare({ state: 'ready', run: COMPLETE_RUN });
    await screen.findByText(/nothing to compare yet/i);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/trends'))).toBe(true);
  });

  /**
   * THE TRANSITION THIS FIX ROUND'S GAP LEFT UNGUARDED. Every hook in
   * `RunCompare` sits above its `!terminal` early return today, but nothing
   * PINS that shape — each case above mounts a single, fixed state, so
   * moving the return above even one hook (e.g. `useQueries` for
   * `seriesResults`) would still pass all of them and only break on an
   * already-mounted instance whose `terminal` flips false -> true,
   * "Rendered more hooks than during the previous render."
   * `RunTrends.live.test.tsx`'s "survives a running run finishing while the
   * reader is on this tab" is the identical guard for that tab; this is
   * `RunCompare`'s own — the compare route needs the same hook-order guard.
   */
  it('survives a running run finishing while the reader is on this tab', async () => {
    const { rerenderAs } = renderCompare(processing('running'));
    expect(screen.getByTestId('live-notice-withheld')).toHaveTextContent(/compare/i);

    await expect(rerenderAs({ state: 'ready', run: COMPLETE_RUN })).resolves.toBeUndefined();

    // Past the withheld notice now — the real (empty-cohort) content.
    await waitFor(() => expect(screen.queryByTestId('live-notice-withheld')).toBeNull());
    expect(await screen.findByText(/nothing to compare yet/i)).toBeInTheDocument();
  });
});

/**
 * REVIEW M20 — AN EMPTY STATE THAT NAMES ITS OWN REMEDY.
 *
 * "Nothing to compare yet" said exactly what was missing and then left the
 * reader on a page with no way to supply it. These are valid data states with
 * incomplete workflows, not errors.
 *
 * The destination differs by CAUSE — a lone run of a KNOWN test needs another
 * run of that test, which is what the test's own page lists, while a run with
 * no test needs the project's runs. `EMPTY_TRENDS` carries a test, so this
 * pins the first; the second branch is the same `data.test === null`
 * discriminant the body copy above it already switches on.
 */
describe('RunCompare — the empty state offers a way on', () => {
  it('points a lone run of a known test at that test’s own runs', async () => {
    renderCompare({ state: 'ready', run: COMPLETE_RUN });
    const link = await screen.findByRole('link', { name: /every run of/i });
    expect(link).toHaveAttribute('href', '/projects/checkout/tests/example-paritysimulation');
  });

  it('still says what is missing, rather than replacing the explanation', async () => {
    renderCompare({ state: 'ready', run: COMPLETE_RUN });
    expect(await screen.findByText(/only completed run/i)).toBeInTheDocument();
  });
});


/**
 * ═══ WHAT A READER IS CHOOSING BETWEEN (review.md 17) ═══
 *
 * The picker labelled every candidate with a bare timestamp — `09-13 11:31` —
 * which "distinguishes records mechanically but does not tell an engineer which
 * build or environment they are choosing".
 *
 * The time STAYS the primary line: `labelFor` also names the overlay's series
 * and the matrix's columns, so a chip that dropped it would leave the reader
 * matching a picker against a legend by eye. What is added is everything else
 * they need to recognise it.
 */
/** A cohort row, varied only where a case cares. */
const cohortRunAt = (over: Record<string, unknown>) => ({
  id: RUN_ID,
  startedAt: '2026-08-15T12:00:00.000Z',
  toolStartedAt: '2026-08-15T12:00:00.000Z',
  durationMs: 63_161,
  verdict: 'passed',
  count: 895,
  okCount: 871,
  koCount: 24,
  errorRate: 0.0268,
  minMs: 12,
  maxMs: 2503,
  meanMs: 228,
  throughputRps: 14.4,
  percentiles: { p95: 646 },
  ...over,
});

const OTHER = '00000000-0000-4000-8000-0000000000ff';
/** A third candidate, so the picker has a chip that is NOT already pressed:
 *  `parseCompareSelection` opens with the current run AND its nearest
 *  neighbour, so a two-run cohort has nothing left to tick. */
const THIRD = '00000000-0000-4000-8000-0000000000aa';
const populated = (runs: unknown[]) => ({ ...EMPTY_TRENDS, cohortSize: runs.length, runs });


describe('RunCompare — the picker says which run each candidate is', () => {
  /**
   * TICKING A RUN MUST NOT DISCARD THE REST OF THE QUERY STRING.
   *
   * `toggle` wrote `setParams({ runs })` — an OBJECT, which React Router reads
   * as the COMPLETE new search string — while `setMetric` forty lines above
   * copies `params` first. Two view-state writes in one file, each arguing
   * `replace: true` in its own comment, disagreeing about what `replace` means.
   *
   * What it costs is two different things, and the second is the quiet one:
   *
   *   metric   owned by THIS page. Chosen so a shared link carries the QUESTION
   *            and not just the runs, and silently reset to p95 on every tick.
   *   from/to  the analysis window. `useWindowSuffix` builds the tab links FROM
   *            the current params, so the window is not hidden — it is gone, and
   *            the brush is deliberately withheld on Compare, so nothing on
   *            screen changes at the moment it is lost.
   */
  it('keeps the window and the metric when a run is ticked', async () => {
    renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      populated([
        cohortRunAt({}),
        cohortRunAt({ id: OTHER, startedAt: '2026-08-15T11:00:00.000Z', toolStartedAt: '2026-08-15T11:00:00.000Z' }),
        cohortRunAt({ id: THIRD, startedAt: '2026-08-15T10:00:00.000Z', toolStartedAt: '2026-08-15T10:00:00.000Z' }),
      ]),
      '?from=1000&to=5000&metric=errors',
    );

    // The fixture has to be able to tell the two answers apart: a run that is
    // already selected would make `toggle` a no-op on the selection and the
    // assertion would pass against a page that never wrote the URL at all.
    const chip = await screen.findByTestId(`compare-run-${THIRD}`);
    const before = screen.getByTestId('where').textContent ?? '';
    expect(before).toContain('from=1000');
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(chip);

    const after = new URLSearchParams(screen.getByTestId('where').textContent ?? '');
    expect(after.get('runs'), 'the tick itself still lands').toContain(THIRD);
    expect(after.get('from'), 'the analysis window survives a tick').toBe('1000');
    expect(after.get('to')).toBe('5000');
    expect(after.get('metric'), 'the question the link was sharing survives').toBe('errors');
  });

  it('names the conditions a run carries, and says nothing for one that carries none', async () => {
    renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      populated([
        cohortRunAt({ environment: 'production', branch: 'main', commitSha: 'a1b2c3d4e5f6' }),
        cohortRunAt({ id: OTHER, startedAt: '2026-08-15T11:00:00.000Z', toolStartedAt: '2026-08-15T11:00:00.000Z' }),
      ]),
    );

    const chip = await screen.findByTestId(`compare-run-${RUN_ID}`);
    // Eight characters of the sha, matching the run header's own short form.
    expect(chip).toHaveTextContent('production · main · a1b2c3d4');
    // AND THE OMISSION IS THE OTHER HALF. A run that recorded nothing gets no
    // dash and no "unknown" — the comparability panel below already states
    // missing evidence in the one place it changes what a comparison means, and
    // a chip repeating it would spend its one spare line on a non-fact.
    expect(screen.getByTestId(`compare-run-${OTHER}`)).not.toHaveTextContent('·');
  });

  /**
   * The chip names the REFERENCE the tiles and the table measure from —
   * `resolveReference`'s answer — so it has to be the run the table leads
   * with. A chip naming any other run would be worse than no label, because
   * it reads as evidence.
   */
  it('marks which run is current and which one the deltas are measured against', async () => {
    renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      populated([
        cohortRunAt({}),
        cohortRunAt({ id: OTHER, startedAt: '2026-08-15T11:00:00.000Z', toolStartedAt: '2026-08-15T11:00:00.000Z' }),
      ]),
      '',
      fixture.stats,
    );

    expect(await screen.findByTestId(`compare-role-${OTHER}`)).toHaveTextContent('Reference');
    expect(screen.getByTestId(`compare-role-${RUN_ID}`)).toHaveTextContent('Current');
    expect(screen.getByTestId(`compare-role-${RUN_ID}`)).not.toHaveTextContent('Reference');
    // The same run the table leads with.
    expect(screen.getAllByTestId('compare-column')[0]).toHaveAttribute('data-reference', 'true');
    expect(screen.queryByText('Baseline')).toBeNull();
  });

  /**
   * PINNED ON THE CURRENT RUN, the chip says both and the tile states the
   * other run against it — so the tile cannot be labelled as though the
   * current run were its subject.
   */
  it('follows a pin on the current run, in the chip and the tile', async () => {
    renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      populated([
        cohortRunAt({ runNumber: 2 }),
        cohortRunAt({ id: OTHER, runNumber: 1, startedAt: '2026-08-15T11:00:00.000Z', toolStartedAt: '2026-08-15T11:00:00.000Z' }),
      ]),
      `?ref=${RUN_ID}`,
      fixture.stats,
    );

    const current = await screen.findByTestId(`compare-role-${RUN_ID}`);
    await waitFor(() => expect(current).toHaveTextContent('Reference'));
    expect(current).toHaveTextContent('Current');
    expect(screen.queryByTestId(`compare-role-${OTHER}`)).toBeNull();

    const summary = screen.getByRole('region', { name: 'Comparison summary' });
    expect(summary).not.toHaveTextContent(/current vs/i);
    expect(summary).toHaveTextContent('Run 1 against Run 2');
  });

  /** A numbered cohort: each chip is NAMED by its number, with the start time
   *  kept as its second line — Gatling Enterprise's picker reads the same. */
  it('names each numbered candidate "Run n", its start time beneath', async () => {
    renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      populated([
        cohortRunAt({ id: RUN_ID, runNumber: 2 }),
        cohortRunAt({ id: OTHER, runNumber: 1, toolStartedAt: '2026-08-14T09:30:00.000Z', startedAt: '2026-08-14T09:30:00.000Z' }),
      ]),
    );

    const chip = await screen.findByTestId(`compare-run-${OTHER}`);
    expect(chip).toHaveTextContent('Run 1');
    expect(chip).toHaveTextContent(runMinuteLabel('2026-08-14T09:30:00.000Z'));
    expect(chip.getAttribute('aria-label')).toMatch(/^Run 1 · /);
    expect(screen.getByTestId(`compare-run-${RUN_ID}`)).toHaveTextContent('Run 2');
  });
});


/**
 * ═══ WHICH CONDITIONS DIFFER, NOT THAT SOME DO (review.md 19) ═══
 *
 * The panel opened with "These runs differ in ways that change what a
 * comparison means" over six facts shown whether or not they said anything.
 * That sentence is true of every non-matching selection and actionable for
 * none of them.
 */
describe('RunCompare — the comparability notice is concise', () => {
  const differing = () =>
    populated([
      cohortRunAt({ environment: 'production', branch: 'main', commitSha: 'a1b2c3d4e5' }),
      cohortRunAt({
        id: OTHER,
        startedAt: '2026-08-15T11:00:00.000Z',
        toolStartedAt: '2026-08-15T11:00:00.000Z',
        environment: 'staging',
        branch: 'feature/cart',
        commitSha: 'ffeeddccbb',
      }),
    ]);

  it('names the dimensions that differ instead of warning in general', async () => {
    renderCompare({ state: 'ready', run: COMPLETE_RUN }, differing());

    const panel = await screen.findByTestId('comparability');
    expect(panel).toHaveTextContent('Different environment, branch and build');
    // The retired sentence must not come back. Asserted as an absence beside
    // the positive above, because an absence alone passes against a panel that
    // failed to render at all.
    expect(panel).not.toHaveTextContent('ways that change what a comparison means');
  });

  /**
   * "Details available" is the other half of the finding — the six facts are
   * FILED, not deleted. The ones that MATCH are what a reader needs to conclude
   * a comparison is sound rather than merely un-flagged, so they survive too.
   *
   * Asserted on the `open` attribute, never on visibility: jsdom keeps a closed
   * disclosure's children queryable, which is why `queryByTestId` would find
   * these either way.
   */
  it('files the per-dimension facts behind a disclosure, shut when the headline already said it', async () => {
    renderCompare({ state: 'ready', run: COMPLETE_RUN }, differing());

    const details = await screen.findByTestId('comparability-details');
    expect(details).toHaveProperty('open', false);
    expect(within(details).getByTestId('comparability-environment')).toHaveTextContent('production');
  });

  /**
   * AND OPEN WHEN EVERYTHING MATCHES, which is the case the pair exists for: the
   * headline is then six words with no detail in it, and this is the only place
   * the evidence lives. A disclosure that was always shut would hide the answer
   * exactly when it is the whole answer.
   */
  it('opens the facts when the runs match, since the headline then carries none', async () => {
    const same = { environment: 'production', branch: 'main', commitSha: 'a1b2c3d4e5' };
    renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      populated([
        cohortRunAt(same),
        cohortRunAt({
          ...same,
          id: OTHER,
          startedAt: '2026-08-15T11:00:00.000Z',
          toolStartedAt: '2026-08-15T11:00:00.000Z',
        }),
      ]),
    );

    const details = await screen.findByTestId('comparability-details');
    expect(details).toHaveProperty('open', true);
  });
});

/**
 * ═══ ≈ FOLLOWS EACH SELECTED RUN'S OWN `statsMethod` ═══
 *
 * The seam the pure cases cannot reach: the page reads each run's
 * `statsMethod` off the COHORT (`/trends`) and hands it to the matrix and the
 * summary per run. An estimated baseline marks its own column header, the
 * Change column and the delta tile — and leaves the current, exact run's
 * header bare. Both directions, because a ≈ on an exact run is as false as a
 * missing one on an estimate. The default metric is p95, a percentile.
 */
describe('RunCompare — ≈ marks an estimated run’s figures', () => {
  const cohort = (otherMethod: 'estimated' | 'exact-v1') =>
    populated([
      cohortRunAt({ statsMethod: 'exact-v1' }),
      cohortRunAt({
        id: OTHER,
        startedAt: '2026-08-15T11:00:00.000Z',
        toolStartedAt: '2026-08-15T11:00:00.000Z',
        statsMethod: otherMethod,
      }),
    ]);

  const currentLabel = runMinuteLabel('2026-08-15T12:00:00.000Z');
  const otherLabel = runMinuteLabel('2026-08-15T11:00:00.000Z');

  it('marks the estimated baseline’s column, the change and the delta, not the exact run', async () => {
    renderCompare({ state: 'ready', run: COMPLETE_RUN }, cohort('estimated'), '', fixture.stats);

    // The other run is the default reference, so it leads and says so.
    expect(
      await screen.findByRole('columnheader', { name: `approximately ${otherLabel} (ms) Reference` }),
    ).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: `${currentLabel} (ms)` })).toBeInTheDocument();
    // The current run's change leans on the estimated reference, so it carries ≈.
    const allRequests = screen.getByRole('row', { name: /^All requests/ });
    expect(within(allRequests).getByTestId('compare-change').textContent).toContain('≈');
    expect(screen.getByTestId('compare-delta').textContent).toMatch(/^≈approximately /);
  });

  it('marks nothing when every selected run is exact', async () => {
    renderCompare({ state: 'ready', run: COMPLETE_RUN }, cohort('exact-v1'), '', fixture.stats);

    expect(
      await screen.findByRole('columnheader', { name: `${otherLabel} (ms) Reference` }),
    ).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: `${currentLabel} (ms)` })).toBeInTheDocument();
    const summary = screen.getByRole('region', { name: 'Comparison summary' });
    expect(summary.textContent).not.toContain('≈');
    for (const h of screen.getAllByRole('columnheader')) expect(h.textContent).not.toContain('≈');
  });
});

/**
 * ═══ THE PAGE WIRING: METRICS, THE REFERENCE AND THE TIME RANGE ═══
 *
 * The pure cases (`compare`, `buildCompareMatrix`, `compareSummary`) prove each
 * decision from payloads they build. These prove the page asks for the right
 * payloads and hands each one to the right decision — the seam none of those
 * files can reach.
 */
describe('RunCompare — metric data, reference and time range', () => {
  const urls = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]));

  /** Three numbered, exact runs, newest first: Run 3 is the one the page is
   *  on. Exact, so no header carries ≈ in front of its label. */
  const three = (durations: [number, number, number] = [63_161, 63_161, 63_161]) =>
    populated([
      cohortRunAt({ runNumber: 3, durationMs: durations[0], statsMethod: 'exact-v1' }),
      cohortRunAt({ id: OTHER, runNumber: 2, durationMs: durations[1], statsMethod: 'exact-v1', startedAt: '2026-08-15T11:00:00.000Z', toolStartedAt: '2026-08-15T11:00:00.000Z' }),
      cohortRunAt({ id: THIRD, runNumber: 1, durationMs: durations[2], statsMethod: 'exact-v1', startedAt: '2026-08-15T10:00:00.000Z', toolStartedAt: '2026-08-15T10:00:00.000Z' }),
    ]);

  /** The header names in table order, the leading `Request`/`Figure` dropped. */
  const runColumns = () =>
    screen.getAllByTestId('compare-column').map((th) => th.textContent ?? '');

  it('selector lists eleven metrics in GE order', async () => {
    renderCompare({ state: 'ready', run: COMPLETE_RUN }, three());
    const select = await screen.findByLabelText('Metric');
    const values = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual([
      'users', 'cpu', 'errors', 'p50', 'p90', 'p95', 'p99', 'p99.9', 'p99.99', 'max', 'throughput',
    ]);
  });

  it('pinning writes ref and moves the column', async () => {
    const search = `?runs=${OTHER},${THIRD}&metric=p99&from=1000&to=5000`;
    renderCompare({ state: 'ready', run: COMPLETE_RUN }, three(), search, fixture.stats);

    // The default reference is the first other selected run, Run 2.
    await waitFor(() => expect(runColumns()[0]).toMatch(/^Run 2 /));
    fireEvent.click(screen.getByRole('button', { name: 'Set Run 1 as reference' }));

    const after = new URLSearchParams(screen.getByTestId('where').textContent ?? '');
    expect(after.get('ref')).toBe(THIRD);
    // `refine` keeps every other parameter and pushes no history entry.
    expect(after.get('runs')).toBe(`${OTHER},${THIRD}`);
    expect(after.get('metric')).toBe('p99');
    expect(after.get('from')).toBe('1000');
    expect(after.get('to')).toBe('5000');
    expect(screen.getByTestId('how')).toHaveTextContent('REPLACE');

    await waitFor(() => expect(runColumns()[0]).toMatch(/^Run 1 /));
    expect(screen.getAllByTestId('compare-column')[0]).toHaveAttribute('data-reference', 'true');
    expect(screen.getByTestId(`compare-role-${THIRD}`)).toHaveTextContent('Reference');
  });

  it('a ref outside the selection is ignored', async () => {
    // Default selection: this run and its neighbour, Run 2. Run 1 is in the
    // cohort but not selected, so a pin on it cannot be honoured.
    renderCompare({ state: 'ready', run: COMPLETE_RUN }, three(), `?ref=${THIRD}`, fixture.stats);

    await waitFor(() => expect(runColumns()[0]).toMatch(/^Run 2 /));
    expect(screen.getAllByTestId('compare-column')[0]).toHaveAttribute('data-reference', 'true');
    expect(screen.queryByTestId(`compare-role-${THIRD}`)).toBeNull();
  });

  it('trims the pinned id before honouring it', async () => {
    // Selection order puts Run 1 first among the others, so the default would
    // be Run 1; only the trimmed pin makes Run 2 the reference.
    renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      three(),
      `?runs=${THIRD},${OTHER}&ref=%20${OTHER}%20`,
      fixture.stats,
    );
    await waitFor(() => expect(runColumns()[0]).toMatch(/^Run 2 /));
  });

  it('typing From/To writes from and to and refetches stats with the window', async () => {
    const { fetchSpy } = renderCompare({ state: 'ready', run: COMPLETE_RUN }, three(), '', fixture.stats);

    fireEvent.change(await screen.findByLabelText('From (s)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('To (s)'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply window' }));

    const after = new URLSearchParams(screen.getByTestId('where').textContent ?? '');
    expect(after.get('from')).toBe('10000');
    expect(after.get('to')).toBe('20000');
    expect(screen.getByTestId('how')).toHaveTextContent('REPLACE');

    await waitFor(() =>
      expect(
        urls(fetchSpy).some((u) => u.includes(`/runs/${RUN_ID}/stats?from=10000&to=20000`)),
      ).toBe(true),
    );
    expect(urls(fetchSpy).some((u) => u.includes(`/runs/${OTHER}/stats?from=10000&to=20000`))).toBe(true);

    // And Whole run clears both bounds.
    fireEvent.click(await screen.findByRole('button', { name: 'Whole run' }));
    const cleared = new URLSearchParams(screen.getByTestId('where').textContent ?? '');
    expect(cleared.has('from')).toBe(false);
    expect(cleared.has('to')).toBe(false);
  });

  it('p99.9 requests percentiles=99.9 on stats and 99.9,99.99 on series', async () => {
    const { fetchSpy } = renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      three(),
      '?metric=p99.9',
      fixture.stats,
    );

    await waitFor(() =>
      expect(urls(fetchSpy).some((u) => /\/stats\?percentiles=99\.9$/.test(u))).toBe(true),
    );
    await waitFor(() =>
      expect(urls(fetchSpy).some((u) => u.includes('/series?') && u.endsWith('&percentiles=99.9,99.99'))).toBe(true),
    );
    // Only the selected metric's reads.
    expect(urls(fetchSpy).some((u) => /\/users|\/agent\/|\/telemetry/.test(u))).toBe(false);
  });

  it('names every run without CPU', async () => {
    const notCollected = (url: string) => {
      const id = /\/runs\/([^/]+)\//.exec(url)?.[1];
      if (url.includes('/agent/injectors')) {
        return {
          runId: id, available: false, reason: 'not_collected', detail: null,
          bucketWidthMs: null, window: null, machine: { available: false, reason: null }, buckets: [],
        };
      }
      if (url.includes('/telemetry')) {
        return { runId: id, available: false, bucketWidthMs: 1000, window: null, hosts: [] };
      }
      return undefined;
    };
    const { fetchSpy } = renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      three(),
      '?metric=cpu',
      fixture.stats,
      notCollected,
    );

    for (const label of ['Run 3', 'Run 2']) {
      await waitFor(() =>
        expect(document.body.textContent).toContain(`CPU usage was not recorded for ${label}.`),
      );
    }
    // The table's CPU rows read dashes for every run, never a zero.
    for (const name of ['Mean', 'Max']) {
      const row = screen.getByRole('row', { name: new RegExp(`^${name}`) });
      expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual(['—', '—']);
    }
    expect(urls(fetchSpy).some((u) => /\/series|\/users/.test(u))).toBe(false);
  });

  /** The users table's `Max` is each run's peak, read from its own `/users`. */
  it('fills the users table from each run’s /users', async () => {
    const peak = Math.max(...fixture.users.total.map((bucket) => bucket.maxConcurrent));
    renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      three(),
      '?metric=users',
      fixture.stats,
      (url) => (url.includes('/users') ? fixture.users : undefined),
    );

    const row = await screen.findByRole('row', { name: /^Max/ });
    await waitFor(() =>
      expect(within(row).getAllByRole('cell').map((c) => c.textContent?.startsWith(formatCell(peak)))).toEqual([
        true,
        true,
      ]),
    );
  });

  /** CPU `Mean` and `Max` are over the run's own samples, from the agent's
   *  machine collector when it ran (`cpuUserPct + cpuSysPct`). */
  it('fills the CPU table from each run’s agent samples', async () => {
    const samples = [
      [10, 2],
      [30, 5],
      [20, 3],
    ] as const;
    const totals = samples.map(([user, sys]) => user + sys);
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
    const max = Math.max(...totals);
    const injectors = (url: string) => {
      if (url.includes('/agent/injectors')) {
        return {
          runId: /\/runs\/([^/]+)\//.exec(url)?.[1], available: true, reason: null, detail: null,
          bucketWidthMs: 1000, window: null, machine: { available: true, reason: null },
          buckets: samples.map(([user, sys], i) => ({
            startOffsetMs: i * 1000, gcCount: {}, gcTimeMs: {}, cpuUserPct: user, cpuSysPct: sys,
            ramTotalBytes: null, ramUsedBytes: null, heapMaxBytes: null, heapCommittedBytes: null,
            heapUsedBytes: null, nettyDirectBytes: null, nettyHeapBytes: null,
            tcpEvents: null, tcpSegments: null,
          })),
        };
      }
      if (url.includes('/telemetry')) {
        return { runId: /\/runs\/([^/]+)\//.exec(url)?.[1], available: false, bucketWidthMs: 1000, window: null, hosts: [] };
      }
      return undefined;
    };
    renderCompare({ state: 'ready', run: COMPLETE_RUN }, three(), '?metric=cpu', fixture.stats, injectors);

    for (const [name, value] of [['Mean', mean], ['Max', max]] as const) {
      const row = await screen.findByRole('row', { name: new RegExp(`^${name}`) });
      await waitFor(() =>
        expect(within(row).getAllByRole('cell').map((c) => c.textContent?.startsWith(formatCell(value)))).toEqual([
          true,
          true,
        ]),
      );
    }
  });

  it('clamps each run to its own duration', async () => {
    // Run 3 lasted 60 s, Run 2 30 s; the window is 40–60 s, after Run 2 ended.
    const { fetchSpy } = renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      three([60_000, 30_000, 63_161]),
      '?from=40000&to=60000',
      fixture.stats,
    );

    expect(await screen.findByTestId('compare-ended')).toHaveTextContent('Run 2 ended before this window.');
    await waitFor(() =>
      expect(urls(fetchSpy).some((u) => u.includes(`/runs/${RUN_ID}/stats?from=40000&to=60000`))).toBe(true),
    );
    // No request at all for the run that had ended — never its whole run.
    expect(urls(fetchSpy).some((u) => u.includes(`/runs/${OTHER}/`))).toBe(false);

    await waitFor(() => expect(runColumns().some((h) => h.startsWith('Run 2'))).toBe(true));
    const column = runColumns().findIndex((h) => h.startsWith('Run 2'));
    const allRequests = screen.getByRole('row', { name: /^All requests/ });
    expect(within(allRequests).getAllByRole('cell')[column]).toHaveTextContent(/^—$/);
  });

  /**
   * The one clamp branch with no direct guard: a run that ENDS inside the
   * window is asked for its own slice of it, never for time it did not have.
   * Run 2 lasted 50 s and the window is 40–60 s, so its read stops at 50 s
   * while the 63 s run's does not — and it is not "ended before this window".
   */
  it('holds a run that ends inside the window to its own end', async () => {
    const { fetchSpy } = renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      three([63_161, 50_000, 63_161]),
      '?from=40000&to=60000',
      fixture.stats,
    );

    await waitFor(() =>
      expect(urls(fetchSpy).some((u) => u.includes(`/runs/${OTHER}/stats?from=40000&to=50000`))).toBe(true),
    );
    expect(urls(fetchSpy).some((u) => u.includes(`/runs/${OTHER}/stats?from=40000&to=60000`))).toBe(false);
    expect(urls(fetchSpy).some((u) => u.includes(`/runs/${RUN_ID}/stats?from=40000&to=60000`))).toBe(true);
    expect(screen.queryByTestId('compare-ended')).toBeNull();
  });

  /**
   * EVERY PERCENTILE IS AN EXACT RANK ASKED FOR (final review m1). `/stats`
   * with no `?percentiles=` answers the project's configured set, so a project
   * configured without p95 read `—` for p95 on an exact run while the overlay
   * drew its line from the bucket bands. So p95 — the default — asks too.
   */
  it('asks /stats for the exact rank of the metric on screen, p95 included', async () => {
    const { fetchSpy } = renderCompare({ state: 'ready', run: COMPLETE_RUN }, three(), '', fixture.stats);
    await waitFor(() =>
      expect(urls(fetchSpy).some((u) => u.endsWith(`/runs/${RUN_ID}/stats?percentiles=95`))).toBe(true),
    );
  });

  /**
   * ═══ A QUERY THAT HAS NOT ANSWERED HAS SEEN NOTHING (final review I1) ═══
   *
   * A window change re-keys every run's `/stats`, so for one round trip each
   * `data` is `undefined`. The page drew that as "No statistics for the
   * selected runs" and "Select at least one run to compare." — conclusions
   * about reads that had not answered. The windowed `/stats` is held open here
   * so the in-between state can be looked at.
   */
  it('says it is loading, not that nothing was measured, while a window’s stats are in flight', async () => {
    let release: (value: unknown) => void = () => undefined;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const { fetchSpy } = renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      three(),
      '',
      undefined,
      (url) => {
        if (url.includes('/stats')) return url.includes('from=') ? held : fixture.stats;
        if (url.includes('/series')) return fixture.series;
        return undefined;
      },
    );
    // The whole-run comparison is drawn first, so there is a table to lose.
    await waitFor(() => expect(runColumns().length).toBeGreaterThan(0));

    fireEvent.change(screen.getByLabelText('From (s)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('To (s)'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply window' }));
    await waitFor(() =>
      expect(urls(fetchSpy).some((u) => u.includes(`/runs/${RUN_ID}/stats?from=10000&to=20000`))).toBe(true),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.queryByText('No statistics for the selected runs')).toBeNull();
    expect(screen.queryByText('Select at least one run to compare.')).toBeNull();
    expect(screen.getByText('Loading the comparison…')).toBeInTheDocument();

    await act(async () => {
      release(fixture.stats);
    });
    await waitFor(() => expect(runColumns().length).toBeGreaterThan(0));
    expect(screen.queryByText('Loading the comparison…')).toBeNull();
  });

  /**
   * THE OVERLAY WAITS ON ITS OWN READS, NOT ON THE TABLE'S (fix-wave review).
   * Every percentile asks `/stats` for its own rank, so switching p95 to p50
   * re-keys `/stats` — while the overlay's series is the same cached read for
   * both. Handed the page-wide flag, the chart blanked a line that was ready.
   */
  it('keeps drawing a cached overlay while a percentile switch reloads the table', async () => {
    let release: (value: unknown) => void = () => undefined;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const { fetchSpy } = renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      three(),
      '',
      undefined,
      (url) => {
        if (url.includes('/stats')) return url.includes('percentiles=50') ? held : fixture.stats;
        if (url.includes('/series')) return fixture.series;
        return undefined;
      },
    );
    await waitFor(() => expect(runColumns().length).toBeGreaterThan(0));
    const seriesReads = () => urls(fetchSpy).filter((u) => u.includes('/series')).length;
    const before = seriesReads();

    fireEvent.change(screen.getByLabelText('Metric'), { target: { value: 'p50' } });
    await waitFor(() =>
      expect(urls(fetchSpy).some((u) => u.endsWith(`/runs/${RUN_ID}/stats?percentiles=50`))).toBe(true),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // The series really was cached: the switch asked for no new one.
    expect(seriesReads()).toBe(before);
    expect(screen.getByText('Loading the comparison…')).toBeInTheDocument();
    expect(screen.queryAllByTestId('compare-column')).toHaveLength(0);
    expect(screen.queryByText('Loading the selected runs…')).toBeNull();

    await act(async () => {
      release(fixture.stats);
    });
    await waitFor(() => expect(runColumns().length).toBeGreaterThan(0));
  });

  /** One loading state, one live region: with the table and the overlay both
   *  waiting, the overlay's status line is the announcement and the page's
   *  line is plain text — two regions mounting at once read out twice. */
  it('announces a loading comparison once when the table and the overlay both wait', async () => {
    let release: (value: unknown) => void = () => undefined;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      three(),
      '',
      undefined,
      (url) => {
        if (url.includes('from=')) return held;
        if (url.includes('/stats')) return fixture.stats;
        if (url.includes('/series')) return fixture.series;
        return undefined;
      },
    );
    await waitFor(() => expect(runColumns().length).toBeGreaterThan(0));

    fireEvent.change(screen.getByLabelText('From (s)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('To (s)'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply window' }));
    await screen.findByText('Loading the selected runs…');

    const loading = screen
      .getAllByRole('status')
      .filter((region) => /loading/i.test(region.textContent ?? ''));
    expect(loading).toHaveLength(1);
    expect(screen.getByText('Loading the comparison…')).toBeInTheDocument();

    await act(async () => {
      release(fixture.series);
    });
  });

  /**
   * A PIN STILL LOADING IS NOT A PIN THAT IS ABSENT. Resolved against the runs
   * that had answered, `?ref=` naming the run still in flight fell back to
   * another, and the chip and every change named the wrong reference until
   * the pinned run's stats arrived.
   */
  it('does not fall back from a pinned reference whose stats are still loading', async () => {
    let release: (value: unknown) => void = () => undefined;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const { fetchSpy } = renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      three(),
      `?runs=${OTHER},${THIRD}&ref=${THIRD}`,
      undefined,
      (url) => {
        if (url.includes('/stats')) return url.includes(`/runs/${THIRD}/`) ? held : fixture.stats;
        if (url.includes('/series')) return fixture.series;
        return undefined;
      },
    );
    await waitFor(() =>
      expect(urls(fetchSpy).some((u) => u.includes(`/runs/${THIRD}/stats`))).toBe(true),
    );
    // Long enough for the other two runs' stats to have answered.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.queryByTestId(`compare-role-${OTHER}`)).toBeNull();
    expect(screen.queryAllByTestId('compare-column')).toHaveLength(0);
    expect(screen.getByText('Loading the comparison…')).toBeInTheDocument();

    await act(async () => {
      release(fixture.stats);
    });
    await waitFor(() => expect(runColumns()[0]).toMatch(/^Run 1 /));
    expect(screen.getByTestId(`compare-role-${THIRD}`)).toHaveTextContent('Reference');
  });

  /**
   * A pin on a run that ended before the window names a column of dashes, and
   * a change measured against it would be a change against nothing — so the
   * reference falls back to the default among the runs that have figures.
   */
  it('a pin on a run that ended before the window falls back', async () => {
    renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      three([60_000, 30_000, 63_161]),
      `?runs=${OTHER},${THIRD}&from=40000&to=60000&ref=${OTHER}`,
      fixture.stats,
    );

    await screen.findByTestId('compare-ended');
    await waitFor(() => expect(runColumns()[0]).toMatch(/^Run 1 /));
    expect(screen.getAllByTestId('compare-column')[0]).toHaveAttribute('data-reference', 'true');
    expect(screen.queryByTestId(`compare-role-${OTHER}`)).toBeNull();
  });
});
