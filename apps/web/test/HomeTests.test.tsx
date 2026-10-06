import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrgTestListResponseSchema,
  attentionReasons,
  type OrgTestListResponse,
} from '@perfportal/contracts';
import { orgTestsPageQueryKey, orgTestsQueryKey } from '../src/api/tests';
import HomeTests, { HOME_FILTER_DEBOUNCE_MS, HOME_TESTS_LIMIT } from '../src/home/HomeTests';
import { runName } from '../src/runNumber';
import { projectTestPath, runPath } from '../src/routes/paths';
import useIsCompact from '../src/useIsCompact';

/**
 * ═══ THE HOME PAGE'S TESTS TABLE ═══
 *
 * One list of every test in the organisation, filtered by a box and walked a
 * page at a time. What is worth pinning is the part that is easy to get wrong
 * and silent when it is: the filter and the cursor are two pieces of state
 * that must move together, because a cursor belongs to the filter it came
 * from.
 *
 * Fixtures are parsed through the real `OrgTestListResponseSchema`, so a
 * malformed one fails here instead of quietly sending the component down a
 * fallback. Expectations that are FACTS about a fixture (a link's destination,
 * a rounded value) are read off it; the few that are the spec's own words
 * ("No tests yet", "Next") are written down, because they are what a reader
 * is promised.
 */
