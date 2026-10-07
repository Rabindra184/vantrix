import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityResponseSchema, type ActivityResponse } from '@perfportal/contracts';
import useIsCompact from '../src/useIsCompact';
import AttentionCard from '../src/home/AttentionCard';
import LastRunCell from '../src/home/LastRunCell';
import { formatListInstant } from '../src/routes/format';
import { STATUS, VERDICT } from '../src/routes/marks';
import { NEW_PROJECT_ROUTE, projectSetupPath, projectTestPath, runPath } from '../src/routes/paths';

/**
 * ═══ THE CARD, IN ALL FOUR OF ITS STATES ═══
 *
 * The page asks one endpoint and the card decides what that answer means:
 * something to look at, a clean week, a quiet week after a busy history, or an
 * org that has never run anything. Each state has its own copy and its own
 * way out, and the copy is the contract (constraints.md), so the strings below
 * are written down — they are what a reader is promised. Everything that is a
 * FACT about the payload (a link's destination, a count, a date) is read off
 * the payload instead.
 */
afterEach(cleanup);

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
const useIsCompactMock = vi.mocked(useIsCompact);
beforeEach(() => {
  useIsCompactMock.mockReset();
  useIsCompactMock.mockReturnValue(false);
});

const id = (n: number) => `1a2b3c4d-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CHECKOUT = { slug: 'checkout', name: 'Checkout' };
const SEARCH = { slug: 'search', name: 'Search Service' };

const DAYS = [
  { date: '2026-09-30', total: 0, successful: 0, needsAttention: 0 },
  { date: '2026-10-01', total: 2, successful: 2, needsAttention: 0 },
  { date: '2026-10-02', total: 4, successful: 2, needsAttention: 1 },
  { date: '2026-10-03', total: 1, successful: 0, needsAttention: 1 },
  { date: '2026-10-04', total: 0, successful: 0, needsAttention: 0 },
  { date: '2026-10-05', total: 3, successful: 3, needsAttention: 0 },
  { date: '2026-10-06', total: 4, successful: 4, needsAttention: 0 },
];

const run = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  runNumber: 4,
  status: 'complete',
  verdict: 'failed',
  startedAt: '2026-10-05T09:00:00.000Z',
  durationMs: 60_000,
  checks: null,
  simulation: 'example.SoakSimulation',
  ...over,
});

/** Failed its gate AND two of its own checks: two reasons, the second counted. */
const BOTH = {
  test: { slug: 'checkout-soak', name: 'Checkout soak' },
  project: CHECKOUT,
  run: run(1, { checks: { failed: 2, total: 5 } }),
  reasons: ['gate_failed', 'assertion_failed'],
};
/** A stuck ingest: no test to group it under, but its simulation is known. */
const STUCK = {
  test: null,
  project: SEARCH,
  run: run(2, { runNumber: null, status: 'failed', verdict: null, simulation: 'example.StuckSimulation' }),
  reasons: ['failed'],
};
/** The same, with nothing known at all about what it was. */
const UNNAMED = {
  test: null,
  project: SEARCH,
  run: run(3, { runNumber: null, status: 'incomplete', verdict: null, simulation: null }),
  reasons: ['incomplete'],
};

const LAST_RUN = {
  id: id(9),
  runNumber: 3,
  test: { slug: 'soak', name: 'Soak' },
  project: CHECKOUT,
  startedAt: '2026-08-16T09:00:00.000Z',
};

function activity(over: Record<string, unknown> = {}): ActivityResponse {
  return ActivityResponseSchema.parse({
    window: { from: '2026-09-30T00:00:00.000Z', to: '2026-10-06T12:00:00.000Z', tz: 'UTC' },
    days: DAYS,
    runCount: 14,
    passRate: 0.9,
    running: 0,
    byProject: [],
    attention: [],
    attentionTotal: 0,
    lastRun: LAST_RUN,
    ...over,
  });
}

const FILLED = activity({ attention: [BOTH, STUCK, UNNAMED], attentionTotal: 3 });
const NOW = new Date('2026-10-06T12:00:00.000Z');
const PROJECTS = [SEARCH, CHECKOUT];

function mount(a: ActivityResponse, projects = PROJECTS) {
  return render(
    <MemoryRouter>
      <AttentionCard activity={a} projects={projects} now={NOW} />
    </MemoryRouter>,
  );
}

describe('AttentionCard, filled', () => {
  it('is a card headed by what it holds, with the count in the header and no description line', () => {
    mount(FILLED);
    expect(screen.getByRole('heading', { level: 2, name: 'Tests that need attention' })).toBeInTheDocument();
    expect(screen.getByTestId('attention-count')).toHaveTextContent('3 tests · last 7 days');
  });

  it('counts the TESTS, not the rows it was sent, when the list is capped', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      ...BOTH,
      test: { slug: `t-${i}`, name: `Test ${i}` },
      run: run(100 + i, { checks: { failed: 1, total: 2 } }),
    }));
    mount(activity({ attention: twenty, attentionTotal: 22 }));
    expect(screen.getAllByTestId('attention-row')).toHaveLength(20);
    expect(screen.getByTestId('attention-count')).toHaveTextContent('22 tests · last 7 days');
  });

  it('says "1 test" in the singular', () => {
    mount(activity({ attention: [BOTH], attentionTotal: 1 }));
    expect(screen.getByTestId('attention-count')).toHaveTextContent('1 test · last 7 days');
    expect(screen.getByTestId('attention-count')).not.toHaveTextContent('1 tests');
  });

  it('heads three columns: Test, Project, Last run', () => {
    mount(FILLED);
    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Test', 'Project', 'Last run']);
  });

  it('names the table for what it lists without borrowing the Tests table’s name', () => {
    mount(FILLED);
    // Playwright matches a name as a substring: "Tests that need attention"
    // would also answer a query for the page's own "Tests" table.
    const table = screen.getByRole('table');
    expect(table).toHaveAccessibleName('Needs attention');
  });

  it('links a row with a test to that test, and a test-less row to its run', () => {
    mount(FILLED);
    const [withTest, stuck, unnamed] = screen.getAllByTestId('attention-row');

    const testLink = within(withTest!).getByRole('link', { name: 'Checkout soak' });
    expect(testLink).toHaveAttribute('href', projectTestPath(BOTH.project.slug, BOTH.test.slug));

    const stuckLink = within(stuck!).getByRole('link', { name: 'example.StuckSimulation' });
    expect(stuckLink).toHaveAttribute('href', runPath(STUCK.run.id));

    // Nothing is known about this one but its id, and it still gets a name a
    // reader can recognise as the same upload next week.
    const unnamedLink = within(unnamed!).getByRole('link', { name: 'Upload 1a2b3c4d' });
    expect(unnamedLink).toHaveAttribute('href', runPath(UNNAMED.run.id));
  });

  it('shows the last run, its time, and a badge per reason with the failed checks counted', () => {
    mount(FILLED);
    const [withTest, stuck] = screen.getAllByTestId('attention-row');

    const link = within(withTest!).getByRole('link', { name: 'Run 4' });
    expect(link).toHaveAttribute('href', runPath(BOTH.run.id));
    expect(withTest).toHaveTextContent(formatListInstant(BOTH.run.startedAt));
    expect(within(withTest!).getByText('SLA failed')).toBeInTheDocument();
    expect(within(withTest!).getByText('2 assertions failed')).toBeInTheDocument();

    // A run with no number is named by its short id, and says why it is here.
    expect(within(stuck!).getByRole('link', { name: `Run ${STUCK.run.id.slice(0, 8)}` })).toHaveAttribute(
      'href',
      runPath(STUCK.run.id),
    );
    expect(within(stuck!).getByText('Could not be ingested')).toBeInTheDocument();
    expect(within(screen.getAllByTestId('attention-row')[2]!).getByText('Incomplete')).toBeInTheDocument();
  });

  it('writes a project name as text, never as a link — the rail owns that name', () => {
    mount(FILLED);
    for (const row of screen.getAllByTestId('attention-row')) {
      const cell = within(row).getByTestId('attention-project');
      expect(cell).toHaveTextContent(/Checkout|Search Service/);
      expect(within(cell).queryByRole('link')).toBeNull();
    }
    expect(screen.queryByRole('link', { name: 'Checkout' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Search Service' })).toBeNull();
  });

  it('adds no link named Home or All runs', () => {
    mount(FILLED);
    // A Testing Library string name is an EXACT match already (Playwright's is
    // a substring), so this is the same claim `home.spec.ts` makes with `exact`.
    expect(screen.queryByRole('link', { name: 'Home' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'All runs' })).toBeNull();
  });

  /**
   * The ORDER is the same on both (list first, glance after), and only the
   * desktop layout can put the glance BESIDE the list: its container-query
   * row is there, and a phone has a single column with nothing conditional
   * on its container. jsdom lays nothing out, so "beside" is the class that
   * makes it — the same claim `Home.test.tsx` makes for the page's grid.
   */
  it('puts the glance beside the table on a desktop and after it on a phone, in the same document order', () => {
    const order = () => {
      const table = document.querySelector('table, [data-testid="attention-cards"]')!;
      const glance = screen.getByRole('figure', { name: 'Runs per day' });
      return table.compareDocumentPosition(glance) & Node.DOCUMENT_POSITION_FOLLOWING;
    };
    const layout = () => screen.getByTestId('attention-layout');

    mount(FILLED);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(order()).toBeTruthy();
    expect(layout().className).toMatch(/@2xl:flex-row/);
    expect(layout()).toContainElement(screen.getByRole('figure', { name: 'Runs per day' }));

    cleanup();
    useIsCompactMock.mockReturnValue(true);
    mount(FILLED);
    expect(order()).toBeTruthy();
    expect(layout().className).not.toMatch(/flex-row/);
    expect(layout()).toContainElement(screen.getByRole('figure', { name: 'Runs per day' }));
  });

  it('is a list of cards on a phone, with every field the table row had', () => {
    useIsCompactMock.mockReturnValue(true);
    mount(FILLED);
    expect(screen.queryByRole('table')).toBeNull();

    const cards = screen.getAllByTestId('attention-row');
    expect(cards).toHaveLength(3);
    const first = cards[0]!;
    expect(within(first).getByRole('link', { name: 'Checkout soak' })).toHaveAttribute(
      'href',
      projectTestPath(BOTH.project.slug, BOTH.test.slug),
    );
    expect(within(first).getByTestId('attention-project')).toHaveTextContent('Checkout');
    expect(within(first).getByRole('link', { name: 'Run 4' })).toBeInTheDocument();
    expect(within(first).getByText('SLA failed')).toBeInTheDocument();
    expect(within(first).getByText('2 assertions failed')).toBeInTheDocument();
    expect(within(first).queryByRole('link', { name: 'Checkout' })).toBeNull();
  });
});

describe('AttentionCard, clean', () => {
  const CLEAN = activity({ attention: [], attentionTotal: 0, runCount: 200, passRate: 199 / 200 });

  it('says a clean week, the pass rate rounded down and the run count, and that nothing needs attention', () => {
    mount(CLEAN);
    expect(screen.getByRole('heading', { level: 2, name: 'Tests that need attention' })).toBeInTheDocument();
    expect(screen.getByText('Clean week')).toBeInTheDocument();
    expect(screen.getByTestId('attention-summary').textContent).toBe('99% pass rate · 200 runs');
    expect(screen.getByText('No test needs attention.')).toBeInTheDocument();
  });

  it('leaves out the pass rate when there is none to state, and out of the header the count it would contradict', () => {
    mount(activity({ attention: [], attentionTotal: 0, runCount: 3, passRate: null }));
    // The glance's own hover box also says "3 runs" for its busiest day, so
    // the line is named by what it is rather than found by its words.
    expect(screen.getByTestId('attention-summary').textContent).toBe('3 runs');
    expect(screen.queryByText(/pass rate/)).toBeNull();
    expect(screen.queryByTestId('attention-count')).toBeNull();
  });

  it('keeps the glance beside it', () => {
    mount(CLEAN);
    expect(screen.getByRole('figure', { name: 'Runs per day' })).toBeInTheDocument();
  });

  it('has no table and no row', () => {
    mount(CLEAN);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryAllByTestId('attention-row')).toHaveLength(0);
  });
});

describe('AttentionCard, coverage gap', () => {
  const GAP = activity({ runCount: 0, passRate: null, days: DAYS.map((d) => ({ ...d, total: 0, successful: 0, needsAttention: 0 })) });

  it('says so, names the last run and how long ago it was, and offers to add results', () => {
    mount(GAP);
    expect(screen.getByText('Coverage gap')).toBeInTheDocument();
    expect(screen.getByText('No runs in the last 7 days')).toBeInTheDocument();

    // 51 CALENDAR days between the run's date and today's, in the window's
    // zone (UTC here), read off the two dates rather than off `daysAgo`.
    const days = (Date.parse(NOW.toISOString().slice(0, 10)) - Date.parse(LAST_RUN.startedAt.slice(0, 10))) / 86_400_000;
    expect(days).toBe(51);
    expect(screen.getByTestId('attention-last-run')).toHaveTextContent(
      `${LAST_RUN.test.name} · Run ${LAST_RUN.runNumber} · ${days} days ago`,
    );
  });

  it('sends Add results to the LAST RUN’s project, not to whichever project is first', () => {
    mount(GAP, [SEARCH, CHECKOUT]);
    expect(PROJECTS[0]!.slug).not.toBe(LAST_RUN.project.slug);
    expect(screen.getByRole('link', { name: 'Add results' })).toHaveAttribute(
      'href',
      projectSetupPath(LAST_RUN.project.slug),
    );
  });

  it('names a test-less last run by its project and its short id', () => {
    mount(activity({ runCount: 0, passRate: null, lastRun: { ...LAST_RUN, test: null, runNumber: null } }));
    expect(screen.getByTestId('attention-last-run')).toHaveTextContent(
      `${LAST_RUN.project.name} · Run ${LAST_RUN.id.slice(0, 8)} · 51 days ago`,
    );
  });

  it('draws no glance of seven empty columns', () => {
    mount(GAP);
    expect(screen.queryByRole('figure')).toBeNull();
  });

  /**
   * ═══ NEVER "6 DAYS AGO" BESIDE "NO RUNS IN THE LAST 7 DAYS" ═══
   *
   * The window starts at the oldest glance day's local midnight, and a gap's
   * last run arrived before it. By the clock it can be 6 days 23 hours old —
   * here it started at 13:00 on the 29th, the day BEFORE the window's first
   * day — and elapsed time floored to whole days called that "6 days ago".
   * Counted by calendar day in the window's zone it is seven.
   */
  it('counts a run from the day before the window as seven days ago, not six', () => {
    const startedAt = new Date(NOW.getTime() - (6 * 24 + 23) * 3_600_000).toISOString();
    mount(activity({ runCount: 0, passRate: null, lastRun: { ...LAST_RUN, startedAt } }));
    // The fixture's facts, checked rather than assumed: the day before the
    // window's first day, and under seven days by the clock.
    expect(startedAt.slice(0, 10)).toBe('2026-09-29');
    expect(Date.parse(startedAt)).toBeLessThan(Date.parse(activity().window.from));
    expect(screen.getByText('No runs in the last 7 days')).toBeInTheDocument();
    expect(screen.getByTestId('attention-last-run')).toHaveTextContent(/· 7 days ago$/);
  });

  /**
   * The same claim in a zone far from UTC, where the run's UTC date is INSIDE
   * the window's first day and only its local date is the day before: Pago
   * Pago (UTC-11) at 05:00Z on the 30th is 18:00 on the 29th. Elapsed time says
   * six days and so does a count in UTC; the window's own zone says seven.
   */
  it('counts the days in the window’s own zone, not in UTC', () => {
    const inPagoPago = activity({
      window: { from: '2026-09-30T11:00:00.000Z', to: NOW.toISOString(), tz: 'Pacific/Pago_Pago' },
      runCount: 0,
      passRate: null,
      lastRun: { ...LAST_RUN, startedAt: '2026-09-30T05:00:00.000Z' },
    });
    mount(inPagoPago);
    expect(screen.getByTestId('attention-last-run')).toHaveTextContent(/· 7 days ago$/);
  });
});

describe('AttentionCard, no runs yet', () => {
  const NONE = activity({ runCount: 0, passRate: null, lastRun: null });

  it('offers both ways to get a first run, to the first project and to a new one', () => {
    mount(NONE, [SEARCH, CHECKOUT]);
    expect(screen.getByText('No runs yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add results' })).toHaveAttribute(
      'href',
      projectSetupPath(SEARCH.slug),
    );
    expect(screen.getByRole('link', { name: 'New project' })).toHaveAttribute('href', NEW_PROJECT_ROUTE);
  });

  it('leaves Add results out when there is no project to add them to', () => {
    mount(NONE, []);
    expect(screen.queryByRole('link', { name: 'Add results' })).toBeNull();
    expect(screen.getByRole('link', { name: 'New project' })).toHaveAttribute('href', NEW_PROJECT_ROUTE);
  });

  it('keeps the card’s own heading and draws no glance', () => {
    mount(NONE);
    expect(screen.getByRole('heading', { level: 2, name: 'Tests that need attention' })).toBeInTheDocument();
    expect(screen.queryByRole('figure')).toBeNull();
  });
});

/**
 * ═══ THE LAST-RUN CELL, ON ITS OWN ═══
 *
 * The attention table only ever hands it a run that needs attention, so the
 * three quieter tints — in flight, passed, and neither — are reachable only
 * from the tests table (Task 6), which is a different file. They are pinned
 * here, where the cell is, so a re-tint cannot pass through a suite that never
 * draws one. The colour is a left RULE, never the text's.
 */
describe('LastRunCell', () => {
  type CellRun = Parameters<typeof LastRunCell>[0]['run'];
  const RUN: CellRun = {
    id: id(5),
    runNumber: 12,
    status: 'complete',
    verdict: 'passed',
    startedAt: '2026-10-05T09:00:00.000Z',
    checks: null,
  };

  const cell = (over: Partial<CellRun>, reasons: Parameters<typeof LastRunCell>[0]['reasons'] = []) => {
    render(
      <MemoryRouter>
        <LastRunCell run={{ ...RUN, ...over }} reasons={reasons} />
      </MemoryRouter>,
    );
    return screen.getByTestId('last-run-cell');
  };

  it.each([
    ['needs attention', { status: 'failed' as const, verdict: null }, ['failed'] as const, 'failed'],
    ['in flight', { status: 'running' as const, verdict: null }, [] as const, 'pending'],
    ['pending', { status: 'pending' as const, verdict: null }, [] as const, 'pending'],
    ['parsing', { status: 'parsing' as const, verdict: null }, [] as const, 'pending'],
    ['a passed verdict', { status: 'complete' as const, verdict: 'passed' as const }, [] as const, 'passed'],
  ])('rules a run that is %s in its own colour', (_name, over, reasons, token) => {
    const rule = cell(over, reasons);
    expect(rule).toHaveClass('border-l-[3px]');
    expect(rule.style.borderLeftColor).toBe(`var(--color-status-${token})`);
  });

  it('puts a reason ahead of being in flight, because it is the fact a reader scanning by colour wants first', () => {
    const rule = cell({ status: 'running', verdict: null, checks: { failed: 1, total: 2 } }, ['assertion_failed']);
    expect(rule.style.borderLeftColor).toBe('var(--color-status-failed)');
  });

  it('draws a finished run nothing judged in the card’s own line colour, not a status colour', () => {
    for (const verdict of ['not_evaluated', null] as const) {
      cleanup();
      const rule = cell({ status: 'complete', verdict });
      expect(rule.style.borderLeftColor).toBe('var(--color-border)');
    }
  });

  it('never colours the text: the name stays the link’s colour', () => {
    const rule = cell({ status: 'failed', verdict: null }, ['failed']);
    const link = within(rule).getByRole('link');
    expect(link.style.color).toBe('');
    expect(rule.style.color).toBe('');
  });

  it('names the run, links to it, and says when it started', () => {
    const rule = cell({});
    const link = within(rule).getByRole('link', { name: 'Run 12' });
    expect(link).toHaveAttribute('href', runPath(RUN.id));
    expect(rule).toHaveTextContent(formatListInstant(RUN.startedAt));
  });

  it('falls back to the start of the id for a run with no number', () => {
    const rule = cell({ runNumber: null });
    expect(within(rule).getByRole('link', { name: `Run ${RUN.id.slice(0, 8)}` })).toBeInTheDocument();
  });

  it('draws one badge per reason, and no verdict badge beside them', () => {
    const two = cell({ verdict: 'failed', checks: { failed: 1, total: 4 } }, ['gate_failed', 'assertion_failed']);
    expect(two.querySelectorAll('.tint')).toHaveLength(2);
    expect(within(two).getByText('SLA failed')).toBeInTheDocument();
    expect(within(two).getByText('1 assertion failed')).toBeInTheDocument();
    // The reasons already say what went wrong: a bare "failed" beside "SLA
    // failed" would say it twice.
    expect(within(two).queryByText(VERDICT.failed.label)).toBeNull();
  });

  /**
   * ═══ A RUN WITH NO REASON IS A WORD, NOT ONLY A COLOUR (WCAG 1.4.1) ═══
   *
   * Without a badge, passed, in flight and judged-by-nothing differ by the
   * rule's colour alone. So a run with no reason wears exactly one badge: its
   * STATUS while it is in flight, its VERDICT once it has finished — the marks
   * the run list draws, read off `marks.tsx` rather than written down.
   */
  it.each([
    ['a passed run', { status: 'complete' as const, verdict: 'passed' as const }, VERDICT.passed],
    ['a running run', { status: 'running' as const, verdict: null }, STATUS.running],
    ['a pending run', { status: 'pending' as const, verdict: null }, STATUS.pending],
    ['a parsing run', { status: 'parsing' as const, verdict: null }, STATUS.parsing],
    ['a finished run no rule judged', { status: 'complete' as const, verdict: 'not_evaluated' as const }, VERDICT.not_evaluated],
    ['a finished run with no verdict', { status: 'complete' as const, verdict: null }, VERDICT.none],
  ])('gives %s one badge naming its outcome', (_name, over, mark) => {
    const rule = cell(over);
    const badges = rule.querySelectorAll<HTMLElement>('.tint');
    expect(badges).toHaveLength(1);
    expect(within(rule).getByText(mark.label)).toBe(badges[0]);
    expect(badges[0]!.style.color).toBe(mark.colour);
  });

  it('says a failed check without a count when the run carries no checks', () => {
    const rule = cell({}, ['assertion_failed']);
    expect(within(rule).getByText('Assertion failed')).toBeInTheDocument();
  });
});
