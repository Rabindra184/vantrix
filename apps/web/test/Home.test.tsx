import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ActivityResponseSchema,
  OrgTestListResponseSchema,
  ProjectListResponseSchema,
  type ActivityResponse,
} from '@perfportal/contracts';
import AuthGate from '../src/AuthGate';
import { ACTIVITY_POLL_MS, activityQueryKey, browserTimeZone } from '../src/api/activity';
import Home from '../src/routes/Home';
import { ALL_RUNS_ROUTE, projectPath } from '../src/routes/paths';
import useIsCompact from '../src/useIsCompact';

/**
 * ═══ THE HOME PAGE, COMPOSED ═══
 *
 * The cards are tested where they are built (`AttentionCard.test.tsx`,
 * `HomeTests.test.tsx`, `Glance.test.tsx`); what is worth pinning HERE is the
 * composition — the greeting, the activity line, the side column, and above
 * all that the two reads stay independent: a failed activity read must never
 * blank the tests table, nor the reverse. Every fixture goes through the real
 * schema, so a malformed one fails here rather than sending a card down a
 * fallback (CLAUDE.md's malformed-fixture trap). The copy is the
 * constraints' own and is written down; the facts (dates, counts, hrefs) are
 * read off the fixtures.
 */
afterEach(cleanup);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
const useIsCompactMock = vi.mocked(useIsCompact);
beforeEach(() => {
  useIsCompactMock.mockReset();
  useIsCompactMock.mockReturnValue(false);
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const id = (n: number) => `9e8d7c6b-0000-4000-8000-${String(n).padStart(12, '0')}`;
/* Names that cannot collide with "Home", "All runs" or each other under any
   matcher (CLAUDE.md: Playwright matches names as a case-insensitive
   substring, and fixtures that cannot collide stay right under both). */
const CHECKOUT = { slug: 'checkout', name: 'Checkout' };
const SEARCH = { slug: 'search', name: 'Search Service' };

const DAYS = [
  { date: '2026-09-30', total: 0, successful: 0, needsAttention: 0 },
  { date: '2026-10-01', total: 2, successful: 2, needsAttention: 0 },
  { date: '2026-10-02', total: 4, successful: 2, needsAttention: 1 },
  { date: '2026-10-03', total: 1, successful: 0, needsAttention: 1 },
  { date: '2026-10-04', total: 0, successful: 0, needsAttention: 0 },
  { date: '2026-10-05', total: 3, successful: 3, needsAttention: 0 },
  { date: '2026-10-06', total: 2, successful: 2, needsAttention: 0 },
];

const SOAK_ROW = {
  test: { slug: 'checkout-soak', name: 'Checkout soak' },
  project: CHECKOUT,
  run: {
    id: id(1),
    runNumber: 7,
    status: 'complete',
    verdict: 'failed',
    startedAt: '2026-10-05T09:00:00.000Z',
    durationMs: 60_000,
    checks: null,
    simulation: 'example.SoakSimulation',
  },
  reasons: ['gate_failed'],
};

function activity(over: Record<string, unknown> = {}): ActivityResponse {
  return ActivityResponseSchema.parse({
    window: { from: '2026-09-30T00:00:00.000Z', to: '2026-10-06T12:00:00.000Z', tz: 'UTC' },
    days: DAYS,
    runCount: 12,
    passRate: 0.9,
    running: 2,
    byProject: [
      { project: CHECKOUT, runs: 9 },
      { project: SEARCH, runs: 3 },
    ],
    attention: [SOAK_ROW],
    attentionTotal: 1,
    lastRun: {
      id: id(2),
      runNumber: 8,
      test: { slug: 'checkout-smoke', name: 'Checkout smoke' },
      project: CHECKOUT,
      startedAt: '2026-10-06T08:00:00.000Z',
    },
    ...over,
  });
}

const TESTS = OrgTestListResponseSchema.parse({
  items: [
    {
      id: id(10),
      slug: 'search-latency',
      name: 'Search latency',
      simulationClass: 'example.LatencySimulation',
      runCount: 3,
      project: SEARCH,
      latestRun: {
        id: id(11),
        runNumber: 3,
        status: 'complete',
        verdict: 'passed',
        startedAt: '2026-10-04T09:00:00.000Z',
        durationMs: 30_000,
        checks: null,
        p95Ms: 120,
      },
      p95History: [{ runId: id(11), runNumber: 3, p95Ms: 120 }],
    },
  ],
  nextCursor: null,
});

const PROJECTS = ProjectListResponseSchema.parse({
  items: [
    { id: id(20), slug: CHECKOUT.slug, name: CHECKOUT.name, latestRun: null },
    { id: id(21), slug: SEARCH.slug, name: SEARCH.name, latestRun: null },
  ],
});

/** `getSession` casts its body rather than parsing it, so a minimal object is honest. */
const session = (user: { name: string; email: string }) => ({
  session: { id: 's1' },
  user: { id: 'u1', ...user },
});

// ─── The fetch stub ──────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status < 300 ? 'application/json' : 'application/problem+json' },
  });
}

