// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResponse } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import { runQueryKey } from '../src/api/run';
import RunReport from '../src/routes/RunReport';
import type { RunWindowContext } from '../src/routes/useRunWindow';
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

function readyRun(): RunResponse {
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

/** Answers each endpoint from the captured fixture; anything else is a 404,
 *  which `Payload` renders as an undrawn slot — still a figure with its id. */
function stubFetch(statsBody: unknown = reference.stats, telemetryBody: unknown = NO_TELEMETRY): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const path = new URL(url, 'http://x').pathname;
    const body = path.endsWith('/users')
      ? reference.users
      : path.endsWith('/series')
        ? reference.series
        : path.endsWith('/distribution')
          ? reference.distribution
          : path.endsWith('/stats')
            ? statsBody
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
}: {
  url?: string;
  window?: RunWindowContext['window'];
  /** What `/stats` answers; `null` for a 404. Defaults to the reference run's. */
  stats?: unknown;
  /** What `/telemetry` answers; defaults to no agent having reported. */
  telemetry?: unknown;
} = {}) {
  const seen = stubFetch(stats, telemetry);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runQueryKey(RUN_ID), { state: 'ready', run: readyRun() });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/runs/:runId"
            element={<Outlet context={{ window, durationMs: 63161, liveDurationMs: null, warmupMs: null, live: null } satisfies RunWindowContext} />}
          >
            <Route path="report" element={<RunReport />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return seen;
}

const SECTIONS = ['Requests', 'Groups', 'Virtual users', 'Connections', 'Load generators'];

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

  it('narrows every Requests query to the window', async () => {
    const seen = renderReport({ window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 } });
    await screen.findByTestId('chart-requests-and-responses');
    const metric = seen.filter((u) => /\/(series|stats|distribution|errors\/series)/.test(u));
    expect(metric.length).toBeGreaterThan(3);
    for (const url of metric) expect(url).toMatch(/[?&]from=10000/);
  });

  // The test above reads the Charts view only. Every OTHER consumer reaches the
  // window by its own call — the table, the groups list, the users charts and
  // the telemetry sections — and a section that forgot it would draw the whole
  // run under a window the reader selected, so each one is opened.
  it('narrows the table, the groups, the users and the telemetry to the window too', async () => {
    const seen = renderReport({ window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 } });
    await screen.findByTestId('chart-requests-and-responses');
    await userEvent.click(within(screen.getByTestId('section-requests')).getByRole('button', { name: 'Table' }));
    for (const title of ['Groups', 'Virtual users', 'Connections']) {
      await userEvent.click(screen.getByRole('button', { name: title }));
    }
    await waitFor(() => expect(seen.some((u) => u.includes('/telemetry'))).toBe(true));
    await waitFor(() => expect(seen.some((u) => u.includes('/users'))).toBe(true));

    const kinds = ['/series', '/stats', '/distribution', '/errors/series', '/users', '/telemetry'];
    const metric = seen.filter((u) => kinds.some((k) => new URL(u, 'http://x').pathname.endsWith(k)));
    // Every kind really was asked for, or the loop below proves less than it says.
    for (const kind of kinds) expect(metric.some((u) => new URL(u, 'http://x').pathname.endsWith(kind)), kind).toBe(true);
    for (const url of metric) expect(url).toMatch(/[?&]from=10000/);
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
    expect(within(section).getByRole('button', { name: /open the charts/i })).toBeVisible();
    expect(seen.some((u) => u.includes('/series'))).toBe(false);
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