afterEach(cleanup);

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
const useIsCompactMock = vi.mocked(useIsCompact);
beforeEach(() => {
  useIsCompactMock.mockReset();
  useIsCompactMock.mockReturnValue(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const id = (n: number) => `1a2b3c4d-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CHECKOUT = { slug: 'checkout', name: 'Checkout' };
const SEARCH = { slug: 'search', name: 'Search Service' };

/** Failed its gate and two of its own checks; its latest run IS the last point. */
const SOAK = {
  id: id(1),
  slug: 'checkout-soak',
  name: 'Checkout soak',
  simulationClass: 'example.SoakSimulation',
  runCount: 12,
  project: CHECKOUT,
  latestRun: {
    id: id(103),
    runNumber: 12,
    status: 'complete',
    verdict: 'failed',
    startedAt: '2026-10-05T09:00:00.000Z',
    durationMs: 60_000,
    checks: { failed: 2, total: 5 },
    p95Ms: 812.6,
  },
  p95History: [
    { runId: id(101), runNumber: 10, p95Ms: 610.4 },
    { runId: id(102), runNumber: 11, p95Ms: 700.2 },
    { runId: id(103), runNumber: 12, p95Ms: 812.6 },
  ],
};
/** Fine: nothing about its latest run needs attention. */
const SMOKE = {
  id: id(2),
  slug: 'checkout-smoke',
  name: 'Checkout smoke',
  simulationClass: 'example.SmokeSimulation',
  runCount: 4,
  project: CHECKOUT,
  latestRun: {
    id: id(203),
    runNumber: 4,
    status: 'complete',
    verdict: 'passed',
    startedAt: '2026-10-04T09:00:00.000Z',
    durationMs: 30_000,
    checks: { failed: 0, total: 3 },
    p95Ms: 120.4,
  },
  p95History: [
    { runId: id(201), runNumber: 2, p95Ms: 118 },
    { runId: id(202), runNumber: 3, p95Ms: 121 },
    { runId: id(203), runNumber: 4, p95Ms: 120.4 },
  ],
};
/**
 * Its latest run FAILED TO INGEST, so it has no p95 and is not in the history:
 * the last point belongs to an older, healthy run. That point must not be
 * painted as though it were the run that needs attention.
 */
const STUCK = {
  id: id(3),
  slug: 'search-stuck',
  name: 'Search stuck',
  simulationClass: 'example.StuckSimulation',
  runCount: 3,
  project: SEARCH,
  latestRun: {
    id: id(303),
    runNumber: null,
    status: 'failed',
    verdict: null,
    startedAt: '2026-10-05T11:00:00.000Z',
    durationMs: null,
    checks: null,
    p95Ms: null,
  },
  p95History: [
    { runId: id(301), runNumber: 1, p95Ms: 400 },
    { runId: id(302), runNumber: 2, p95Ms: 410 },
  ],
};
/** Created, never run. */
const NEVER = {
  id: id(4),
  slug: 'search-never',
  name: 'Search never run',
  simulationClass: 'example.NeverSimulation',
  runCount: 0,
  project: SEARCH,
  latestRun: null,
  p95History: [],
};
/** Lives on the second page only. */
const LATE = {
  id: id(5),
  slug: 'checkout-late',
  name: 'Checkout late',
  simulationClass: 'example.LateSimulation',
  runCount: 1,
  project: CHECKOUT,
  latestRun: {
    id: id(403),
    runNumber: 1,
    status: 'complete',
    verdict: 'passed',
    startedAt: '2026-09-01T09:00:00.000Z',
    durationMs: 30_000,
    checks: null,
    p95Ms: 90,
  },
  p95History: [{ runId: id(403), runNumber: 1, p95Ms: 90 }],
};

const list = (items: unknown[], nextCursor: string | null): OrgTestListResponse =>
  OrgTestListResponseSchema.parse({ items, nextCursor });

const PAGE_1 = list([SOAK, SMOKE, STUCK, NEVER], 'cursor-page-2');
const PAGE_2 = list([LATE], null);
/** What any filter answers: a first page that itself has more behind it. */
const FILTERED = list([SOAK], 'cursor-filtered-2');

// ─── The fetch stub ──────────────────────────────────────────────────────────

type Handler = (url: URL) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status < 300 ? 'application/json' : 'application/problem+json' },
  });
}

/** The cursor decides first, then whether a filter was sent, then page one. */
const answer: Handler = (url) => {
  if (url.searchParams.get('cursor') === PAGE_1.nextCursor) return json(PAGE_2);
  if (url.searchParams.has('q')) return json(FILTERED);
  return json(PAGE_1);
};

let requests: URL[] = [];
const asked = () => requests.map((u) => ({ q: u.searchParams.get('q'), cursor: u.searchParams.get('cursor') }));

function Where() {
  const location = useLocation();
  const how = useNavigationType();
  return (
    <>
      <output data-testid="where">{location.search}</output>
      <output data-testid="how">{how}</output>
    </>
  );
}

function renderTests(initialEntry = '/', handler: Handler = answer) {
  requests = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(url);
    return Promise.resolve(url.pathname === '/v1/tests' ? handler(url) : json({}, 404));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Where />
        {/* The rail's own link to this page: same route, no query string. */}
        <Link to="/">Back to the top</Link>
        <HomeTests />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const filterBox = () => screen.getByRole('searchbox', { name: 'Filter tests' });
const where = () => screen.getByTestId('where').textContent;
const rows = () => screen.queryAllByTestId('home-test-row');
const rowOf = (name: string) => {
  const row = rows().find((r) => within(r).queryByRole('link', { name }) !== null);
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
};
const type = (value: string) => fireEvent.change(filterBox(), { target: { value } });
const pager = () => screen.getByRole('navigation', { name: 'Test pages' });
const previous = () => within(pager()).getByRole('button', { name: 'Previous' });
const next = () => within(pager()).getByRole('button', { name: 'Next' });

/** Wait for the debounce to land in the URL and for the request it caused. */
async function settleFilter(value: string) {
  await waitFor(() => expect(where()).toBe(value === '' ? '' : `?q=${value}`));
  if (value !== '') {
    await waitFor(() => expect(asked().some((r) => r.q === value)).toBe(true));
  }
}

// ─── The spec's own numbers ──────────────────────────────────────────────────

describe('HomeTests, the constants the spec names', () => {
  it('is 25 per page and waits a quarter of a second before asking', () => {
    expect(HOME_TESTS_LIMIT).toBe(25);
    expect(HOME_FILTER_DEBOUNCE_MS).toBe(250);
  });

  it('keys a page by its cursor, and apart from the palette’s first-page key', () => {
    expect(orgTestsPageQueryKey('a', 25, 'c1')).not.toEqual(orgTestsPageQueryKey('a', 25, 'c2'));
    expect(orgTestsPageQueryKey('a', 25, null)).not.toEqual(orgTestsPageQueryKey('a', 25, 'c1'));
    expect(orgTestsPageQueryKey('a', HOME_TESTS_LIMIT, null)).not.toEqual(orgTestsQueryKey('a', 5));
    // Not even the palette's key at THIS limit: the cursor is part of the shape.
    expect(orgTestsPageQueryKey('a', HOME_TESTS_LIMIT, null)).not.toEqual(
      orgTestsQueryKey('a', HOME_TESTS_LIMIT),
    );
  });
});

// ─── What a row says ─────────────────────────────────────────────────────────

describe('HomeTests, the table', () => {
  it('is a section named Tests, with a table of the same name and the four columns', async () => {
    renderTests();
    const section = await screen.findByRole('region', { name: 'Tests' });
    expect(within(section).getByRole('heading', { level: 2, name: 'Tests' })).toBeInTheDocument();
    const table = await within(section).findByRole('table', { name: 'Tests' });
    for (const name of ['Name', 'Project', 'Last run', 'p95 · last 10']) {
      expect(within(table).getByRole('columnheader', { name })).toBeInTheDocument();
    }
  });

  it('asks the server for a page of 25 and nothing else on first sight', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.pathname).toBe('/v1/tests');
    expect(requests[0]!.searchParams.get('limit')).toBe(String(HOME_TESTS_LIMIT));
    expect(requests[0]!.searchParams.has('q')).toBe(false);
    expect(requests[0]!.searchParams.has('cursor')).toBe(false);
  });

  it('draws one row per test, in the order the server sent them', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');
    const names = rows().map((r) => within(r).getAllByRole('link')[0]!.textContent);
    expect(names).toEqual(PAGE_1.items.map((t) => t.name));
  });

  it('names a test by a link to its page, with its slug and a copy button beneath', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');
    for (const test of PAGE_1.items) {
      const row = rowOf(test.name);
      expect(within(row).getByRole('link', { name: test.name })).toHaveAttribute(
        'href',
        projectTestPath(test.project.slug, test.slug),
      );
      expect(within(row).getByTestId('home-test-slug')).toHaveTextContent(test.slug);
      expect(
        within(row).getByRole('button', { name: `Copy test slug ${test.slug}` }),
      ).toBeInTheDocument();
    }
  });

  it('draws the project as text, never as a link: the rail owns that name', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');
    for (const test of PAGE_1.items) {
      const row = rowOf(test.name);
      expect(within(row).getByTestId('home-test-project')).toHaveTextContent(test.project.name);
      expect(within(row).queryByRole('link', { name: test.project.name })).toBeNull();
    }
    // Not "Home", not "All runs" either — those belong to the rail too.
    expect(screen.queryByRole('link', { name: 'Home' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'All runs' })).toBeNull();
  });

  it('says what the last run was: its name as a link, and a badge per reason it needs attention', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');
    for (const test of PAGE_1.items) {
      if (test.latestRun === null) continue;
      const row = rowOf(test.name);
      const label = test.latestRun.runNumber === null
        ? `Run ${test.latestRun.id.slice(0, 8)}`
        : runName(test.latestRun.runNumber);
      expect(within(row).getByRole('link', { name: label })).toHaveAttribute(
        'href',
        runPath(test.latestRun.id),
      );
      // One badge per reason the shared rule finds, derived from the run itself.
      expect(row.querySelectorAll('.tint')).toHaveLength(attentionReasons(test.latestRun).length);
    }
    expect(within(rowOf(SOAK.name)).getByText('SLA failed')).toBeInTheDocument();
    expect(within(rowOf(SOAK.name)).getByText('2 assertions failed')).toBeInTheDocument();
    expect(within(rowOf(SMOKE.name)).queryByText('SLA failed')).toBeNull();
  });

  it('says a test that has never run has never run, and draws no line for it', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');
    const row = rowOf(NEVER.name);
    expect(within(row).getByText('Never run')).toBeInTheDocument();
    expect(within(row).queryByTestId('last-run-cell')).toBeNull();
    // The copy button has an icon of its own: it is the SPARKLINE that has no figure.
    expect(within(row).getByTestId('sparkline').querySelector('svg')).toBeNull();
    expect(within(row).getByText('No completed runs with a p95')).toBeInTheDocument();
  });

  it('shows each test’s latest p95 as text, and its range for a screen reader', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');
    for (const test of PAGE_1.items) {
      if (test.p95History.length === 0) continue;
      const row = rowOf(test.name);
      const values = test.p95History.map((p) => p.p95Ms);
      expect(within(row).getByText(`${Math.round(values.at(-1)!)} ms`)).toBeInTheDocument();
      expect(
        within(row).getByText(new RegExp(`^last ${values.length} runs: `)),
      ).toBeInTheDocument();
      expect(within(row).getByTestId('sparkline').querySelector('polyline')).not.toBeNull();
    }
  });

  describe('the last sparkline point', () => {
    const lastFill = (name: string) => {
      const circles = within(rowOf(name)).getByTestId('sparkline').querySelectorAll('circle');
      return circles[circles.length - 1]?.style.fill ?? null;
    };

    it('takes the failed colour when the latest run needs attention AND is that point', async () => {
      renderTests();
      await screen.findAllByTestId('home-test-row');
      // The last point of SOAK's history IS its latest run, which failed its gate.
      expect(SOAK.p95History.at(-1)!.runId).toBe(SOAK.latestRun.id);
      expect(lastFill(SOAK.name)).toBe('var(--color-status-failed)');
    });

    it('does not for a test that is fine', async () => {
      renderTests();
      await screen.findAllByTestId('home-test-row');
      expect(lastFill(SMOKE.name)).not.toContain('--color-status-failed');
    });

    it('does not paint an OLDER run as failed because a NEWER one is: the point must be the run', async () => {
      renderTests();
      await screen.findAllByTestId('home-test-row');
      // STUCK's latest run needs attention, but it has no p95, so the last point is another run.
      const stuck = PAGE_1.items.find((t) => t.id === STUCK.id)!;
      expect(attentionReasons(stuck.latestRun!)).not.toEqual([]);
      expect(STUCK.p95History.at(-1)!.runId).not.toBe(STUCK.latestRun.id);
      expect(
        within(rowOf(STUCK.name)).getByTestId('sparkline').querySelectorAll('circle').length,
      ).toBeGreaterThan(0);
      expect(lastFill(STUCK.name)).not.toContain('--color-status-failed');
    });
  });
});

// ─── The filter ──────────────────────────────────────────────────────────────

describe('HomeTests, the filter', () => {
  it('writes ?q= and asks for it only once typing has paused, replacing the history entry', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');
    const before = requests.length;

    type('chec');
    // Synchronously after the keystroke nothing has gone anywhere.
    expect(where()).toBe('');
    expect(requests).toHaveLength(before);

    await settleFilter('chec');
    expect(asked().at(-1)).toEqual({ q: 'chec', cursor: null });
    expect(screen.getByTestId('how')).toHaveTextContent('REPLACE');
  });

  it('asks once for a word, not once per letter', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');
    for (const value of ['c', 'ch', 'che', 'chec']) type(value);
    await settleFilter('chec');
    expect(asked().filter((r) => r.q !== null)).toEqual([{ q: 'chec', cursor: null }]);
  });

  it('opens on the filter the address already carries, and asks for that and nothing else', async () => {
    renderTests('/?q=chec');
    await screen.findAllByTestId('home-test-row');
    expect((filterBox() as HTMLInputElement).value).toBe('chec');
    expect(asked()).toEqual([{ q: 'chec', cursor: null }]);
    // Opening on it writes nothing: the address was already right.
    expect(where()).toBe('?q=chec');
    expect(screen.getByTestId('how')).toHaveTextContent('POP');
  });

  it('removes ?q= when the box is emptied, and leaves the rest of the query alone', async () => {
    renderTests('/?keep=1&q=chec');
    await screen.findAllByTestId('home-test-row');
    type('');
    await waitFor(() => expect(where()).toBe('?keep=1'));
    await waitFor(() => expect(asked().at(-1)).toEqual({ q: null, cursor: null }));
  });

  it('keeps the address in step with the filter: a navigation that drops ?q= does not clear it', async () => {
    renderTests('/?q=chec');
    await screen.findAllByTestId('home-test-row');

    fireEvent.click(screen.getByRole('link', { name: 'Back to the top' }));
    // The address is put back rather than left saying "unfiltered" over a filtered table...
    await waitFor(() => expect(where()).toBe('?q=chec'));
    // ...and the box and the table never moved.
    expect((filterBox() as HTMLInputElement).value).toBe('chec');
    expect(asked().every((r) => r.q === 'chec')).toBe(true);
  });

  it('treats typing only spaces as no filter at all', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');
    type('   ');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, HOME_FILTER_DEBOUNCE_MS + 100));
    });
    expect(where()).toBe('');
    expect(requests).toHaveLength(1);
  });

  it('does not ask again, or rewrite the box, for a space typed after the word', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');
    type('chec');
    await settleFilter('chec');
    const asks = requests.length;

    type('chec ');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, HOME_FILTER_DEBOUNCE_MS + 100));
    });
    expect(requests).toHaveLength(asks);
    expect(where()).toBe('?q=chec');
    expect((filterBox() as HTMLInputElement).value).toBe('chec ');
  });
});

// ─── The pager ───────────────────────────────────────────────────────────────

describe('HomeTests, the pager', () => {
  it('opens on the first page: Previous is disabled, Next is not', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');
    expect(previous()).toBeDisabled();
    expect(next()).toBeEnabled();
  });

  it('sends the cursor the server gave for Next, and comes back to the first page with Previous', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');

    fireEvent.click(next());
    await screen.findByRole('link', { name: LATE.name });
    expect(asked().at(-1)).toEqual({ q: null, cursor: PAGE_1.nextCursor });
    // Page two replaces page one: nothing of it is left on screen.
    expect(screen.queryByRole('link', { name: SMOKE.name })).toBeNull();
    expect(previous()).toBeEnabled();
    // The server said there is nothing after this page.
    expect(PAGE_2.nextCursor).toBeNull();
    expect(next()).toBeDisabled();

    fireEvent.click(previous());
    await screen.findByRole('link', { name: SMOKE.name });
    expect(screen.queryByRole('link', { name: LATE.name })).toBeNull();
    expect(previous()).toBeDisabled();
    expect(next()).toBeEnabled();
    expect(asked().at(-1)?.cursor).toBeNull();
  });

  it('keeps Next off while the next page is on its way, so a second click cannot skip one', async () => {
    let release!: (res: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    renderTests('/', (url) => (url.searchParams.has('cursor') ? held : answer(url)));
    await screen.findAllByTestId('home-test-row');

    fireEvent.click(next());
    await waitFor(() => expect(asked().at(-1)?.cursor).toBe(PAGE_1.nextCursor));
    expect(next()).toBeDisabled();
    expect(next()).toHaveAttribute('aria-busy', 'true');

    release(json(PAGE_2));
    await screen.findByRole('link', { name: LATE.name });
    expect(next()).not.toHaveAttribute('aria-busy');
  });

  it('draws no pager at all when there is no page to turn', async () => {
    renderTests('/', () => json(list([], null)));
    await screen.findByText('No tests yet');
    expect(screen.queryByRole('navigation', { name: 'Test pages' })).toBeNull();
  });

  it('turns Next off at the last page when the server sent no cursor', async () => {
    renderTests('/', () => json(list([SMOKE], null)));
    await screen.findAllByTestId('home-test-row');
    expect(previous()).toBeDisabled();
    expect(next()).toBeDisabled();
  });

  /**
   * ═══ A CURSOR BELONGS TO THE FILTER IT CAME FROM ═══
   *
   * Review focus 5. Carrying page two's cursor across a filter change asks the
   * API to continue a walk through a list that no longer exists — and the
   * answer is a page of the NEW filter that starts somewhere in the middle, or
   * an empty one, with nothing on screen saying why.
   */
  it('goes back to the first page when the filter changes on page two', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');
    fireEvent.click(next());
    await screen.findByRole('link', { name: LATE.name });
    expect(previous()).toBeEnabled();

    type('zz');
    await settleFilter('zz');

    // THE request after the change carries no cursor — every one of them.
    const filtered = asked().filter((r) => r.q === 'zz');
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((r) => r.cursor === null)).toBe(true);

    // And the page that comes back is a first page.
    await waitFor(() => expect(screen.queryByRole('link', { name: LATE.name })).toBeNull());
    expect(previous()).toBeDisabled();
    expect(next()).toBeEnabled();
  });

  it('does not resume an old page when the filter comes back to a value it had before', async () => {
    renderTests();
    await screen.findAllByTestId('home-test-row');
    fireEvent.click(next());
    await screen.findByRole('link', { name: LATE.name });

    type('zz');
    await settleFilter('zz');
    await waitFor(() => expect(screen.queryByRole('link', { name: LATE.name })).toBeNull());

    type('');
    await waitFor(() => expect(where()).toBe(''));
    // Page ONE of the unfiltered list — not page two, which it was last on.
    await screen.findByRole('link', { name: SMOKE.name });
    expect(screen.queryByRole('link', { name: LATE.name })).toBeNull();
    expect(previous()).toBeDisabled();
    expect(asked().at(-1)?.cursor).toBeNull();
  });
});

// ─── Nothing to show, and failing ────────────────────────────────────────────

describe('HomeTests, when there is nothing to show', () => {
  it('says there are no tests when the organisation has none', async () => {
    renderTests('/', () => json(list([], null)));
    expect(await screen.findByText('No tests yet')).toBeInTheDocument();
    expect(screen.queryByText(/No tests match/)).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('names the filter when nothing matches it', async () => {
    renderTests('/?q=zzz', () => json(list([], null)));
    expect(await screen.findByText('No tests match “zzz”')).toBeInTheDocument();
    expect(screen.queryByText('No tests yet')).toBeNull();
  });

  it('never says a filter matched nothing while the answer for it is still on its way', async () => {
    // First answer: nothing matches `zzz`. Then the box is changed to `zz`, whose answer is held.
    let release!: (res: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    renderTests('/?q=zzz', (url) =>
      url.searchParams.get('q') === 'zz' ? held : json(list([], null)),
    );
    await screen.findByText('No tests match “zzz”');

    type('zz');
    await waitFor(() => expect(asked().some((r) => r.q === 'zz')).toBe(true));
    // The old, empty answer is still all there is. It must not wear the new filter's name.
    expect(screen.queryByText('No tests match “zz”')).toBeNull();

    release(json(list([], null)));
    expect(await screen.findByText('No tests match “zz”')).toBeInTheDocument();
  });

  it('shows a failed read as an alert inside this section, with the section still usable', async () => {
    renderTests('/', () =>
      json({ code: 'INTERNAL', detail: 'The list could not be built.', remediation: 'Try again later.' }, 500),
    );
    const alert = await screen.findByRole('alert');
    const section = screen.getByRole('region', { name: 'Tests' });
    expect(section).toContainElement(alert);
    expect(alert).toHaveTextContent('The list could not be built.');
    expect(alert).toHaveTextContent('Try again later.');
    // The heading and the filter are not taken away with the table.
    expect(within(section).getByRole('heading', { level: 2, name: 'Tests' })).toBeInTheDocument();
    expect(within(section).getByRole('searchbox', { name: 'Filter tests' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Test pages' })).toBeNull();
  });
});

// ─── A phone ─────────────────────────────────────────────────────────────────

describe('HomeTests, below 768px', () => {
  beforeEach(() => {
    useIsCompactMock.mockReturnValue(true);
  });

  it('is a list of cards, not a table, carrying the same facts', async () => {
    renderTests();
    const list = await screen.findByRole('list', { name: 'Tests' });
    expect(screen.queryByRole('table')).toBeNull();
    expect(within(list).getAllByRole('listitem')).toHaveLength(PAGE_1.items.length);

    const card = rowOf(SOAK.name);
    expect(within(card).getByRole('link', { name: SOAK.name })).toHaveAttribute(
      'href',
      projectTestPath(SOAK.project.slug, SOAK.slug),
    );
    expect(within(card).getByTestId('home-test-slug')).toHaveTextContent(SOAK.slug);
    expect(within(card).getByTestId('home-test-project')).toHaveTextContent(SOAK.project.name);
    expect(within(card).queryByRole('link', { name: SOAK.project.name })).toBeNull();
    expect(within(card).getByRole('link', { name: runName(SOAK.latestRun.runNumber) })).toBeInTheDocument();
    expect(within(card).getByText('p95 · last 10')).toBeInTheDocument();
    expect(within(card).getByText(`${Math.round(SOAK.p95History.at(-1)!.p95Ms)} ms`)).toBeInTheDocument();
    expect(within(rowOf(NEVER.name)).getByText('Never run')).toBeInTheDocument();
  });

  it('gives the copy button a fingertip-sized target; the table’s is the 24px row size', async () => {
    renderTests();
    await screen.findByRole('list', { name: 'Tests' });
    expect(within(rowOf(SOAK.name)).getByRole('button', { name: `Copy test slug ${SOAK.slug}` })).toHaveClass('h-9');

    cleanup();
    useIsCompactMock.mockReturnValue(false);
    renderTests();
    await screen.findByRole('table', { name: 'Tests' });
    expect(within(rowOf(SOAK.name)).getByRole('button', { name: `Copy test slug ${SOAK.slug}` })).toHaveClass('h-6');
  });

  it('pages and filters the same way', async () => {
    renderTests();
    await screen.findByRole('list', { name: 'Tests' });
    fireEvent.click(next());
    await screen.findByRole('link', { name: LATE.name });
    expect(asked().at(-1)).toEqual({ q: null, cursor: PAGE_1.nextCursor });
    type('zz');
    await settleFilter('zz');
    expect(asked().filter((r) => r.q === 'zz').every((r) => r.cursor === null)).toBe(true);
  });
});
