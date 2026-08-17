import type { SeriesResponse } from '@perfportal/contracts';
import { useMemo, useState } from 'react';
import Chart from './Chart';
import { Chip, ControlBar, ControlGroup, Segmented, Switch } from './ChartControls';
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
    <Chart
      id={id}
      title={title}
      data={data}
      kind="line"
      // INSIDE the figure, under its heading — see `ChartProps.controls`. These
      // three used to sit in a bare `<div>` above the card, where nothing tied
      // them to this chart rather than to the one above it.
      controls={
        <ControlBar>
          {/* Each chip carries the colour of the line it draws. The chart puts
              ten ordered bands on a green-to-red ramp; without the swatch the
              only way to find out which line `95%` was, was to switch it off
              and see what vanished. */}
          <ControlGroup label="Percentile bands">
            {BANDS.map((band) => (
              <Chip
                key={band}
                pressed={bands.includes(band)}
                swatch={`--chart-pct-${band}`}
                testId={`band-${band}-${id}`}
                onClick={() => toggle(band)}
              >
                {BAND_LABEL[band]}
              </Chip>
            ))}
          </ControlGroup>

          {/* Segments, not chips: these REPLACE each other, and drawn as chips
              they were indistinguishable from the bands beside them, which
              combine. The label says "Response outcome", not "Outcome",
              because a screen-reader user meets it with no chart context. */}
          <ControlGroup label="Response outcome">
            <Segmented
              options={OUTCOMES}
              value={outcome}
              testId={(value) => `outcome-${value}-${id}`}
              onChange={(value) => setOutcome(value as Outcome)}
            />
          </ControlGroup>

          {/* A switch, because it is the one binary control here. Its label is
              fixed and the knob carries the state: the old button was labelled
              with the CURRENT scale while the buttons beside it were labelled
              with the state they would select, so the same row of controls
              read two ways at once. */}
          <ControlGroup label="Scale">
            <Switch
              pressed={scale === 'log'}
              label="Logarithmic"
              testId={`scale-toggle-${id}`}
              onClick={() => setScale((s) => (s === 'log' ? 'value' : 'log'))}
            />
          </ControlGroup>
        </ControlBar>
      }
      // Log by default. A log axis cannot render a zero or a null as a
      // point, which is correct here: an unmeasured second is a gap.
      yAxis={{ type: scale, name: 'Response time (ms)' }}
      xAxis={{ name: 'Elapsed (s)' }}
      unit="ms"
      // Shares one crosshair with the other time-axis charts (§22.4/§22.5).
      group="run-time"
      roles={roles}
    />
  );
}
