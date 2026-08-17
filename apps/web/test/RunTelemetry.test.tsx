import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryResponse } from '@perfportal/contracts';
import RunTelemetry from '../src/routes/RunTelemetry';
import type { RunWindowContext } from '../src/routes/useRunWindow';

/**
 * `RunTelemetry` reads its window through `useOutletContext` (`useRunWindow.ts`
 * — "the window travels down, it is not re-parsed per tab"), so it has to be
 * mounted under something that provides one, the way `RunShell`'s real
 * `<Outlet context={{ window }} />` does. This stands in for that shell with
 * the one value every test here needs: no window selected.
 */
function renderRunTelemetry(response: TelemetryResponse) {
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    const url = String(input);
    if (url.includes('/telemetry')) {
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 500 }));
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN}/load-generators`]}>
        <Routes>
          <Route
            path="/runs/:runId"
            element={<Outlet context={{ window: null, durationMs: null } satisfies RunWindowContext} />}
          >
            <Route path="load-generators" element={<RunTelemetry />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// No global setup runs `afterEach(cleanup)` for us (see StatisticsTable.test.tsx)
// — without it, a leftover tree from an earlier render collides with the next.
afterEach(cleanup);

const RUN = 'a66548b7-2962-43ff-8b93-7149a6f2a1b8';

type Point = TelemetryResponse['hosts'][number]['points'][number];

function point(overrides: Partial<Point> = {}): Point {
  return {
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
    ...overrides,
  };
}

function host(name: string, clockSkewMs: number, cpuTotalPct: number): TelemetryResponse['hosts'][number] {
  return { host: name, clockSkewMs, points: [point({ cpuTotalPct })] };
}

/**
 * `chart-data-telemetry-cpu`'s wrapper `<div>` exists in BOTH states this
 * page can be in — `Payload`'s own loading branch renders `Undrawn`, which
 * carries the same testid with an empty table — so `findByTestId` alone
 * settles on the FIRST render and proves nothing about which state that was.
 * Waiting for the one real value only the resolved chart draws is what
 * actually waits for the fetch.
 */
async function waitForResolvedCpu(expectedValue: number) {
  await waitFor(() => {
    expect(screen.getByTestId('chart-data-telemetry-cpu')).toHaveTextContent(String(expectedValue));
  });
}

describe('RunTelemetry', () => {
  it('renders the empty state and no figure when the agent never reported', async () => {
    renderRunTelemetry({
      runId: RUN,
      available: false,
      bucketWidthMs: 1000,
      window: null,
      hosts: [],
    });

    // The exact phrase Task 11's e2e suite matches — see RunTelemetry.tsx.
    expect(await screen.findByText(/no telemetry was recorded for this run/i)).toBeInTheDocument();

    // Not a chart with nothing in it: NO figure on the page at all, which is
    // the whole reason `available: false` gets a dedicated branch rather than
    // six charts each explaining themselves.
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
  });

  it('renders a "Load generator" combobox for two hosts, defaulting to the first', async () => {
    renderRunTelemetry({
      runId: RUN,
      available: true,
      bucketWidthMs: 1000,
      window: null,
      hosts: [host('gen-1', 0, 11), host('gen-2', 0, 99)],
    });

    await screen.findByRole('combobox', { name: /load generator/i });

    const cpuTable = screen.getByTestId('chart-data-telemetry-cpu');
    expect(cpuTable).toHaveTextContent('11');
    expect(cpuTable).not.toHaveTextContent('99');
  });

  it('switches every chart to the second host once it is selected', async () => {
    const user = userEvent.setup();
    renderRunTelemetry({
      runId: RUN,
      available: true,
      bucketWidthMs: 1000,
      window: null,
      hosts: [host('gen-1', 0, 11), host('gen-2', 0, 99)],
    });

    const select = await screen.findByRole('combobox', { name: /load generator/i });
    await user.selectOptions(select, 'gen-2');

    const cpuTable = screen.getByTestId('chart-data-telemetry-cpu');
    expect(cpuTable).toHaveTextContent('99');
    expect(cpuTable).not.toHaveTextContent('11');
  });

  it('hides the host select when there is exactly one load generator', async () => {
    renderRunTelemetry({
      runId: RUN,
      available: true,
      bucketWidthMs: 1000,
      window: null,
      hosts: [host('gen-1', 0, 10)],
    });

    await waitForResolvedCpu(10);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('warns past the clock-skew threshold, naming the generator behind the server', async () => {
    // Positive: the docstring's "behind" branch. `CLOCK_SKEW_WARN_MS` is
    // 5_000; this is comfortably past it.
    renderRunTelemetry({
      runId: RUN,
      available: true,
      bucketWidthMs: 1000,
      window: null,
      hosts: [host('gen-1', 6_000, 10)],
    });

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/gen-1/);
    expect(banner).toHaveTextContent(/behind/i);
  });

  it('warns of a large NEGATIVE skew as the generator being ahead of the server', async () => {
    renderRunTelemetry({
      runId: RUN,
      available: true,
      bucketWidthMs: 1000,
      window: null,
      hosts: [host('gen-1', -6_000, 10)],
    });

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/ahead of/i);
  });

  it('says nothing for a skew under the threshold', async () => {
    renderRunTelemetry({
      runId: RUN,
      available: true,
      bucketWidthMs: 1000,
      window: null,
      hosts: [host('gen-1', 200, 10)],
    });

    // Wait for the chart data to land before asserting an absence, so this
    // is not passing because the fetch simply had not resolved yet — every
    // chart's OWN loading placeholder also carries `role="status"`
    // ("Loading…"), so a query taken before resolution would find those
    // instead and pass for the wrong reason.
    await waitForResolvedCpu(10);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
