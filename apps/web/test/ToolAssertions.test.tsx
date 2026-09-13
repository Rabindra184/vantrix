// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResponse, StatsResponse, ToolAssertion } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import { runQueryKey } from '../src/api/run';
import { RunOverviewTab } from '../src/routes/RunDetail';
import type { RunWindowContext } from '../src/routes/useRunWindow';
import useIsCompact from '../src/useIsCompact';

/**
 * ═══ REVIEW 09-13 M13 — THE SIMULATION-ASSERTION TABLE ═══
 *
 * Two findings in one row. The table grew structured Target/Metric/Bound/
 * Actual columns (review M10) and kept the tool's whole sentence beside them,
 * so every row said the same thing twice — `Search`, `95th`, `< 100 ms`, and
 * then "Search: 95th percentile of response time is less than 100.0". And the
 * Target was plain text: a reader looking at the one failing check could read
 * the name of the request that failed and had nowhere to go with it.
 *
 * ═══ WHAT MUST SURVIVE THE FIX, WHICH IS THE HARDER HALF ═══
 *
 * The sentence is not redundant decoration. G-05's tolerance is exact WORDING
 * — somebody holding this report beside Gatling's own is comparing strings —
 * and it is the only thing that can describe an assertion shape this build
 * does not recognise, which is a real state because `assertion` is optional on
 * the wire. So the cases below spend as much effort on "it is still reachable"
 * and "it is forced open when a row needs it" as on "it is out of the way".
 */

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
vi.mocked(useIsCompact).mockReturnValue(false);

afterEach(cleanup);

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const STATS = reference.stats as StatsResponse;

/**
 * A `details` path, the one shape that names something drillable.
 *
 * `Search` and `Cart/Add To Cart` are both REQUEST rows in the reference
 * payload, which is why they can be linked; `Ghost` deliberately is not.
 */
function details(parts: readonly string[], outcome: ToolAssertion['outcome']): ToolAssertion {
  return {
    expression: `${parts.join(' / ')}: 95th percentile of response time is less than 100.0`,
    assertion: {
      path: { kind: 'details', parts: [...parts] },
      target: { kind: 'responseTime', stat: 'percentile', rank: 95 },
      condition: { kind: 'lt', value: 100 },
    },
    actualValue: outcome === 'not_applicable' ? null : 572,
    outcome,
  };
}

const GLOBAL_ASSERTION: ToolAssertion = {
  expression: 'Global: max of response time is less than 30000.0',
  assertion: {
    path: { kind: 'global' },
    target: { kind: 'responseTime', stat: 'max' },
    condition: { kind: 'lt', value: 30000 },
  },
  actualValue: 2643,
  outcome: 'passed',
};

const FOR_ALL_ASSERTION: ToolAssertion = {
  expression: 'Session: max of response time is less than 2.0',
  assertion: {
    path: { kind: 'forAll' },
    target: { kind: 'responseTime', stat: 'max' },
    condition: { kind: 'lt', value: 2 },
  },
  actualValue: 1,
  outcome: 'passed',
};

/** A run ingested before the decoder existed: prose and nothing else. */
const UNDECODED_ASSERTION: ToolAssertion = {
  expression: 'Place Order: percentage of failed events is less than 5.0',
  actualValue: 2.68,
  outcome: 'passed',
};

function readyRun(toolAssertions: readonly ToolAssertion[]): RunResponse {
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
    toolAssertions: [...toolAssertions],
  };
}

/**
 * `RunOverviewTab` under a stand-in for `RunShell`'s `<Outlet context/>` — the
 * same harness `RunOverviewTab.baseline.test.tsx` uses, and for the same
 * reason: this tab reads its window from the shell, and the shell's own brush
 * cannot be driven in jsdom.
 *
 * `search` goes on the ROUTER's entry rather than into the context, because
 * `useWindowSuffix` reads the query string directly — it is what decides
 * whether the reader's selection travels into a drill-down.
 */