const OUTAGE = {
  code: 'INTERNAL',
  detail: 'The activity read did not answer.',
  remediation: 'Check that the API and the database are running.',
};

type Answer = () => Response | Promise<Response>;

interface Answers {
  readonly session?: Answer;
  readonly activity?: Answer;
  readonly tests?: Answer;
  readonly projects?: Answer;
}

let requests: URL[] = [];
const asked = (pathname: string) => requests.filter((u) => u.pathname === pathname).length;

interface Setup {
  /** An answer already in the cache, as `AuthGate`'s probe leaves one on a cold load. */
  readonly seed?: ActivityResponse;
  /** Render the real `AuthGate` above the page, as `App.tsx` does. */
  readonly gated?: boolean;
}

function renderHome(answers: Answers = {}, { seed, gated = false }: Setup = {}) {
  requests = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(url);
    const answer: Answer | undefined =
      url.pathname === '/auth/get-session'
        ? (answers.session ?? (() => json(session({ name: 'Ada Lovelace', email: 'ada@example.test' }))))
        : url.pathname === '/v1/activity'
          ? (answers.activity ?? (() => json(activity())))
          : url.pathname === '/v1/tests'
            ? (answers.tests ?? (() => json(TESTS)))
            : url.pathname === '/v1/projects'
              ? (answers.projects ?? (() => json(PROJECTS)))
              : undefined;
    return Promise.resolve(answer === undefined ? json({}, 404) : answer());
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed !== undefined) client.setQueryData(activityQueryKey(browserTimeZone()), seed);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        {gated ? (
          <Routes>
            <Route element={<AuthGate />}>
              <Route path="/" element={<Home />} />
            </Route>
          </Routes>
        ) : (
          <Home />
        )}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const never = () => new Promise<Response>(() => {});
/** The tests table's own row, which only a successful `/v1/tests` draws. */
const testsRow = () => screen.findByRole('link', { name: 'Search latency' });
const attention = () => screen.getByTestId('home-attention');

// ─── Cases ───────────────────────────────────────────────────────────────────

