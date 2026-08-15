import type { DistributionResponse } from '@perfportal/contracts';
import { useMemo, useState } from 'react';
import Chart from './Chart';
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
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
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
      </div>

      <Chart
        id={id}
        title={title}
        data={data}
        kind="line"
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
    </div>
  );
}
