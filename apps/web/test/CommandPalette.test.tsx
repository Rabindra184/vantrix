import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OrgTestListResponse,
  OrgTestSummary,
  ProjectListResponse,
  RunListResponse,
} from '@perfportal/contracts';
import CommandPalette from '../src/palette/CommandPalette';
import { orgTestsQueryKey } from '../src/api/tests';
import { projectTestPath } from '../src/routes/paths';

afterEach(cleanup);

/*
 * ═══ WHAT jsdom LACKS THAT THE PALETTE CALLS ═══
 *
 * `cmdk` scrolls the highlighted option into view on every move, and measures
 * its list with a `ResizeObserver`. jsdom implements neither, and either one
 * missing throws inside a React effect — which reads as the palette failing to
 * render rather than as the harness. Both are inert here: nothing in this file
 * asserts scrolling or the list's height.
 */
const hadScrollIntoView = 'scrollIntoView' in Element.prototype;
beforeAll(() => {
  if (!hadScrollIntoView) Element.prototype.scrollIntoView = () => {};
});
afterAll(() => {
  if (!hadScrollIntoView) delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', InertResizeObserver);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// Names are chosen so no project, test or page label is a substring of
// another's where a case depends on which one matched: `Checkout` the project,
// `Checkout smoke` and `Checkout soak` the tests, `Search` a second project
// whose own name matches none of the queries below.

const CHECKOUT_ID = '11111111-1111-4111-8111-111111111111';
const SEARCH_ID = '22222222-2222-4222-8222-222222222222';

const PROJECTS: ProjectListResponse['items'] = [
  { id: CHECKOUT_ID, slug: 'checkout', name: 'Checkout', latestRun: null },
  { id: SEARCH_ID, slug: 'search', name: 'Search', latestRun: null },
];

function orgTest(
  id: string,
  slug: string,
  name: string,
  project: { slug: string; name: string } = { slug: 'checkout', name: 'Checkout' },
): OrgTestSummary {
  return {
    id,
    slug,
    name,
    simulationClass: 'example.CheckoutSimulation',
    runCount: 12,
    project,
    latestRun: {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      runNumber: 12,
      status: 'complete',
      verdict: 'passed',
      startedAt: '2026-10-01T10:00:00.000Z',
      durationMs: 60_000,
      checks: null,
      p95Ms: 120,
    },
    p95History: [],
  };
}

const SMOKE = orgTest('33333333-3333-4333-8333-333333333333', 'checkout-smoke', 'Checkout smoke');
const SOAK = orgTest('44444444-4444-4444-8444-444444444444', 'checkout-soak', 'Checkout soak');
const SEARCH_SMOKE = orgTest(
  '55555555-5555-4555-8555-555555555555',
  'search-smoke',
  'Search smoke',
  { slug: 'search', name: 'Search' },
);

type RunRow = RunListResponse['items'][number];

function runRow(id: string, runNumber: number | null, test: OrgTestSummary = SMOKE): RunRow {
  return {
    id,
    project: { id: CHECKOUT_ID, slug: test.project.slug, name: test.project.name },
    status: 'complete',
    verdict: 'passed',
    tool: 'gatling',
    startedAt: '2026-10-01T10:00:00.000Z',
    toolStartedAt: '2026-10-01T10:00:00.000Z',
    simulation: 'example.CheckoutSimulation',
    test: { id: test.id, slug: test.slug, name: test.name },
    runNumber,
  };
}

const RUN_7 = runRow('66666666-6666-4666-8666-666666666666', 7);
const RUN_12 = runRow('77777777-7777-4777-8777-777777777777', 12);

// ─── The fetch stub ──────────────────────────────────────────────────────────

type Answer = Response | Promise<Response>;
type Handler = (url: URL) => Answer;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status < 300 ? 'application/json' : 'application/problem+json' },
  });
}

function problem(status: number, code: string): Response {
  return json({ code, detail: `${code} from the stub`, remediation: 'Nothing to do.' }, status);
}

const tests = (items: OrgTestSummary[]): OrgTestListResponse => ({ items, nextCursor: null });
const runs = (items: RunRow[]): RunListResponse => ({ items, nextCursor: null });

/** A response the case releases when it chooses — how "still loading" is held. */
function deferred(): { readonly promise: Promise<Response>; resolve(res: Response): void } {
  let resolve!: (res: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Every request the palette made, as `pathname?search`, in order. */
let requests: string[] = [];

function stubApi(routes: { tests?: Handler; runs?: Handler; projects?: Handler } = {}): void {
  requests = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/v1/projects') {
      return Promise.resolve(routes.projects ? routes.projects(url) : json({ items: PROJECTS }));
    }
    if (url.pathname === '/v1/tests') {
      return Promise.resolve(routes.tests ? routes.tests(url) : json(tests([])));
    }
    if (url.pathname === '/v1/runs') {
      return Promise.resolve(routes.runs ? routes.runs(url) : json(runs([])));
    }
    return Promise.resolve(problem(404, 'NOT_FOUND'));
  });
}

