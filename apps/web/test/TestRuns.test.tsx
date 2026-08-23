import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunListResponse, TestSummary } from '@perfportal/contracts';
import TestRuns from '../src/routes/TestRuns';

// No global `afterEach(cleanup)` — `vitest.config.ts` sets no `globals`, so
// Testing Library never registers its own. See CLAUDE.md.
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

/**
 * `/projects/:slug/tests/:testSlug` — one test, and every run of it.
 *
 * TWO CLAIMS THIS FILE EXISTS FOR, AND NEITHER IS VISIBLE TO THE E2E SUITE
 * WITHOUT A LOT OF SEEDING:
 *
 * that the run list underneath is asked for THIS TEST — `?project=` AND
 * `?test=`, never one without the other, because the API answers a bare
 * `?test=` with 400 TEST_NEEDS_PROJECT and this page is the only caller that
 * sends one at all;
 *
 * and that the page contributes exactly ONE `<h1>`. `RunList` draws its own
 * everywhere else and is told not to here (`showHeading={false}`); if that
 * prop is ever dropped the page grows a second one, which no visual check
 * catches and which makes a screen-reader user meet the page twice.
 */

const PROJECT = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'checkout',
  name: 'Checkout',
  latestRun: null,
};

const TEST: TestSummary = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'example-checkoutsimulation',
  name: 'Checkout smoke',
  simulationClass: 'example.CheckoutSimulation',
  description: 'The happy path, hourly.',
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
  runCount: 2,
  latestRun: { id: '33333333-3333-4333-8333-333333333333', status: 'complete', verdict: 'passed' },
};

function runItem(id: string): RunListResponse['items'][number] {
  return {
    id,
    status: 'complete',
    verdict: 'passed',
    tool: 'gatling',
    startedAt: '2026-08-20T10:00:00.000Z',
    toolStartedAt: null,
    project: { id: PROJECT.id, slug: PROJECT.slug, name: PROJECT.name },
    simulation: 'example.CheckoutSimulation',
  };
}

