// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes, useLocation, type Location } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentStatusResponseSchema, AgentSummaryResponseSchema, StatsResponseSchema, UsersResponseSchema, requestsInGroup } from '@perfportal/contracts';
import type { RunResponse, UsersResponse } from '@perfportal/contracts';
import agentRun from './fixtures/agent-run.json';
import reference from './fixtures/reference-run.json';
import { ProblemError } from '../src/api/fetch';
import { usersQueryKey } from '../src/api/metrics';
import { runQueryKey } from '../src/api/run';
import { toIndicators, toRequestCounts } from '../src/charts/transforms/indicators';
import { toConcurrentUsers, toUserEndRate, toUserStartRate } from '../src/charts/transforms/users';
import type { ChartData } from '../src/charts/types';
import RunReport from '../src/routes/RunReport';
import { explain } from '../src/routes/payload';
import { narrowStats, narrowUsers } from '../src/routes/report/narrow';
import type { RunWindowContext } from '../src/routes/useRunWindow';
import { UNKNOWN_ACCESS } from './support/access';
import useIsCompact from '../src/useIsCompact';

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));

// Real charts draw here, and ECharts measures text through a 2D canvas context
// that jsdom does not implement — it answers null and prints "Not implemented"
// on every call, 120-odd lines of stderr for this file alone. Answering null
// ourselves is what jsdom does anyway, without the noise.
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(useIsCompact).mockReturnValue(false);
});

const RUN_ID = '00000000-0000-4000-8000-000000000001';

function readyRun(over: Partial<RunResponse> = {}): RunResponse {
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
    toolAssertions: [],
    ...over,
  };
}

/** What `/telemetry` answers unless a case says otherwise: no agent reported. */
const NO_TELEMETRY = { runId: RUN_ID, available: false, bucketWidthMs: 1000, window: null, hosts: [] };

/** Two load generators that both reported — the state that draws a host
 *  picker, which a section shows only when there is more than one to pick. */
const TWO_HOSTS = {
  runId: RUN_ID,
  available: true,
  bucketWidthMs: 1000,
  window: null,
  hosts: ['gen-01', 'gen-02'].map((host) => ({
    host,
    clockSkewMs: 0,
    points: [
      {
        startOffsetMs: 0,
        cpuTotalPct: 10,
        cpuUserPct: 6,
        cpuSystemPct: 4,
        memUsedBytes: 1024 * 1024,
        memTotalBytes: 4 * 1024 * 1024,
        rxBytesPerSec: 100,
        txBytesPerSec: 200,
        inSegsPerSec: 5,
        outSegsPerSec: 6,
        retransSegsPerSec: 0,
        inErrsPerSec: 0,
        activeOpensPerSec: 1,
        passiveOpensPerSec: 0,
        tcpStates: { ESTABLISHED: 3 },
      },
    ],
  })),
};

/** The captured agent run's summary and status reads, parsed so the bodies
 *  still satisfy today's contract. Their `runId` is the captured run's, which
 *  nothing here reads. */
const AGENT_SUMMARY = AgentSummaryResponseSchema.parse(agentRun.summary);
const AGENT_STATUS = AgentStatusResponseSchema.parse(agentRun.status);

/** What `/agent` answers unless a case says otherwise: no agent file — every
 *  upload and plugin run — so Connections and Load generators keep the
 *  load-generator telemetry, which is what most cases below are about. */
const NO_AGENT_SUMMARY = {
  ...AGENT_SUMMARY,
  runId: RUN_ID,
  available: false,
  reason: 'not_collected' as const,
  header: null,
  bucketWidthMs: null,
  remotes: [],
  hostnames: [],
  injector: { host: null, sharedWithPerfPortal: false },
};

/** `/agent/status` answering unavailable, in the API's own shape. */
function statusUnavailable(reason: 'not_collected' | 'unreadable' | 'http_not_collected', detail: string | null) {
  return { runId: RUN_ID, available: false, reason, detail, bucketWidthMs: null, window: null, codes: [], buckets: [] };
}

interface AgentBodies {
  /** What `/agent` answers; `'hold'` never answers, `null` is a 500. */
  readonly summary?: unknown;
  /** What `/agent/status` answers. */
  readonly status?: unknown;
}

interface RequestsBodies {
  /** What a WINDOWED `/stats` (one carrying `from`) answers; the whole-run body otherwise. */
  readonly windowedStats?: unknown;
  /** Holds every `/stats` answer until it resolves. */
  readonly statsGate?: Promise<unknown>;
  /** How a group read (`?group=`) answers: with its echo (the default), without
   *  one (an API older than the pickers), or 409 `GROUP_NOT_MERGEABLE`. */
  readonly group?: 'echo' | 'no-echo' | 'not-mergeable';
}

/** How `/users` answers: the whole run (no `from`) and a window apart, as the
 *  API does — its windowed body holds only the scenarios with a bucket inside
 *  the range (`ParityController.users`). */
interface UsersBodies {
  /** The whole-run body; `null` is a 404. Defaults to the reference run's. */
  readonly body?: unknown;
  /** What a WINDOWED `/users` answers; the whole-run body otherwise. */
  readonly windowed?: unknown;
  /** Holds the whole-run answer until it resolves. */
  readonly gate?: Promise<unknown>;
  /** Told as a WINDOWED `/users` is answered. */
  readonly onWindowed?: () => void;
}

/** What the stub's `/users` answers for `body: null`: a 404 problem document. */
const USERS_NOT_FOUND = { status: 404, title: 'Not Found', code: 'NOT_FOUND', detail: 'stub', remediation: 'stub' } as const;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 300 ? 'application/json' : 'application/problem+json' },
  });

/** Answers each endpoint from the captured fixture; anything else is a 404,
 *  which `Payload` renders as an undrawn slot — still a figure with its id. */
function stubFetch(
  statsBody: unknown = reference.stats,
  telemetryBody: unknown = NO_TELEMETRY,
  agent: AgentBodies = {},
  requests: RequestsBodies = {},
  users: UsersBodies = {},
): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const parsed = new URL(url, 'http://x');
    const path = parsed.pathname;
    const group = parsed.searchParams.get('group');
    if (group !== null && (path.endsWith('/series') || path.endsWith('/distribution'))) {
      const body = path.endsWith('/series') ? reference.series : reference.distribution;
      if (requests.group === 'not-mergeable') {
        return Promise.resolve(
          json(
            { status: 409, title: 'Conflict', code: 'GROUP_NOT_MERGEABLE', detail: 'A member has no exact histogram.', remediation: 'Recompute the run.' },
            409,
          ),
        );
      }
      // An older API ignores `group` and answers the run's own body, echoing nothing.
      if (requests.group === 'no-echo') return Promise.resolve(json(body));
      return Promise.resolve(json({ ...body, scope: 'request', name: '', group }));
    }
    if (path.endsWith('/stats')) {
      const windowed = parsed.searchParams.has('from') && requests.windowedStats !== undefined;
      const answer = () =>
        statsBody === null && !windowed
          ? json({ status: 404, title: 'Not Found', code: 'NOT_FOUND', detail: 'stub', remediation: 'stub' }, 404)
          : json(windowed ? requests.windowedStats : statsBody);
      return requests.statsGate === undefined ? Promise.resolve(answer()) : requests.statsGate.then(answer);
    }
    if (path.endsWith('/users')) {
      const windowed = parsed.searchParams.has('from');
      if (windowed) users.onWindowed?.();
      if (windowed && users.windowed !== undefined) return Promise.resolve(json(users.windowed));
      const body = users.body === undefined ? reference.users : users.body;
      const answer = () => (body === null ? json(USERS_NOT_FOUND, 404) : json(body));
      return windowed || users.gate === undefined ? Promise.resolve(answer()) : users.gate.then(answer);
    }
    if (path.endsWith('/agent')) {
      const summary = agent.summary === undefined ? NO_AGENT_SUMMARY : agent.summary;
      if (summary === 'hold') return new Promise<Response>(() => {});
      if (summary === null) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ status: 500, title: 'Internal', code: 'INTERNAL', detail: 'The agent summary could not be read.', remediation: 'Retry the request.' }),
            { status: 500, headers: { 'content-type': 'application/problem+json' } },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(summary), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    const body = path.endsWith('/agent/status')
      ? (agent.status ?? statusUnavailable('not_collected', null))
      : path.endsWith('/series')
        ? reference.series
        : path.endsWith('/distribution')
          ? reference.distribution
          : path.endsWith('/telemetry')
            ? telemetryBody
            : null;
    return Promise.resolve(
      body === null
        ? new Response(JSON.stringify({ status: 404, title: 'Not Found', code: 'NOT_FOUND', detail: 'stub', remediation: 'stub' }), {
            status: 404,
            headers: { 'content-type': 'application/problem+json' },
          })
        : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  });
  return seen;
}