describe('Home — the heading', () => {
  it('greets the reader by the first word of their name', async () => {
    renderHome();
    expect(await screen.findByRole('heading', { level: 1, name: 'Hello, Ada' })).toBeInTheDocument();
  });

  it('falls back to the email’s local part when the name is empty', async () => {
    renderHome({ session: () => json(session({ name: '', email: 'grace@example.test' })) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Hello, grace' })).toBeInTheDocument();
  });

  /**
   * The dates are the attention window's own, in the zone the answer names
   * (`window.tz`) — formatted by the very `Intl` call the page makes, so this
   * case is right on any runner, and fails the day the page formats them some
   * other way.
   */
  it('states the activity window from the answer, with the same Intl call', async () => {
    renderHome();
    const a = activity();
    // ONE range, so the year the two ends share is printed once ("Sep 30 –
    // Oct 6, 2026"), not after each date. Compared as the exact string:
    // `formatRange` puts THIN spaces around its dash, and `toHaveTextContent`
    // normalises the element's whitespace and not the expectation's.
    const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: a.window.tz });
    const expected = `Activity in the last 7 days (${day.formatRange(new Date(a.window.from), new Date(a.window.to))})`;
    expect((await screen.findByTestId('home-activity-line')).textContent).toBe(expected);
  });

  /**
   * After a refused zone the server answers in UTC while the viewer is
   * elsewhere, so the heading has to follow the ANSWER's zone or it names a
   * range a day off the glance under it. Kiritimati (UTC+14) is far enough
   * from both UTC and this runner's own zone that the two readings differ for
   * this window — asserted first, so the case cannot pass vacuously.
   */
  it('prints the window in the zone the server answered in, not the viewer’s', async () => {
    const window = {
      from: '2026-09-30T10:00:00.000Z', // midnight 1 Oct in Kiritimati
      to: '2026-10-06T12:00:00.000Z', //   02:00 7 Oct in Kiritimati
      tz: 'Pacific/Kiritimati',
    };
    renderHome({ activity: () => json(activity({ window })) });
    const range = (f: Intl.DateTimeFormat) =>
      `Activity in the last 7 days (${f.formatRange(new Date(window.from), new Date(window.to))})`;
    const inAnswerZone = range(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: window.tz }));
    const inViewerZone = range(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }));
    expect(inAnswerZone).not.toBe(inViewerZone);
    expect((await screen.findByTestId('home-activity-line')).textContent).toBe(inAnswerZone);
  });

  it('names the document after the page', async () => {
    renderHome();
    await screen.findByRole('heading', { level: 1, name: 'Hello, Ada' });
    expect(document.title).toBe('Home · PerfPortal');
  });
});