const RUNS = [
  runItem('33333333-3333-4333-8333-333333333333'),
  runItem('44444444-4444-4444-8444-444444444444'),
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Every `/v1/runs` URL this render asked for, in order. */
const runRequests: string[] = [];
/** Every PATCH body this render sent, parsed. */
const patches: unknown[] = [];
/** Every DELETE this render issued. */
const deletes: string[] = [];

function stubFetch({
  test = TEST,
  testStatus = 200,
  patchStatus = 200,
  deleteStatus = 200,
  rulesBody = [],
  runsBody = RUNS,
}: {
  test?: unknown;
  testStatus?: number;
  patchStatus?: number;
  deleteStatus?: number;
  rulesBody?: unknown[];
  runsBody?: RunListResponse['items'];
} = {}) {
  runRequests.length = 0;
  patches.length = 0;
  deletes.length = 0;
  vi.stubGlobal('fetch', (input: RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');

    if (url.pathname === '/v1/projects') {
      return Promise.resolve(jsonResponse({ items: [PROJECT] }));
    }
    if (url.pathname === '/v1/projects/checkout/rules') {
      return Promise.resolve(jsonResponse({ rules: rulesBody }));
    }
    if (url.pathname === '/v1/projects/checkout/tests/example-checkoutsimulation') {
      if (init?.method === 'DELETE') {
        deletes.push(url.pathname);
        return Promise.resolve(
          deleteStatus === 200
            ? jsonResponse(TEST)
            : jsonResponse(
                {
                  type: 'about:blank',
                  title: 'Not Found',
                  status: 404,
                  detail: 'No test "example-checkoutsimulation" in this project.',
                  code: 'NOT_FOUND',
                  remediation: 'It may already have been deleted.',
                },
                deleteStatus,
              ),
        );
      }
      if (init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)));
        return Promise.resolve(
          patchStatus === 200
            ? jsonResponse({ ...TEST, name: 'Checkout, hourly' })
            : jsonResponse(
                {
                  type: 'about:blank',
                  title: 'Bad Request',
                  status: 400,
                  detail: 'The update is not valid.',
                  code: 'INVALID_TEST_UPDATE',
                  remediation: 'Send at least one of "name" or "description".',
                },
                patchStatus,
              ),
        );
      }
      return Promise.resolve(jsonResponse(test, testStatus));
    }
    if (url.pathname === '/v1/runs') {
      runRequests.push(url.search);
      return Promise.resolve(jsonResponse({ items: runsBody, nextCursor: null }));
    }

    throw new Error(`unhandled request in TestRuns.test.tsx: ${url.pathname}${url.search}`);
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/checkout/tests/example-checkoutsimulation']}>
        <Routes>
          <Route path="/projects/:slug/tests/:testSlug" element={<TestRuns />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TestRuns', () => {
  it('names the test as the page, and the project as the rung above it', async () => {
    stubFetch();
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Checkout smoke' }),
    ).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Checkout' })).toHaveAttribute(
      'href',
      '/projects/checkout',
    );
  });

  /**
   * ONE `<h1>` PER DOCUMENT. `RunList` renders its own page heading on every
   * other screen; dropping `showHeading={false}` here would add a second, and
   * nothing about the page would look wrong.
   */
  it('contributes exactly one level-1 heading, not one per component', async () => {
    stubFetch();
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Checkout smoke' });
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(RUNS.length));
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  /**
   * ═══ ONE RULES PANEL, AND THE REASON THIS CASE EXISTS ═══
   *
   * `ProjectRules` and `RunList` are siblings here and BOTH take a `key` built
   * to force a remount when the reader moves between two tests. Built from the
   * same two slugs, those keys were IDENTICAL — and React's rule is that keys
   * are unique among siblings. The failure is not an error: React rendered the
   * rules panel FOUR times, behind a console warning nobody sees in a browser
   * tab.
   *
   * Every existing case here passed throughout, because each queried something
   * unique to the page (`Rename`, `Delete test`, the heading). The e2e suite
   * caught it as `getByRole('button', { name: 'Add rule' }) resolved to 2
   * elements`, which names the symptom two layers from the cause. This asserts
   * the cause directly, and cheaply.
   */
  it('mounts exactly one rules panel, not one per key collision', async () => {
    stubFetch();
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Checkout smoke' });
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Add rule' })).toHaveLength(1),
    );
  });

  /**
   * ═══ THE REQUEST IS THE ASSERTION ═══
   *
   * A run list that renders rows proves nothing here — the stub answers every
   * `/v1/runs` the same way. What matters is that this page asked for ONE
   * TEST's runs, and that it sent the project alongside: a test slug is unique
   * within its project, not across the org, and the API answers a bare
   * `?test=` with 400 TEST_NEEDS_PROJECT rather than guessing.
   */
  it('asks for this test’s runs, with the project that scopes the slug', async () => {
    stubFetch();
    renderPage();
    await waitFor(() => expect(runRequests.length).toBeGreaterThan(0));
    const params = new URLSearchParams(runRequests[0]);
    expect(params.get('project')).toBe('checkout');
    expect(params.get('test')).toBe('example-checkoutsimulation');
  });

  it('states the simulation class and the run count as facts about the test', async () => {
    stubFetch();
    renderPage();
    expect(await screen.findByText('example.CheckoutSimulation')).toBeInTheDocument();
    expect(screen.getByText('2 runs')).toBeInTheDocument();
  });

  /**
   * A 404 is the likeliest arrival at this URL after a hand edit or a stale
   * link, and the server's own sentence names the slug it could not find —
   * more use than a generic page-not-found.
   */
  it('renders what the server said when the test does not exist', async () => {
    stubFetch({
      test: {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'No test "example-checkoutsimulation" in this project.',
        code: 'NOT_FOUND',
        remediation: 'Check the address, or open the project’s test list.',
      },
      testStatus: 404,
    });
    renderPage();
    expect(await screen.findByText('This test could not be loaded')).toBeInTheDocument();
    expect(
      screen.getByText('No test "example-checkoutsimulation" in this project.'),
    ).toBeInTheDocument();
    // No run list under an error: the runs of a test that could not be
    // resolved are not a thing this page can ask for.
    expect(screen.queryByTestId('run-row')).toBeNull();
  });
});

/**
 * ═══ THE PAYOFF OF GROUPING RUNS AT ALL ═══
 *
 * Compare has always been reachable only from INSIDE a run, so answering "how
 * have the last few of these gone" meant opening one run to get at a
 * comparison of several. Its cohort has been this test's since `TRENDS_SQL`
 * started keying on `test_id`; this link is the door.
 */