function renderReport({
  url = `/runs/${RUN_ID}/report`,
  window = null,
  stats,
  telemetry,
  agent,
  run,
  requests,
  users,
}: {
  url?: string;
  /** How `/users` answers, whole-run and windowed. */
  users?: UsersBodies;
  /** How the Requests section's narrowed reads answer. */
  requests?: RequestsBodies;
  /** What the agent reads answer; defaults to a run with no agent file. */
  agent?: AgentBodies;
  /** Fields of the run's identity to override — `statsMethod` among them. */
  run?: Partial<RunResponse>;
  window?: RunWindowContext['window'];
  /** What `/stats` answers; `null` for a 404. Defaults to the reference run's. */
  stats?: unknown;
  /** What `/telemetry` answers; defaults to no agent having reported. */
  telemetry?: unknown;
} = {}) {
  const seen = stubFetch(stats, telemetry, agent, requests, users);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastClient = client;
  client.setQueryData(runQueryKey(RUN_ID), { state: 'ready', run: readyRun(run) });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/runs/:runId"
            element={<Outlet context={{ window, durationMs: 63161, liveDurationMs: null, warmupMs: null, live: null, projectAccess: UNKNOWN_ACCESS } satisfies RunWindowContext} />}
          >
            <Route
              path="report"
              element={
                <>
                  <RunReport />
                  <LocationProbe />
                </>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return seen;
}

/** Where the page's last navigation left the URL, for the cases that read a write. */
let lastLocation: Location | null = null;
/** The last report's query client, for a case that waits on what the page holds. */
let lastClient: QueryClient | null = null;
function LocationProbe() {
  lastLocation = useLocation();
  return null;
}

const path = (url: string) => new URL(url, 'http://x').pathname;

/** The pickers' names read (ruling R13): `/stats` with no window. */
const isWholeRunStats = (url: string) => path(url).endsWith('/stats') && !/[?&]from=/.test(url);

/** Virtual users' scenario list: `/users` with no window. */
const isWholeRunUsers = (url: string) => path(url).endsWith('/users') && !/[?&]from=/.test(url);

/** GE's sections in GE's order — DNS between Connections and Load generators. */
const SECTIONS = ['Requests', 'Groups', 'Virtual users', 'Connections', 'DNS', 'Load generators'];

describe('RunReport — GE’s sections', () => {
  it('lists GE’s sections in GE’s order, with only Requests open', () => {
    renderReport();
    const h2 = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.trim());
    expect(h2).toEqual(SECTIONS);
    for (const title of SECTIONS) {
      expect(screen.getByRole('button', { name: title })).toHaveAttribute('aria-expanded', String(title === 'Requests'));
    }
  });

  it('asks for nothing a shut section would show', async () => {
    const seen = renderReport();
    await screen.findByTestId('chart-requests-and-responses');
    expect(seen.some((u) => u.includes('/users'))).toBe(false);
    expect(seen.some((u) => u.includes('/telemetry'))).toBe(false);
    // The agent sections are shut, so not even the summary they all read first.
    expect(seen.some((u) => new URL(u, 'http://x').pathname.endsWith('/agent'))).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Virtual users' }));
    await waitFor(() => expect(seen.some((u) => u.includes('/users'))).toBe(true));
  });

  it('opens Requests on Charts, in GE’s order with this product’s two after', async () => {
    renderReport();
    const section = screen.getByTestId('section-requests');
    await within(section).findByTestId('chart-requests-and-responses');
    const ids = [...section.querySelectorAll('figure[data-testid^="chart-"]')].map((f) => f.getAttribute('data-testid'));
    expect(ids).toEqual([
      'chart-requests-and-responses',
      'chart-percentiles',
      'chart-distribution',
      'chart-percentile-distribution',
      'chart-errors-over-time',
      'chart-agent-status',
      'chart-indicators',
      'chart-request-counts',
    ]);
    expect(within(section).getByRole('button', { name: 'Charts' })).toHaveAttribute('aria-pressed', 'true');
  });

  it.each(['?sort=p99&dir=desc', '?q=Search'])('opens straight on Table for a link carrying the table’s view (%s)', async (search) => {
    renderReport({ url: `/runs/${RUN_ID}/report${search}` });
    const section = screen.getByTestId('section-requests');
    expect(within(section).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    // Read before anything awaits, so it is the LOADING section's heading
    // (`TableSection`'s own, drawn while `/stats` is in flight) — the level has
    // to be passed to it as well as to the table, and a `findBy` would wait out
    // a wrong one until the table arrived.
    expect(within(section).getByRole('heading', { level: 3, name: 'Statistics' })).toBeVisible();

    // Once the table is there its heading is `StatisticsTable`'s — a second
    // place the level is passed — and it is the only one left.
    await within(section).findByRole('table', { name: /statistics/i });
    expect(within(section).getAllByRole('heading', { name: 'Statistics' }).map((h) => h.tagName)).toEqual(['H3']);
    // The glossary defines the table's words, so it travelled with the table.
    expect(within(section).getByTestId('run-glossary')).toBeInTheDocument();
  });

  /**
   * ═══ THE TABLE'S PERCENTILE CAVEAT FOLLOWS THE RUN'S `statsMethod` ═══
   *
   * `StatisticsTable.test.tsx` proves the table prints what its `exact` prop
   * says; nothing there proves THIS page derives the prop from the run's own
   * identity. A hard-coded `exact` passes that file whichever value it holds,
   * so the run is rendered three ways here and the description read off the
   * real Table view: exact-v1 says exact, estimated and an older API's absent
   * field keep the estimate.
   */
  it.each([
    ['exact-v1', /exact/i, /within 1%|estimat/i],
    ['estimated', /within 1%/i, /are exact/i],
    [undefined, /within 1%/i, /are exact/i],
  ] as const)('the Statistics info for a %s run says what it should', async (statsMethod, says, never) => {
    renderReport({ run: statsMethod === undefined ? {} : { statsMethod } });
    const section = screen.getByTestId('section-requests');
    await userEvent.click(within(section).getByRole('button', { name: 'Table' }));
    await within(section).findByRole('table', { name: /statistics/i });
    const trigger = within(section).getByRole('button', { name: 'About Statistics' });
    expect(trigger).toHaveAccessibleDescription(says);
    expect(trigger).not.toHaveAccessibleDescription(never);
  });

  /**
   * The Groups section's two p95 headings carry ≈ for an estimated run, and
   * this page is what decides it — `GroupsList` only does what it is told.
   */
  it('marks the Groups p95 headings of an estimated run and not of an exact one', async () => {
    const openGroups = async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Groups' }));
      return within(screen.getByTestId('section-groups')).findByRole('table', { name: 'Groups' });
    };
    renderReport({ run: { statsMethod: 'estimated' } });
    let table = await openGroups();
    for (const name of ['p95 cumulated', 'p95 duration']) {
      expect(within(table).getByRole('columnheader', { name: `approximately ${name}` }).textContent).toContain('≈');
    }
    expect(within(table).getByRole('columnheader', { name: 'Count' }).textContent).not.toContain('≈');
    cleanup();

    renderReport({ run: { statsMethod: 'exact-v1' } });
    table = await openGroups();
    expect(within(table).getByRole('columnheader', { name: 'p95 cumulated' })).toBeInTheDocument();
    expect(table.textContent).not.toMatch(/≈|approximately/);
  });

  it('narrows every Requests query to the window', async () => {
    const seen = renderReport({ window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 } });
    await screen.findByTestId('chart-requests-and-responses');
    // The figure reads wait for the pickers' names, so wait for them in turn.
    await waitFor(() => expect(seen.some((u) => u.includes('/agent/status'))).toBe(true));
    const metric = seen.filter((u) => /\/(series|stats|distribution|errors\/series|agent\/status)/.test(u));
    // ONE read is whole-run on purpose: the pickers' names (ruling R13). It is
    // left out by its exact shape, and the charts' own `/stats` must still be
    // windowed — an unwindowed one would share the names' key, become the same
    // request, and pass the loop below unseen.
    const names = metric.filter(isWholeRunStats);
    expect(names, 'the pickers’ names are the one whole-run read').toHaveLength(1);
    expect(metric.some((u) => path(u).endsWith('/stats') && /[?&]from=10000/.test(u)), 'the charts’ /stats').toBe(true);
    // The status chart reads the agent file through the same window.
    expect(metric.some((u) => u.includes('/agent/status'))).toBe(true);
    expect(metric.length).toBeGreaterThan(4);
    for (const url of metric.filter((u) => !isWholeRunStats(u))) expect(url).toMatch(/[?&]from=10000/);
  });

  // The test above reads the Charts view only. Every OTHER consumer reaches the
  // window by its own call — the table, the groups list, the users charts and
  // the telemetry sections — and a section that forgot it would draw the whole
  // run under a window the reader selected, so each one is opened.
  it('narrows the table, the groups, the users and the telemetry to the window too', async () => {
    // The windowed `/stats` lacks Search and the Catalog/Recommendations group,
    // so a table or a groups list that read the whole run instead would show
    // them. Read off the screen, because an unwindowed read here is the
    // pickers' names' key: served from that entry, it is never fetched, and no
    // URL in `seen` could give it away.
    const nested = 'Catalog/Recommendations';
    const seen = renderReport({
      window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 },
      requests: {
        windowedStats: {
          ...reference.stats,
          stats: reference.stats.stats.filter((s) => s.name !== 'Search' && !(s.scope === 'group' && s.name === nested)),
        },
      },
    });
    await screen.findByTestId('chart-requests-and-responses');
    await userEvent.click(within(screen.getByTestId('section-requests')).getByRole('button', { name: 'Table' }));
    const rows = await within(screen.getByTestId('section-requests')).findAllByTestId('stat-row');
    expect(rows.map((r) => r.getAttribute('data-path'))).toContain('Place Order');
    expect(rows.map((r) => r.getAttribute('data-path'))).not.toContain('Search');
    for (const title of ['Groups', 'Virtual users', 'Connections']) {
      await userEvent.click(screen.getByRole('button', { name: title }));
    }
    const groups = screen.getByTestId('section-groups');
    expect(await within(groups).findByRole('link', { name: 'Cart' })).toBeInTheDocument();
    expect(reference.stats.stats.some((s) => s.scope === 'group' && s.name === nested), 'the whole run has it').toBe(true);
    expect(within(groups).queryByRole('link', { name: nested })).toBeNull();
    await waitFor(() => expect(seen.some((u) => u.includes('/telemetry'))).toBe(true));
    await waitFor(() => expect(seen.some((u) => u.includes('/users'))).toBe(true));

    const kinds = ['/series', '/stats', '/distribution', '/errors/series', '/users', '/telemetry'];
    const metric = seen.filter((u) => kinds.some((k) => new URL(u, 'http://x').pathname.endsWith(k)));
    // Every kind really was asked for, or the loop below proves less than it says.
    for (const kind of kinds) expect(metric.some((u) => new URL(u, 'http://x').pathname.endsWith(kind)), kind).toBe(true);
    // The pickers' names, and only they, are whole-run (ruling R13): the
    // Requests section's from `/stats`, Virtual users' scenarios from `/users`.
    expect(metric.filter(isWholeRunStats)).toHaveLength(1);
    expect(metric.filter(isWholeRunUsers)).toHaveLength(1);
    // And the users charts' own read is windowed: an unwindowed one would share
    // the scenarios' key, become the same request, and pass the loop unseen.
    expect(metric.some((u) => path(u).endsWith('/users') && /[?&]from=10000/.test(u)), 'the users charts’ /users').toBe(true);
    for (const url of metric.filter((u) => !isWholeRunStats(u) && !isWholeRunUsers(u))) expect(url).toMatch(/[?&]from=10000/);
  });

  it('lists the run’s groups, each linked to its own page', async () => {
    renderReport();
    await userEvent.click(screen.getByRole('button', { name: 'Groups' }));
    const section = screen.getByTestId('section-groups');
    // A NESTED group, whose name carries the separator the link has to encode.
    const nested = reference.stats.stats.find((s) => s.scope === 'group' && s.name.includes('/'))!.name;
    const link = await within(section).findByRole('link', { name: nested });
    expect(link).toHaveAttribute('href', `/runs/${RUN_ID}/groups/${encodeURIComponent(nested)}`);
    expect(link.getAttribute('href')).toContain('%2F');
  });

  /** The window rides along on a drill-down, as it does from the statistics
   *  table's rows — only `from`/`to`, never the rest of the query string. A
   *  link built from the bare path drops it, and the group page's "Back to
   *  this run" then lands on a Report that has forgotten the interval. */
  it('carries the reader’s window, and only the window, onto a group link', async () => {
    renderReport({
      url: `/runs/${RUN_ID}/report?from=10000&to=20000&sort=p95`,
      window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Groups' }));
    const section = screen.getByTestId('section-groups');
    const nested = reference.stats.stats.find((s) => s.scope === 'group' && s.name.includes('/'))!.name;
    const link = await within(section).findByRole('link', { name: nested });
    expect(link).toHaveAttribute(
      'href',
      `/runs/${RUN_ID}/groups/${encodeURIComponent(nested)}?from=10000&to=20000`,
    );
  });

  it('says so when the run has no groups, rather than drawing an empty table', async () => {
    renderReport({ stats: { ...reference.stats, stats: reference.stats.stats.filter((s) => s.scope !== 'group') } });
    await userEvent.click(screen.getByRole('button', { name: 'Groups' }));
    const section = screen.getByTestId('section-groups');
    expect(await within(section).findByText('This run has no groups.')).toBeVisible();
    expect(within(section).queryByText('No groups ran in the selected window.')).toBeNull();
    expect(within(section).queryByRole('table')).toBeNull();
  });

  // `/stats` is windowed, so a window that selects no group buckets leaves the
  // list empty for a run that HAS groups. "This run has no groups." would then
  // be a whole-run claim read off a scoped result — the rule ErrorsTable and
  // RunStats already follow.
  it('does not call a run groupless because the selected window held none of its groups', async () => {
    renderReport({
      window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 },
      stats: { ...reference.stats, stats: reference.stats.stats.filter((s) => s.scope !== 'group') },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Groups' }));
    const section = screen.getByTestId('section-groups');
    expect(await within(section).findByText('No groups ran in the selected window.')).toBeVisible();
    expect(within(section).queryByText('This run has no groups.')).toBeNull();
    expect(within(section).queryByRole('table')).toBeNull();
  });

  it('says the groups could not be loaded, rather than saying there are none', async () => {
    renderReport({ stats: null });
    await userEvent.click(screen.getByRole('button', { name: 'Groups' }));
    const section = screen.getByTestId('section-groups');
    expect(await within(section).findByRole('alert')).toHaveTextContent('This run’s groups could not be loaded');
    expect(within(section).queryByText('This run has no groups.')).toBeNull();
  });

  // Connections and Load generators are two mounts of ONE component on one
  // page, so anything it hard-codes into the document is hard-coded twice. The
  // host picker's `<label htmlFor>` and `<select id>` were exactly that: with a
  // literal id the second label pointed at the FIRST section's select, and a
  // click on it moved the wrong picker. Asserted on the pairing, not on a
  // particular id string.
  it('gives each telemetry section its own host picker, labelled by its own id', async () => {
    renderReport({ telemetry: TWO_HOSTS });
    await userEvent.click(screen.getByRole('button', { name: 'Connections' }));
    await userEvent.click(screen.getByRole('button', { name: 'Load generators' }));
    const pickers = await Promise.all(
      ['connections', 'load-generators'].map(async (id) => {
        const section = screen.getByTestId(`section-${id}`);
        const select = await within(section).findByLabelText('Load generator');
        const label = within(section).getByText('Load generator', { selector: 'label' });
        return { select: select as HTMLSelectElement, label: label as HTMLLabelElement };
      }),
    );
    const [connections, loadGenerators] = pickers;
    expect(connections!.select).not.toBe(loadGenerators!.select);
    expect(connections!.select.id).not.toBe('');
    expect(connections!.select.id).not.toBe(loadGenerators!.select.id);
    for (const { select, label } of pickers) {
      expect(label.htmlFor).toBe(select.id);
      expect(label.control).toBe(select);
    }
  });

  it('opens the section a URL fragment names', () => {
    renderReport({ url: `/runs/${RUN_ID}/report#load-generators` });
    expect(screen.getByRole('button', { name: 'Load generators' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('withholds every chart on a phone until asked, and fetches nothing for it', async () => {
    vi.mocked(useIsCompact).mockReturnValue(true);
    const seen = renderReport();
    const section = screen.getByTestId('section-requests');
    expect(within(section).queryByTestId('chart-requests-and-responses')).toBeNull();
    expect(within(section).getByRole('button', { name: 'Open the request charts' })).toBeVisible();
    expect(seen.some((u) => u.includes('/series'))).toBe(false);
  });

  /** FOUR WITHHELD NOTICES, FOUR DIFFERENT BUTTONS. Two sections shared "Open
   *  the charts" and the two telemetry ones shared "Open telemetry charts", so a
   *  screen-reader user stepping through a phone's controls met pairs they could
   *  not tell apart. Asserted on the SET, not on four strings: any caller that
   *  reuses another's name collapses the set, whatever the words are. */
  it('gives every withheld chart section a button with its own name', async () => {
    vi.mocked(useIsCompact).mockReturnValue(true);
    renderReport();
    for (const title of ['Virtual users', 'Connections', 'Load generators']) {
      await userEvent.click(screen.getByRole('button', { name: title }));
    }
    const names = screen.getAllByTestId('desktop-only-show').map((b) => b.textContent);
    expect(names, 'the page has four withheld chart sections').toHaveLength(4);
    expect(new Set(names).size).toBe(names.length);
  });

  // Review focus 3: EVERY chart section has its own gate, not just the one that
  // opens first — a phone that opens Virtual users or a telemetry section must
  // be offered the charts, not given them.
  it.each([
    ['virtual-users', 'Virtual users', '/users'],
    ['connections', 'Connections', '/telemetry'],
    ['load-generators', 'Load generators', '/telemetry'],
  ])('keeps %s behind its own desktop-only gate on a phone', async (id, title, path) => {
    vi.mocked(useIsCompact).mockReturnValue(true);
    const seen = renderReport();
    await userEvent.click(screen.getByRole('button', { name: title }));
    expect(within(screen.getByTestId(`section-${id}`)).getByTestId('desktop-only')).toBeVisible();
    expect(seen.some((u) => u.includes(path))).toBe(false);
  });
});

/**
 * ═══ THE REQUESTS SECTION'S GROUP AND REQUEST PICK ═══
 * (docs/superpowers/specs/2026-11-04-report-pickers-design.md, sections 5-7)
 *
 * Every expectation is read off the captured payload: the groups and requests
 * are the reference run's own rows, a group's members are `requestsInGroup`'s,
 * and the narrowed figures are what `narrowStats` and the transforms make of
 * them. The copy the plan pins (the whole-run notes, the unsupported and 409
 * sentences) is asserted verbatim; everything else as a claim.
 */
describe('RunReport — the Requests pickers', () => {
  const STATS = StatsResponseSchema.parse(reference.stats);
  const REQUESTS = STATS.stats.filter((r) => r.scope === 'request' && r.family === 'response_time').map((r) => r.name);
  const GROUPS = STATS.stats.filter((r) => r.scope === 'group' && r.family === 'group_cumulated').map((r) => r.name);
  const ADD_TO_CART = 'Cart/Add To Cart';
  const requests = () => screen.getByTestId('section-requests');
  const groupPicker = () => within(requests()).getByTestId('requests-group-picker');
  const requestPicker = () => within(requests()).getByTestId('requests-request-picker');
  const options = (select: HTMLElement) => [...select.querySelectorAll('option')].map((o) => o.textContent);
  /** The run's own `/<endpoint>` reads — `/series` is not `/errors/series`. */
  const atPath = (seen: readonly string[], endpoint: string) =>
    seen.filter((u) => path(u) === `/v1/runs/${RUN_ID}${endpoint}`);
  /** A chart's data table as [label, ...values], values in their unrounded form. */
  const tableOf = (id: string) =>
    [...screen.getByTestId(`chart-data-${id}`).querySelectorAll('tbody tr')].map((tr) => [
      tr.querySelector('th')?.textContent?.trim(),
      ...[...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-value')),
    ]);
  const rowsOf = (data: ChartData) => data.rows.map((r) => [r.label, ...r.values.map((v) => (v === null ? null : String(v)))]);

  it('draws Group and Request beside Charts | Table', async () => {
    renderReport();
    const bar = within(requests()).getByTestId('requests-bar');
    expect(within(bar).getByRole('group', { name: 'Requests view' })).toBeInTheDocument();
    const group = await within(groupPicker()).findByLabelText('Group');
    expect(bar).toContainElement(group);
    // All groups first, then the run's groups as a reader reads them, then (no group).
    expect(GROUPS).toEqual(['Cart', 'Catalog', 'Catalog/Recommendations']);
    expect(options(group)).toEqual(['All groups', 'Cart', 'Catalog', 'Catalog / Recommendations', '(no group)']);
    // The Request control waits for a group, and says so in text.
    const request = within(requestPicker()).getByLabelText('Request');
    expect(bar).toContainElement(request);
    expect(request).toBeDisabled();
    expect(request).toHaveAccessibleDescription('Pick a group first.');
  });

  it('a group pick reads the group’s series and distribution, never the run’s', async () => {
    const seen = renderReport({ url: `/runs/${RUN_ID}/report?requests-group=Cart` });
    await waitFor(() => expect(atPath(seen, '/distribution')).not.toHaveLength(0));
    await waitFor(() => expect(atPath(seen, '/series')).not.toHaveLength(0));
    const reads = [...atPath(seen, '/series'), ...atPath(seen, '/distribution')].map((u) => new URL(u, 'http://x').searchParams);
    for (const params of reads) {
      expect(params.get('scope')).toBe('request');
      expect(params.get('group')).toBe('Cart');
      expect(params.has('name')).toBe(false);
    }
    expect(within(groupPicker()).getByLabelText('Group')).toHaveValue('Cart');
  });

  // A group pick UNDER A WINDOW reads the window, on both of its reads. The
  // window test above takes no pick and the pick test above takes no window,
  // so handing either group read `null` for the window passed every case in
  // this file (Task 10 review) — the whole run's group figures drawn under a
  // brushed selection. Each read is checked on its own: a distribution that
  // dropped the window while the series kept it is the same defect.
  it('a group pick under a window reads the window on both group reads', async () => {
    const seen = renderReport({
      url: `/runs/${RUN_ID}/report?requests-group=Cart`,
      window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 },
    });
    await waitFor(() => expect(atPath(seen, '/distribution')).not.toHaveLength(0));
    await waitFor(() => expect(atPath(seen, '/series')).not.toHaveLength(0));
    for (const endpoint of ['/series', '/distribution']) {
      for (const url of atPath(seen, endpoint)) {
        const params = new URL(url, 'http://x').searchParams;
        expect(params.get('group'), `${endpoint} is the group read`).toBe('Cart');
        expect(params.get('from'), `${endpoint} carries the window's from`).toBe('10000');
        expect(params.get('to'), `${endpoint} carries the window's to`).toBe('20000');
      }
    }
  });

  it('a request pick reads that request’s series and distribution', async () => {
    const seen = renderReport({
      url: `/runs/${RUN_ID}/report?requests-group=Cart&requests-request=${encodeURIComponent(ADD_TO_CART)}`,
    });
    await waitFor(() => expect(atPath(seen, '/distribution')).not.toHaveLength(0));
    await waitFor(() => expect(atPath(seen, '/series')).not.toHaveLength(0));
    for (const url of [...atPath(seen, '/series'), ...atPath(seen, '/distribution')]) {
      expect(url).toContain('scope=request&name=Cart%2FAdd%20To%20Cart');
      expect(new URL(url, 'http://x').searchParams.has('group')).toBe(false);
    }
  });

  it('ranges and number of requests read the group’s narrowed stats', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?requests-group=Cart` });
    const narrowed = { kind: 'group', name: 'Cart' } as const;
    const stats = narrowStats(STATS, requestsInGroup(REQUESTS, GROUPS, 'Cart'));
    const ranges = rowsOf(toIndicators(stats, { windowSelected: false, narrowed }));
    const counts = rowsOf(toRequestCounts(stats, { windowSelected: false, narrowed }));
    // The group's figures are not the run's, or this proves nothing.
    expect(ranges).not.toEqual(rowsOf(toIndicators(STATS, { windowSelected: false })));
    await waitFor(() => expect(tableOf('indicators')).toEqual(ranges));
    expect(tableOf('request-counts')).toEqual(counts);
  });

  it('names a picked request as the picker lists it', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?requests-group=Cart&requests-request=${encodeURIComponent(ADD_TO_CART)}` });
    const about = await within(requests()).findByRole('button', { name: 'About Response time ranges' });
    expect(about).toHaveAccessibleDescription(/Narrowed to the request Cart \/ Add To Cart\./);
  });

  it('errors per second and responses by status carry their whole-run notes under a pick', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?requests-group=Cart` });
    const notes = await within(requests()).findAllByTestId('whole-run-note');
    expect(notes.map((n) => n.textContent)).toEqual([
      'Shows every request: errors are not recorded per request.',
      'Shows every request: status codes are not recorded per request.',
    ]);
    // Each line sits with the chart it describes, above it.
    expect(notes[0]!.parentElement).toContainElement(within(requests()).getByTestId('chart-errors-over-time'));
    expect(notes[1]!.parentElement).toContainElement(within(requests()).getByTestId('chart-agent-status'));
  });

  it('carries no whole-run note without a pick', async () => {
    renderReport();
    await within(requests()).findByLabelText('Group');
    await waitFor(() => expect(within(requests()).getByTestId('chart-errors-over-time')).toBeInTheDocument());
    expect(within(requests()).queryByTestId('whole-run-note')).toBeNull();
  });

  it('says once that the server cannot narrow by group, and draws no group chart under it', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?requests-group=Cart`, requests: { group: 'no-echo' } });
    const sentence = await within(requests()).findByText('This server cannot narrow by group yet.');
    expect(sentence).toBeVisible();
    expect(within(requests()).getAllByText('This server cannot narrow by group yet.')).toHaveLength(1);
    for (const id of ['requests-and-responses', 'percentiles', 'distribution', 'percentile-distribution']) {
      expect(within(requests()).queryByTestId(`chart-${id}`), id).toBeNull();
    }
    // What the browser narrows itself still draws.
    expect(within(requests()).getByTestId('chart-indicators')).toBeInTheDocument();
  });

  it('says a run’s group figures cannot be merged in each chart they feed', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?requests-group=Cart`, requests: { group: 'not-mergeable' } });
    for (const id of ['requests-and-responses', 'percentiles', 'distribution', 'percentile-distribution']) {
      await waitFor(() =>
        expect(within(within(requests()).getByTestId(`chart-${id}`)).getByRole('status')).toHaveTextContent(
          "This run's group figures cannot be merged: it predates exact statistics.",
        ),
      );
    }
    // The section's words, not the server's.
    expect(requests().textContent).not.toContain('A member has no exact histogram.');
  });

  async function openTable() {
    await userEvent.click(within(requests()).getByRole('button', { name: 'Table' }));
    return within(requests()).findAllByTestId('stat-row');
  }

  it('the Table view lists only a picked request’s own row, with no All Requests row', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?requests-group=Cart&requests-request=${encodeURIComponent(ADD_TO_CART)}` });
    const rows = await openTable();
    expect(rows.map((r) => r.getAttribute('data-path'))).toEqual([ADD_TO_CART]);
    expect(within(requests()).queryByTestId('stat-row-total')).toBeNull();
  });

  it('the Table view lists a picked group’s subtree and nothing above it', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?requests-group=Catalog` });
    // Open on arrival, the subgroup on the path to its one request included
    // (Task 8 review M3), so every row of the subtree is on screen unclicked.
    await openTable();
    const shown = () => within(requests()).getAllByTestId('stat-row').map((r) => r.getAttribute('data-path'));
    await waitFor(() =>
      expect(shown().sort()).toEqual(['Catalog', 'Catalog/Recommendations', ...requestsInGroup(REQUESTS, GROUPS, 'Catalog')].sort()),
    );
    expect(within(requests()).queryByTestId('stat-row-total')).toBeNull();
  });

  /*
   * Task 8 review M3: a group pick's table is that group's subtree, and opened
   * collapsed it was one row — the group — with the members the pick is about
   * a click away. It opens on them, and stays the reader's to close.
   */
  it('the Table view under a Cart pick shows Cart’s request rows without a click', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?requests-group=Cart` });
    const members = requestsInGroup(REQUESTS, GROUPS, 'Cart');
    expect(members.length, 'Cart holds more than one request').toBeGreaterThan(1);
    expect(GROUPS.some((g) => g.startsWith('Cart/')), 'Cart has no subgroup').toBe(false);
    const rows = await openTable();
    expect(rows.map((r) => r.getAttribute('data-path')).sort()).toEqual(['Cart', ...members].sort());
    const toggle = within(requests()).getByRole('button', { name: 'collapse Cart' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Opened, not held open: the reader can still close it.
    await userEvent.click(toggle);
    expect(within(requests()).getAllByTestId('stat-row').map((r) => r.getAttribute('data-path'))).toEqual(['Cart']);
  });

  // The table stays mounted while the reader changes the pick, so a new pick
  // opens its own group too, rather than only the pick the page arrived with.
  it('the Table view opens a group picked after arrival', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?requests-group=Cart` });
    await openTable();
    await userEvent.selectOptions(within(groupPicker()).getByLabelText('Group'), 'Catalog');
    const shown = () => within(requests()).getAllByTestId('stat-row').map((r) => r.getAttribute('data-path'));
    await waitFor(() =>
      expect(shown().sort()).toEqual(['Catalog', 'Catalog/Recommendations', ...requestsInGroup(REQUESTS, GROUPS, 'Catalog')].sort()),
    );
  });

  it('the Table view under a nested group’s one request carries no ancestor row', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?requests-group=${encodeURIComponent('Catalog/Recommendations')}` });
    const rows = await openTable();
    const paths = rows.map((r) => r.getAttribute('data-path'));
    expect(paths).not.toContain('Catalog');
    expect(paths).toEqual(requestsInGroup(REQUESTS, GROUPS, 'Catalog/Recommendations'));
  });

  it('says the pick held nothing in the window, not that no request ran', async () => {
    renderReport({
      url: `/runs/${RUN_ID}/report?requests-group=&requests-request=Search`,
      window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 },
      requests: { windowedStats: { ...reference.stats, stats: reference.stats.stats.filter((s) => s.name !== 'Search') } },
    });
    await userEvent.click(within(requests()).getByRole('button', { name: 'Table' }));
    const empty = await within(requests()).findByText(/Nothing was recorded for this request in the selected window/);
    expect(empty).toBeVisible();
    expect(within(requests()).queryByText(/No requests ran in the selected window/)).toBeNull();
    // A region named by its own heading, as the table it stands in for is.
    expect(within(requests()).getByRole('region', { name: /Statistics/ })).toContainElement(empty);
  });

  it('asks for no figure until /stats has answered', async () => {
    let release!: (value?: unknown) => void;
    const statsGate = new Promise((resolve) => {
      release = resolve;
    });
    const seen = renderReport({ url: `/runs/${RUN_ID}/report?requests-group=Cart`, requests: { statsGate } });
    await waitFor(() => expect(atPath(seen, '/stats')).not.toHaveLength(0));
    // Long enough for any effect the first render scheduled to have fetched.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const figures = () => seen.filter((u) => /\/(series|distribution|errors\/series|agent\/status)$/.test(path(u)));
    expect(figures()).toEqual([]);
    release();
    await waitFor(() => expect(atPath(seen, '/series')).not.toHaveLength(0));
    // And the first figure asked for is the PICK's, never the run's first.
    for (const url of [...atPath(seen, '/series'), ...atPath(seen, '/distribution')]) {
      expect(new URL(url, 'http://x').searchParams.get('group')).toBe('Cart');
    }
  });

  it('shows (no group) read-only and the Request picker usable in a run with no groups', async () => {
    renderReport({ stats: { ...reference.stats, stats: reference.stats.stats.filter((s) => s.scope !== 'group') } });
    const group = groupPicker();
    expect(await within(group).findByText('(no group)')).toBeVisible();
    expect(within(group).queryByRole('combobox')).toBeNull();
    const request = within(requestPicker()).getByLabelText('Request');
    expect(request).toBeEnabled();
    expect(requests().textContent).not.toContain('Pick a group first.');
    expect(options(request)).toEqual(['All requests', ...REQUESTS]);
  });

  // Review M1: "Pick a group first." belongs only where the Group control
  // offers a choice. A run that recorded no request rows has no Group control
  // at all, so a disabled Request control telling the reader to pick from it
  // would point at nothing.
  it('draws no picker, and asks for no group, in a run with no request rows', async () => {
    const seen = renderReport({ stats: { ...reference.stats, stats: reference.stats.stats.filter((s) => s.scope === 'run') } });
    // The figures are asked for only once the names have answered, so this is
    // the state AFTER they arrived — not the first render, where the picker's
    // box exists before anything is known.
    await waitFor(() => expect(atPath(seen, '/series')).not.toHaveLength(0));
    await waitFor(() => expect(atPath(seen, '/distribution')).not.toHaveLength(0));
    expect(within(requests()).queryByRole('combobox')).toBeNull();
    expect(requests().textContent).not.toContain('Pick a group first.');
    for (const url of [...atPath(seen, '/series'), ...atPath(seen, '/distribution')]) {
      const params = new URL(url, 'http://x').searchParams;
      expect(params.get('scope')).toBe('run');
      expect(params.has('group')).toBe(false);
    }
  });

  // `''` is "(no group)", a real group path: an empty value, never a missing
  // one. A truthiness check would read it as All — the run's figures, the
  // run's ranges and the full table under a link for the requests in no group.
  it('a (no group) pick reads group= with an empty value and narrows to the requests in no group', async () => {
    const seen = renderReport({ url: `/runs/${RUN_ID}/report?requests-group=` });
    await waitFor(() => expect(atPath(seen, '/series')).not.toHaveLength(0));
    await waitFor(() => expect(atPath(seen, '/distribution')).not.toHaveLength(0));
    for (const url of [...atPath(seen, '/series'), ...atPath(seen, '/distribution')]) {
      const params = new URL(url, 'http://x').searchParams;
      expect(params.get('scope')).toBe('request');
      expect(params.get('group')).toBe('');
      expect(params.has('name')).toBe(false);
    }
    const members = requestsInGroup(REQUESTS, GROUPS, '');
    expect(members.length).toBeGreaterThan(1);
    const narrowed = { kind: 'group', name: '' } as const;
    const ranges = rowsOf(toIndicators(narrowStats(STATS, members), { windowSelected: false, narrowed }));
    await waitFor(() => expect(tableOf('indicators')).toEqual(ranges));
    const rows = await openTable();
    expect(rows.map((r) => r.getAttribute('data-path')).sort()).toEqual([...members].sort());
    expect(within(requests()).queryByTestId('stat-row-total')).toBeNull();
  });

  /**
   * ═══ THE NAMES COULD NOT BE LOADED (ruling R14) ═══
   *
   * The review's construction: a window, a whole-run `/stats` answering 404
   * and a windowed one answering 200. No pick can be checked, so the figures
   * draw unnarrowed — and the pickers' place says what that means for the link
   * the reader followed. Each case is an exclusive pair: the true claim, and
   * not the other one.
   */
  const namesFail = (url: string) =>
    renderReport({
      url: `/runs/${RUN_ID}/report${url}`,
      window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 },
      stats: null,
      requests: { windowedStats: reference.stats },
    });

  it('says a link’s pick could not be checked when the names fail, and shows every request', async () => {
    const seen = namesFail('?requests-group=Cart');
    const line = await within(requests()).findByTestId('requests-names-unavailable');
    expect(line.textContent).toMatch(/link.*could not be checked/);
    expect(line.textContent).toMatch(/every request/);
    expect(line.textContent).not.toMatch(/unavailable/);
    // Not a live region: it describes the section, nothing that changed.
    expect(line).not.toHaveAttribute('role');
    expect(within(requests()).queryByTestId('requests-group-picker')).toBeNull();
    // What it says is what draws: the run's figures, unnarrowed.
    await waitFor(() => expect(atPath(seen, '/series')).not.toHaveLength(0));
    for (const url of [...atPath(seen, '/series'), ...atPath(seen, '/distribution')]) {
      expect(new URL(url, 'http://x').searchParams.get('scope')).toBe('run');
    }
  });

  it('says the picks are unavailable when the names fail and the link named none', async () => {
    namesFail('');
    const line = await within(requests()).findByTestId('requests-names-unavailable');
    expect(line.textContent).toMatch(/picks are unavailable/);
    expect(line.textContent).toMatch(/request names could not be loaded/);
    expect(line.textContent).not.toMatch(/link/);
    expect(within(requests()).queryByTestId('requests-request-picker')).toBeNull();
  });

  it('draws no names line when the names answer', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?requests-group=Cart` });
    expect(await within(groupPicker()).findByLabelText('Group')).toHaveValue('Cart');
    expect(within(requests()).queryByTestId('requests-names-unavailable')).toBeNull();
  });

  // The pick drives both views, so on a phone it waits behind the same gate as
  // they do — and opening either view opens the pickers with it. UNDER A
  // WINDOW, because only there are the names a read of their own: with none,
  // the table's `/stats` is the names' key, and its fetch would answer a
  // names read the phone never made, hiding a table left waiting on it.
  it('keeps the pickers behind the phone’s gate, and the Table’s offer to open', async () => {
    vi.mocked(useIsCompact).mockReturnValue(true);
    const seen = renderReport({
      url: `/runs/${RUN_ID}/report?requests-group=Cart`,
      window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 },
    });
    await userEvent.click(within(requests()).getByRole('button', { name: 'Table' }));
    const open = await within(requests()).findByRole('button', { name: 'Open detailed table' });
    expect(within(requests()).queryByTestId('requests-group-picker')).toBeNull();
    // Nothing the pickers or the charts would read has been asked for.
    expect(seen.filter(isWholeRunStats)).toHaveLength(0);
    expect(seen.some((u) => /\/(series|distribution)$/.test(path(u)))).toBe(false);
    await userEvent.click(open);
    expect(await within(groupPicker()).findByLabelText('Group')).toHaveValue('Cart');
    const rows = await within(requests()).findAllByTestId('stat-row');
    // Cart's subtree, open on arrival (Task 8 review M3).
    expect(rows.map((r) => r.getAttribute('data-path')).sort()).toEqual(['Cart', ...requestsInGroup(REQUESTS, GROUPS, 'Cart')].sort());
  });

  it('offers a request the selected window holds no traffic for (ruling R13)', async () => {
    renderReport({
      url: `/runs/${RUN_ID}/report?requests-group=`,
      window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 },
      requests: { windowedStats: { ...reference.stats, stats: reference.stats.stats.filter((s) => s.name !== 'Search') } },
    });
    // Waited on as a whole: the control can exist before the names do.
    const members = requestsInGroup(REQUESTS, GROUPS, '');
    expect(members).toContain('Search');
    await waitFor(() => expect(options(within(requestPicker()).getByLabelText('Request'))).toEqual(['All requests', ...members]));
  });
});

/**
 * ═══ GE'S "RESPONSES PER SECOND BY STATUS" ═══
 *
 * A `simulation.log` carries no HTTP status code, so this chart reads the
 * run's agent file (`/agent/status`) and nothing else. For the three ways a
 * run can lack one, the figure stays in its place and says which — never an
 * empty chart, which would read as "measured, and no responses came back".
 * The not-collected sentence is a fact about the run's FILE, not about any
 * window, so a window cannot make it false.
 */
describe('RunReport — Responses per Second by Status', () => {
  // Queried afresh every time: the drawn chart (or its sentence) REPLACES the
  // loading figure under the same id, so a node taken before the read answers
  // is a detached one.
  const statusFigure = () => within(screen.getByTestId('section-requests')).getByTestId('chart-agent-status');

  it('draws one series per status code for a run with an agent file', async () => {
    renderReport({ agent: { summary: AGENT_SUMMARY, status: AGENT_STATUS } });
    // Drawn, not a placeholder: only a drawn chart holds a plotting surface.
    await waitFor(() => expect(statusFigure().querySelector('[data-chart-canvas]')).not.toBeNull());
    expect(within(statusFigure()).getByRole('heading', { name: 'Responses per Second by Status' })).toBeInTheDocument();
    // The data table's columns are the codes the payload carries.
    const columns = [...screen.getByTestId('chart-data-agent-status').querySelectorAll('thead th')].map((th) =>
      th.textContent?.trim(),
    );
    expect(AGENT_STATUS.codes.length).toBeGreaterThan(1);
    for (const code of AGENT_STATUS.codes) expect(columns).toContain(code);
  });

  it('says the run carries no status codes when it has no agent file', async () => {
    renderReport();
    await waitFor(() =>
      expect(within(statusFigure()).getByRole('status')).toHaveTextContent(
        'This run carries no HTTP status codes: it has no agent file.',
      ),
    );
    expect(statusFigure().querySelector('[data-chart-canvas]')).toBeNull();
  });

  it.each([
    ['unreadable', 'checksum mismatch'],
    ['http_not_collected', 'disabled by -Dperfportal.agent.http=false'],
  ] as const)('says why for %s, in the stored reason’s own words, never as a missing file', async (reason, detail) => {
    renderReport({ agent: { status: statusUnavailable(reason, detail) } });
    await waitFor(() => expect(within(statusFigure()).getByRole('status')).toHaveTextContent(detail));
    expect(statusFigure().textContent).not.toMatch(/no agent file/);
  });
});

/**
 * ═══ THREE AGENT SECTIONS OPEN TOGETHER, AND EACH SAYS WHICH IT IS ═══
 *
 * Connections, DNS and Load generators draw through one gate, which used to
 * print "Loading this run's agent figures…" in each — three identical lines
 * on one page, and three identical alerts when the summary failed, so a
 * reader could not tell which section a line belonged to. Asserted on the
 * SET, not on three strings: any section that reuses another's line
 * collapses it.
 */
describe('RunReport — the agent sections', () => {
  const AGENT_SECTIONS = [
    ['connections', 'Connections'],
    ['dns', 'DNS'],
    ['load-generators', 'Load generators'],
  ] as const;

  async function openAll() {
    for (const [, title] of AGENT_SECTIONS) await userEvent.click(screen.getByRole('button', { name: title }));
  }

  it('never prints the same loading line twice', async () => {
    renderReport({ agent: { summary: 'hold' } });
    await openAll();
    const lines = await Promise.all(
      AGENT_SECTIONS.map(async ([id]) => (await within(screen.getByTestId(`section-${id}`)).findByRole('status')).textContent),
    );
    expect(lines).toHaveLength(3);
    expect(new Set(lines).size).toBe(3);
  });

  it('never prints the same failure twice', async () => {
    renderReport({ agent: { summary: null } });
    await openAll();
    const alerts = await Promise.all(
      AGENT_SECTIONS.map(async ([id]) => (await within(screen.getByTestId(`section-${id}`)).findByRole('alert')).textContent),
    );
    expect(new Set(alerts).size).toBe(3);
  });

  it('serves all three open sections from ONE summary read', async () => {
    const seen = renderReport({ agent: { summary: AGENT_SUMMARY } });
    await openAll();
    const paths = () => seen.map((u) => new URL(u, 'http://x').pathname);
    // Each section has asked for its own figures, so each has read the summary first.
    await waitFor(() => {
      for (const figures of ['/agent/connections', '/agent/dns', '/agent/injectors']) {
        expect(paths().some((p) => p.endsWith(figures)), figures).toBe(true);
      }
    });
    expect(paths().filter((p) => p.endsWith('/agent'))).toHaveLength(1);
  });

  it('mounts DNS under its own id, and opens it from a URL fragment', () => {
    renderReport({ url: `/runs/${RUN_ID}/report#dns` });
    expect(within(screen.getByTestId('section-dns')).getByRole('button', { name: 'DNS' })).toHaveAttribute('aria-expanded', 'true');
  });
});


