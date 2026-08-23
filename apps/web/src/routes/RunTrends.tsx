import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { trendsQuery } from '../api/metrics';
import TrendsCharts from '../charts/TrendsCharts';
import { linkButtonClasses } from '../components/Button';
import { CompareTabIcon } from '../components/icons';
import { MAX_COMPARE } from './compareSelection';
import LiveNotice from './LiveNotice';
import { Payload, type Slot } from './payload';
import { runComparePath } from './paths';
import { useRunTerminal } from './useRunWindow';
import DesktopOnly from './DesktopOnly';
import useIsCompact from '../useIsCompact';

/**
 * The Trends tab — this run in the context of every other run of the same
 * simulation.
 *
 * A run report answers "what happened". Only a trend answers "is it getting
 * worse", which is the question a performance engineer actually arrives with,
 * and the one nothing in this product could answer before.
 *
 * WITHHELD WHILE THE RUN IS LIVE (Task 11), for the same reason it always
 * would have been: `/trends` reads the same `RunStat` rows every other
 * metric endpoint does, and none exist until the parse pipeline runs — a
 * running run has no statistics row of its OWN to plot a point from, cohort
 * or no cohort.
 */

const STATUS: Slot = { id: 'trend-status', title: 'Response status across runs' };
const PERCENTILES: Slot = {
  id: 'trend-percentiles',
  title: 'Response time percentiles across runs',
};
const THROUGHPUT: Slot = { id: 'trend-throughput', title: 'Throughput across runs' };

export default function RunTrends() {
  const { runId } = useParams<{ runId: string }>();
  const { terminal } = useRunTerminal(runId);
  // §22.6: deep analysis is a desktop task. Gated on the QUERY as well as the
  // render, so a phone does not fetch a payload it has been told not to draw.
  const compact = useIsCompact();
  const [shown, setShown] = useState(false);

  // EVERY HOOK ABOVE THIS LINE RUNS ON EVERY RENDER, UNCONDITIONALLY —
  // `useQuery` is hoisted above BOTH early returns below rather than gated
  // behind either of them, because BOTH `terminal` and `wanted` can flip in
  // place on an already-mounted instance: a reader sitting on this tab while
  // the run they are watching finishes flips `terminal` false -> true (the
  // shell's own poll writes the shared `runQueryKey` entry this hook reads),
  // and a phone reader pressing "Show it anyway" flips `wanted` false ->
  // true. Either transition changing how many hooks a render calls is
  // exactly "Rendered more hooks than during the previous render" — a
  // regression this file shipped with once already (fix round 1) by putting
  // the `!terminal` return above this call. `enabled` is the only thing that
  // may vary; the hook itself may not become conditional.
  const wanted = !compact || shown;
  const trends = useQuery({
    ...trendsQuery(runId ?? ''),
    enabled: runId !== undefined && terminal && wanted,
  });

  // AHEAD OF THE COMPACT GATE BELOW, deliberately. This notice is cheap
  // text, not eight ECharts instances, so a phone is told the same thing a
  // desktop is rather than a SECOND withheld notice ("Comparing a run
  // against its history is a desktop task") for content that was never
  // coming this session regardless of viewport.
  if (!terminal) {
    return <LiveNotice kind="withheld" subject="Trends" />;
  }

  if (compact && !shown) {
    return (
      <DesktopOnly compact what="Comparing a run against its history" onShow={() => setShown(true)}>
        {() => null}
      </DesktopOnly>
    );
  }

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
                {data.test?.name ?? data.simulation ?? 'this run'} so far, so there is nothing
                to compare it against yet.
              </p>
            )}

            {/* ═══ A RUN THAT BELONGS TO NO TEST SAYS SO ═══

                What stood here was the opposite sentence: "these runs are
                grouped because none of them carries a simulation name, not
                because they are known to be the same test." It was honest
                about a cohort that should never have existed — the old query
                matched NULL to NULL, so every run in a project whose header
                declared no simulation was trended against every other one,
                a failed checkout ingest beside a failed search ingest.

                Cohorting by test ends that: a run with no test is a cohort of
                exactly one. So the paragraph explaining the bad grouping is
                replaced by one naming the actual state, and the remedy — this
                is a run waiting to be identified, not a run mis-filed. */}
            {data.test === null && (
              <p className="text-[13px] text-muted">
                This run is not part of a test yet, so it has nothing to trend against. A run
                joins a test when its simulation name is read from the log — a run that failed
                to parse never gets one.
              </p>
            )}

            {/* THE ENTRY POINT TO COMPARE, and only when there is something
                to compare against. A control that is always present but
                usually useless teaches a reader to stop seeing it — and a
                cohort of one has no comparison to offer.

                The tab strip exposes Compare now, so the feature is not hidden
                from the app's top-level run navigation. This contextual link
                still belongs here because Trends is where the cohort is
                explained before the reader starts choosing runs. */}
            {data.runs.length > 1 && (
              <p className="flex flex-wrap items-center gap-2 text-[13px]">
                <Link to={runComparePath(data.runId)} className={linkButtonClasses}>
                  <CompareTabIcon className="h-3.5 w-3.5" />
                  Compare these runs
                </Link>{' '}
                <span className="text-muted">
                  Overlay up to {MAX_COMPARE} of them on one metric.
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
