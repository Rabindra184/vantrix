import { AGENT_PERCENTILE_ROWS } from '@perfportal/contracts';
import type { AgentPercentileRow, DurationSection } from '@perfportal/contracts';
import { useMemo, useState } from 'react';
import BandsMenu from './BandsMenu';
import Chart from './Chart';
import { ControlBar, ControlGroup, Segmented } from './ChartControls';
import { RUN_TIME_GROUP } from './crosshair';
import type { MarkRole } from './theme';
import {
  AGENT_ROW_LABEL,
  DEFAULT_AGENT_ROWS,
  toDurationDistribution,
  toDurationOverTime,
  toDurationPercentiles,
} from './transforms/agentDurations';
import { DISTRIBUTION_ROLES } from './transforms/distribution';
import type { Outcome } from './transforms/percentiles';
import type { TimeDomainMs } from './types';

/** `PercentilesChart`'s outcome control, in its order, `'ok'` first and default. */
const OUTCOMES: readonly { readonly value: Outcome; readonly label: string }[] = [
  { value: 'ok', label: 'OK' },
  { value: 'ko', label: 'KO' },
  { value: 'all', label: 'All' },
];

/** One curve, in its outcome's status colour — `PercentileDistributionChart`'s map. */
const CURVE_ROLE: Record<Outcome, readonly MarkRole[]> = { ok: ['passed'], ko: ['failed'], all: ['neutral'] };

/**
 * One agent duration section's three charts, as GE draws them — TCP connect
 * and TLS handshake under Connections, DNS resolution under DNS:
 *
 *   `${idPrefix}-percentiles`               GE's 13 rows over time
 *   `${idPrefix}-distribution`              OK and KO per duration bin
 *   `${idPrefix}-percentiles-distribution`  the percentile curve
 *
 * A component rather than three charts per section because two sections draw
 * it three times between them, and each chart's controls and roles have to be
 * wired identically every time.
 *
 * The over-time chart mirrors `PercentilesChart`: a `BandsMenu` over GE's
 * thirteen rows opening on the eight GE shows (`DEFAULT_AGENT_ROWS`), the
 * outcome control defaulting to OK, and the rows drawn on the percentile ramp
 * (`pct-${row}`, `pct-mean` among them). It is a time chart, so it joins the
 * run page's crosshair on the shell's domain. The other two are not — their x
 * is a duration or a percentile — and stay out of the group for
 * `PercentileDistributionChart`'s reason: a pointer driven there by a hover
 * elsewhere would mean nothing.
 *
 * Linear y, not `PercentilesChart`'s log: a sub-millisecond TCP connect has a
 * Min of 0, which a log axis cannot place, and a dropped point there would read
 * as an unmeasured second.
 */
export default function AgentDurationCharts({
  idPrefix,
  titles,
  section,
  noun,
  domainMs,
  windowSelected,
}: {
  readonly idPrefix: string;
  /** GE's three titles for this section, verbatim. */
  readonly titles: { readonly overTime: string; readonly distribution: string; readonly percentiles: string };
  readonly section: DurationSection;
  /** What a reading is ("TCP connects") — the empty sentences and the distribution's y-axis say it. */
  readonly noun: string;
  readonly domainMs: TimeDomainMs | undefined;
  /** REQUIRED, as on every Report chart: a quiet window must not read as a quiet run. */
  readonly windowSelected: boolean;
}) {
  const [rows, setRows] = useState<readonly AgentPercentileRow[]>(DEFAULT_AGENT_ROWS);
  const [overTimeOutcome, setOverTimeOutcome] = useState<Outcome>('ok');
  const [curveOutcome, setCurveOutcome] = useState<Outcome>('ok');

  const overTime = useMemo(
    () => toDurationOverTime(section, { windowSelected, noun, outcome: overTimeOutcome, rows }),
    [section, windowSelected, noun, overTimeOutcome, rows],
  );
  const distribution = useMemo(
    () => toDurationDistribution(section, { windowSelected, noun }),
    [section, windowSelected, noun],
  );
  const curve = useMemo(
    () => toDurationPercentiles(section, curveOutcome, { windowSelected, noun }),
    [section, curveOutcome, windowSelected, noun],
  );
  // The transform emits rows in `AGENT_PERCENTILE_ROWS` order, never toggle
  // order, so the roles follow the same filter. Memoised: `roles` is in
  // `Chart`'s option-effect dependency list.
  const roles = useMemo(
    () => AGENT_PERCENTILE_ROWS.filter((row) => rows.includes(row)).map((row) => `pct-${row}` as MarkRole),
    [rows],
  );

  const overTimeId = `${idPrefix}-percentiles`;
  const curveId = `${idPrefix}-percentiles-distribution`;

  function toggle(row: AgentPercentileRow) {
    setRows((current) => (current.includes(row) ? current.filter((r) => r !== row) : [...current, row]));
  }

  return (
    <>
      <Chart
        id={overTimeId}
        title={titles.overTime}
        data={overTime}
        kind="line"
        controls={
          <ControlBar>
            <ControlGroup label="Percentile rows">
              <BandsMenu
                id={overTimeId}
                bands={AGENT_PERCENTILE_ROWS}
                labels={AGENT_ROW_LABEL}
                selected={rows}
                onToggle={toggle}
              />
            </ControlGroup>
            <ControlGroup label="Outcome">
              <Segmented
                options={OUTCOMES}
                value={overTimeOutcome}
                testId={(value) => `outcome-${value}-${overTimeId}`}
                onChange={(value) => setOverTimeOutcome(value as Outcome)}
              />
            </ControlGroup>
          </ControlBar>
        }
        yAxis={{ name: 'Duration (ms)' }}
        // Its x is an INSTANT, not a measurement — the tooltip title names it.
        pairValue="y"
        xAxis={{ type: 'value', tickUnit: 'ms-as-s', min: domainMs?.[0], max: domainMs?.[1] }}
        unit="ms"
        group={RUN_TIME_GROUP}
        roles={roles}
      />
      <Chart
        id={`${idPrefix}-distribution`}
        title={titles.distribution}
        data={distribution}
        // Stacked, as the request distribution is: one bar per bin, split by outcome.
        kind="bar"
        stacked
        roles={DISTRIBUTION_ROLES}
        // The transform's label column says whether bins are midpoints or exact values.
        xAxis={{ name: distribution.columns[0] }}
        yAxis={{ name: noun }}
      />
      <Chart
        id={curveId}
        title={titles.percentiles}
        data={curve}
        kind="line"
        controls={
          <ControlBar>
            <ControlGroup label="Outcome">
              <Segmented
                options={OUTCOMES}
                value={curveOutcome}
                testId={(value) => `outcome-${value}-${curveId}`}
                onChange={(value) => setCurveOutcome(value as Outcome)}
              />
            </ControlGroup>
          </ControlBar>
        }
        // A value axis: the curve's percentiles are unevenly spaced (2.5 steps, then 99, 99.9 …).
        xAxis={{ type: 'value', name: 'Percentile (%)' }}
        yAxis={{ name: 'Duration (ms)' }}
        unit="ms"
        roles={CURVE_ROLE[curveOutcome]}
      />
    </>
  );
}
