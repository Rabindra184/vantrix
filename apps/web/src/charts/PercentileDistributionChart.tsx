import type { DistributionResponse } from '@perfportal/contracts';
import { useMemo, useState } from 'react';
import Chart from './Chart';
import { ControlBar, ControlGroup, Segmented } from './ChartControls';
import type { MarkRole } from './theme';
import { toPercentileDistribution } from './transforms/percentileDistribution';
import type { Outcome } from './transforms/percentiles';

/**
 * The outcome control's three states.
 *
 * Its own instance, independent of the percentiles-over-time chart's, exactly
 * as Gatling's two are: a reader wants to put an OK curve beside a KO one, and
 * a shared control makes that the one comparison they cannot make.
 */
const OUTCOMES: readonly { readonly value: Outcome; readonly label: string }[] = [
  { value: 'ok', label: 'OK' },
  { value: 'ko', label: 'KO' },
  { value: 'all', label: 'All' },
];

/**
 * THE MARK MEANS SOMETHING, so it takes the status palette rather than a
 * categorical hue — this is the same claim about the same requests that the
 * histogram and the donut make, and red has to mean there what it means here.
 */
const ROLE: Record<Outcome, readonly MarkRole[]> = {
  ok: ['passed'],
  ko: ['failed'],
  all: ['neutral'],
};

/**
 * Response Time Percentiles Distribution — percentile across, response time up.
 *
 * `id` and `title` are props for the reason `PercentilesChart`'s are: the group
 * detail page renders one chart per metric family, and a component that names
 * itself cannot appear twice. Every testid derives from `id`.
 */
export default function PercentileDistributionChart({
  distribution,
  id = 'percentile-distribution',
  title = 'Response time percentiles distribution',
}: {
  readonly distribution: DistributionResponse;
  readonly id?: string;
  readonly title?: string;
}) {
  const [outcome, setOutcome] = useState<Outcome>('ok');

  const data = useMemo(
    () => toPercentileDistribution(distribution, outcome),
    [distribution, outcome],
  );

  // In the option effect's dependency list, so it must not be a fresh array
  // per render.
  const roles = ROLE[outcome];

  return (
      <Chart
        id={id}
        title={title}
        data={data}
        kind="line"
        // INSIDE the figure — see `ChartProps.controls`. This was the second of
        // the two floating control clusters on the run page, and being one
        // lone group made it the more ambiguous of the pair: three bare
        // buttons above a card, with the card above them ending in a legend
        // that also read as a row of small labels.
        controls={
          <ControlBar>
            <ControlGroup label="Response outcome">
              <Segmented
                options={OUTCOMES}
                value={outcome}
                testId={(value) => `outcome-${value}-${id}`}
                onChange={(value) => setOutcome(value as Outcome)}
              />
            </ControlGroup>
          </ControlBar>
        }
        // A VALUE AXIS, not a category one. The percentiles come from a
        // cumulative sum over bin counts, so they arrive unevenly spaced;
        // drawn as categories they would be spread at equal intervals, which
        // straightens exactly the curvature this chart exists to show.
        xAxis={{ type: 'value', name: 'Percentile (%)' }}
        yAxis={{ name: 'Response time (ms)' }}
        unit="ms"
        roles={roles}
        // NO `group`, deliberately. Its x-axis is a percentile, not elapsed
        // time, so joining the `run-time` crosshair would drive a pointer to a
        // meaningless position here on every hover elsewhere on the page —
        // and, worse, invite reading the two as aligned. Gatling's own
        // distribution charts sit outside their sync group for this reason.
      />
  );
}
