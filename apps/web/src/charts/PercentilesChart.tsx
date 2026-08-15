import type { SeriesResponse } from '@perfportal/contracts';
import { useMemo, useState } from 'react';
import Chart from './Chart';
import type { MarkRole } from './theme';
import { BANDS, type Band, type Outcome, toPercentiles } from './transforms/percentiles';

/**
 * The outcome control's three states, in the order they are drawn.
 *
 * `'ok'` first and selected by default: it is what G-22 specifies and what
 * this chart has always shown, so a reader who never touches the control sees
 * exactly the chart they saw before.
 */
const OUTCOMES: readonly { readonly value: Outcome; readonly label: string }[] = [
  { value: 'ok', label: 'OK' },
  { value: 'ko', label: 'KO' },
  { value: 'all', label: 'All' },
];

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
 * **Band selection.** Ten lines on one axis is more than a sighted reader can
 * follow, so by default this draws a readable subset and lets the reader ask
 * for the rest. It is no longer a palette limit — percentiles are an ORDERED
 * measure, so `roles` draws them on `PERCENTILE_RAMP` (green at `min` through
 * red at `max`) instead of the six-hue categorical palette, and `Chart` lifts
 * its six-series cap for any chart that brings its own colour per series. All
 * ten can be selected and all ten will draw. The transform always orders by
 * `BANDS`, so toggling never reorders the legend.
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
  const [outcome, setOutcome] = useState<Outcome>('ok');

  const data = useMemo(
    () => toPercentiles(series, bands, outcome),
    [series, bands, outcome],
  );

  // The transform always emits series in BANDS order, so the roles must be the
  // SELECTED bands in that same order — `bands` is toggle order, which is not
  // it. Memoised because `roles` is in Chart's option-effect dependency list.
  const roles = useMemo(
    () => BANDS.filter((band) => bands.includes(band)).map((band) => `pct-${band}` as MarkRole),
    [bands],
  );

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

        {/* `aria-pressed` rather than a radio group, to match the band
            selector this sits beside — one interaction idiom on one toolbar.
            The legend names it "Response outcome", not "Outcome", because a
            screen-reader user meets it with no chart context. */}
        <fieldset className="flex items-center gap-1">
          <legend className="sr-only">Response outcome</legend>
          {OUTCOMES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={outcome === value}
              data-testid={`outcome-${value}-${id}`}
              onClick={() => setOutcome(value)}
              className={`rounded border px-2 py-0.5 text-sm ${
                outcome === value ? 'border-primary text-primary' : 'border-default text-muted'
              }`}
            >
              {label}
            </button>
          ))}
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
        unit="ms"
        // Shares one crosshair with the other time-axis charts (§22.4/§22.5).
        group="run-time"
        roles={roles}
      />
    </div>
  );
}
