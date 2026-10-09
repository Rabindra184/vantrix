import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunListResponse } from '@perfportal/contracts';
import RunList from '../src/routes/RunList';
import { NEW_PROJECT_ROUTE } from '../src/routes/paths';
import { seedAccess } from './support/access';

afterEach(cleanup);

/**
 * `props` is what scopes the list. Empty is the org-wide `/runs`; a
 * `projectSlug` is a project's own list; both together are a test's.
 */
function renderList(
  items: RunListResponse['items'],
  initialEntry = '/runs',
  props: { projectSlug?: string; testSlug?: string; showHeading?: boolean } = {},
) {
  const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(
      new Response(JSON.stringify({ items, nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchSpy);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <RunList {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, fetchSpy };
}

const ROWS: RunListResponse['items'] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'complete',
    verdict: 'passed',
    tool: 'gatling',
    startedAt: '2026-08-15T10:00:00.000Z',
    toolStartedAt: '2026-08-15T09:00:00.000Z',
    project: { id: '22222222-2222-4222-8222-222222222222', slug: 'checkout', name: 'Checkout' },
    simulation: 'example.ParitySimulation',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'pending',
    verdict: null,
    tool: 'gatling',
    startedAt: '2026-08-15T11:00:00.000Z',
    toolStartedAt: null,
    project: { id: '22222222-2222-4222-8222-222222222222', slug: 'checkout', name: 'Checkout' },
    simulation: null,          // the worker has not parsed it
  },
];

/* ======================================================================== *
 * CLEAN UI, PR 3 — FOCUS IS GONE, AND THE ONE FACT ONLY IT CARRIED MOVED
 * ======================================================================== */

/**
 * Focus read "investigate" on every row that failed, stopped early, failed its
 * SLA verdict — or whose SIMULATION had a failing assertion. Status and
 * Verdict already say the first three. The fourth only Focus said, so it moves
 * into the Verdict cell: a second line under the badge, and only when it
 * happened, so most rows look as they always did.
 */
describe('RunList — a failed simulation assertion in the Verdict cell', () => {
  const ASSERTED = {
    id: '66666666-6666-4666-8666-666666666666',
    status: 'complete' as const,
    verdict: 'passed' as const,
    tool: 'gatling',
    startedAt: '2026-08-16T09:00:00.000Z',
    toolStartedAt: '2026-08-16T09:00:00.000Z',
    project: { id: '55555555-5555-4555-8555-555555555555', slug: 'catalog', name: 'Catalog' },
    simulation: 'example.CatalogSimulation',
    checks: { failed: 1, total: 3 },
  };

  it('names a failed simulation assertion in the Verdict cell, and only then', async () => {
    renderList([
      ASSERTED,
      { ...ASSERTED, id: '77777777-7777-4777-8777-777777777777', checks: { failed: 0, total: 3 } },
      { ...ASSERTED, id: '88888888-8888-4888-8888-888888888888', checks: null },
    ]);
    const lines = await screen.findAllByTestId('run-assertions-failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent(/^1 assertion failed$/);
    expect(lines[0]!.closest('tr')).toHaveAttribute('data-run-id', ASSERTED.id);
  });

  it('counts failed assertions in the plural', async () => {
    renderList([{ ...ASSERTED, checks: { failed: 2, total: 3 } }]);
    expect(await screen.findByTestId('run-assertions-failed')).toHaveTextContent(
      /^2 assertions failed$/,
    );
  });

  it('draws no Focus column', async () => {
    renderList([...ROWS, { ...ASSERTED, verdict: 'failed' }]);
    await screen.findByRole('columnheader', { name: 'Simulation' });
    expect(screen.queryByRole('columnheader', { name: 'Focus' })).toBeNull();
    expect(screen.queryByText('investigate')).toBeNull();
    expect(screen.queryByText('processing')).toBeNull();
  });
});

describe('RunList columns', () => {
  it('names each row by its project and simulation', async () => {
    renderList(ROWS);
    expect(await screen.findByRole('columnheader', { name: 'Project' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Simulation' })).toBeInTheDocument();
    expect(screen.getAllByText('Checkout')).toHaveLength(2);
    // The link's TEXT, not `getByText`: the name is drawn in pieces (package
    // line, then the class's words), which together still read as one string.
    expect(
      screen.getByRole('link', { name: 'View run 11111111-1111-4111-8111-111111111111' }),
    ).toHaveTextContent(/^example\.ParitySimulation$/);
  });

  /**
   * ═══ A COLUMN THAT IS CONSTANT BY CONSTRUCTION CARRIES NOTHING ═══
   *
   * The same argument the missing Tool column already rests on, applied per
   * scope. On a project's run list every row's project is that project, so the
   * column costs horizontal room on an already-wide table and gives a reader
   * nothing to compare.
   *
   * The paired positive comes first: the table really rendered, so the absence
   * below is about this column and not about an empty list.
   */
  it('drops the Project column on a project’s own list, where it never varies', async () => {
    renderList(ROWS, '/projects/checkout', { projectSlug: 'checkout' });
    expect(await screen.findByRole('columnheader', { name: 'Simulation' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Project' })).toBeNull();
    expect(screen.queryByText('Checkout')).toBeNull();
  });

  /**
   * ═══ THE SIMULATION COLUMN CANNOT SIMPLY GO ═══
   *
   * On a test's list the simulation is constant too — it is the page's own
   * heading — but that cell holds the ONLY link to the run. So the column keeps
   * its place and becomes `Run`, showing the short id, which is the thing that
   * actually tells two runs of one test apart.
   *
   * The link and its accessible name are asserted, not just the header: a
   * column that lost its link would still pass a header-only check while
   * leaving every row unreachable.
   */
  it('identifies a test’s runs by id, keeping the link the row depends on', async () => {
    renderList(ROWS, '/projects/checkout/tests/parity', {
      projectSlug: 'checkout',
      testSlug: 'parity',
    });
    expect(await screen.findByRole('columnheader', { name: 'Run' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Simulation' })).toBeNull();
    // The simulation is NOT repeated down the rows...
    expect(screen.queryByText('example.ParitySimulation')).toBeNull();
    // ...and the row is still reachable, by a link whose name carries the
    // WHOLE id even though the cell shows only its prefix.
    const link = screen.getByRole('link', {
      name: 'View run 11111111-1111-4111-8111-111111111111',
    });
    expect(link).toHaveAttribute('href', '/runs/11111111-1111-4111-8111-111111111111');
    expect(link).toHaveTextContent('11111111');
  });

  /** A numbered run on its test's list is named by its number; the link's
   *  accessible name still carries the WHOLE id, and the copy button still
   *  copies it. */
  it('names a test’s numbered runs "Run n", keeping the whole id in the link’s name', async () => {
    renderList(
      [{ ...ROWS[0]!, runNumber: 12 }, ROWS[1]!],
      '/projects/checkout/tests/parity',
      { projectSlug: 'checkout', testSlug: 'parity' },
    );
    const numbered = await screen.findByRole('link', {
      name: 'View run 11111111-1111-4111-8111-111111111111',
    });
    expect(numbered).toHaveTextContent(/^Run 12$/);
    // The numberless row keeps today's id prefix.
    expect(
      screen.getByRole('link', { name: 'View run 33333333-3333-4333-8333-333333333333' }),
    ).toHaveTextContent('33333333');
  });

  /** The split name is for a SIMULATION. A run the worker has not parsed keeps
   *  its short id, and a test's list keeps "Run n" — neither is a class, so
   *  neither grows a package line (clean UI, PR 3). */
  it('keeps the short id and "Run n" as they were, with no package line', async () => {
    renderList(ROWS);
    const unparsed = await screen.findByRole('link', {
      name: 'View run 33333333-3333-4333-8333-333333333333',
    });
    expect(unparsed).toHaveTextContent(/^33333333$/);
    expect(unparsed.querySelector('[data-name-package]')).toBeNull();

    cleanup();
    renderList([{ ...ROWS[0]!, runNumber: 3 }], '/projects/checkout/tests/parity', {
      projectSlug: 'checkout',
      testSlug: 'parity',
    });
    const numbered = await screen.findByRole('link', {
      name: 'View run 11111111-1111-4111-8111-111111111111',
    });
    expect(numbered).toHaveTextContent(/^Run 3$/);
    expect(numbered.querySelector('[data-name-package]')).toBeNull();
  });

  /** Clean UI, PR 3: Focus gone, Started after the measurements, its zone in
   *  the header once rather than on every row. */
  it('orders the columns identity, outcome, measurements, then when and where', async () => {
    renderList(ROWS);
    await screen.findByRole('columnheader', { name: 'Project' });
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim() ?? '');
    expect(headers.slice(0, 6)).toEqual(['Project', 'Simulation', 'Status', 'Verdict', 'p95', 'Errors']);
    expect(headers[6]).toMatch(/^Started \(.+\)$/);
    expect(headers[7]).toBe('Environment');
    expect(headers).toHaveLength(8);
  });

  /** A page can straddle a daylight-saving change. The header names the first
   *  row's zone; a row in another keeps its own, so no time reads under the
   *  wrong zone (Review Focus 1). */
  it('keeps a row’s own zone when it differs from the header’s', async () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      expect(new Date('2026-01-15T12:00:00Z').getHours()).toBe(7);
      renderList([
        { ...ROWS[0]!, toolStartedAt: '2026-04-01T15:00:00.000Z' },
        { ...ROWS[0]!, id: '99999999-9999-4999-8999-999999999999', toolStartedAt: '2026-03-01T15:00:00.000Z' },
      ]);
      const header = await screen.findByRole('columnheader', { name: /^Started \(/ });
      const headerZone = /\((.+)\)/.exec(header.textContent ?? '')![1]!;
      const suffixes = screen.getAllByTestId('run-started-zone');
      expect(suffixes).toHaveLength(1);
      expect(suffixes[0]!.textContent?.trim()).not.toBe(headerZone);
      expect(suffixes[0]!.closest('tr')).toHaveAttribute(
        'data-run-id',
        '99999999-9999-4999-8999-999999999999',
      );
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('has no Tool column — TOOL_IDS has one member, so it read "gatling" on every row', async () => {
    renderList(ROWS);
    await screen.findByRole('columnheader', { name: 'Project' });
    expect(screen.queryByRole('columnheader', { name: 'Tool' })).toBeNull();
  });

  it('summarizes the current page', async () => {
    renderList([
      ...ROWS,
      {
        id: '44444444-4444-4444-8444-444444444444',
        status: 'complete',
        verdict: 'failed',
        tool: 'gatling',
        startedAt: '2026-08-15T12:00:00.000Z',
        toolStartedAt: '2026-08-15T12:00:00.000Z',
        project: { id: '55555555-5555-4555-8555-555555555555', slug: 'catalog', name: 'Catalog' },
        simulation: 'example.CatalogSimulation',
      },
    ]);

    const health = await screen.findByRole('region', { name: 'Run health on this page' });
    expect(within(health).getByText('Needs attention').closest('div')).toHaveTextContent('1');
    expect(within(health).getByText('In flight').closest('div')).toHaveTextContent('1');
    expect(within(health).getByText('Passed gates').closest('div')).toHaveTextContent('1');
    expect(within(health).getByText('Unjudged').closest('div')).toHaveTextContent('1');

    // THE COUNTS SAY WHAT THEY COUNT. They reduce over one keyset page, and
    // shipped under the name "Run list health" with only the fourth tile
    // disclosing that — so an org with 90 failed runs read "Needs attention:
    // 2" off its first page. The scope stays visible, beside the counts it
    // qualifies; the run total it used to repeat is the heading's (clean UI,
    // PR 3), so the line says "On this page" and nothing more.
    expect(within(health).getByTestId('health-scope')).toHaveTextContent(/^On this page$/);
    expect(screen.getByRole('heading', { level: 1 }).parentElement).toHaveTextContent(
      `${screen.getAllByTestId('run-row').length} runs`,
    );
  });

  it('falls back to the short id when the run has no simulation yet', async () => {
    renderList(ROWS);
    // Derived from the row, not written down: re-slicing the id here the way
    // the component does would just restate the implementation. Assert
    // instead that the accessible name carries the WHOLE id while the visible
    // text is a strict prefix of it.
    const link = await screen.findByRole('link', { name: `View run ${ROWS[1]!.id}` });
    const visible = link.textContent!;
    // Non-empty FIRST, and it is load-bearing: `''.startsWith` is vacuously
    // true and `'' !== id` is too, so without this an implementation that
    // rendered nothing for a null simulation — `run.simulation && …` instead
    // of `run.simulation ?? …`, since `null && x` is `null` — would satisfy
    // both assertions below. `findByRole` would still match it, because the
    // aria-label supplies the accessible name whatever the content is. A
    // test for a fallback that passes when the fallback is gone is worse
    // than no test.
    expect(visible.length).toBeGreaterThan(0);
    expect(ROWS[1]!.id.startsWith(visible)).toBe(true);
    expect(visible).not.toBe(ROWS[1]!.id);
  });

  /**
   * ═══ THE FILTERS ARE A TOOLBAR, NOT A PANEL (review.md 8) ═══
   *
   * "The filter area has a card, 'Filter runs', 'Search runs', multiple labels,
   * and an Apply action before the rows begin… give routine filters less visual
   * weight than the data."
   *
   * The COMPACT viewport had already dropped both the frame and the repeated
   * title — `CompactFilters` folds the whole thing behind its own summary — and
   * the desktop kept them. That is M02's lesson exactly: A FIX APPLIED AT ONE
   * BREAKPOINT IS NOT APPLIED.
   *
   * ASSERTED ON THE SURFACE TREATMENT, because that is what "visual weight" is
   * in this app: `border-default` + `shadow-panel` + a surface fill is how
   * `Card`, the statistics table and the decision band all say "this is a thing
   * to read". A filter wearing it competes with the run it exists to help find.
   *
   * The behaviour assertions sit beside it deliberately — the finding warns "do
   * not change search behavior merely for appearance", so the controls being
   * present and named is half of what this case claims.
   */
  it('frames the filters as a toolbar rather than as a panel of their own', async () => {
    renderList(ROWS);
    const form = await screen.findByRole('form', { name: 'Run filters' });

    expect(form.className).not.toMatch(/border-default|shadow-panel|bg-surface/);
    // And the title the compact summary already carries is not repeated here.
    expect(within(form).queryByText('Filter runs')).toBeNull();

    // Unchanged: every control still present, still labelled, Apply still there.
    expect(within(form).getByLabelText('Search runs')).toBeInTheDocument();
    expect(within(form).getByLabelText('Status')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Apply' })).toBeInTheDocument();
  });

  it('sends search, status, and verdict filters to the API', async () => {
    const { fetchSpy } = renderList(ROWS);
    await screen.findByRole('form', { name: 'Run filters' });

    fireEvent.change(screen.getByLabelText('Search runs'), { target: { value: 'checkout main' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'complete' } });
    fireEvent.change(screen.getByLabelText('Verdict'), { target: { value: 'failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes('q=checkout+main'))).toBe(true);
      expect(urls.some((url) => url.includes('status=complete'))).toBe(true);
      expect(urls.some((url) => url.includes('verdict=failed'))).toBe(true);
    });
  });

  /**
   * A FILTER THE LIST CANNOT HONOUR IS STATED, NOT DROPPED.
   *
   * `?status=completed` (a plausible typo for `complete`) used to be parsed
   * to `null`, left in the address bar, and reported as no active filter —
   * so the page rendered the whole unfiltered list with no Clear control,
   * and a shared link read as "there are no other completed runs". The API
   * answers the identical value with a 400 RUN_FILTER_INVALID; the two must
   * not disagree about one input.
   */
  it('says so when the URL names a filter value this list cannot use', async () => {
    const { fetchSpy } = renderList(ROWS, '/runs?status=completed');

    expect(await screen.findByTestId('run-filter-ignored')).toHaveTextContent(
      /ignored status=completed/i,
    );
    // Offered a way out, which is the half that was missing: `hasActiveFilters`
    // was false, so no Clear button rendered at all.
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();

    // And the value never reaches the API, which would refuse it.
    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(0));
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain('status=');
    }
  });

  it('says nothing when every filter in the URL is one it can use', async () => {
    renderList(ROWS, '/runs?status=complete');
    // Waits for the LOADED state: the notice renders above the table in
    // every branch, so asserting its absence before the rows arrive would
    // pass against a page that had not rendered the controls at all.
    await screen.findByRole('table');
    expect(screen.queryByTestId('run-filter-ignored')).toBeNull();
  });

  it('can clear active filters from the no-match state', async () => {
    const { fetchSpy } = renderList([], '/runs?q=catalog&status=complete');
    expect(await screen.findByText('No runs match these filters')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    await waitFor(() => {
      const lastUrl = String(fetchSpy.mock.calls.at(-1)?.[0]);
      expect(lastUrl).not.toContain('q=');
      expect(lastUrl).not.toContain('status=');
    });
  });
});

/**
 * REVIEW C02 — THE COUNTS SAY WHICH SYSTEMS THEY COUNT.
 *
 * "Needs attention: 0" once sat above a run whose simulation had a failing
 * assertion, because the list endpoint did not send the outcomes. M02 put
 * `checks` on the contract and the count reads it; the tally's ⓘ says so, and
 * still says the counts are page-local (clean UI, PR 3: the caveat moved from
 * a disclosure to the ⓘ, its claims unchanged).
 */
/**
 * FINAL REVIEW, IMPORTANT 2: the scope line dropped the run total because "the
 * heading already says it" — true on All runs, false on a project's list and a
 * test's page, which hide the list's heading (`showHeading={false}`). There
 * the scope line is the page's only count, so it keeps it.
 */
describe('RunList — the tally counts the page where no heading does', () => {
  it('says how many runs are on the page when the heading is hidden, and not when it is shown', async () => {
    renderList([...ROWS], '/projects/checkout/runs', { projectSlug: 'checkout', showHeading: false });
    const hidden = await screen.findByRole('region', { name: 'Run health on this page' });
    expect(within(hidden).getByTestId('health-scope')).toHaveTextContent(/^On this page · 2 runs$/);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();

    cleanup();
    renderList([...ROWS]);
    const shown = await screen.findByRole('region', { name: 'Run health on this page' });
    expect(within(shown).getByTestId('health-scope')).toHaveTextContent(/^On this page$/);
  });
});

describe('RunList — the health summary says which systems it counted', () => {
  it('says the counts include simulation assertions and cover this page only', async () => {
    renderList([...ROWS]);
    const health = await screen.findByRole('region', { name: 'Run health on this page' });
    const info = within(health).getByRole('button', { name: 'About these counts' });
    expect(info).toHaveAccessibleDescription(/simulation/i);
    // And still says it is page-local — the new caveat must not replace the
    // one that was already there.
    expect(info).toHaveAccessibleDescription(/this page only/i);
  });
});

/**
 * REVIEW M02 + C02 — A LIST ROW HAD TO BE OPENED TO BE TRIAGED.
 *
 * The list carried Started, Project, Simulation, Status, Verdict — and no
 * latency, no error rate, no environment. Deciding whether a run was
 * interesting meant opening it, one at a time.
 *
 * The row data was already in the repository's SQL; the CONTRACT dropped it.
 * `RunListResponseSchema` picked nine fields, so `environment`, `durationMs`
 * and `toolAssertions` were fetched and discarded — which is also why "Needs
 * attention" could read zero over a run whose simulation had a failing check.
 */
const TRIAGE_ROW = {
  id: '66666666-6666-4666-8666-666666666666',
  status: 'complete' as const,
  verdict: 'passed' as const,
  tool: 'gatling',
  startedAt: '2026-08-16T09:00:00.000Z',
  toolStartedAt: '2026-08-16T09:00:00.000Z',
  project: { id: '55555555-5555-4555-8555-555555555555', slug: 'catalog', name: 'Catalog' },
  simulation: 'example.CatalogSimulation',
  environment: 'staging',
  branch: 'main',
  commitSha: 'abcdef1234567890',
  durationMs: 63_161,
  test: null,
  checks: { failed: 1, total: 3 },
  metrics: { count: 895, errorRate: 0.0268, throughputRps: 14.4, p95Ms: 659 },
};

describe('RunList — a row carries enough to triage on', () => {
  it('shows p95, error rate and environment without opening the run', async () => {
    renderList([TRIAGE_ROW]);
    const row = (await screen.findAllByRole('row')).find((r) =>
      r.textContent?.includes('CatalogSimulation'),
    )!;
    expect(row).toHaveTextContent('659');
    expect(row).toHaveTextContent('2.68%');
    expect(row).toHaveTextContent('staging');
  });

  /** A run with no statistics row has no p95. That is an absence, and "—" is
   *  the honest cell — a zero would be a measurement. */
  it('renders unavailable metrics as absent, never as zero', async () => {
    renderList([{ ...TRIAGE_ROW, metrics: null }]);
    const row = (await screen.findAllByRole('row')).find((r) =>
      r.textContent?.includes('CatalogSimulation'),
    )!;
    expect(row).not.toHaveTextContent('0.00%');
    expect(row).toHaveTextContent('—');
  });

  /**
   * THE C02 HALF. A passing platform verdict over a failing simulation check
   * is exactly the run "Needs attention: 0" was hiding.
   */
  it('counts a failing simulation check as needing attention', async () => {
    renderList([TRIAGE_ROW]);
    const health = await screen.findByRole('region', { name: 'Run health on this page' });
    expect(within(health).getByText('Needs attention').closest('div')).toHaveTextContent('1');
  });

  it('does not count a run whose checks all passed', async () => {
    renderList([{ ...TRIAGE_ROW, checks: { failed: 0, total: 3 } }]);
    const health = await screen.findByRole('region', { name: 'Run health on this page' });
    expect(within(health).getByText('Needs attention').closest('div')).toHaveTextContent('0');
  });

  /**
   * ═══ THE OTHER STATE "NEEDS ATTENTION" COUNTS, AND NOTHING RENDERED IT ═══
   *
   * `needsAttention` names `failed` and `incomplete` in the same breath, and
   * only `failed` had ever reached this component from a test. An incomplete
   * run is a live run whose producer stopped reporting -- `markIncomplete`,
   * driven by the sweeper -- so its verdict is always `not_evaluated` and its
   * data is partial rather than absent. It is exactly the run an engineer must
   * not scroll past, and the tile is what stops them.
   *
   * `verdict: 'not_evaluated'` is deliberate: this row must be counted on its
   * STATUS alone. A fixture that also carried a failed verdict or a failed
   * check would be counted by a component that had lost the status branch
   * entirely, and would prove nothing about it.
   */
  it('counts an incomplete run as needing attention, on its status alone', async () => {
    renderList([{ ...TRIAGE_ROW, status: 'incomplete', verdict: 'not_evaluated', checks: { failed: 0, total: 3 } }]);
    const health = await screen.findByRole('region', { name: 'Run health on this page' });
    expect(within(health).getByText('Needs attention').closest('div')).toHaveTextContent('1');
  });

  /** A server that reports no checks must not be counted either way. */
  it('does not count a run that reported no checks at all', async () => {
    renderList([{ ...TRIAGE_ROW, checks: null }]);
    const health = await screen.findByRole('region', { name: 'Run health on this page' });
    expect(within(health).getByText('Needs attention').closest('div')).toHaveTextContent('0');
  });
});

/**
 * ═══ THE NOTE LINE ═══ (docs/superpowers/specs/2026-09-27-run-note-design.md)
 *
 * The text alone, under the simulation, so "ignore this run" is read before
 * anyone opens it. `max-w-[32ch]` and `line-clamp-2` are a readable measure
 * and at most two lines — not what keeps the Simulation column narrow, which
 * is the table's own automatic layout wrapping the note between words.
 * `run-note.spec.ts` measures how far that reach actually goes, in a browser,
 * because jsdom lays nothing out: a long sentence stays within p95 and
 * Errors at every width, and a 300-character unbroken token (a URL, with no
 * break opportunity at all) did push Errors off screen before `NoteLine`
 * wrapped anywhere rather than only between words.
 */
describe('RunList — a run’s note is read without opening it', () => {
  it('shows the note under the simulation, and nothing for a run without one', async () => {
    renderList([
      { ...ROWS[0]!, note: 'flaky environment, ignore' },
      { ...ROWS[1]!, note: null },
    ]);
    const lines = await screen.findAllByTestId('run-note-line');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent('Note: flaky environment, ignore');
    const cell = lines[0]!.closest('td');
    expect(cell).toHaveAttribute('data-testid', 'run-simulation');
  });
});

/**
 * ═══ A RUN'S ID, ONE CLICK FROM ITS ROW ═══ (backlog #4)
 *
 * The case that earns its place is a TEST'S list, where the row shows an
 * 8-character prefix: a button that copied what the row DISPLAYS would copy
 * something no endpoint takes, and on the org-wide list — where the row shows
 * the simulation — the same mistake would copy a class name. So the list
 * under test is the one whose display and id disagree most, and the copied
 * value is compared with the row's own `data-run-id`, not a literal.
 */
describe('RunList — a run’s id is copyable from its row', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('copies the FULL run id from each row, even where the row shows only its prefix', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    renderList(ROWS, '/projects/checkout/tests/parity', {
      projectSlug: 'checkout',
      testSlug: 'parity',
    });

    const rows = await screen.findAllByTestId('run-row');
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      const id = row.getAttribute('data-run-id')!;
      const link = within(row).getByRole('link', { name: `View run ${id}` });
      // The fixture has to show LESS than the id, or this case cannot tell a
      // button that copies the id from one that copies the display.
      expect(link.textContent!.length).toBeGreaterThan(0);
      expect(link.textContent!.length).toBeLessThan(id.length);

      const button = within(row).getByRole('button', { name: `Copy run id ${id}` });
      // Beside the link, never inside it: a click on the button must not also
      // be a click on the link.
      expect(link).not.toContainElement(button);
      await act(async () => {
        fireEvent.click(button);
      });
      expect(writeText).toHaveBeenLastCalledWith(id);
    }
    expect(writeText).toHaveBeenCalledTimes(rows.length);
  });

  /**
   * One button per row, so a page of twenty-five runs holds twenty-five — and
   * a status region each would be twenty-five permanently-empty live regions,
   * the trap `ChartActions` records. Asserted over the whole LIST, because the
   * component's own test cannot see what N copies of it add up to.
   */
  it('adds no live region to the list until a copy is made', async () => {
    renderList(ROWS);
    const rows = await screen.findAllByTestId('run-row');
    expect(screen.getAllByTestId('copy-id')).toHaveLength(rows.length);
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });
});

/**
 * ═══ NEW PROJECT IS OFFERED TO AN ADMIN, AND ONLY ONCE THAT IS KNOWN ═══
 *
 * Gate by destination: the heading's New project opens a page whose one action
 * is `projects:create`, which only an admin may take. The API refuses anyone
 * else whatever this page draws; hiding is for clarity. It stays on the
 * org-wide list alone — `run-list.spec.ts` pins exactly one link by that name
 * on `/runs` for the admin every e2e signs in as — and never on a project's.
 *
 * Who is looking is SEEDED (`seedAccess`), so the flag is in the cache before
 * the list draws; a pending reader is a session that never answers.
 */
describe('RunList — New project follows the admin flag', () => {
  function renderAs(who: 'admin' | 'member' | 'pending', props: { projectSlug?: string } = {}) {
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const { pathname } = new URL(String(input), 'http://localhost');
      if (pathname === '/auth/get-session') return new Promise<Response>(() => {});
      return Promise.resolve(
        new Response(JSON.stringify({ items: ROWS, nextCursor: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (who !== 'pending') seedAccess(client, { isAdmin: who === 'admin' });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/runs']}>
          <RunList {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }
  const newProject = () => screen.queryByRole('link', { name: 'New project' });

  it('offers an admin New project in the org-wide list’s heading', async () => {
    renderAs('admin');
    expect(await screen.findByRole('link', { name: 'New project' })).toHaveAttribute('href', NEW_PROJECT_ROUTE);
  });

  it.each(['member', 'pending'] as const)('offers a %s reader none', async (who) => {
    renderAs(who);
    // The loaded list, so the heading and its action slot have drawn.
    await screen.findAllByTestId('run-row');
    expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeInTheDocument();
    expect(newProject()).toBeNull();
  });

  it('offers none on a project’s own list, even to an admin', async () => {
    renderAs('admin', { projectSlug: 'checkout' });
    await screen.findAllByTestId('run-row');
    expect(newProject()).toBeNull();
  });
});