/**
 * ═══ VIRTUAL USERS NARROWS TO A SCENARIO ═══
 * (docs/superpowers/specs/2026-11-04-report-pickers-design.md, sections 1 and 5)
 *
 * No new request: `/users` already carries one series per scenario, and the
 * browser narrows the payload it holds (`narrowUsers`). Every expectation is
 * read off the captured payload through the same transforms the charts use,
 * and each case pins a claim rather than wording, except the control's own
 * label and "All scenarios", which the plan names.
 *
 * The scenarios a reader may pick come from the WHOLE-RUN `/users`, never the
 * window's: the API's windowed body holds only the scenarios with a bucket
 * inside the range, so under a brush a scenario that had not started yet would
 * leave the picker, and a link for it would be named as never recorded — false
 * (the R13 lesson, one section over).
 */
describe('RunReport — the Virtual users scenario pick', () => {
  const USERS: UsersResponse = UsersResponseSchema.parse(reference.users);
  const SCENARIOS = USERS.scenarios.map((s) => s.scenario);
  const BROWSE = { kind: 'scenario', name: 'Browse' } as const;
  const section = () => screen.getByTestId('section-virtual-users');
  const picker = () => within(section()).getByTestId('users-scenario-picker');
  /** The picker's box exists only once it draws something (review M1), so a
   *  case reading it before the scenarios answer waits for it. */
  const findPicker = () => within(section()).findByTestId('users-scenario-picker');
  const options = (select: HTMLElement) => [...select.querySelectorAll('option')].map((o) => o.textContent);
  const atPath = (seen: readonly string[], endpoint: string) =>
    seen.filter((u) => path(u) === `/v1/runs/${RUN_ID}${endpoint}`);
  const tableOf = (id: string) =>
    [...screen.getByTestId(`chart-data-${id}`).querySelectorAll('tbody tr')].map((tr) => [
      tr.querySelector('th')?.textContent?.trim(),
      ...[...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-value')),
    ]);
  const headersOf = (id: string) =>
    [...screen.getByTestId(`chart-data-${id}`).querySelectorAll('thead th')].map((th) => th.textContent?.trim());
  const rowsOf = (data: ChartData) => data.rows.map((r) => [r.label, ...r.values.map((v) => (v === null ? null : String(v)))]);
  /** The three users charts, each with the transform that draws it. */
  const CHARTS = [
    ['user-start-rate', toUserStartRate],
    ['user-end-rate', toUserEndRate],
    ['concurrent-users', toConcurrentUsers],
  ] as const;

  /**
   * `/users` under a window, built as the API builds it: the buckets whose
   * start falls in `[fromMs, toMs)`, and only the scenarios that kept one.
   */
  function windowUsers(users: UsersResponse, fromMs: number, toMs: number): UsersResponse {
    const inRange = (offset: number) => offset >= fromMs && offset < toMs;
    return {
      ...users,
      window: { fromMs, toMs, bucketWidthMs: 1_000 },
      scenarios: users.scenarios
        .map((s) => ({ ...s, buckets: s.buckets.filter((b) => inRange(b.startOffsetMs)) }))
        .filter((s) => s.buckets.length > 0),
      total: users.total.filter((b) => inRange(b.startOffsetMs)),
    };
  }

  it('draws Scenario with All scenarios, Browse and Checkout', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report#virtual-users` });
    expect(SCENARIOS).toEqual(['Browse', 'Checkout']);
    const select = await within(await findPicker()).findByLabelText('Scenario');
    expect(options(select)).toEqual(['All scenarios', ...SCENARIOS]);
    expect(select).toHaveValue('*');
    // No pick, no narrowing: the run's own users, total included.
    await waitFor(() =>
      expect(tableOf('concurrent-users')).toEqual(rowsOf(toConcurrentUsers(USERS, { x: 'ms', windowSelected: false }))),
    );
  });

  /**
   * `narrowUsers` makes the scenario's buckets the total, and the charts drop
   * the "All users" line ONLY when told the pick (Task 6, keyed on
   * `narrowed.kind`). So both halves are pinned here: un-narrowed data under a
   * pick draws two scenario lines, and narrowed data with no pick draws a
   * second line named "All users" over Browse's.
   */
  it('a scenario pick draws only that scenario’s users', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?users-scenario=Browse#virtual-users` });
    const narrowed = narrowUsers(USERS, 'Browse');
    for (const [id, transform] of CHARTS) {
      const expected = rowsOf(transform(narrowed, { x: 'ms', windowSelected: false, narrowed: BROWSE }));
      // Browse's figures are not the run's, or this proves nothing.
      expect(expected, id).not.toEqual(rowsOf(transform(USERS, { x: 'ms', windowSelected: false })));
      await waitFor(() => expect(tableOf(id), id).toEqual(expected));
      expect(headersOf(id).slice(1), id).toEqual(['Browse']);
    }
    expect(within(picker()).getByLabelText('Scenario')).toHaveValue('Browse');
    expect(within(section()).queryByTestId('users-names-unavailable')).toBeNull();
  });

  it('a scenario pick names the scenario behind each chart’s ⓘ', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?users-scenario=Browse#virtual-users` });
    for (const title of ['Users started per second', 'Users ended per second', 'Concurrent users over time']) {
      const about = await within(section()).findByRole('button', { name: `About ${title}` });
      expect(about, title).toHaveAccessibleDescription(/Narrowed to the scenario Browse\./);
    }
  });

  it('one scenario shows a read-only Scenario field', async () => {
    const one = narrowUsers(USERS, 'Browse');
    renderReport({ url: `/runs/${RUN_ID}/report#virtual-users`, users: { body: one } });
    const field = await findPicker();
    expect(await within(field).findByText('Browse')).toBeVisible();
    expect(within(field).getByText('Scenario')).toBeVisible();
    expect(within(section()).queryByRole('combobox')).toBeNull();
  });

  /*
   * Review M1: the picker's box is drawn only when it draws something. Empty,
   * it is still a child of the section's column, and the column's gap stands
   * 16 px above the grid — while the scenarios load, and for good in a run
   * that recorded none. Each state below is waited into first, so the absence
   * is a claim about it rather than about a first render.
   */
  it('draws no picker box while the scenarios are loading', async () => {
    let release!: (value?: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const seen = renderReport({ url: `/runs/${RUN_ID}/report#virtual-users`, users: { gate } });
    await waitFor(() => expect(seen.filter(isWholeRunUsers)).not.toHaveLength(0));
    expect(within(section()).getByTestId('chart-concurrent-users')).toHaveTextContent('Loading…');
    expect(within(section()).queryByTestId('users-scenario-picker')).toBeNull();
    release();
    // And drawn once there are scenarios to offer.
    expect(within(await findPicker()).getByLabelText('Scenario')).toBeInTheDocument();
  });

  it('draws no picker box for a run that recorded no scenarios', async () => {
    const none: UsersResponse = { ...USERS, scenarios: [], total: [] };
    renderReport({ url: `/runs/${RUN_ID}/report#virtual-users`, users: { body: none } });
    const empty = toConcurrentUsers(none, { x: 'ms', windowSelected: false }).empty;
    expect(empty, 'a run with no scenarios has an empty-chart sentence').toBeTruthy();
    // Settled: a chart can say the run had no user activity only once the
    // scenarios have answered.
    await waitFor(() =>
      expect(within(within(section()).getByTestId('chart-concurrent-users')).getByRole('status')).toHaveTextContent(empty!),
    );
    expect(within(section()).queryByTestId('users-scenario-picker')).toBeNull();
    expect(within(section()).queryByTestId('users-names-unavailable')).toBeNull();
  });

  it('the pick is written as users-scenario=Browse with #virtual-users', async () => {
    renderReport({
      url: `/runs/${RUN_ID}/report?from=10000&to=20000#virtual-users`,
      window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 },
    });
    const select = await within(await findPicker()).findByLabelText('Scenario');
    await waitFor(() => expect(options(select)).toEqual(['All scenarios', ...SCENARIOS]));
    await userEvent.selectOptions(select, 'Browse');
    const written = new URLSearchParams(lastLocation!.search);
    expect(written.get('users-scenario')).toBe('Browse');
    // Every other parameter kept: the window above all.
    expect(written.get('from')).toBe('10000');
    expect(written.get('to')).toBe('20000');
    expect(lastLocation!.hash).toBe('#virtual-users');
    expect(within(picker()).getByLabelText('Scenario')).toHaveValue('Browse');

    // "All" deletes the key rather than writing a filter that does not filter.
    await userEvent.selectOptions(within(picker()).getByLabelText('Scenario'), '*');
    expect(new URLSearchParams(lastLocation!.search).has('users-scenario')).toBe(false);
    expect(lastLocation!.hash).toBe('#virtual-users');
  });

  it('a link naming a scenario the run lacks reads as All, and says so', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?users-scenario=Nope#virtual-users` });
    const note = await within(await findPicker()).findByTestId('filter-unknown');
    expect(note.textContent).toContain('Nope');
    expect(note.textContent).toMatch(/never/);
    expect(note.textContent).toMatch(/all scenarios/);
    expect(within(picker()).getByLabelText('Scenario')).toHaveValue('*');
    // What it says is what draws: every scenario, and the run's total.
    await waitFor(() =>
      expect(tableOf('concurrent-users')).toEqual(rowsOf(toConcurrentUsers(USERS, { x: 'ms', windowSelected: false }))),
    );
  });

  /** A window before Checkout's first arrival: the API's windowed body has Browse alone. */
  const EARLY = { fromMs: 0, toMs: 5_000, bucketWidthMs: 1_000 };

  it('offers a scenario the selected window holds no users for', async () => {
    const windowed = windowUsers(USERS, EARLY.fromMs, EARLY.toMs);
    expect(windowed.scenarios.map((s) => s.scenario), 'the window drops Checkout').toEqual(['Browse']);
    renderReport({ url: `/runs/${RUN_ID}/report#virtual-users`, window: EARLY, users: { windowed } });
    // Waited on as a whole: the control can exist before the names do.
    await waitFor(() => expect(options(within(picker()).getByLabelText('Scenario'))).toEqual(['All scenarios', ...SCENARIOS]));
  });

  it('a pick of a scenario the window holds nothing for says so for this scenario, and names nothing', async () => {
    const windowed = windowUsers(USERS, EARLY.fromMs, EARLY.toMs);
    const seen = renderReport({
      url: `/runs/${RUN_ID}/report?users-scenario=Checkout#virtual-users`,
      window: EARLY,
      users: { windowed },
    });
    const checkout = { kind: 'scenario', name: 'Checkout' } as const;
    const empty = toConcurrentUsers(narrowUsers(windowed, 'Checkout'), { x: 'ms', windowSelected: true, narrowed: checkout }).empty;
    expect(empty).toMatch(/for this scenario in the selected window/);
    await waitFor(() =>
      expect(within(within(section()).getByTestId('chart-concurrent-users')).getByRole('status')).toHaveTextContent(empty!),
    );
    expect(within(picker()).getByLabelText('Scenario')).toHaveValue('Checkout');
    expect(within(section()).queryByTestId('filter-unknown')).toBeNull();
    // The charts read the window; only the scenario list is whole-run.
    expect(atPath(seen, '/users').some((u) => /[?&]from=0/.test(u))).toBe(true);
  });

  /**
   * Until the run's scenarios are known no chart is drawn: under a window the
   * figures' read can answer first, and drawing it then would put every
   * scenario on screen under a link for one, to be replaced a moment later.
   */
  it('draws no users chart until the run’s scenarios are known', async () => {
    let release!: (value?: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let answered!: () => void;
    const windowedAnswered = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const window = { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 };
    renderReport({
      url: `/runs/${RUN_ID}/report?users-scenario=Browse#virtual-users`,
      window,
      users: { gate, onWindowed: () => answered() },
    });
    // Waited on, never timed (review M2): the stub has answered the charts'
    // windowed read, and the page's cache holds that answer — the moment an
    // early draw would put every scenario on screen.
    await windowedAnswered;
    await waitFor(() => expect(lastClient!.getQueryState(usersQueryKey(RUN_ID, window))?.status).toBe('success'));
    // TanStack tells its observers on a zero-delay timer queued as the answer
    // landed; one more, queued after it, runs once they have been told, and
    // `act` renders what they were told before anything is read.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The figure stands in its place saying it is loading, with no row drawn.
    expect(within(section()).getByTestId('chart-concurrent-users')).toHaveTextContent('Loading…');
    expect(tableOf('concurrent-users')).toEqual([]);
    release();
    const expected = rowsOf(toConcurrentUsers(narrowUsers(USERS, 'Browse'), { x: 'ms', windowSelected: true, narrowed: BROWSE }));
    await waitFor(() => expect(tableOf('concurrent-users')).toEqual(expected));
  });

  /**
   * ═══ THE SCENARIOS COULD NOT BE LOADED ═══
   *
   * Ruling R14's construction, for this section: a window, a whole-run
   * `/users` answering 404 and a windowed one answering 200. No pick can be
   * checked, so the charts draw unnarrowed, and the picker's place says what
   * that means for the link the reader followed.
   */
  const namesFail = (search: string) =>
    renderReport({
      url: `/runs/${RUN_ID}/report${search}#virtual-users`,
      window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 },
      users: { body: null, windowed: USERS },
    });

  it('says a link’s scenario could not be checked when the scenarios fail, and narrows nothing', async () => {
    namesFail('?users-scenario=Browse');
    const line = await within(section()).findByTestId('users-names-unavailable');
    expect(line.textContent).toMatch(/link.*could not be checked/);
    expect(line.textContent).toMatch(/not narrowed/);
    expect(line.textContent).not.toMatch(/unavailable/);
    expect(line).not.toHaveAttribute('role');
    expect(within(section()).queryByTestId('users-scenario-picker')).toBeNull();
    // What it says is what draws: every scenario, and the total.
    await waitFor(() =>
      expect(tableOf('concurrent-users')).toEqual(rowsOf(toConcurrentUsers(USERS, { x: 'ms', windowSelected: true }))),
    );
  });

  it('says the scenario pick is unavailable when the scenarios fail and the link named none', async () => {
    namesFail('');
    const line = await within(section()).findByTestId('users-names-unavailable');
    expect(line.textContent).toMatch(/pick is unavailable/);
    expect(line.textContent).toMatch(/scenarios could not be loaded/);
    expect(line.textContent).not.toMatch(/link/);
  });

  /*
   * Review M3. With NO window the scenario list IS the charts' read — one key,
   * one request — so when it fails there is nothing unnarrowed to draw either.
   * That state is what the line's wording rests on: it says only that the
   * charts are not narrowed to the link's scenario, never that every scenario
   * is shown (ruling R14's words, false here), and each chart says, in its
   * own place, that its data could not be loaded.
   */
  it('with no window, a failed scenario list draws the line and each chart’s own error, and no figure', async () => {
    renderReport({ url: `/runs/${RUN_ID}/report?users-scenario=Browse#virtual-users`, users: { body: null } });
    const line = await within(section()).findByTestId('users-names-unavailable');
    expect(line.textContent).toMatch(/link.*could not be checked/);
    expect(line.textContent).toMatch(/not narrowed/);
    expect(line.textContent).not.toMatch(/every scenario/);
    expect(within(section()).queryByTestId('users-scenario-picker')).toBeNull();
    const failed = explain(new ProblemError(404, USERS_NOT_FOUND), 'chart');
    for (const [id] of CHARTS) {
      const status = within(within(section()).getByTestId(`chart-${id}`)).getByRole('status');
      expect(status, id).toHaveTextContent(failed);
      expect(status, id).not.toHaveTextContent('Loading…');
      expect(tableOf(id), id).toEqual([]);
    }
  });

  // UNDER A WINDOW, because only there is the scenario list a read of its own:
  // with none it is the charts' own `/users`, one key and one request.
  it('keeps the picker behind the phone’s gate, and fetches nothing for it', async () => {
    vi.mocked(useIsCompact).mockReturnValue(true);
    const seen = renderReport({
      url: `/runs/${RUN_ID}/report?users-scenario=Browse#virtual-users`,
      window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 },
    });
    const open = within(section()).getByRole('button', { name: 'Open the virtual-user charts' });
    expect(within(section()).queryByTestId('users-scenario-picker')).toBeNull();
    expect(atPath(seen, '/users')).toEqual([]);
    await userEvent.click(open);
    expect(await within(await findPicker()).findByLabelText('Scenario')).toHaveValue('Browse');
  });
});