describe('TestRuns — comparing the latest runs', () => {
  it('links to a comparison of this test’s runs, anchored on the newest', async () => {
    stubFetch();
    renderPage();

    const link = await screen.findByRole('link', { name: `Compare latest ${RUNS.length}` });
    // Anchored on the NEWEST run and carrying both ids: the anchor fixes the
    // palette (`parseCompareSelection` puts the current run first), so the run
    // a reader is most likely thinking about keeps a stable colour.
    expect(link).toHaveAttribute(
      'href',
      `/runs/${RUNS[0]!.id}/compare?runs=${encodeURIComponent(RUNS.map((r) => r.id).join(','))}`,
    );
  });

  /**
   * One run is not a comparison, and a link that opens a page saying "there is
   * nothing to compare" is worse than no link — the same call `RunTrends`
   * makes about linking here at all.
   */
  it('offers nothing to compare when the test has only one complete run', async () => {
    stubFetch({ runsBody: [RUNS[0]!] });
    renderPage();

    await screen.findByRole('heading', { level: 1, name: 'Checkout smoke' });
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(1));
    expect(screen.queryByRole('link', { name: /Compare latest/ })).toBeNull();
  });

  /**
   * ═══ ONLY COMPLETE RUNS ARE CANDIDATES ═══
   *
   * `TRENDS_SQL` — where the Compare page gets its own cohort — selects
   * `status = 'complete'`, so a pending run is not a candidate there and
   * `parseCompareSelection` would drop it on arrival. Including it here would
   * build a link the destination silently refuses, which reads as the
   * comparison having lost a run for no reason.
   */
  it('leaves an unfinished run out of the selection rather than sending it', async () => {
    stubFetch({
      runsBody: [
        RUNS[0]!,
        { ...RUNS[1]!, status: 'running', verdict: null },
        { ...RUNS[1]!, id: '77777777-7777-4777-8777-777777777777' },
      ],
    });
    renderPage();

    const link = await screen.findByRole('link', { name: 'Compare latest 2' });
    const runs = new URL(link.getAttribute('href')!, 'http://x').searchParams.get('runs');
    expect(runs?.split(',')).toEqual([RUNS[0]!.id, '77777777-7777-4777-8777-777777777777']);
  });
});

describe('TestRuns — renaming', () => {
  /**
   * The form is DISCLOSED, not always open. Renaming happens once in a test's
   * life; a form permanently above the run history would make the page about
   * administration rather than about the runs.
   */
  it('keeps the rename form closed until it is asked for', async () => {
    stubFetch();
    renderPage();
    const rename = await screen.findByRole('button', { name: 'Rename' });
    expect(rename).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('form', { name: 'Rename this test' })).toBeNull();

    await userEvent.click(rename);
    expect(screen.getByRole('form', { name: 'Rename this test' })).toBeInTheDocument();
  });

  it('sends the new name, and closes on success', async () => {
    stubFetch();
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));

    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Checkout, hourly');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ name: 'Checkout, hourly' });
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Rename this test' })).toBeNull(),
    );
  });

  /**
   * ═══ EMPTYING THE BOX MUST SEND `null`, NOT OMIT THE FIELD ═══
   *
   * `UpdateTestRequestSchema` draws that distinction on purpose: `undefined`
   * means "leave this alone", so omitting the field on an emptied box would
   * silently keep the description the reader just deleted — a save that
   * reports success and changes nothing.
   */
  it('clears a description by sending null, rather than by omitting it', async () => {
    stubFetch();
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));

    await userEvent.clear(screen.getByLabelText('Description'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ name: 'Checkout smoke', description: null });
  });

  /**
   * The class is shown as a FACT, never as a field. `.strict()` rejects it,
   * and the reason is worth stating on screen: editing it would split the
   * test's history rather than rename it, silently.
   */
  it('offers no way to re-aim the test at another simulation class', async () => {
    stubFetch();
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));

    const form = screen.getByRole('form', { name: 'Rename this test' });
    expect(within(form).queryByLabelText(/simulation class/i)).toBeNull();
    expect(within(form).queryByLabelText(/slug/i)).toBeNull();
    expect(within(form).getByText(/split this test’s history/)).toBeInTheDocument();
  });

  /**
   * SCOPED TO THE FORM, deliberately. `RunList`'s own error state is a
   * `role="alert"` too and can be on screen at the same time, so a page-wide
   * `getByRole('alert')` here would stop asking "did the rename fail" and
   * start asking "did anything fail" — the exact trap CLAUDE.md records from
   * the SLA rules panel.
   */
  it('reports a rejected rename in the server’s own words, beside the form', async () => {
    stubFetch({ patchStatus: 400 });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const panel = await screen.findByTestId('test-rename');
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('The update is not valid.');
    // Still open — a form that closed on failure would discard what the
    // reader typed along with the reason it was refused.
    expect(screen.getByRole('form', { name: 'Rename this test' })).toBeInTheDocument();
  });

  /** The server requires a name; catching it here puts the refusal on the
   *  control rather than a round trip away. */
  it('will not submit a blank name', async () => {
    stubFetch();
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));

    await userEvent.clear(screen.getByLabelText('Name'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(patches).toHaveLength(0);
  });
});

