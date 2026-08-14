import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Chart from '../src/charts/Chart.js';
import { CATEGORICAL } from '../src/charts/theme.js';
import type { ChartData } from '../src/charts/types.js';

/**
 * `Chart`'s behaviour that never reaches ECharts.
 *
 * The design (§8) is right that what ECharts DRAWS must not be asserted in
 * jsdom: `getBoundingClientRect` returns zeros there, the chart lays out at
 * 0×0, and an assertion about a mark is theatre. That argument does not cover
 * three requirements which are plain React and are decided before the renderer
 * is ever involved:
 *
 *   - the `data.empty` branch, which returns an EXPLANATION and never
 *     constructs an instance at all — the global constraint "a chart with no
 *     data shows an explanation, not empty axes";
 *   - the data table, rendered unconditionally, which is the parity surface and
 *     which Task 10's e2e suite counts one of per chart;
 *   - the stated limitation when a chart is handed more series than the palette
 *     has hues (A3), which was asserted at the `assignPalette` level but never
 *     at the rendered one.
 *
 * The failure this closes is specific and likely: a later task refactors the
 * empty branch to render the container with zero series so it can reuse the
 * axis config. The chart then shows empty axes — the thing the constraint
 * forbids — the unit suite stays green, and it surfaces five tasks later in a
 * browser.
 *
 * THE BOUNDARY THIS FILE KEEPS: `echarts` is mocked, so these tests assert
 * what the component HANDS the renderer and never what the renderer did with
 * it. Everything past that line — that a series was drawn, that the crosshair
 * moved, that the log axis is legible — is Task 10's, in a real browser.
 */

const { initSpy, connectSpy, setOptionSpy, disposeSpy, resizeSpy } = vi.hoisted(() => ({
  initSpy: vi.fn(),
  connectSpy: vi.fn(),
  setOptionSpy: vi.fn(),
  disposeSpy: vi.fn(),
  resizeSpy: vi.fn(),
}));

vi.mock('../src/charts/echarts.js', () => ({
  echarts: {
    init: initSpy,
    connect: connectSpy,
  },
}));

/** The last option object the component handed to `setOption`. */
function lastOption(): Record<string, unknown> {
  expect(setOptionSpy.mock.calls.length).toBeGreaterThan(0);
  return setOptionSpy.mock.calls.at(-1)![0] as Record<string, unknown>;
}

function seriesData(names: readonly string[]): ChartData {
  return {
    series: names.map((name) => ({ name, data: [1, 2, 3] })),
    axisLabels: [0, 1000, 2000],
    columns: ['Time', ...names],
    rows: [{ label: '0', values: names.map(() => 1) }],
  };
}

beforeEach(() => {
  initSpy.mockReset();
  connectSpy.mockReset();
  setOptionSpy.mockReset();
  disposeSpy.mockReset();
  resizeSpy.mockReset();
  initSpy.mockImplementation(() => ({
    // `group` is ASSIGNED by the component before connect, so the stub must
    // tolerate the write.
    group: undefined as string | undefined,
    setOption: setOptionSpy,
    dispose: disposeSpy,
    resize: resizeSpy,
  }));
});

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--chart-1');
});

describe('Chart — the empty state', () => {
  const empty: ChartData = {
    series: [],
    axisLabels: [],
    columns: ['Time', 'Value'],
    rows: [],
    empty: 'This run is still processing, so no requests have been recorded yet.',
  };

  it('renders the explanation instead of a chart, and builds no instance at all', () => {
    render(<Chart id="none" title="Requests per second" data={empty} />);

    expect(screen.getByText(/still processing/i)).toBeVisible();
    // The constraint is "an explanation, NOT empty axes". A chart constructed
    // with zero series would satisfy a test that only looked for the text.
    expect(initSpy).not.toHaveBeenCalled();
    expect(setOptionSpy).not.toHaveBeenCalled();
  });

  it('still renders its data table, because every chart on the page has one', () => {
    render(<Chart id="none" title="Requests per second" data={empty} />);
    // Task 10 asserts exactly one `chart-data-<id>` per chart, and a pending
    // run has no series at all — so the empty chart must still ship the table.
    expect(screen.getByTestId('chart-data-none')).toBeInTheDocument();
  });
});

