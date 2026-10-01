import '@testing-library/jest-dom/vitest';
import type { SeriesResponse, UsersResponse } from '@perfportal/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestsAndResponsesChart } from '../src/charts/RatesChart';
import { UserEndRateChart } from '../src/charts/UsersChart';
import { CATEGORICAL, CATEGORICAL_DARK, resolveChartMode, STATUS_MARK_COLORS } from '../src/charts/theme';
import { REQUESTS_AND_RESPONSES_ROLES } from '../src/charts/transforms/rates';
import fixture from './fixtures/reference-run.json';

/**
 * THE TWO CHARTS THIS TASK ADDED, as the component hands them to `Chart`: the
 * transforms are proven in `transforms.*.test.ts` and the drawing in a real
 * browser, so what is left for this file is the strings and colours that exist
 * only at the binding — and that nothing else would notice drifting.
 *
 * ═══ THE COMBINED CHART MUST SPEAK THE STATUS COLOUR LANGUAGE ═══
 *
 * `roles` is silently optional on `Chart`: a chart that forgets it falls back
 * to the categorical palette and draws Responses KO in a hue that means
 * "neither outcome", while every transform test stays green because none of
 * them can see a colour. `TimeBrush.test.tsx` met exactly this on the strip
 * above `RatesChart` and reads the option the same way — through a mocked
 * renderer, because jsdom draws nothing and the colours are the one thing this
 * component hands ECharts that is not data.
 */

const { initSpy, setOptionSpy, connectSpy } = vi.hoisted(() => ({
  initSpy: vi.fn(),
  setOptionSpy: vi.fn(),
  connectSpy: vi.fn(),
}));

vi.mock('../src/charts/echarts.js', () => ({
  echarts: { init: initSpy, connect: connectSpy },
}));

/** The last option object `Chart` handed to `setOption`. */
function lastOption(): Record<string, unknown> {
  expect(setOptionSpy.mock.calls.length).toBeGreaterThan(0);
  return setOptionSpy.mock.calls.at(-1)![0] as Record<string, unknown>;
}

beforeEach(() => {
  initSpy.mockReset();
  setOptionSpy.mockReset();
  connectSpy.mockReset();
  initSpy.mockImplementation(() => ({
    group: undefined as string | undefined,
    setOption: setOptionSpy,
    dispose: vi.fn(),
    resize: vi.fn(),
    on: vi.fn(),
    getOption: vi.fn(),
  }));
});

afterEach(cleanup);

describe('RequestsAndResponsesChart — the colours it hands ECharts', () => {
  it('draws Responses KO in the failed status colour and OK in the passed one', () => {
    render(<RequestsAndResponsesChart series={fixture.series as unknown as SeriesResponse} windowSelected={false} />);

    const names = (lastOption()['series'] as { name: string }[]).map((s) => s.name);
    expect(names).toEqual(['Requests', 'Total', 'Responses OK', 'Responses KO']);

    // `Chart` maps `roles` through the live token table, and jsdom parses no
    // stylesheet, so what lands in the option is the fallback per role — the
    // MARK colours (`STATUS_MARK_COLORS`), because a chart line is a fill, not
    // text. Per series, in series order.
    const colors = lastOption()['color'] as string[];
    const status = STATUS_MARK_COLORS[resolveChartMode()];
    expect(colors).toEqual(REQUESTS_AND_RESPONSES_ROLES.map((role) => status[role]));
    expect(colors[2]).toBe(status.passed);
    expect(colors[3]).toBe(status.failed);
    // Four lines, four colours: a Total drawn in the neutral grey of Requests
    // would make the two indistinguishable exactly where they diverge.
    expect(new Set(colors).size).toBe(4);
    for (const categorical of [...CATEGORICAL, ...CATEGORICAL_DARK]) {
      expect(colors).not.toContain(categorical);
    }
  });

  it('shares the one run-time crosshair the other time charts carry', () => {
    render(<RequestsAndResponsesChart series={fixture.series as unknown as SeriesResponse} windowSelected={false} />);

    // The literal the existing charts spell out. The new chart reads it from
    // `RUN_TIME_GROUP`; if that constant ever drifts from what they carry, the
    // pointer stops following this chart and nothing else notices.
    expect(connectSpy).toHaveBeenCalledWith('run-time');
  });
});

/**
 * ═══ WHAT EACH CHART IS CALLED ═══
 *
 * The id is the figure's test id, the anchor later pages and every browser spec
 * reach a chart by; the title and the y-axis name are the words a reader sees
 * and the spec names (GE's own `Count/s` for the combined chart, whose lines
 * are not all requests). All three are strings typed once, at the binding, so
 * no transform test can see one drift.
 */
describe('RequestsAndResponsesChart — what it is called', () => {
  it('is the figure, titled and axis-named as the spec says', () => {
    render(<RequestsAndResponsesChart series={fixture.series as unknown as SeriesResponse} windowSelected={false} />);

    const figure = screen.getByTestId('chart-requests-and-responses');
    expect(
      within(figure).getByRole('heading', { level: 3, name: 'Requests and responses per second over time' }),
    ).toBeInTheDocument();
    expect(lastOption()['yAxis']).toMatchObject({ name: 'Count/s' });
  });
});

describe('UserEndRateChart — what it is called, and which crosshair it joins', () => {
  const users = fixture.users as unknown as UsersResponse;

  it('is the figure, titled and axis-named as the spec says', () => {
    render(<UserEndRateChart users={users} windowSelected={false} />);

    const figure = screen.getByTestId('chart-user-end-rate');
    expect(
      within(figure).getByRole('heading', { level: 3, name: 'Users ended per second' }),
    ).toBeInTheDocument();
    expect(lastOption()['yAxis']).toMatchObject({ name: 'Users/s' });
  });

  it('hands the crosshair group its page gives it on to `Chart`', () => {
    // A prop, unlike the combined chart's: the users charts are drawn by pages
    // that own the group (`UsersChartProps.group`).
    render(<UserEndRateChart users={users} group="run-time" windowSelected={false} />);
    expect(connectSpy).toHaveBeenCalledWith('run-time');
  });
});
