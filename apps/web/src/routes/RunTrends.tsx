import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { trendsQuery } from '../api/metrics';
import TrendsCharts from '../charts/TrendsCharts';
import { MAX_COMPARE } from './compareSelection';
import { Payload, type Slot } from './payload';
import { runComparePath } from './paths';

/**
 * The Trends tab — this run in the context of every other run of the same
 * simulation.
 *
 * A run report answers "what happened". Only a trend answers "is it getting
 * worse", which is the question a performance engineer actually arrives with,
 * and the one nothing in this product could answer before.
 */

const STATUS: Slot = { id: 'trend-status', title: 'Response status across runs' };
const PERCENTILES: Slot = {
  id: 'trend-percentiles',
  title: 'Response time percentiles across runs',
};
const THROUGHPUT: Slot = { id: 'trend-throughput', title: 'Throughput across runs' };

export default function RunTrends() {
  const { runId } = useParams<{ runId: string }>();
  const trends = useQuery({ ...trendsQuery(runId ?? ''), enabled: runId !== undefined });

  return (
    // ONE COLUMN, unlike the Charts tab's two. These three are read DOWN, as
    // one story about the same sequence of runs — status, then latency, then
    // load — and side by side they would be three unrelated pictures that
    // happen to share an axis. There are also only three, so the scroll depth
    // the Charts tab is pairing away does not arise here.
    <section aria-labelledby="trends-heading" className="grid grid-cols-1 gap-6">
      <h2 id="trends-heading" className="sr-only">
        Trends
      </h2>

      <Payload query={trends} slots={[STATUS, PERCENTILES, THROUGHPUT]}>
        {(data) => (
          <>
            {/* A COHORT OF ONE DRAWS ITS POINT and says why there is nothing
                to compare it against. Deliberately NOT the empty state, which
                is for no data: one datum is data, its value is real, and
                hiding it would answer "is it getting worse" with silence
                rather than with "there is nothing to compare yet".

                Above the charts rather than below, because it changes how the
                three figures underneath should be read. */}
            {data.runs.length === 1 && (
              <p className="text-[13px] text-muted">
                This is the only completed run of{' '}
                {data.simulation === null ? 'this unnamed simulation' : data.simulation} so far,
                so there is nothing to compare it against yet.
              </p>
            )}

            {/* The cohort key, stated. A reader whose runs carry no simulation
                name needs to know they are grouped by that ABSENCE — not that
                the product decided they are the same test. */}
            {data.simulation === null && data.runs.length > 1 && (
              <p className="text-[13px] text-muted">
                These runs are grouped because none of them carries a simulation name, not
                because they are known to be the same test.
              </p>
            )}

            {/* THE ENTRY POINT TO COMPARE, and only when there is something
                to compare against. A control that is always present but
                usually useless teaches a reader to stop seeing it — and a
                cohort of one has no comparison to offer.

                Here rather than in the tab strip because a comparison needs a
                SELECTION, and this page is where the runs are listed. */}
            {data.runs.length > 1 && (
              <p className="text-[13px]">
                <Link to={runComparePath(data.runId)} className="text-accent underline">
                  Compare these runs
                </Link>{' '}
                <span className="text-muted">
                  — overlay up to {MAX_COMPARE} of them on one metric.
                </span>
              </p>
            )}

            <TrendsCharts trends={data} />
          </>
        )}
      </Payload>
    </section>
  );
}