describe('Chart — the data table is always present', () => {
  it('carries the plotted values whether or not anything was drawn', () => {
    render(<Chart id="rate" title="Requests per second" data={seriesData(['All'])} />);

    const table = screen.getByTestId('chart-data-rate');
    expect(table).toBeInTheDocument();
    expect(table).not.toBeVisible();
    expect(table.textContent).toContain('1');
    // And the drawing was attempted, so this is not the empty branch.
    expect(initSpy).toHaveBeenCalledTimes(1);
  });
});

describe('Chart — more series than the palette has hues (A3)', () => {
  const seven = ['Browse', 'Checkout', 'Search', 'Cart', 'Pay', 'Confirm', 'Logout'];

  it('states the limitation in the rendered figure, naming what was left out', () => {
    render(<Chart id="users" title="Concurrent users" data={seriesData(seven)} />);

    // Asserted at the RENDERED level. `assignPalette` returning the right
    // string is not the same as the reader being told.
    //
    // Matched on the limitation sentence, then read for the name: 'Logout' on
    // its own also matches the data table's column header, which is a
    // different (and much weaker) fact — the table lists every series whether
    // or not the chart says anything about them.
    const limitation = screen.getByText(/not drawn/i);
    expect(limitation).toBeVisible();
    expect(limitation.textContent).toContain('Logout');
    expect(limitation.textContent).toMatch(/first 6 of 7/i);
  });

  it('hands ECharts six colours, all distinct — never a seventh that repeats one', () => {
    render(<Chart id="users" title="Concurrent users" data={seriesData(seven)} />);

    const colors = lastOption().color as string[];
    expect(colors).toHaveLength(6);
    expect(new Set(colors).size).toBe(6);
    expect((lastOption().series as unknown[]).length).toBe(6);
  });

  /**
   * A series marked `essential` survives the cut, and — the part that is easy
   * to get wrong — is drawn against ITS OWN numbers.
   *
   * `assignPalette` returns the drawn series in declaration order, but with one
   * of the earlier ones missing, so the sixth drawn entry is the seventh
   * series. A component pairing colours to data by position in that list draws
   * the total's line using the sixth scenario's values: right name, right
   * colour, wrong numbers, and nothing about the chart says so. The per-series
   * data below is what distinguishes the two.
   */
  it('draws an essential series in place of an earlier one, with its own data', () => {
    const names = [...seven];
    const data: ChartData = {
      ...seriesData(names),
      series: names.map((name, i) => ({
        name,
        data: [i, i, i],
        essential: name === 'Logout',
      })),
    };

    render(<Chart id="users" title="Concurrent users" data={data} />);

    const drawn = lastOption().series as { name: string; data: number[] }[];
    expect(drawn.map((s) => s.name)).toEqual([
      'Browse',
      'Checkout',
      'Search',
      'Cart',
      'Pay',
      'Logout',
    ]);
    // 6 is Logout's own index; 5 would be Confirm's data under Logout's name.
    expect(drawn.at(-1)!.data).toEqual([6, 6, 6]);
    expect(screen.getByText(/not drawn/i).textContent).toContain('Confirm');
  });

  it('renders a transform’s own limitation too, not only the palette’s', () => {
    render(
      <Chart
        id="dist"
        title="Response time distribution"
        data={{ ...seriesData(['OK']), limitation: 'Bins above 10000 ms are incomplete.' }}
      />,
    );
    expect(screen.getByText(/Bins above 10000 ms are incomplete\./)).toBeVisible();
  });
});

/**
 * F2's plumbing: `--chart-*` must reach the colour the renderer is given.
 *
 * These tokens were computed and then dropped for a while — `chartTheme`
 * exposed a `palette` nothing read, so the six tokens influenced no mark while
 * the docstring claimed a theme switch was picked up. This is the assertion
 * that keeps them load-bearing.
 */
