import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Assertion, RunProcessing, RunResponse } from '@perfportal/contracts';
import { ProblemError } from '../api/fetch';
import {
  distributionQuery,
  errorsQuery,
  seriesQuery,
  statsQuery,
  usersQuery,
} from '../api/metrics';
import { POLL_CAP_MS, fetchRun, pollIntervalFor, runQueryKey } from '../api/run';
import DistributionChart from '../charts/DistributionChart';
import IndicatorsChart from '../charts/IndicatorsChart';
import PercentilesChart from '../charts/PercentilesChart';
import RequestCountChart from '../charts/RequestCountChart';
import { RequestRateChart, ResponseRateChart } from '../charts/RatesChart';
import { ConcurrentUsersChart, UserStartRateChart } from '../charts/UsersChart';
import ErrorsTable from '../tables/ErrorsTable';
import StatisticsTable from '../tables/StatisticsTable';
import { formatStarted } from './format';
import { ASSERTION_OUTCOME, Marked, STATUS, VERDICT } from './marks';
import { DEFAULT_ROUTE } from './paths';
import { Payload, TableSection, type Slot } from './payload';
import RunShell from './RunShell';
import RunStats from './RunStats';

/**
 * One run: its header, and the SLA rules that were evaluated against it.
 *
 * The last screen of the parity shell, and the end of the definition of done
 * — a person signs in, sees their org's runs, opens one, and reads it.
 *
 * Three states, not two, because `GET /v1/runs/:id` has three answers (see
 * `fetchRun`): a readable run, a run still being processed, and a problem.
 * Collapsing the middle one into the first is what would put `0s` and "no
 * verdict yet" on screen as though they were measurements.
 */
export default function RunDetail() {
  const { runId } = useParams<{ runId: string }>();

  // The polling cap, held as state rather than computed at render time. A
  // derived `Date.now() - start > CAP` would be correct only at the moments
  // something else happens to re-render — and the whole point of the cap is
  // the moment polling STOPS, when by definition nothing else is happening.
  // A timer that sets state is what makes the message appear when it is true
  // rather than at the next unrelated render.
  const [capReached, setCapReached] = useState(false);
  useEffect(() => {
    // Reset the FLAG as well as the timer. `[runId]` already says this
    // component instance can outlive the run it was showing (two /runs/:runId
    // locations in a row, no unmount); without this line, a second run opened
    // after the first hit the cap renders "stopped checking automatically" on
    // its first paint and never polls once.
    //
    // COVERED, finally, by `apps/web/test/RunDetail.polling.test.tsx` — both
    // halves: the timer that sets the flag, and this line that resets it for a
    // second run. That test mounts this component in jsdom and advances fake
    // timers past POLL_CAP_MS, which is what makes the two real minutes the
    // cap needs cost nothing. Until the DOM environment existed this effect
    // had no test that could fail; deleting it left every suite green.
    setCapReached(false);
    const timer = setTimeout(() => setCapReached(true), POLL_CAP_MS);
    return () => clearTimeout(timer);
  }, [runId]);

  const run = useQuery({
    queryKey: runQueryKey(runId ?? ''),
    queryFn: () => fetchRun(runId!),
    enabled: runId !== undefined,
    // The decision lives in api/run.ts as a pure function so the cap is
    // testable without waiting two real minutes in a browser.
    refetchInterval: (query) => pollIntervalFor(query.state.data, capReached),
  });

  // Not reachable through the router — `/runs/:runId` cannot match without a
  // segment — but `useParams` is typed as optional and silently rendering an
  // empty page for `undefined` would be worse than saying so.
  if (runId === undefined) return <NotARun />;

  if (run.isPending) {
    return (
      <p role="status" className="text-muted">
        Loading run…
      </p>
    );
  }

  if (run.isError) {
    // Show what the server said — including the `remediation` every `/v1`
    // error is required to carry — rather than inventing copy. The 404 for a
    // run in another org arrives here, and the API's own sentence ("No run
    // <id> in this project.") is a better answer than a guess at one.
    const error = run.error;
    const problem = error instanceof ProblemError ? error : null;
    return (
      <div role="alert" className="flex flex-col items-start gap-2">
        <h1 className="text-2xl font-semibold">This run could not be loaded</h1>
        <p>{problem?.detail ?? error.message}</p>
        {problem !== null && (
          <p data-testid="problem-remediation" className="text-muted">
            {problem.remediation}
          </p>
        )}
        <BackToRuns />
      </div>
    );
  }

  if (run.data.state === 'processing') {
    return <Processing status={run.data.run.status} capReached={capReached} onRetry={() => void run.refetch()} />;
  }

  return <Ready run={run.data.run} />;
}

