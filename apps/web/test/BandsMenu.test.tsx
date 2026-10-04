import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SeriesResponseSchema } from '@perfportal/contracts';
import PercentilesChart from '../src/charts/PercentilesChart';
import fixture from './fixtures/reference-run.json';

/**
 * ═══ THE PERCENTILE CHART'S BANDS MENU (clean UI, PR 2) ═══
 *
 * Ten band chips sat above a legend listing the same ten bands in the same
 * colours. They are one `Bands · <n>` trigger now, opening a menu of checkbox
 * items — and the menu STAYS OPEN while bands are ticked, so a reader can
 * pick three without reopening it three times.
 *
 * What the chart DRAWS is read off the option it hands ECharts: the data
 * table under the figure carries all ten columns whatever is selected (see
 * `toPercentiles`), so it cannot say which lines are drawn.
 */

const { setOptionCalls } = vi.hoisted(() => ({ setOptionCalls: [] as Record<string, unknown>[] }));
vi.mock('../src/charts/echarts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/charts/echarts')>();
  return {
    echarts: {
      ...real.echarts,
      init: (...args: Parameters<typeof real.echarts.init>) => {
        const instance = real.echarts.init(...args);
        const setOption = instance.setOption.bind(instance);
        instance.setOption = ((option: Record<string, unknown>, ...rest: unknown[]) => {
          setOptionCalls.push(option);
          return (setOption as (...a: unknown[]) => unknown)(option, ...rest);
        }) as typeof instance.setOption;
        return instance;
      },
    },
  };
});

// ECharts measures text through a 2D context jsdom does not implement.
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

afterEach(() => {
  cleanup();
  setOptionCalls.length = 0;
});

const series = SeriesResponseSchema.parse(fixture.series);

function renderChart() {
  const user = userEvent.setup();
  render(<PercentilesChart series={series} windowSelected={false} />);
  return user;
}

/** The series names of the last option that carried any series. */
function drawnSeries(): string[] {
  const withSeries = setOptionCalls.filter((o) => Array.isArray(o['series']));
  const last = withSeries[withSeries.length - 1];
  return ((last?.['series'] ?? []) as { name?: string }[]).map((s) => String(s.name));
}

const trigger = (n: number) => screen.getByRole('button', { name: `Percentile bands, ${n} selected` });

describe('BandsMenu', () => {
  it('replaces the ten band chips with one trigger reading the count', () => {
    renderChart();
    expect(trigger(6)).toHaveTextContent('Bands · 6');
    expect(trigger(6)).toHaveAttribute('data-testid', 'bands-percentiles');
    // The chips are gone until the menu opens: their handles live in it now.
    expect(screen.queryByTestId('band-p95-percentiles')).toBeNull();
  });

  it('opens one checkbox per band, in band order, reflecting the selection', async () => {
    const user = renderChart();
    await user.click(trigger(6));
    await screen.findByRole('menu');
    const items = screen.getAllByRole('menuitemcheckbox');
    expect(items.map((i) => i.textContent)).toEqual([
      'min',
      '25%',
      '50%',
      '75%',
      '80%',
      '85%',
      '90%',
      '95%',
      '99%',
      'max',
    ]);
    expect(screen.getByTestId('band-p95-percentiles')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('band-p25-percentiles')).toHaveAttribute('aria-checked', 'false');
  });

  it('toggles a band by keyboard and stays open', async () => {
    const user = renderChart();
    trigger(6).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    // Opened from the keyboard, focus lands on the first item (min); one
    // ArrowDown is 25%.
    await waitFor(() => expect(screen.getByTestId('band-min-percentiles')).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('band-p25-percentiles')).toHaveFocus();
    await user.keyboard(' ');
    expect(screen.getByTestId('band-p25-percentiles')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(trigger(7)).toHaveTextContent('Bands · 7');
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = renderChart();
    await user.click(trigger(6));
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger(6)).toHaveFocus();
  });

  it('draws what is ticked', async () => {
    const user = renderChart();
    await waitFor(() => expect(drawnSeries()).toEqual(['min', '50%', '75%', '95%', '99%', 'max']));
    await user.click(trigger(6));
    await user.click(await screen.findByTestId('band-p25-percentiles'));
    // BANDS order, not toggle order: 25% is drawn second, not last.
    await waitFor(() => expect(drawnSeries()).toEqual(['min', '25%', '50%', '75%', '95%', '99%', 'max']));
  });

  it('reads Bands · 0 with nothing ticked and still opens', async () => {
    const user = renderChart();
    await user.click(trigger(6));
    for (const band of ['min', 'p50', 'p75', 'p95', 'p99', 'max']) {
      await user.click(await screen.findByTestId(`band-${band}-percentiles`));
    }
    expect(trigger(0)).toHaveTextContent('Bands · 0');
    expect(screen.getByRole('status')).toHaveTextContent(/no percentile bands are selected/i);
    // Closed and reopened, it still lists every band to tick.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await user.click(trigger(0));
    expect(await screen.findAllByRole('menuitemcheckbox')).toHaveLength(10);
  });
});