const requestsTo = (pathname: string): URL[] =>
  requests
    .map((r) => new URL(r, 'http://localhost'))
    .filter((u) => u.pathname === pathname);

/** The run-by-number lookups: `GET /v1/runs` calls carrying `number=`. */
const numberLookups = (): URL[] => requestsTo('/v1/runs').filter((u) => u.searchParams.has('number'));

// ─── The harness ─────────────────────────────────────────────────────────────

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function Harness({
  initialOpen,
  onOpenChange,
}: {
  readonly initialOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={opener} type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <CommandPalette
        open={open}
        returnFocusFallback={opener}
        onOpenChange={(next) => {
          onOpenChange(next);
          setOpen(next);
        }}
      />
      <Where />
    </>
  );
}

function renderPalette({ route = '/runs', open = true }: { route?: string; open?: boolean } = {}) {
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Harness initialOpen={open} onOpenChange={onOpenChange} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, client, onOpenChange };
}

const input = () => screen.getByRole('combobox');

/**
 * Enter `text` as ONE change — a paste, appended at the caret.
 *
 * Every case but the debounce one wants to ask the palette one question.
 * Typing it a key at a time asks every prefix too whenever the machine is slow
 * enough for 150 ms to pass between two keystrokes: `checkout #1` before
 * `checkout #12`, each prefix's searches answered from the same held stub. So
 * those cases would test the debounce by accident, and fail on a loaded
 * machine for a reason that is not theirs.
 */
async function enter(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.click(input());
  await user.paste(text);
}

/** Group headings in DOM order. cmdk marks its own heading element. */
const headings = (): string[] =>
  [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent ?? '');

const optionNames = (group: HTMLElement): string[] =>
  within(group)
    .getAllByRole('option')
    .map((o) => o.textContent ?? '');

// ─── Cases ───────────────────────────────────────────────────────────────────

