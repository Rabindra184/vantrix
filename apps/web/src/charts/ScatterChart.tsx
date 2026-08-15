import type { ScatterResponse } from '@perfportal/contracts';
import { useMemo } from 'react';
import Chart from './Chart';
import { SCATTER_ROLES, toScatter } from './transforms/scatter';

/**
 * §13.3 ⑨ — a transform and a title, like every other chart component.
 *
 * TAKES THE PAYLOAD, DOES NOT FETCH IT (design §6). `RequestDetail` runs the
 * one `scatterQuery` and hands the response here.
 */
export default function ScatterChart({ scatter }: { readonly scatter: ScatterResponse }) {
  const data = useMemo(() => toScatter(scatter), [scatter]);

  return (
    <Chart
      id="scatter"
      title="Response time against global requests per second"
      data={data}
      kind="scatter"
      // OK and KO mean an outcome, so they wear the status tokens rather than
      // the categorical palette — the same rule DistributionChart follows.
      roles={SCATTER_ROLES}
      xAxis={{ name: 'Requests per second (all requests)' }}
      yAxis={{ name: 'p95 response time (ms)' }}
      // NO `unit`, deliberately. Every other chart's values share one unit;
      // this one's are `[x, y]` pairs spanning TWO — requests per second and
      // milliseconds — and `Chart`'s unit is per chart, not per axis. Suffixing
      // the pair with either one would label half of it wrongly, which is worse
      // than the axis titles carrying it alone.
    />
  );
}