function renderOverview(
  toolAssertions: readonly ToolAssertion[],
  { search = '' }: { search?: string } = {},
) {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) =>
    Promise.resolve(
      new Response(JSON.stringify(String(input).includes('/trends') ? { runs: [] } : STATS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runQueryKey(RUN_ID), { state: 'ready', run: readyRun(toolAssertions) });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}${search}`]}>
        <Routes>
          <Route
            path="/runs/:runId"
            element={
              <Outlet
                context={
                  {
                    window: null,
                    durationMs: 63161,
                    liveDurationMs: null,
                    live: null,
                  } satisfies RunWindowContext
                }
              />
            }
          >
            <Route index element={<RunOverviewTab />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The simulation-assertion table, once its rows are on screen. */
async function assertionTable(): Promise<HTMLElement> {
  await screen.findAllByTestId('tool-assertion-row');
  return screen.getByRole('table', { name: /every assertion the simulation itself declared/i });
}

/**
 * The table, once the STATISTICS have landed as well as the rows.
 *
 * The rows render off the run body on the first paint and the links do not:
 * whether a name is a request, a group or neither is a question only `/stats`
 * can answer. So every assertion that a target is NOT a link has to wait for
 * that, or it passes against a table that simply had not been told yet — the
 * fallback trap CLAUDE.md records, met one query over. Each such case seeds a
 * target that MUST link, and this waits on it.
 */
async function tableWithLinks(anchor: string): Promise<HTMLElement> {
  const table = await assertionTable();
  await within(table).findByRole('link', { name: anchor });
  return table;
}

/* ======================================================================== *
 * THE SENTENCE IS WITHHELD, NOT DELETED
 * ======================================================================== */

describe('ToolAssertions — the tool’s own wording', () => {
  it('does not repeat in prose what the four columns already carry', async () => {
    renderOverview([details(['Search'], 'failed')]);
    const table = await assertionTable();

    // The structured columns are what is on screen at rest.
    for (const name of ['Status', 'Target', 'Metric', 'Bound', 'Actual']) {
      expect(within(table).getByRole('columnheader', { name })).toBeInTheDocument();
    }
    expect(within(table).queryByRole('columnheader', { name: 'Assertion' })).toBeNull();
    expect(within(table).queryByText(/95th percentile of response time is less than/i)).toBeNull();
  });

  /** AND IT COMES BACK IN FULL. G-05's tolerance is the exact string, so this
   *  asserts the sentence itself rather than that a sixth column exists. */
  it('brings the exact sentence back on request', async () => {
    const user = userEvent.setup();
    renderOverview([details(['Search'], 'failed')]);
    await assertionTable();

    await user.click(screen.getByTestId('tool-assertions-wording'));

    const table = await assertionTable();
    expect(within(table).getByRole('columnheader', { name: 'Assertion' })).toBeInTheDocument();
    expect(
      within(table).getByText('Search: 95th percentile of response time is less than 100.0'),
    ).toBeInTheDocument();

    // And it folds away again — a one-way control would make the column a
    // permanent cost for anyone who looked at it once.
    await user.click(screen.getByTestId('tool-assertions-wording'));
    expect(
      within(await assertionTable()).queryByRole('columnheader', { name: 'Assertion' }),
    ).toBeNull();
  });

  /**
   * THE ROW THAT HAS NOTHING ELSE TO SAY. `assertion` is `.optional()` on the
   * wire — a run ingested before the decoder, or an API pod that predates it —
   * and such a row renders four em dashes. Withholding the sentence there
   * would leave a row that states nothing at all, so the column is forced open
   * and the toggle withdrawn rather than offered as a way to empty the table.
   */
  it('forces the wording open for a row whose structure never decoded', async () => {
    renderOverview([UNDECODED_ASSERTION]);
    const table = await assertionTable();

    expect(within(table).getByRole('columnheader', { name: 'Assertion' })).toBeInTheDocument();
    expect(
      within(table).getByText('Place Order: percentage of failed events is less than 5.0'),
    ).toBeInTheDocument();
    // A toggle that cannot change anything is worse than no toggle.
    expect(screen.queryByTestId('tool-assertions-wording')).toBeNull();
  });
});

/* ======================================================================== *
 * THE TARGET IS A ROUTE TO THE EVIDENCE
 * ======================================================================== */

describe('ToolAssertions — the target leads somewhere', () => {
  it('links a failing request to its own analysis', async () => {
    renderOverview([details(['Search'], 'failed')]);
    const table = await tableWithLinks('Search');

    expect(within(table).getByRole('link', { name: 'Search' })).toHaveAttribute(
      'href',
      `/runs/${RUN_ID}/requests/Search`,
    );
  });

  /**
   * THE LABEL AND THE IDENTITY ARE SPELLED DIFFERENTLY, and only one of them
   * addresses a row. `Cart / Add To Cart` reads as a path; `Cart/Add To Cart`
   * IS one — it is what `rowFor` keys on and what `buildTree`'s `SEPARATOR`
   * splits. A link built from the spaced label resolves to nothing.
   */
  it('addresses a nested request by its unspaced path, not its spaced label', async () => {
    renderOverview([details(['Cart', 'Add To Cart'], 'failed')]);
    const table = await tableWithLinks('Cart / Add To Cart');

    expect(within(table).getByRole('link', { name: 'Cart / Add To Cart' })).toHaveAttribute(
      'href',
      `/runs/${RUN_ID}/requests/${encodeURIComponent('Cart/Add To Cart')}`,
    );
  });

  /**
   * ═══ A GROUP TARGET LINKS TO ITS GROUP PAGE ═══
   *
   * The evaluator resolves a `details` path against requests first and then
   * groups, reading a group from `group_cumulated` — the family the engine
   * actually files it under. This mirror has to agree, or the link and the
   * verdict beside it disagree about whether the run has data for that name.
   *
   * `Cart` is a GROUP in the reference payload (`group_cumulated`), and is
   * deliberately not also a request, so the section in the href is the whole
   * assertion.
   */
  it('links a group target to its group analysis, not to a request', async () => {
    renderOverview([details(['Cart'], 'passed'), details(['Search'], 'passed')]);
    const table = await tableWithLinks('Search');

    expect(within(table).getByRole('link', { name: 'Cart' })).toHaveAttribute(
      'href',
      `/runs/${RUN_ID}/groups/Cart`,
    );
  });

  /**
   * A `not_applicable` row names something this run has no data for — that is
   * what the outcome MEANS. Linking it would send the reader to a page whose
   * only content is that the request was not found: the same dead end, one
   * click further along.
   */
  it('offers no link for a target this run never recorded', async () => {
    /* The `Search` row is the proof the statistics have landed; without it
       this case would pass against a table that had not been told anything.
       It PASSES rather than fails, because one failing row collapses every
       other row behind the disclosure and Ghost is the row being asserted on. */
    renderOverview([details(['Ghost'], 'not_applicable'), details(['Search'], 'passed')]);
    const table = await tableWithLinks('Search');

    expect(within(table).getByText('Ghost')).toBeInTheDocument();
    expect(within(table).queryByRole('link', { name: 'Ghost' })).toBeNull();
  });

  /**
   * NEITHER OF THE OTHER TWO PATH SHAPES NAMES A ROW. `global` is the run,
   * which is the page the reader is already on; `forAll` ranges over every
   * request rather than naming one, and the row's own request survives only in
   * the tool's prose — which `toolAssertion.ts` exists specifically not to
   * parse back apart.
   */
  it('leaves the run and every-request targets as plain text', async () => {
    // Passing, for the same reason as above: a failed row would hide these two.
    renderOverview([GLOBAL_ASSERTION, FOR_ALL_ASSERTION, details(['Search'], 'passed')]);
    const table = await tableWithLinks('Search');

    for (const label of ['the run', 'every request']) {
      expect(within(table).getByText(label)).toBeInTheDocument();
      expect(within(table).queryByRole('link', { name: label })).toBeNull();
    }
  });

  /** The reader's selected interval travels with the drill-down, exactly as
   *  the statistics table's own request link carries it — an investigation
   *  that started inside a brushed window should stay inside it. */
  it('carries the analysis window into the drill-down', async () => {
    renderOverview([details(['Search'], 'failed')], { search: '?from=10000&to=30000' });
    const table = await tableWithLinks('Search');

    expect(within(table).getByRole('link', { name: 'Search' })).toHaveAttribute(
      'href',
      `/runs/${RUN_ID}/requests/Search?from=10000&to=30000`,
    );
  });

  /** Until the statistics arrive there is no way to know whether a name is a
   *  request, a group or neither — so the name renders, and only the link
   *  waits. A table that withheld the target entirely would be worse than the
   *  dead end this finding is about. */
  it('renders the name before the statistics can say whether it is linkable', async () => {
    renderOverview([details(['Search'], 'failed')]);

    // The row exists on the first paint, off the run body alone.
    const row = (await screen.findAllByTestId('tool-assertion-row'))[0]!;
    expect(within(row).getByText('Search')).toBeInTheDocument();

    // And the link arrives with the statistics.
    await waitFor(() =>
      expect(within(row).getByRole('link', { name: 'Search' })).toBeInTheDocument(),
    );
  });
});