describe('CommandPalette', () => {
  it("shows Go to with the current project's pages before anything is typed", async () => {
    stubApi();
    renderPalette({ route: '/projects/checkout/rules' });

    // The project's NAME, which only arrives with the project list — the slug
    // `checkout` is the fallback and would read "Tests · checkout".
    await screen.findByRole('option', { name: 'Tests · Checkout' });
    const goTo = screen.getByRole('group', { name: 'Go to' });
    expect(optionNames(goTo)).toEqual([
      'Home',
      'All runs',
      'New project',
      'Tests · Checkout',
      'Runs · Checkout',
      'Packages · Checkout',
      'Add results · Checkout',
      'SLA rules · Checkout',
      'API tokens · Checkout',
      'New on-prem run · Checkout',
    ]);
    // Nothing typed, so nothing searched.
    expect(requestsTo('/v1/tests')).toHaveLength(0);
    expect(requestsTo('/v1/runs')).toHaveLength(0);
  });

  it('waits 150 ms after the last keystroke before searching', () => {
    /* Synchronous on purpose. user-event awaits Testing Library's async
       wrapper, which drains with a `setTimeout(0)` and recognises only JEST's
       fake timers — under vitest's it never fires and the case hangs. A
       `change` per keystroke is what the input receives either way. */
    vi.useFakeTimers();
    stubApi();
    renderPalette();
    const type = (value: string) => fireEvent.change(input(), { target: { value } });

    // Each keystroke inside the window restarts it: 100 ms apart, never 150.
    type('c');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    type('ch');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    type('che');
    expect(requestsTo('/v1/tests')).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(requestsTo('/v1/tests')).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    const searches = requestsTo('/v1/tests');
    // ONE request, for the whole word: `c` and `ch` were never asked.
    expect(searches).toHaveLength(1);
    expect(searches[0]?.searchParams.get('q')).toBe('che');
    expect(searches[0]?.searchParams.get('limit')).toBe('5');
  });

  it('renders groups in a fixed order', async () => {
    stubApi({
      tests: () => json(tests([SMOKE])),
      runs: () => json(runs([RUN_7])),
    });
    renderPalette({ route: '/projects/checkout/rules' });
    const user = userEvent.setup();

    await enter(user, 'che');
    // Every group is drawn, so the order read below is final.
    await screen.findByRole('group', { name: 'Tests' });
    await screen.findByRole('group', { name: 'Runs' });
    expect(headings()).toEqual(['Projects', 'Pages', 'Tests', 'Runs']);
  });

  it('keeps the other groups when one fails', async () => {
    stubApi({
      tests: () => problem(500, 'INTERNAL'),
      runs: () => json(runs([RUN_7])),
    });
    renderPalette();
    const user = userEvent.setup();

    await enter(user, 'smoke');
    expect(await screen.findByText("Couldn't search tests")).toBeInTheDocument();
    const runsGroup = await screen.findByRole('group', { name: 'Runs' });
    expect(within(runsGroup).getByRole('option', { name: /Run 7/ })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Tests' })).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't search runs")).not.toBeInTheDocument();
  });

  it('says No results only after every group has answered', async () => {
    const heldRuns = deferred();
    const heldNext = deferred();
    stubApi({
      tests: () => json(tests([])),
      runs: (url) => (url.searchParams.get('q') === 'zzzq' ? heldNext.promise : heldRuns.promise),
    });
    const { client } = renderPalette();
    const user = userEvent.setup();

    await enter(user, 'zzz');
    // Every other group has answered with nothing: projects and pages are
    // matched locally, and the test search has SUCCEEDED, empty.
    await waitFor(() => {
      expect(client.getQueryState(orgTestsQueryKey('zzz', 5))?.status).toBe('success');
    });
    expect(requestsTo('/v1/runs')).toHaveLength(1);
    await act(async () => {});
    expect(screen.queryByText(/No results/)).not.toBeInTheDocument();

    heldRuns.resolve(json(runs([])));
    expect(await screen.findByText('No results for “zzz”')).toBeInTheDocument();

    /* The NEXT query is unanswered too while the previous answer is held on
       screen — an empty one, here. Held is not answered: no "No results" for
       a query whose runs have not come back. */
    await enter(user, 'q');
    await waitFor(() => {
      expect(client.getQueryState(orgTestsQueryKey('zzzq', 5))?.status).toBe('success');
    });
    await act(async () => {});
    expect(screen.queryByText(/No results/)).not.toBeInTheDocument();

    heldNext.resolve(json(runs([])));
    expect(await screen.findByText('No results for “zzzq”')).toBeInTheDocument();
  });

  it('looks a run up by number within the matching tests', async () => {
    stubApi({
      tests: (url) =>
        url.searchParams.get('q') === 'checkout' ? json(tests([SMOKE, SOAK])) : json(tests([])),
      runs: (url) => {
        if (!url.searchParams.has('number')) return json(runs([]));
        return url.searchParams.get('test') === 'checkout-smoke'
          ? json(runs([RUN_12]))
          : json(runs([]));
      },
    });
    renderPalette();
    const user = userEvent.setup();

    await enter(user, 'checkout #12');
    const group = await screen.findByRole('group', { name: 'Run by number' });
    expect(optionNames(group)).toEqual(['Run 12 · Checkout smoke · Checkout']);

    // The tests were resolved with the text BEFORE the `#`, three at most…
    const lookup = requestsTo('/v1/tests').find((u) => u.searchParams.get('q') === 'checkout');
    expect(lookup?.searchParams.get('limit')).toBe('3');
    // …and each one asked for run 12 within its own project and test.
    const lookups = numberLookups();
    expect(lookups.map((u) => u.searchParams.get('test')).sort()).toEqual([
      'checkout-smoke',
      'checkout-soak',
    ]);
    for (const u of lookups) {
      expect(u.searchParams.get('number')).toBe('12');
      expect(u.searchParams.get('project')).toBe('checkout');
      expect(u.searchParams.get('limit')).toBe('1');
    }
  });

  it('shows nothing and no failure for a run number that resolves to nothing', async () => {
    stubApi({ tests: () => json(tests([])) });
    renderPalette();
    const user = userEvent.setup();

    await enter(user, 'checkout #12');
    expect(await screen.findByText('No results for “checkout #12”')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Run by number' })).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't look up that run")).not.toBeInTheDocument();
    // No test matched, so no run was asked for.
    expect(numberLookups()).toHaveLength(0);
  });

  it('counts a test that vanished before its run was looked up as no hit, not a failure', async () => {
    stubApi({
      tests: (url) =>
        url.searchParams.get('q') === 'checkout' ? json(tests([SOAK, SMOKE])) : json(tests([])),
      runs: (url) => {
        if (!url.searchParams.has('number')) return json(runs([]));
        // `checkout-soak` was deleted between the two requests.
        return url.searchParams.get('test') === 'checkout-soak'
          ? problem(404, 'NOT_FOUND')
          : json(runs([RUN_12]));
      },
    });
    renderPalette();
    const user = userEvent.setup();

    await enter(user, 'checkout #12');
    const group = await screen.findByRole('group', { name: 'Run by number' });
    expect(optionNames(group)).toEqual(['Run 12 · Checkout smoke · Checkout']);
    expect(screen.queryByText("Couldn't look up that run")).not.toBeInTheDocument();
  });

  it('reports a run lookup that failed for any other reason', async () => {
    stubApi({
      tests: (url) =>
        url.searchParams.get('q') === 'checkout' ? json(tests([SOAK, SMOKE])) : json(tests([])),
      runs: (url) => {
        if (!url.searchParams.has('number')) return json(runs([RUN_7]));
        return url.searchParams.get('test') === 'checkout-soak'
          ? problem(500, 'INTERNAL')
          : json(runs([RUN_12]));
      },
    });
    renderPalette();
    const user = userEvent.setup();

    await enter(user, 'checkout #12');
    expect(await screen.findByText("Couldn't look up that run")).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Run by number' })).not.toBeInTheDocument();
    // The other groups carry on.
    expect(await screen.findByRole('group', { name: 'Runs' })).toBeInTheDocument();
  });

  it('navigates to the chosen result and closes', async () => {
    stubApi({ tests: () => json(tests([SMOKE, SEARCH_SMOKE])) });
    const { onOpenChange } = renderPalette();
    const user = userEvent.setup();

    await enter(user, 'smoke');
    const first = await screen.findByRole('option', { name: /Checkout smoke/ });
    const second = screen.getByRole('option', { name: /Search smoke/ });
    await waitFor(() => expect(first).toHaveAttribute('aria-selected', 'true'));

    await user.keyboard('{ArrowDown}');
    expect(second).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');

    expect(screen.getByTestId('where')).toHaveTextContent(
      projectTestPath('search', 'search-smoke'),
    );
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens empty again after a search', async () => {
    stubApi({ tests: () => json(tests([SMOKE])) });
    renderPalette();
    const user = userEvent.setup();

    await enter(user, 'smoke');
    await screen.findByRole('group', { name: 'Tests' });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open palette' }));

    expect(input()).toHaveValue('');
    expect(await screen.findByRole('group', { name: 'Go to' })).toBeInTheDocument();
    const searchesBefore = requestsTo('/v1/tests').length;
    // Past the debounce window: a search that outlived the close would land now.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(requestsTo('/v1/tests')).toHaveLength(searchesBefore);
    expect(screen.getByRole('group', { name: 'Go to' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Tests' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Checkout smoke/ })).not.toBeInTheDocument();
  });

  it('announces the result count only while open, once settled', async () => {
    const heldRuns = deferred();
    stubApi({
      tests: () => json(tests([SMOKE, SEARCH_SMOKE])),
      runs: () => heldRuns.promise,
    });
    const { client } = renderPalette({ open: false });
    const user = userEvent.setup();

    // Closed: no region at all.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open palette' }));
    /* Open: the region is there from the start, EMPTY. A region mounted
       already holding its message has not changed, it was inserted — and a
       screen reader announces a live region's changes. */
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();

    await enter(user, 'smoke');
    await waitFor(() => {
      expect(client.getQueryState(orgTestsQueryKey('smoke', 5))?.status).toBe('success');
    });
    await screen.findByRole('option', { name: /Search smoke/ });
    // Two tests are on screen, but the runs have not answered: no count yet.
    expect(region).toBeEmptyDOMElement();

    heldRuns.resolve(json(runs([RUN_7])));
    await waitFor(() => expect(region).toHaveTextContent(/^3 results$/));
    // The same node, filled: changed, not inserted.
    expect(screen.getByRole('status')).toBe(region);
  });

  it('keeps the last results on screen while the next query loads', async () => {
    const heldSmok = deferred();
    stubApi({
      tests: (url) =>
        url.searchParams.get('q') === 'smok' ? heldSmok.promise : json(tests([SMOKE, SEARCH_SMOKE])),
    });
    renderPalette();
    const user = userEvent.setup();

    // No project is named like this, so the tests are the only rows.
    await enter(user, 'smo');
    await screen.findByRole('option', { name: /Checkout smoke/ });

    await enter(user, 'k');
    await waitFor(() => {
      expect(requestsTo('/v1/tests').map((u) => u.searchParams.get('q'))).toContain('smok');
    });
    await act(async () => {});
    // `smok` is in flight; the `smo` answer stays rather than flashing empty.
    expect(screen.getByRole('option', { name: /Checkout smoke/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Search smoke/ })).toBeInTheDocument();
    // …and so does its count: the region changes, it is not removed and re-added.
    expect(screen.getByRole('status')).toHaveTextContent(/^2 results$/);

    heldSmok.resolve(json(tests([SOAK])));
    const soak = await screen.findByRole('option', { name: /Checkout soak/ });
    expect(screen.queryByRole('option', { name: /Checkout smoke/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^1 result$/);
    /* Both old rows left in ONE commit — the case cmdk's own bookkeeping
       loses, leaving nothing highlighted and Enter dead. */
    await waitFor(() => expect(soak).toHaveAttribute('aria-selected', 'true'));
  });

  it('does not navigate to a Go to row when Enter follows typing at once', () => {
    vi.useFakeTimers();
    stubApi({ tests: () => json(tests([SMOKE])) });
    const { onOpenChange } = renderPalette({ route: '/projects/checkout/rules' });
    // Before anything is typed, Go to is on screen and its first row — Home —
    // is highlighted.
    expect(screen.getByRole('option', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');

    // A fast typist: the whole word, then Enter, all inside the 150 ms pause.
    fireEvent.change(input(), { target: { value: 'smoke' } });
    /* Go to leaves with the first keystroke, not when the pause ends: no row
       is left on screen for Enter to choose. Asserted BEFORE Enter, because
       Enter ends the pause and would hide a Go to list that outlived it. */
    expect(screen.queryByRole('group', { name: 'Go to' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(screen.getByTestId('where')).toHaveTextContent(/^\/projects\/checkout\/rules$/);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('searches at once when Enter is pressed during the pause', async () => {
    vi.useFakeTimers();
    stubApi({
      tests: (url) =>
        url.searchParams.get('q') === 'smo' ? json(tests([SMOKE])) : json(tests([SOAK])),
    });
    const { onOpenChange } = renderPalette();
    const settle = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    // `smo` has been answered and its row is highlighted.
    fireEvent.change(input(), { target: { value: 'smo' } });
    await settle(150);
    await settle(50);
    expect(screen.getByRole('option', { name: /Checkout smoke/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // `smok` and Enter inside the pause: the highlighted row answers `smo`, not
    // what was typed, so Enter must not choose it — it asks for `smok` NOW.
    fireEvent.change(input(), { target: { value: 'smok' } });
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(screen.getByTestId('where')).toHaveTextContent(/^\/runs$/);
    expect(onOpenChange).not.toHaveBeenCalled();
    const asked = () => requestsTo('/v1/tests').map((u) => u.searchParams.get('q'));
    // No time has passed since the keystroke, and the search has been sent.
    expect(asked()).toEqual(['smo', 'smok']);
    // The pause's own timer, when it lapses, asks nothing a second time.
    await settle(150);
    expect(asked()).toEqual(['smo', 'smok']);
  });

  it('keeps exactly one row highlighted when the highlighted one is narrowed away', async () => {
    stubApi({
      tests: (url) =>
        url.searchParams.get('q') === 'smok'
          ? json(tests([SOAK]))
          : json(tests([SMOKE, SEARCH_SMOKE, SOAK])),
    });
    renderPalette();
    const user = userEvent.setup();

    await enter(user, 'smo');
    const first = await screen.findByRole('option', { name: /Checkout smoke/ });
    await waitFor(() => expect(first).toHaveAttribute('aria-selected', 'true'));

    /* `Checkout soak` SURVIVES the narrowing — same row, same key — so no
       row mounts, and the two that leave include the highlighted one. */
    await enter(user, 'k');
    await waitFor(() => {
      expect(screen.queryByRole('option', { name: /Checkout smoke/ })).not.toBeInTheDocument();
    });
    const soak = screen.getByRole('option', { name: /Checkout soak/ });
    const highlighted = screen
      .getAllByRole('option')
      .filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(highlighted).toEqual([soak]);
    // A screen reader is told which option that is, too.
    expect(input()).toHaveAttribute('aria-activedescendant', soak.id);

    await user.keyboard('{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent(
      projectTestPath('checkout', 'checkout-soak'),
    );
  });

  it("colours a result's outcome glyph, never its word, on the highlighted row", async () => {
    stubApi({ tests: () => json(tests([SMOKE])) });
    renderPalette();
    const user = userEvent.setup();

    await enter(user, 'smoke');
    const row = await screen.findByRole('option', { name: /Checkout smoke/ });
    // Highlighted: the row sits on the sunken ground, where a status colour
    // as TEXT measures under 4.5:1 in the light theme.
    await waitFor(() => expect(row).toHaveAttribute('aria-selected', 'true'));

    const glyph = within(row).getByText('✓');
    expect(glyph.getAttribute('style') ?? '').toContain('--color-status-passed');
    const word = within(row).getByText('passed');
    expect(word.closest('[style*="--color-status"]')).toBeNull();
  });

  it("gives a row's context only the space its name leaves", async () => {
    /* A LAYOUT claim, and jsdom lays nothing out — so this pins the class that
       carries it, and `command-palette.spec.ts` is what measures it. The row's
       context (the project beside a test) used to be `shrink-[2]`, which flex
       weights by its UNCLAMPED size: beside a long name it took a share of
       the NAME's width however short the name was, and a run's "Run 2" drew as
       "R…". The context is the remainder instead — a basis of zero that only
       grows into free space — so it can never take from the name. */
    stubApi({ tests: () => json(tests([SMOKE])) });
    renderPalette();
    const user = userEvent.setup();

    await enter(user, 'smoke');
    const row = await screen.findByRole('option', { name: /Checkout smoke/ });
    const name = within(row).getByText('Checkout smoke');
    const context = within(row).getByText('Checkout', { exact: true });

    expect(context).toHaveClass('flex-1');
    expect(context).toHaveClass('min-w-0');
    expect(name).not.toHaveClass('flex-1');
    // A shrink factor on the context is the shape that failed: it is weighed
    // against the name by size, so it is never zero.
    expect(context.className).not.toMatch(/(^|\s)shrink-/);
  });

  it('returns focus to what had it before the palette opened', async () => {
    stubApi();
    renderPalette({ open: false });
    const user = userEvent.setup();
    const opener = screen.getByRole('button', { name: 'Open palette' });

    await user.click(opener);
    expect(input()).toHaveFocus();
    await user.keyboard('{Escape}');
    // Radix hands focus back in its close effect, after the keystroke returns.
    await waitFor(() => expect(opener).toHaveFocus());
  });
});

/*
 * ═══ AN ENTER THAT ARRIVES BEFORE ITS ANSWER WAITS FOR IT ═══
 *
 * Two windows separate what the reader typed from the rows answering it: the
 * 150 ms pause, and the request that follows it — during which the groups go
 * on showing the PREVIOUS query's rows, as loading (`keepPreviousData`). An
 * Enter in either is queued rather than swallowed: the pause is ended, and
 * once every group answers what the input says, the highlighted row — the
 * first, since the reader has not moved it — is chosen as a normal Enter would
 * choose it. Anything the reader does in between withdraws it.
 */
describe('CommandPalette — an Enter before the answer', () => {
  const asked = () => requestsTo('/v1/tests').map((u) => u.searchParams.get('q'));
  const where = () => screen.getByTestId('where');

  it('waits for the answer, then chooses its first row, never the previous query’s', async () => {
    const heldSearch = deferred();
    stubApi({
      // No project is named like `search` here, so no locally matched row
      // leads the list: the first row on screen is the stale `smo` test until
      // `search`'s own answer replaces it.
      projects: () => json({ items: PROJECTS.filter((p) => p.slug !== 'search') }),
      tests: (url) =>
        url.searchParams.get('q') === 'search' ? heldSearch.promise : json(tests([SMOKE])),
    });
    const { onOpenChange } = renderPalette();
    const user = userEvent.setup();

    await enter(user, 'smo');
    const smoke = await screen.findByRole('option', { name: /Checkout smoke/ });
    await waitFor(() => expect(smoke).toHaveAttribute('aria-selected', 'true'));

    // The whole text replaced in ONE change, then the pause allowed to lapse:
    // `search` is asked and held, and `smo`'s row is still drawn — the row an
    // Enter used to choose here.
    fireEvent.change(input(), { target: { value: 'search' } });
    await waitFor(() => expect(asked()).toContain('search'));
    expect(screen.getByRole('option', { name: /Checkout smoke/ })).toBeInTheDocument();

    await user.keyboard('{Enter}');
    await act(async () => {});
    expect(where()).toHaveTextContent(/^\/runs$/);
    expect(onOpenChange).not.toHaveBeenCalled();

    heldSearch.resolve(json(tests([SEARCH_SMOKE])));
    // `search`'s own first row — not `smo`'s, which was highlighted when Enter
    // was pressed.
    await waitFor(() =>
      expect(where()).toHaveTextContent(projectTestPath('search', 'search-smoke')),
    );
    expect(where()).not.toHaveTextContent(projectTestPath('checkout', 'checkout-smoke'));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('chooses the first row once results arrive when Enter follows typing at once', async () => {
    const held = deferred();
    stubApi({ tests: () => held.promise });
    const { onOpenChange } = renderPalette();
    const user = userEvent.setup();

    await enter(user, 'smoke');
    await user.keyboard('{Enter}');
    await act(async () => {});
    // Nothing has answered, so nothing is chosen yet — and the dialog stays.
    expect(where()).toHaveTextContent(/^\/runs$/);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    held.resolve(json(tests([SMOKE, SEARCH_SMOKE])));
    await waitFor(() =>
      expect(where()).toHaveTextContent(projectTestPath('checkout', 'checkout-smoke')),
    );
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  /* Safari fires the Enter that commits an IME composition AFTER the
     composition has ended, so `isComposing` is already false and only
     `keyCode === 229` says what it is. cmdk skips it on that rule; this
     palette's own queue has to agree, or the key a reader pressed to confirm
     a character navigates them away once the answer lands. */
  it('does not queue the Enter that commits an IME composition', async () => {
    const held = deferred();
    stubApi({ tests: () => held.promise });
    const { onOpenChange } = renderPalette();
    const user = userEvent.setup();

    await enter(user, 'smoke');
    // The very key a plain Enter would queue: pending, nothing answered yet.
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });
    await act(async () => {});

    held.resolve(json(tests([SMOKE])));
    await screen.findByRole('option', { name: /Checkout smoke/ });
    await act(async () => {});
    expect(where()).toHaveTextContent(/^\/runs$/);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('chooses the first row of the answer, not one picked among the previous query’s', async () => {
    const heldSoak = deferred();
    stubApi({
      // No projects, so the tests are the only rows on screen.
      projects: () => json({ items: [] }),
      tests: (url) =>
        url.searchParams.get('q') === 'soak' ? heldSoak.promise : json(tests([SMOKE, SOAK])),
    });
    renderPalette();
    const user = userEvent.setup();

    await enter(user, 'smo');
    await screen.findByRole('option', { name: /Checkout soak/ });
    fireEvent.change(input(), { target: { value: 'soak' } });
    await waitFor(() => expect(asked()).toContain('soak'));
    // Among `smo`'s rows, still drawn while `soak` is held, the reader arrows
    // to the one that LOOKS like what they typed, and presses Enter.
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /Checkout soak/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.keyboard('{Enter}');

    // `soak`'s answer leads with another test. The row chosen is the answer's
    // first, which the reader is asking for — not the stale row the highlight
    // happened to rest on, which would otherwise survive into this answer.
    heldSoak.resolve(json(tests([SEARCH_SMOKE, SOAK])));
    await waitFor(() =>
      expect(where()).toHaveTextContent(projectTestPath('search', 'search-smoke')),
    );
  });

  /* Each variant names the row that answers LAST — `smokex`'s after typing,
     the held `smoke` one after an arrow — and the case waits for it on
     screen: that is the moment a queued Enter that had survived would act. */
  it.each([
    ['typing', async (user: ReturnType<typeof userEvent.setup>) => enter(user, 'x'), /Checkout soak/],
    [
      'an arrow key',
      async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{ArrowDown}'),
      /Checkout smoke/,
    ],
  ])('withdraws a queued Enter on %s', async (_label, act2, lastRow) => {
    const heldSmoke = deferred();
    stubApi({
      tests: (url) =>
        url.searchParams.get('q') === 'smoke' ? heldSmoke.promise : json(tests([SOAK])),
    });
    const { onOpenChange } = renderPalette();
    const user = userEvent.setup();

    await enter(user, 'smoke');
    await user.keyboard('{Enter}');
    await act2(user);

    // Every answer arrives — the held one and, after typing, the new one —
    // and with the Enter withdrawn none of them is chosen.
    heldSmoke.resolve(json(tests([SMOKE])));
    await screen.findByRole('option', { name: lastRow });
    await act(async () => {});
    expect(where()).toHaveTextContent(/^\/runs$/);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows no row from a query the reader cleared before typing the next', async () => {
    const heldSearch = deferred();
    stubApi({
      tests: (url) =>
        url.searchParams.get('q') === 'search' ? heldSearch.promise : json(tests([SMOKE])),
    });
    renderPalette();
    const user = userEvent.setup();

    await enter(user, 'smo');
    await screen.findByRole('option', { name: /Checkout smoke/ });

    await user.clear(input());
    // Go to returns only once the CLEARED box has outlasted the pause: the
    // groups have been asked nothing, and `smo` has been abandoned.
    await screen.findByRole('group', { name: 'Go to' });

    await enter(user, 'search');
    await waitFor(() => expect(asked()).toContain('search'));
    await act(async () => {});
    // `search` is in flight. `smo` was the last query with an answer, and it
    // is not what this reader is asking any more: no row of it comes back.
    expect(screen.queryByRole('option', { name: /Checkout smoke/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Tests' })).not.toBeInTheDocument();

    heldSearch.resolve(json(tests([SEARCH_SMOKE])));
    expect(await screen.findByRole('option', { name: /Search smoke/ })).toBeInTheDocument();
  });
});

/*
 * ═══ NO ROW FROM BEFORE A CLEAR, HOWEVER MANY QUERIES LATER ═══
 *
 * TanStack's `keepPreviousData` hands a query the last answer its observer
 * HAD, not the answer to the text asked just before. So withholding the
 * placeholder from the first query after a clear is not enough: type `sea`
 * and then `sear` before `sea` answers, and the last answer the observer had
 * is still `smo`'s, from before the clear. These cases hold every post-clear
 * answer so that is exactly the state `sear` is asked in.
 */
describe('CommandPalette — a cleared box stays cleared', () => {
  /**
   * Every option drawn from now until `stop()` whose text matches `name`.
   *
   * A checkpoint `queryByRole` sees only the moment it runs; a stale row drawn
   * and replaced between two checkpoints passes it. A MutationObserver is
   * handed every node React inserts — including one already removed by the
   * time anything is asserted, which still carries its text.
   */
  function watchForOption(name: RegExp): { stop(): string[] } {
    const seen: string[] = [];
    const scan = (node: Node) => {
      const el = node instanceof Element ? node : node.parentElement;
      if (el === null) return;
      const enclosing = el.closest('[role="option"]');
      const options = [...(enclosing ? [enclosing] : []), ...el.querySelectorAll('[role="option"]')];
      for (const o of options) {
        const text = o.textContent ?? '';
        if (name.test(text)) seen.push(text);
      }
    };
    const record = (records: MutationRecord[]) => {
      for (const r of records) {
        r.addedNodes.forEach(scan);
        if (r.type === 'characterData') scan(r.target);
      }
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return {
      stop() {
        record(observer.takeRecords());
        observer.disconnect();
        return seen;
      },
    };
  }

  it('shows no row from a query cleared two queries ago', async () => {
    const held = { sea: deferred(), sear: deferred() };
    const heldRuns = { sea: deferred(), sear: deferred() };
    const isHeld = (q: string | null): q is keyof typeof held => q === 'sea' || q === 'sear';
    stubApi({
      tests: (url) => {
        const q = url.searchParams.get('q');
        return isHeld(q) ? held[q].promise : json(tests([SMOKE]));
      },
      runs: (url) => {
        const q = url.searchParams.get('q');
        return isHeld(q) ? heldRuns[q].promise : json(runs([RUN_7]));
      },
    });
    renderPalette();
    const user = userEvent.setup();
    const asked = (pathname: string) => requestsTo(pathname).map((u) => u.searchParams.get('q'));

    // `smo` answers in BOTH server groups: a test row and a run row.
    await enter(user, 'smo');
    await screen.findByRole('option', { name: /^Checkout smoke/ });
    await screen.findByRole('option', { name: /^Run 7/ });

    await user.clear(input());
    await screen.findByRole('group', { name: 'Go to' });
    expect(screen.queryByRole('option', { name: /Checkout smoke/ })).not.toBeInTheDocument();
    const watch = watchForOption(/Checkout smoke/);

    // `sea` is asked and held. The placeholder is withheld from it — the first
    // query after the clear, which the guard before this one already covered.
    await enter(user, 'sea');
    await waitFor(() => expect(asked('/v1/tests')).toContain('sea'));
    await waitFor(() => expect(asked('/v1/runs')).toContain('sea'));

    // `sear` before `sea` has answered. The text asked just before it is `sea`,
    // not empty — but the last answer either group HAD is still `smo`'s.
    await enter(user, 'r');
    await waitFor(() => expect(asked('/v1/tests')).toContain('sear'));
    await waitFor(() => expect(asked('/v1/runs')).toContain('sear'));
    await act(async () => {});
    expect(screen.queryByRole('group', { name: 'Tests' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Runs' })).not.toBeInTheDocument();

    // The abandoned `sea` answers late, then `sear` itself.
    held.sea.resolve(json(tests([SOAK])));
    heldRuns.sea.resolve(json(runs([])));
    await act(async () => {});
    held.sear.resolve(json(tests([SEARCH_SMOKE])));
    heldRuns.sear.resolve(json(runs([])));
    expect(await screen.findByRole('option', { name: /^Search smoke/ })).toBeInTheDocument();

    // Not one `smo` row — test or run — was drawn at any point after the clear.
    expect(watch.stop()).toEqual([]);
  });

  it('shows no run-by-number row from a lookup cleared two queries ago', async () => {
    const heldNumbers = new Map([
      ['1', deferred()],
      ['12', deferred()],
    ]);
    stubApi({
      tests: (url) =>
        url.searchParams.get('q') === 'checkout' ? json(tests([SMOKE])) : json(tests([])),
      runs: (url) => {
        const n = url.searchParams.get('number');
        if (n === null) return json(runs([]));
        return heldNumbers.get(n)?.promise ?? json(runs([RUN_7]));
      },
    });
    renderPalette();
    const user = userEvent.setup();
    const asked = () => numberLookups().map((u) => u.searchParams.get('number'));

    await enter(user, 'checkout #7');
    const group = await screen.findByRole('group', { name: 'Run by number' });
    expect(optionNames(group)).toEqual(['Run 7 · Checkout smoke · Checkout']);

    await user.clear(input());
    await screen.findByRole('group', { name: 'Go to' });
    expect(screen.queryByRole('option', { name: /^Run 7/ })).not.toBeInTheDocument();
    const watch = watchForOption(/^Run 7/);

    await enter(user, 'checkout #1');
    await waitFor(() => expect(asked()).toContain('1'));
    // `checkout #12` before run 1's lookup has answered.
    await enter(user, '2');
    await waitFor(() => expect(asked()).toContain('12'));
    await act(async () => {});
    expect(screen.queryByRole('group', { name: 'Run by number' })).not.toBeInTheDocument();

    heldNumbers.get('1')?.resolve(json(runs([])));
    await act(async () => {});
    heldNumbers.get('12')?.resolve(json(runs([RUN_12])));
    const answered = await screen.findByRole('group', { name: 'Run by number' });
    expect(optionNames(answered)).toEqual(['Run 12 · Checkout smoke · Checkout']);

    expect(watch.stop()).toEqual([]);
  });
});