describe('Home — each card on its own', () => {
  /**
   * ═══ A FAILED ACTIVITY READ NEVER BLANKS THE TESTS TABLE ═══
   *
   * The two halves of the page ask two endpoints. The error lands where the
   * attention card was — in the server's own words — while the tests table
   * goes on rendering from its own answer.
   */
  it('shows the activity failure where the attention card was, and the tests table still renders', async () => {
    renderHome({ activity: () => json(OUTAGE, 500) });
    expect(await testsRow()).toBeInTheDocument();
    const alert = await within(attention()).findByRole('alert');
    expect(alert).toHaveTextContent(OUTAGE.detail);
    expect(alert).toHaveTextContent(OUTAGE.remediation);
    // ONE alert for one failed request: the side cards say so quietly rather
    // than announcing the same failure three times.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    // And nothing pretends to know what the failed read would have said.
    expect(screen.queryByRole('link', { name: /running$/ })).toBeNull();
  });

  it('and the reverse: a failed tests read leaves the attention card standing', async () => {
    renderHome({ tests: () => json(OUTAGE, 500) });
    expect(
      await within(attention()).findByRole('link', { name: 'Checkout soak' }),
    ).toBeInTheDocument();
    expect(within(attention()).getByTestId('attention-count')).toHaveTextContent('1 test · last 7 days');
    const alert = await screen.findByRole('alert');
    expect(attention()).not.toContainElement(alert);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('draws each card’s own placeholder while the activity read is in flight', async () => {
    renderHome({ activity: never });
    expect(await testsRow()).toBeInTheDocument();
    expect(within(attention()).getByRole('status')).toHaveTextContent('Loading activity…');
    expect(within(attention()).getByTestId('skeleton-table')).toBeInTheDocument();
    // The heading stays put across every state, so the outline does not move
    // when the answer arrives.
    expect(
      within(attention()).getByRole('heading', { level: 2, name: 'Tests that need attention' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('home-activity-line')).toBeNull();
  });
});

describe('Home — the side column', () => {
  it('links Running now to the run list filtered to exactly what it counted', async () => {
    renderHome();
    const link = await screen.findByRole('link', { name: `${activity().running} running` });
    expect(link).toHaveAttribute('href', `${ALL_RUNS_ROUTE}?status=running`);
    expect(screen.getByRole('heading', { level: 2, name: 'Running now' })).toBeInTheDocument();
  });

  /**
   * The one place a project name is a LINK on this page, and it goes where the
   * rail's row of the same name goes — same name, same destination, which is
   * not the collision CLAUDE.md records twice.
   */
  it('lists runs by project: a link to the project, its count, and a bar against the busiest', async () => {
    renderHome();
    const card = (await screen.findByRole('heading', { level: 2, name: 'Runs by project' })).closest(
      'section',
    )!;
    // AWAITED ON THE ROWS, NOT THE HEADING: the card's heading is drawn while
    // the read is still in flight, over a placeholder.
    const rows = await within(card).findAllByTestId('by-project-row');
    const byProject = activity().byProject;
    expect(rows).toHaveLength(byProject.length);
    const top = byProject[0]!.runs;
    byProject.forEach((entry, i) => {
      const row = rows[i]!;
      expect(within(row).getByRole('link', { name: entry.project.name })).toHaveAttribute(
        'href',
        projectPath(entry.project.slug),
      );
      expect(within(row).getByTestId('by-project-runs')).toHaveTextContent(String(entry.runs));
      const bar = within(row).getByTestId('by-project-bar');
      expect(bar.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(bar.style.width).toBe(`${(entry.runs / top) * 100}%`);
    });
  });

  it('says so, quietly, when no project ran in the window', async () => {
    const quiet = activity({
      byProject: [],
      attention: [],
      attentionTotal: 0,
      runCount: 0,
      passRate: null,
      days: DAYS.map((d) => ({ ...d, total: 0, successful: 0, needsAttention: 0 })),
    });
    renderHome({ activity: () => json(quiet) });
    const card = (await screen.findByRole('heading', { level: 2, name: 'Runs by project' })).closest(
      'section',
    )!;
    expect(await within(card).findByText('No runs in the last 7 days.')).toBeInTheDocument();
    expect(within(card).queryAllByTestId('by-project-row')).toHaveLength(0);
  });
});

describe('Home — the rail’s words', () => {
  /**
   * "Home" and "All runs" are the rail's, on every authenticated page; a page
   * link sharing either name is two links with one name in the document.
   * Paired positive first: the page has really drawn every card, so the
   * absence below is about the names and not about an empty page.
   */
  it('adds no link named Home or All runs', async () => {
    renderHome();
    await testsRow();
    await screen.findByRole('link', { name: 'Checkout soak' });
    await screen.findByRole('link', { name: `${activity().running} running` });
    // Playwright's name match is a case-insensitive SUBSTRING, so a page link
    // named "Homepage" or "See all runs" would answer the rail's own queries:
    // the check is the substring too, not an exact or a whole-word match. The
    // fixtures' names are chosen to contain neither.
    const names = screen.getAllByRole('link').map((link) => link.textContent?.trim() ?? '');
    expect(names.filter((name) => /home|all runs/i.test(name))).toEqual([]);
    expect(screen.queryByRole('link', { name: 'Home' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'All runs' })).toBeNull();
  });
});

describe('Home — layout', () => {
  /**
   * Same document order on both: attention, Running now, Runs by project,
   * then the tests. Only the desktop grid puts the side column BESIDE the card;
   * a phone has one column and nothing conditional on its container.
   */
  it('keeps one reading order, with the side column beside the card on a desktop only', async () => {
    const order = async () => {
      const headings = [
        await screen.findByRole('heading', { level: 2, name: 'Tests that need attention' }),
        await screen.findByRole('heading', { level: 2, name: 'Running now' }),
        await screen.findByRole('heading', { level: 2, name: 'Runs by project' }),
        // A string name is EXACT in Testing Library (it is a substring in
        // Playwright, where "Tests that need attention" would also answer).
        await screen.findByRole('heading', { level: 2, name: 'Tests' }),
      ];
      return headings.every(
        (h, i) => i === 0 || headings[i - 1]!.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    };

    renderHome();
    expect(await order()).toBe(true);
    expect(screen.getByTestId('home-overview').className).toMatch(/@4xl:grid-cols-/);

    cleanup();
    useIsCompactMock.mockReturnValue(true);
    renderHome();
    expect(await order()).toBe(true);
    expect(screen.getByTestId('home-overview').className).not.toMatch(/grid-cols-/);
  });
});

describe('Home — polling', () => {
  /**
   * `running` is the one number that changes with nobody touching it, so the
   * page re-asks every thirty seconds while it is above zero — and not at all
   * otherwise. Both halves: a page that always polled, or never did, passes
   * one of them.
   */
  it.each([
    ['re-asks every thirty seconds while something is running', 2, 2],
    ['asks once and goes quiet when nothing is running', 0, 1],
  ])('%s', async (_what, running, expected) => {
    vi.useFakeTimers();
    renderHome({ activity: () => json(activity({ running })) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(asked('/v1/activity')).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_POLL_MS);
    });
    expect(asked('/v1/activity')).toBe(expected);
  });
});

describe('Home — the bars of Runs by project', () => {
  const card = async () =>
    (await screen.findByRole('heading', { level: 2, name: 'Runs by project' })).closest('section')!;
  const widths = async () =>
    (await within(await card()).findAllByTestId('by-project-bar')).map((bar) => bar.style.width);

  /** The busiest is the MAXIMUM, not whichever row the server sent first. */
  it('measures every bar against the busiest project, whatever order the rows arrive in', async () => {
    renderHome({
      activity: () =>
        json(
          activity({
            byProject: [
              { project: SEARCH, runs: 3 },
              { project: CHECKOUT, runs: 9 },
            ],
          }),
        ),
    });
    expect(await widths()).toEqual([`${(3 / 9) * 100}%`, '100%']);
  });

  /** Every count zero: an empty bar each, never `NaN%` from 0 ÷ 0. */
  it('draws empty bars, not NaN, when every count is zero', async () => {
    renderHome({
      activity: () =>
        json(
          activity({
            byProject: [
              { project: CHECKOUT, runs: 0 },
              { project: SEARCH, runs: 0 },
            ],
          }),
        ),
    });
    expect(await widths()).toEqual(['0%', '0%']);
  });
});

/**
 * ═══ ONE QUESTION, ASKED ONCE ═══
 *
 * `AuthGate` asks `GET /v1/activity` on the way in, under this page's key and
 * with this page's options, so the page draws from that answer instead of
 * asking again. That is a claim about REQUESTS, so it is counted — a page that
 * mounted a second observer on a stale entry would draw the same screen and
 * ask twice.
 */
describe('Home — the probe’s answer', () => {
  it('draws from an answer already in the cache, with no placeholder and no second request', async () => {
    renderHome({}, { seed: activity() });
    // Synchronously on the first render: no skeleton was ever drawn.
    expect(within(attention()).queryByTestId('skeleton-table')).toBeNull();
    expect(within(attention()).getByRole('link', { name: 'Checkout soak' })).toBeInTheDocument();
    await testsRow();
    expect(asked('/v1/activity')).toBe(0);
  });

  it('asks once on a cold load through the real gate', async () => {
    renderHome({}, { gated: true });
    expect(await screen.findByRole('heading', { level: 1, name: 'Hello, Ada' })).toBeInTheDocument();
    await testsRow();
    expect(asked('/v1/activity')).toBe(1);
  });

  /**
   * A 400 from the probe (a zone this server's ICU refuses) is the gate PASSED,
   * and the page reports it in its own card. Through the real gate: this page
   * observes the gate's own key, and a gate that read the page's re-fetch as
   * "still deciding" took the page away, got the 400 again, and looped.
   */
  it('renders through the real gate on a 400, reports it in the card, and does not loop', async () => {
    const refusal = {
      code: 'INVALID_TIMEZONE',
      detail: 'The time zone "Mars/Olympus" is not one this server knows.',
      remediation: 'Send an IANA zone such as Europe/London.',
    };
    renderHome({ activity: () => json(refusal, 400) }, { gated: true });
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    // Two asks at most (the gate's, and the page's own mount), each the zone
    // and then, refused, UTC (`fetchActivity`). A loop is one a tick.
    expect(asked('/v1/activity')).toBeLessThanOrEqual(4);
    expect(screen.queryByText('Checking your session…')).toBeNull();
    expect(within(attention()).getByRole('alert')).toHaveTextContent(refusal.detail);
  });
});
