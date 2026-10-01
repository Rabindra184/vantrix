import type { SeriesResponse } from '@perfportal/contracts';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestsAndResponsesChart } from '../src/charts/RatesChart';
import { CATEGORICAL, CATEGORICAL_DARK, resolveChartMode, STATUS_MARK_COLORS } from '../src/charts/theme';
import { REQUESTS_AND_RESPONSES_ROLES } from '../src/charts/transforms/rates';
import fixture from './fixtures/reference-run.json';

/**
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
    render(<RequestsAndResponsesChart series={fixture.series as unknown as SeriesResponse} />);

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
    render(<RequestsAndResponsesChart series={fixture.series as unknown as SeriesResponse} />);

    // The literal the existing charts spell out. The new chart reads it from
    // `RUN_TIME_GROUP`; if that constant ever drifts from what they carry, the
    // pointer stops following this chart and nothing else notices.
    expect(connectSpy).toHaveBeenCalledWith('run-time');
  });
});