function NotARun() {
  return (
    <div role="alert" className="flex flex-col items-start gap-2">
      <h1 className="text-2xl font-semibold">No run was named</h1>
      <p className="text-muted">This address does not identify a run.</p>
      <BackToRuns />
    </div>
  );
}

function BackToRuns() {
  return (
    <Link to={DEFAULT_ROUTE} className="underline">
      Back to all runs
    </Link>
  );
}

/**
 * A run the platform has accepted but not finished parsing (HTTP 202).
 *
 * Deliberately renders NO header shell: there is no duration, no verdict and
 * no assertion to show, and a table of dashes reads as a run that was
 * measured and found empty rather than one nobody has looked at yet.
 *
 * EXPORTED for `apps/web/test/run-detail.test.ts`, which renders it directly
 * to static markup with both values of `capReached` — a cheap, node-environment
 * check that the two branches say different things. The cap's WIRING (the
 * timer in `RunDetail` that sets the flag) is covered separately, and through a
 * real mount, by `apps/web/test/RunDetail.polling.test.tsx`.
 *
 * Taking `capReached` as a prop rather than reading the timer itself is still
 * the right shape: it keeps this component renderable without a clock.
 */
export function Processing({
  status,
  capReached,
  onRetry,
}: {
  // `RunProcessing['status']` — 'pending' | 'parsing' — not `string`. The
  // contract's own union is what makes a future third processing status a
  // compile error here rather than a silent render of the 'pending' mark.
  status: RunProcessing['status'];
  capReached: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-2xl font-semibold">Run in progress</h1>
      <p role="status">This run is still processing.</p>
      <p className="text-muted">
        <Marked mark={STATUS[status]} />
      </p>
      {capReached ? (
        // The cap has been reached: the page has stopped asking on its own.
        // Saying so — and handing the reader the control — is the difference
        // between a page that gave up and a page that appears to be working
        // while making no requests at all.
        <>
          <p>
            PerfPortal stopped checking automatically after two minutes. The run has not finished
            yet.
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-default px-3 py-2"
          >
            Check again
          </button>
        </>
      ) : (
        <p className="text-muted">
          This page checks again every few seconds; there is nothing to do.
        </p>
      )}
      <BackToRuns />
    </div>
  );
}

