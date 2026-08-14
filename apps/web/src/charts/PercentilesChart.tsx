import type { SeriesResponse } from '@perfportal/contracts';
import { useMemo, useState } from 'react';
import Chart from './Chart';
import { BANDS, type Band, toPercentiles } from './transforms/percentiles';

const BAND_LABEL: Record<Band, string> = {
  min: 'min', p25: '25%', p50: '50%', p75: '75%', p80: '80%',
  p85: '85%', p90: '90%', p95: '95%', p99: '99%', max: 'max',
};

/**
 * Response Time Percentiles over Time — §13.2 ⑨, Appendix A G-22.
 *
 * Two controls, both required by §13.2 ⑨ and §12.4:
 *
 * **Log Y by default.** Ten bands spanning min to max on a linear axis push
 * every band below the 95th into a band a few pixels tall — the chart becomes
 * a picture of its own outliers. Log keeps all ten legible, which is the
 * entire reason the spec names it. The linear toggle is there because a log
 * axis misleads about the SIZE of a difference, and someone comparing two
 * absolute numbers needs the other view.
 *
 * **Band selection.** Ten series is more than the six the categorical palette
 * has hues for, so by default this draws a readable subset and lets the reader
 * ask for the rest. The transform always orders by `BANDS`, so toggling never
 * reorders the legend.
 */
const DEFAULT_BANDS: readonly Band[] = ['min', 'p50', 'p75', 'p95', 'p99', 'max'];

/**
 * `id` and `title` are props because the GROUP detail page renders TWO of these
 * — one per metric family — and a component that names itself cannot appear
 * twice. That is true of the figure, and doubly so here: this chart owns a
 * scale toggle and a band selector, so a hardcoded testid gives a page two
 * controls a test cannot tell apart. Every testid below derives from `id`.
 *
 * Defaults keep the run and request pages, which render exactly one, unchanged.
 */
export default function PercentilesChart({
  series,
  id = 'percentiles',
  title = 'Response time percentiles over time',
}: {
  readonly series: SeriesResponse;
  readonly id?: string;
  readonly title?: string;
}) {
  const [scale, setScale] = useState<'log' | 'value'>('log');
  const [bands, setBands] = useState<readonly Band[]>(DEFAULT_BANDS);

  const data = useMemo(() => toPercentiles(series, bands), [series, bands]);

  function toggle(band: Band) {
    setBands((current) =>
      current.includes(band) ? current.filter((b) => b !== band) : [...current, band],
    );
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <fieldset className="flex flex-wrap items-center gap-1">
          <legend className="sr-only">Percentile bands</legend>
          {BANDS.map((band) => {
            const on = bands.includes(band);
            return (
              <button
                key={band}
                type="button"
                aria-pressed={on}
                data-testid={`band-${band}-${id}`}
                onClick={() => toggle(band)}
                className={`rounded border px-2 py-0.5 text-sm ${
                  on
                    ? 'border-primary text-primary'
                    : 'border-default text-muted'
                }`}
              >
                {BAND_LABEL[band]}
              </button>
            );
          })}
        </fieldset>

        <button
          type="button"
          data-testid={`scale-toggle-${id}`}
          aria-pressed={scale === 'log'}
          onClick={() => setScale((s) => (s === 'log' ? 'value' : 'log'))}
          className="rounded border border-default px-2 py-0.5 text-sm text-muted"
        >
          {scale === 'log' ? 'Log scale' : 'Linear scale'}
        </button>
      </div>

      <Chart
        id={id}
        title={title}
        data={data}
        kind="line"
        // Log by default. A log axis cannot render a zero or a null as a
        // point, which is correct here: an unmeasured second is a gap.
        yAxis={{ type: scale, name: 'Response time (ms)' }}
        xAxis={{ name: 'Elapsed (s)' }}
        // Shares one crosshair with the other time-axis charts (§22.4/§22.5).
        group="run-time"
      />
    </div>
  );
}