describe('Chart — the --chart-* tokens reach the series colour', () => {
  it('uses the compiled palette when the document defines no token', () => {
    render(<Chart id="a" title="A" data={seriesData(['All'])} />);
    expect((lastOption().color as string[])[0]).toBe(CATEGORICAL[0]);
  });

  it('uses the document’s value when it defines one', () => {
    document.documentElement.style.setProperty('--chart-1', '#123456');
    render(<Chart id="a" title="A" data={seriesData(['All'])} />);

    const first = (lastOption().color as string[])[0];
    expect(first).toBe('#123456');
    expect(first).not.toBe(CATEGORICAL[0]);
  });
});

describe('Chart — the instance lifecycle', () => {
  it('joins the crosshair group when given one, and not otherwise', () => {
    render(<Chart id="a" title="A" data={seriesData(['All'])} group="run-time" />);
    expect(connectSpy).toHaveBeenCalledWith('run-time');

    cleanup();
    connectSpy.mockClear();
    render(<Chart id="b" title="B" data={seriesData(['All'])} />);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('disposes on unmount, so eight charts per run navigation do not leak', () => {
    const { unmount } = render(<Chart id="a" title="A" data={seriesData(['All'])} />);
    expect(disposeSpy).not.toHaveBeenCalled();
    unmount();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('updates the option without rebuilding the instance when the data changes', () => {
    // The regression this pins: `data` and `yAxis` are compared by identity,
    // and the documented call site builds `yAxis` fresh every render. When one
    // effect owned both the instance and the option, a background refetch
    // disposed and re-initialised all eight charts inside a single commit.
    const { rerender } = render(
      <Chart id="a" title="A" data={seriesData(['All'])} yAxis={{ type: 'log' }} />,
    );
    expect(initSpy).toHaveBeenCalledTimes(1);

    rerender(<Chart id="a" title="A" data={seriesData(['All'])} yAxis={{ type: 'log' }} />);

    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(disposeSpy).not.toHaveBeenCalled();
  });
});

describe('Chart — a legend only from two series up', () => {
  it('shows none for a single series, which the title already names', () => {
    render(<Chart id="a" title="Concurrent users" data={seriesData(['All'])} />);
    expect(lastOption().legend).toEqual({ show: false });
  });

  it('shows one for two', () => {
    render(<Chart id="a" title="Requests per second" data={seriesData(['OK', 'KO'])} />);
    expect(lastOption().legend).not.toEqual({ show: false });
  });
});

/**
 * The tooltip's `valueFormatter` shares `formatCell` with the data table
 * (design §7 / the comment above it in Chart.tsx) specifically so the two
 * surfaces never disagree about the same number. A scatter point breaks that
 * sharing unless the formatter is array-aware: ECharts hands it the whole
 * `[x, y]` pair as one value, not one call per axis, and `String([x, y])`
 * joins with a bare comma — `String([3, 120])` is `"3,120"`, indistinguishable
 * from a single four-figure number on a milliseconds axis.
 */
describe('Chart — the tooltip formats an array-valued (scatter) point', () => {
  it('formats each component through formatCell, not the raw array', () => {
    render(
      <Chart
        id="scatter"
        title="Response time against throughput"
        kind="scatter"
        data={{
          series: [{ name: 'OK', data: [[3, 120]] }],
          axisLabels: [],
          columns: ['Series', 'Requests per second', 'p95 (ms)'],
          rows: [{ label: 'OK', values: [3, 120] }],
        }}
      />,
    );

    const { valueFormatter } = lastOption().tooltip as { valueFormatter: (value: unknown) => string };
    // Non-integer components prove formatCell actually ran on each one — a
    // bare `String()` of the pair would keep every digit un-rounded.
    expect(valueFormatter([3.456, 122.74516052680153])).toBe('3.46, 122.75');
    // The actual defect this guards: never the thousands-separator-shaped
    // string `Array.prototype.toString` produces.
    expect(valueFormatter([3, 120])).not.toBe(String([3, 120]));
    expect(valueFormatter([3, 120])).toBe('3, 120');
  });

  it('still formats a plain number or string exactly as before', () => {
    render(<Chart id="a" title="Requests per second" data={seriesData(['All'])} />);
    const { valueFormatter } = lastOption().tooltip as { valueFormatter: (value: unknown) => string };
    expect(valueFormatter(122.74516052680153)).toBe('122.75');
    expect(valueFormatter(null)).toBe('—');
  });
});