function Ready({ run }: { run: RunResponse }) {
  // The tool's own start when the parser has produced it, ingest time
  // otherwise — the same rule, spelled the same way, as the run list's
  // `startedAt` (RunList.tsx's RunRow). The two screens must not disagree
  // about when a run started.
  const startedAt = run.toolStartedAt ?? run.startedAt;
  const isIngestTime = run.toolStartedAt == null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        {/* The simulation is the run's identity to the person who ran it, so
            it is the heading. Rendered fully-qualified, exactly as the tool
            reported it (`example.ParitySimulation`), rather than trimmed to
            the class name: two simulations in different packages can share a
            class name, and truncating identity to save a few characters is
            how two different runs come to look like the same one. Falls back
            to the short id for a run whose header carried no simulation. */}
        <h1 className="text-2xl font-semibold">{run.simulation ?? `Run ${run.id.slice(0, 8)}`}</h1>
        {run.description != null && run.description !== '' && (
          <p className="text-muted">{run.description}</p>
        )}

        {/* A description list, not a grid of divs: these are name/value pairs
            and <dt>/<dd> is what tells a screen reader that "Duration" names
            "61s" rather than merely preceding it. */}
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
          <Field label="Tool">{run.toolVersion ? `${run.tool} ${run.toolVersion}` : run.tool}</Field>
          <Field label={isIngestTime ? 'Received' : 'Started'}>
            {/* <time dateTime> carries the machine-readable instant beside
                the human one; the text itself is localised. Same treatment as
                the run list. */}
            <time dateTime={startedAt}>{formatStarted(startedAt)}</time>
            {isIngestTime && (
              <span className="ml-2 text-sm text-muted">
                ingest time — the tool reported no start
              </span>
            )}
          </Field>
          <Field label="Duration">
            <span data-testid="run-duration">{formatDuration(run.durationMs)}</span>
          </Field>
          <Field label="Status">
            <span data-testid="run-status">
              <Marked mark={STATUS[run.status]} />
            </span>
          </Field>
          <Field label="Verdict">
            <span data-testid="run-verdict">
              <Marked mark={VERDICT[run.verdict ?? 'none']} />
            </span>
          </Field>
        </dl>
      </header>

      {/* The run's three tabs — design §3, §6. `RunShell` is a LAYOUT ROUTE:
          it mounts once here, inside this branch only, and its `<Outlet/>`
          is what swaps between `RunOverviewTab`, `RunChartsTab` and
          `RunErrorsTab` as the URL's last segment changes. A processing run
          (202) renders `Processing` instead and never reaches here — which
          is what keeps the tab content's metric queries from firing against
          a run whose rows do not exist yet (design §3c), and is why
          `api/metrics.ts` can use `apiFetch` rather than `fetchRun`'s
          three-way status branch (design §6). */}
      <RunShell run={run} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The Overview tab (index), §13.2 ⑤ and the assertions — design §6
 * ------------------------------------------------------------------ */

/**
 * `/runs/:runId`, the index child under `RunShell` (design §3, §6).
 *
 * Assertions, then the stat tiles, then the statistics table: the numbers a
 * reader came to read and the SLA verdict beside them, all on the tab that
 * opens first. `RunChartsTab` and `RunErrorsTab` hold the eight figures and
 * the errors table respectively — moved out to their own tabs rather than
 * left on this one, which is what keeps the landing tab to the reading order
 * `RunDetail.tsx` already argued for: "scrolling past eight figures to reach
 * the p99 of one request is the reading order nobody wants."
 *
 * READS `runId` FROM `useParams`, not a prop — the same pattern
 * `RequestDetail` and `GroupDetail` already use, and the reason `RunShell`'s
 * `<Outlet/>` carries no context (see its own docstring). Assertions live
 * only on the run body, so this re-asks for `runQueryKey(runId)` — the SAME
 * key `RunDetail` already holds warm from its own poll, so this resolves
 * from cache rather than firing a second request, exactly as `statsQuery`
 * already does across this page's components.
 */
export function RunOverviewTab() {
  const { runId } = useParams<{ runId: string }>();
  const run = useQuery({
    queryKey: runQueryKey(runId ?? ''),
    queryFn: () => fetchRun(runId!),
    enabled: runId !== undefined,
  });
  const stats = useQuery({ ...statsQuery(runId ?? ''), enabled: runId !== undefined });

  // Not reachable through the router: `RunShell` mounts this tab only once
  // `RunDetail` has already resolved a `ready` run for this `runId`, and the
  // query above is then served from that same warm cache entry. Guarded
  // anyway so a render that somehow beat the cache is a blank tab rather than
  // a crash on `run.data.run`.
  if (runId === undefined || run.data === undefined || run.data.state !== 'ready') return null;

  return (
    <>
      <Assertions assertions={run.data.run.assertions} />

      {/* `RunStats` renders INSIDE `TableSection`'s own children callback,
          from the SAME `data` the statistics table reads below it, rather
          than behind a `TableSection` of its own: a failed or still-pending
          `/stats` then explains itself once, in the one place this page
          already says so, instead of the stat row silently rendering six
          dashes above an error the reader has to notice separately. */}
      <TableSection title="Statistics" query={stats}>
        {(data) => (
          <>
            <RunStats stats={data} />
            <StatisticsTable stats={data} runId={runId} />
          </>
        )}
      </TableSection>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The Errors tab, §13.2 ⑥ — design §6
 * ------------------------------------------------------------------ */

/**
 * `/runs/:runId/errors`, a child under `RunShell` (design §3, §6).
 *
 * Its own fetch rather than a share of `RunOverviewTab`'s: `koCount` on the
 * run-scope stats row is failed REQUESTS, a different number from the count
 * of DISTINCT error messages this tab is about, and only `/errors` knows the
 * second one.
 */
export function RunErrorsTab() {
  const { runId } = useParams<{ runId: string }>();
  const errors = useQuery({ ...errorsQuery(runId ?? ''), enabled: runId !== undefined });

  return (
    <TableSection title="Errors" query={errors}>
      {(data) => <ErrorsTable errors={data} />}
    </TableSection>
  );
}

/* ------------------------------------------------------------------ *
 * The Charts tab, §13.2 ③④⑦⑦ᵇ⑧⑨⑩⑪ — design §6
 * ------------------------------------------------------------------ */

/**
 * THE ONE CROSSHAIR. Every chart whose x-axis is elapsed seconds carries this
 * `group`, and `Chart` calls `echarts.connect` with it, so hovering any one of
 * them moves the axis pointer on all of them.
 *
 * That linkage is not a nicety, it is the PRD's deliberate encoding change:
 * Gatling overlays active users on requests/s as a second y-axis, §22.4 forbids
 * dual axes outright, and Appendix A records the split as information parity
 * precisely BECAUSE the shared crosshair recovers the "read these two together"
 * affordance the dual axis was buying. Break the connection and the two charts
 * stop being one reading — which is what the e2e crosshair spec exists to catch.
 *
 * `PercentilesChart` and both rate charts hard-code the same string internally
 * (they have no `group` prop to pass one through); the two users charts take it
 * as a prop. Stated here as a named constant so the five agree on one spelling.
 */
const RUN_TIME = 'run-time';

const INDICATORS: Slot = { id: 'indicators', title: 'Response time ranges' };
const REQUEST_COUNTS: Slot = { id: 'request-counts', title: 'Number of requests' };
const CONCURRENT_USERS: Slot = { id: 'concurrent-users', title: 'Concurrent users over time' };
const USER_START_RATE: Slot = { id: 'user-start-rate', title: 'Users started per second' };
const DISTRIBUTION: Slot = { id: 'distribution', title: 'Response time distribution' };
const PERCENTILES: Slot = { id: 'percentiles', title: 'Response time percentiles over time' };
const REQUESTS_PER_SECOND: Slot = {
  id: 'requests-per-second',
  title: 'Requests per second over time',
};
const RESPONSES_PER_SECOND: Slot = {
  id: 'responses-per-second',
  title: 'Responses per second over time',
};

/**
 * `/runs/:runId/charts`, a child under `RunShell` (design §3, §6).
 *
 * Four fetches, eight charts (design §2) — and the charts do the fetching
 * nowhere: this is the only component on the page that calls a query factory,
 * and every chart below receives an already-validated payload as a prop.
 *
 * `/stats` feeds ③ and ④, `/users` feeds ⑦ and ⑦ᵇ, `/distribution` feeds ⑧, and
 * `/series` feeds ⑨, ⑩ and ⑪. That grouping is why §13.2's order can be
 * rendered as four blocks rather than eight: each payload's charts happen to be
 * adjacent in it, so no chart is displaced to keep a fetch tidy. If a future
 * chart broke that adjacency, the ORDER wins and this component grows a fifth
 * block — never the other way round.
 *
 * `aria-label="Charts"`, not an `<h2>` with `aria-labelledby`: a tab named
 * Charts directly above a heading that also said Charts (or, before the tab
 * strip existed, "Overview") would say it twice. The tab itself (Task 2's
 * `RunTabs`) is this section's name for a sighted and a screen-reader user
 * alike.
 */
export function RunChartsTab() {
  const { runId } = useParams<{ runId: string }>();
  const stats = useQuery({ ...statsQuery(runId ?? ''), enabled: runId !== undefined });
  const users = useQuery({ ...usersQuery(runId ?? ''), enabled: runId !== undefined });
  const distribution = useQuery({
    ...distributionQuery(runId ?? ''),
    enabled: runId !== undefined,
  });
  const series = useQuery({ ...seriesQuery(runId ?? ''), enabled: runId !== undefined });

  return (
    <section aria-label="Charts" className="flex flex-col gap-8">
      <Payload query={stats} slots={[INDICATORS, REQUEST_COUNTS]}>
        {(data) => (
          <>
            <IndicatorsChart stats={data} />
            <RequestCountChart stats={data} />
          </>
        )}
      </Payload>

      <Payload query={users} slots={[CONCURRENT_USERS, USER_START_RATE]}>
        {(data) => (
          <>
            {/* Its OWN chart, sharing the crosshair — never an overlay on
                requests/s. See RUN_TIME above. */}
            <ConcurrentUsersChart users={data} group={RUN_TIME} />
            <UserStartRateChart users={data} group={RUN_TIME} />
          </>
        )}
      </Payload>

      <Payload query={distribution} slots={[DISTRIBUTION]}>
        {(data) => <DistributionChart distribution={data} />}
      </Payload>

      <Payload query={series} slots={[PERCENTILES, REQUESTS_PER_SECOND, RESPONSES_PER_SECOND]}>
        {(data) => (
          <>
            <PercentilesChart series={data} />
            <RequestRateChart series={data} />
            <ResponseRateChart series={data} />
          </>
        )}
      </Payload>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-semibold">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * The SLA rules evaluated against this run, in a real `<table>` with real
 * `<th scope="col">` headers — tabular data, and the header/cell relationship
 * is what makes a row comprehensible to a screen reader announcing its third
 * column.
 *
 * Row order is the API's: `RunsService.toResponse` orders by outcome, which
 * puts `failed` first. The thing a reader opened an SLA-failed run to see is
 * at the top of the table without this component sorting anything.
 */
function Assertions({ assertions }: { assertions: readonly Assertion[] }) {
  if (assertions.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">Assertions</h2>
        <p>No SLA rules were evaluated against this run.</p>
        <p className="text-muted">
          Rules are configured per project, and only rules that existed when the run was ingested
          are applied to it.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xl font-semibold">Assertions</h2>
      <table className="w-full border-collapse text-left">
        <caption className="pb-3 text-left text-sm text-muted">
          Every SLA rule evaluated against this run, as the rule read at the time it was evaluated.
          <em>Not applicable</em> means the rule could not be checked at all — it is not a pass.
        </caption>
        <thead>
          <tr className="border-b border-default">
            <th scope="col" className="py-2 pr-4 font-semibold">
              Outcome
            </th>
            <th scope="col" className="py-2 pr-4 font-semibold">
              Rule
            </th>
            <th scope="col" className="py-2 pr-4 font-semibold">
              Actual
            </th>
            <th scope="col" className="py-2 font-semibold">
              What happened
            </th>
          </tr>
        </thead>
        <tbody>
          {assertions.map((assertion) => (
            <tr
              key={assertion.ruleId}
              data-testid="assertion-row"
              className="border-b border-default"
            >
              <td data-testid="assertion-outcome" className="py-2 pr-4">
                <Marked mark={ASSERTION_OUTCOME[assertion.outcome]} />
              </td>
              <td className="py-2 pr-4">{describeRule(assertion.rule)}</td>
              {/* Null for a not_applicable assertion — there was nothing to
                  measure (AssertionSchema). A dash, never `0`: zero is a
                  measurement, and this is the absence of one. */}
              <td className="py-2 pr-4">{assertion.actualValue ?? '—'}</td>
              <td className="py-2">{assertion.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * The rule in the same words the evaluator used when it wrote the assertion's
 * message (`describe` in packages/sla/src/evaluate.ts). Restated here rather
 * than parsed back out of that message: the structured `rule` snapshot is the
 * fact, and a UI that read prose to recover data it already has would break
 * the day the prose was reworded.
 */
function describeRule(rule: Assertion['rule']): string {
  const target = rule.targetName ?? 'the run';
  const comparator = rule.comparator === 'lte' ? '≤' : '≥';
  return `${rule.metric} of ${target} (${rule.family}) ${comparator} ${rule.threshold}`;
}

/**
 * Whole seconds, matching what Gatling's own run header shows (G-04).
 *
 * `Math.round`, not `Math.floor`: flooring reports a 1,900ms run as "1s",
 * which is wrong by nearly a second in the one direction a reader is least
 * likely to question. Rounding is wrong by at most half a second either way.
 *
 * `durationMs` is nullable in the contract — a run whose header the parser
 * never produced has no duration at all — and an explicit dash is the honest
 * rendering of that. `0s` would assert a measurement that was never taken,
 * and `NaNs` would assert nothing at all.
 */
function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs == null) return '—';
  return `${Math.round(durationMs / 1000)}s`;
}