/**
 * ═══ DELETING A TEST, AND SAYING WHAT THAT COSTS ═══
 *
 * Two different cascades meet on this button and a reader cannot be expected
 * to know either. The RUNS survive (`run.test_id` is SET NULL) and move to the
 * project's run list — the half people fear and would otherwise not do. The
 * test's own SLA RULES do not (`sla_rule.test_id` is CASCADE) — the half
 * nobody expects, which is why the count is spelled out rather than implied.
 *
 * A destructive action whose consequences are only discoverable afterwards is
 * not a confirmed one, so these cases are about the WORDS as much as the call.
 */
describe('TestRuns — deleting a test', () => {
  const OWN_RULE = {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Payments p95',
    test: { id: TEST.id, slug: TEST.slug, name: TEST.name },
    scope: 'run',
    targetName: null,
    family: 'response_time',
    metric: 'p95',
    comparator: 'lte',
    threshold: 800,
    enabled: true,
    createdAt: '2026-08-22T10:00:00.000Z',
    updatedAt: '2026-08-22T10:00:00.000Z',
  };
  /** A project-wide rule — it judges this test but is NOT its to lose. */
  const WIDE_RULE = { ...OWN_RULE, id: '66666666-6666-4666-8666-666666666666', test: null };

  it('does not delete on a single click', async () => {
    stubFetch();
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete test' }));

    expect(screen.getByTestId('test-delete-confirm')).toBeInTheDocument();
    expect(deletes).toHaveLength(0);
  });

  it('names the runs it will keep and the rules it will destroy', async () => {
    stubFetch({ rulesBody: [OWN_RULE, WIDE_RULE] });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete test' }));

    const panel = screen.getByTestId('test-delete-confirm');
    // `TEST.runCount` is 2 — computed from the fixture rather than written
    // down, so a re-fixtured count cannot make this pass for the wrong reason.
    expect(panel).toHaveTextContent(new RegExp(`${TEST.runCount} runs are kept`));
    // ONE rule, not two: the project-wide one is not this test's to lose, and
    // counting it would overstate the damage in the one place a reader is
    // deciding whether to proceed.
    expect(panel).toHaveTextContent(/1 SLA rule is\s+deleted with it/);
    expect(panel).toHaveTextContent(/Project-wide rules are unaffected/);
  });

  it('says so plainly when there is nothing of either to lose', async () => {
    stubFetch({ test: { ...TEST, runCount: 0 }, rulesBody: [WIDE_RULE] });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete test' }));

    const panel = screen.getByTestId('test-delete-confirm');
    expect(panel).toHaveTextContent('It has no runs.');
    expect(panel).toHaveTextContent('It has no SLA rules of its own.');
  });

  /**
   * The test comes BACK if a run of its class is parsed again — it is created
   * from the simulation class, not authored — and a reader deciding whether to
   * delete needs to know that this is not permanent in the way it looks.
   */
  it('says the test returns with the next run of its class', async () => {
    stubFetch();
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete test' }));
    expect(screen.getByTestId('test-delete-confirm')).toHaveTextContent(
      /A future run of\s+example\.CheckoutSimulation\s+creates the test again/,
    );
  });

  it('deletes on confirmation, and leaves the page it just destroyed', async () => {
    stubFetch();
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete test' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete this test' }));

    await waitFor(() => expect(deletes).toHaveLength(1));
    // Navigated away — the heading of the page that no longer exists is gone.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 1, name: 'Checkout smoke' })).toBeNull(),
    );
  });

  it('disarms without deleting', async () => {
    stubFetch();
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete test' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByTestId('test-delete-confirm')).toBeNull();
    expect(deletes).toHaveLength(0);
  });

  /**
   * A destructive mutation that failed must announce itself and must NOT claim
   * a state it cannot know — the same wording discipline `TokenTable`'s revoke
   * failure uses. Scoped to the confirm panel, because the run list below has
   * its own `role="alert"` and a page-wide query would stop asking "did the
   * delete fail" and start asking "did anything fail".
   */
  it('says the test may still exist when the delete fails', async () => {
    stubFetch({ deleteStatus: 404 });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete test' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete this test' }));

    const panel = await screen.findByTestId('test-delete-confirm');
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('This test may still exist');
    // Still on the page: navigating away from a delete that did not happen
    // would tell the reader it did.
    expect(screen.getByRole('heading', { level: 1, name: 'Checkout smoke' })).toBeInTheDocument();
  });
});
