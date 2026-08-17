import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TimeBrush from '../src/charts/TimeBrush';
import { RATE_ROLES } from '../src/charts/transforms/rates';
import { CATEGORICAL } from '../src/charts/theme';
import fixture from './fixtures/reference-run.json';

/**
 * THE JOIN BETWEEN THE TRANSFORM AND THE AXIS, which is where this component
 * was broken and which neither side's own tests could see.
 *
 * `transforms.rates.test.ts` proves the millisecond form carries [ms, rate]
 * pairs. `Chart.test.tsx` proves the brush reports its handles in the axis'
 * own units. Both were true while this component was wrong, because it drew
 * the CATEGORY form on a VALUE axis: ECharts then mapped each scalar onto both
 * axes, the strip plotted requests/s against requests/s as a straight 45° line,
 * and every drag committed a window in rate values read as milliseconds — a
 * drag across the first third of a 63 s run produced `?from=0&to=7`.
 *
 * So the assertion here is deliberately about the ONE fact that spans the two:
 * the numbers this component hands the renderer for x are elapsed
 * milliseconds, on the axis it declares. Nothing about what ECharts then drew
 * — that is `run-charts.spec.ts`'s, in a real browser.
 */

const { initSpy, setOptionSpy } = vi.hoisted(() => ({
  initSpy: vi.fn(),
  setOptionSpy: vi.fn(),
}));

vi.mock('../src/charts/echarts.js', () => ({
  echarts: { init: initSpy, connect: vi.fn() },
}));

/** The last option object `Chart` handed to `setOption`. */
function lastOption(): Record<string, unknown> {
  expect(setOptionSpy.mock.calls.length).toBeGreaterThan(0);
  return setOptionSpy.mock.calls.at(-1)![0] as Record<string, unknown>;
}

const RUN = '2b0f2bf2-6c1e-4c3f-9d6a-1f2f1a6d4c11';
const buckets = fixture.series.buckets;

beforeEach(() => {
  initSpy.mockReset();
  setOptionSpy.mockReset();
  initSpy.mockImplementation(() => ({
    group: undefined as string | undefined,
    setOption: setOptionSpy,
    dispose: vi.fn(),
    resize: vi.fn(),
    on: vi.fn(),
    getOption: vi.fn(),
  }));

  vi.stubGlobal('fetch', (input: RequestInfo) =>
    String(input).includes('/series')
      ? Promise.resolve(new Response(JSON.stringify(fixture.series), { status: 200 }))
      : Promise.resolve(new Response('{}', { status: 500 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderBrush() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TimeBrush
        runId={RUN}
        runDurationMs={63_161}
        window={null}
        onChange={() => undefined}
      />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(setOptionSpy).toHaveBeenCalled());
}

describe('TimeBrush — the strip the window is dragged on', () => {
  it('draws against elapsed MILLISECONDS, the units its brush commits in', async () => {
    await renderBrush();

    const series = lastOption()['series'] as { data: readonly (readonly [number, number])[] }[];
    const x = series[0]!.data.map((point) => point[0]);

    // Computed from the payload: a re-capture moves every one of these.
    expect(x).toEqual(buckets.map((b) => b.startOffsetMs));
  });

  it('spans the whole run, so the strip is a map of all of it', async () => {
    await renderBrush();

    const series = lastOption()['series'] as { data: readonly (readonly [number, number])[] }[];
    const x = series[0]!.data.map((point) => point[0]);

    // The failure this replaces drew x over the RATE's range — 0 to about 21 —
    // which is why both axes read 0..21 and the line came out at 45°.
    expect(Math.min(...x)).toBe(buckets[0]!.startOffsetMs);
    expect(Math.max(...x)).toBe(buckets.at(-1)!.startOffsetMs);
    expect(Math.max(...x)).toBeGreaterThan(60_000);
  });

  it('declares the value axis those pairs require', async () => {
    await renderBrush();
    expect(lastOption()['xAxis']).toMatchObject({ type: 'value' });
  });

  /**
   * ═══ THE NAME DESCRIBES WHAT THE READER SEES, THE DATA STAYS IN ms ═══
   *
   * This replaces an assertion that the name read `(ms)`, which was right while
   * the axis was labelled in raw milliseconds and is now wrong: the ticks are
   * relabelled in seconds so the strip agrees with its own From/To fields and
   * with the six charts under it, all of which are in elapsed seconds.
   *
   * The protection that assertion gave — the name must not lie about the axis —
   * is kept, and widened, by pinning the whole chain in one place: the plotted
   * x is still milliseconds (the brush contract), the formatter is what turns
   * those into seconds, and the name is in seconds because that is what ends up
   * under the ticks. A change to any one of the three without the others fails
   * here.
   */
  it('labels that axis in seconds while still plotting milliseconds', async () => {
    await renderBrush();

    const axis = lastOption()['xAxis'] as {
      name: string;
      axisLabel: { formatter?: (value: number) => string };
    };

    // The name the reader sees, and the units the ticks are in.
    expect(axis.name).toMatch(/\(s\)/);
    expect(axis.name).not.toMatch(/\(ms\)/);

    // The formatter is what makes that true, so it has to exist and convert.
    expect(axis.axisLabel.formatter).toBeTypeOf('function');
    expect(axis.axisLabel.formatter!(20_000)).toBe('20');
    expect(axis.axisLabel.formatter!(63_161)).toBe('63');

    // And the DATA underneath is untouched — milliseconds, which is what the
    // slider reports and what `commit` writes to the URL.
    const series = lastOption()['series'] as { data: readonly (readonly [number, number])[] }[];
    expect(series[0]!.data.map((point) => point[0])).toEqual(
      buckets.map((b) => b.startOffsetMs),
    );
  });

  /**
   * ═══ THE STRIP AND THE CHART BELOW IT MUST SPEAK ONE COLOUR LANGUAGE ═══
   *
   * `RATE_ROLES` is `['neutral', 'passed', 'failed']` and exists so All/OK/KO
   * mean here what they mean on the donut and the distribution. This component
   * consumed the same transform as `RatesChart` but never passed the roles, so
   * ECharts fell back to the categorical palette: the strip drew All/OK/KO as
   * indigo/teal/violet while `RatesChart` drew them as grey/green/red, on the
   * same page, for the same three series — and KO arrived in a hue that
   * `rates.ts` reserves for "neither outcome".
   *
   * Asserted as the ROLES, not as hex: the roles are the claim, and the hex
   * behind them is `theme.ts`'s to change.
   */
  it('draws All/OK/KO in the status colours, not the categorical palette', async () => {
    await renderBrush();

    const series = lastOption()['series'] as { name: string }[];
    expect(series.map((s) => s.name)).toEqual(['All', 'OK', 'KO']);

    // `Chart` maps `roles` through the live token table, so what lands in the
    // option is the resolved colour per series, in role order. Three distinct
    // values, and none of them a categorical hue.
    const colors = lastOption()['color'] as string[];
    expect(colors).toHaveLength(RATE_ROLES.length);
    expect(new Set(colors).size).toBe(3);
    for (const categorical of CATEGORICAL) {
      expect(colors).not.toContain(categorical);
    }
  });
});
