import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
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
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <CommandPalette
        open={open}
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

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open palette' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await enter(user, 'smoke');
    await waitFor(() => {
      expect(client.getQueryState(orgTestsQueryKey('smoke', 5))?.status).toBe('success');
    });
    await screen.findByRole('option', { name: /Search smoke/ });
    // Two tests are on screen, but the runs have not answered: no count yet.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    heldRuns.resolve(json(runs([RUN_7])));
    expect(await screen.findByRole('status')).toHaveTextContent(/^3 results$/);
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

  it('returns focus to what had it before the palette opened', async () => {
    stubApi();
    renderPalette({ open: false });
    const user = userEvent.setup();
    const opener = screen.getByRole('button', { name: 'Open palette' });

    await user.click(opener);
    expect(input()).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(opener).toHaveFocus();
  });
});
