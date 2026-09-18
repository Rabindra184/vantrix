import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunListResponse } from '@perfportal/contracts';
import RunList from '../src/routes/RunList';

afterEach(cleanup);

/**
 * `props` is what scopes the list. Empty is the org-wide `/runs`; a
 * `projectSlug` is a project's own list; both together are a test's.
 */
function renderList(
  items: RunListResponse['items'],
  initialEntry = '/runs',
  props: { projectSlug?: string; testSlug?: string } = {},
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
 * REVIEW 09-13 M14 — FOCUS LOOKED LIKE AN ACTION AND WAS A SPAN
 * ======================================================================== */

describe('RunList — the Focus cell', () => {
  /**
   * The caption calls Focus "the first operational action to take from the
   * row", and `investigate` was drawn in the failed-status colour with medium
   * weight — every affordance of a link, on a `<span>` that does nothing.
   *
   * Made real rather than renamed, because the destination exists and is where
   * the reader was going: the run, which opens on the decision band that names
   * the failed check. The accessible name carries the RUN, since "investigate"
   * repeated down a column names nothing.
   */
  it('links investigate to the run, named by the run', async () => {
    renderList([{ ...ROWS[0]!, status: 'failed', verdict: 'failed' }]);
    const link = await screen.findByRole('link', { name: `Investigate run ${ROWS[0]!.id}` });
    expect(link).toHaveAttribute('href', `/runs/${ROWS[0]!.id}`);
    expect(link).toHaveTextContent('investigate');
  });

  /**
   * AND THE OTHER STATES STAY TEXT, which is the half that keeps the first
   * one meaningful. There is nothing to do about "processing", so a link there
   * would be the same false affordance pointing somewhere else.
   */
  it('leaves a status-only focus as plain text', async () => {
    renderList([{ ...ROWS[0]!, status: 'complete', verdict: 'passed' }]);
    expect(await screen.findByText('clear')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /investigate/i })).toBeNull();
  });
});

describe('RunList columns', () => {
  it('names each row by its project and simulation', async () => {
    renderList(ROWS);
    expect(await screen.findByRole('columnheader', { name: 'Project' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Simulation' })).toBeInTheDocument();
    expect(screen.getAllByText('Checkout')).toHaveLength(2);
    expect(screen.getByText('example.ParitySimulation')).toBeInTheDocument();
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

  it('has no Tool column — TOOL_IDS has one member, so it read "gatling" on every row', async () => {
    renderList(ROWS);
    await screen.findByRole('columnheader', { name: 'Project' });
    expect(screen.queryByRole('columnheader', { name: 'Tool' })).toBeNull();
  });

  it('summarizes the current page and adds a focus signal after verdict', async () => {
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
    // 2" off its first page. The denominator is derived from the rows on
    // screen rather than written down, so a fixture change moves both sides.
    //
    // The scope is its own visible line now rather than the opening sentence
    // of a paragraph (review 09-13's copy table); the CLAIM is unchanged and
    // is what this asserts — the reader is told, without opening anything,
    // that these four numbers cover this page and how many runs that is.
    const rows = screen.getAllByTestId('run-row');
    expect(within(health).getByTestId('health-scope')).toHaveTextContent(
      new RegExp(`on this page · ${rows.length} runs`, 'i'),
    );

    expect(screen.getByRole('columnheader', { name: 'Focus' })).toBeInTheDocument();
    expect(screen.getByText('investigate')).toBeInTheDocument();
    expect(screen.getByText('processing')).toBeInTheDocument();
    expect(screen.getByText('clear')).toBeInTheDocument();
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
 * REVIEW C02 — THE HEALTH TILES COUNT TWO SYSTEMS, NOT THREE.
 *
 * "Needs attention: 0" sat above a list containing a run whose simulation had
 * a failing assertion. The tiles are not wrong — they count execution state
 * and the platform SLA verdict, which is all `GET /v1/runs` returns
 * (`RunListResponseSchema` picks id, project, status, verdict, tool,
 * startedAt, toolStartedAt, simulation and nothing else). But a tile labelled
 * "Needs attention" reading zero is a claim about the run, and an engineer
 * triaging a list acts on it.
 *
 * Counting simulation checks here needs a field the list endpoint does not
 * have, so this states the boundary rather than inventing the number. The
 * caveat is the fix that is available today; the count is a backend change.
 */
describe('RunList — the health summary says which systems it counted', () => {
  it('names what the counts do not include', async () => {
    renderList([...ROWS]);
    const health = await screen.findByRole('region', { name: 'Run health on this page' });
    expect(health).toHaveTextContent(/simulation/i);
    // And still says it is page-local — the new caveat must not replace the
    // one that was already there.
    expect(health).toHaveTextContent(/not totals for the whole list/i);
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
