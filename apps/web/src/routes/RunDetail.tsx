import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
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
import Chart from '../charts/Chart';
import DistributionChart from '../charts/DistributionChart';
import IndicatorsChart from '../charts/IndicatorsChart';
import PercentilesChart from '../charts/PercentilesChart';
import RequestCountChart from '../charts/RequestCountChart';
import { RequestRateChart, ResponseRateChart } from '../charts/RatesChart';
import { ConcurrentUsersChart, UserStartRateChart } from '../charts/UsersChart';
import type { ChartData } from '../charts/types';
import ErrorsTable from '../tables/ErrorsTable';
import StatisticsTable from '../tables/StatisticsTable';
import { formatStarted } from './format';
import { ASSERTION_OUTCOME, Marked, STATUS, VERDICT } from './marks';
import { DEFAULT_ROUTE } from './paths';

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
      <p role="status" className="text-[var(--color-text-muted)]">
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
          <p data-testid="problem-remediation" className="text-[var(--color-text-muted)]">
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
      <p className="text-[var(--color-text-muted)]">This address does not identify a run.</p>
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
      <p className="text-[var(--color-text-muted)]">
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
            className="rounded border border-[var(--color-border)] px-3 py-2"
          >
            Check again
          </button>
        </>
      ) : (
        <p className="text-[var(--color-text-muted)]">
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
          <p className="text-[var(--color-text-muted)]">{run.description}</p>
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
              <span className="ml-2 text-sm text-[var(--color-text-muted)]">
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

      <Assertions assertions={run.assertions} />

      {/* §13.2 ⑤ and ⑥, ABOVE THE CHART STACK (tables design §7, §10).
          Deliberately not in §13.2's own numeric order, which interleaves the
          tables between the charts: the numbers a reader came to read are the
          tables, the charts are how those numbers moved over the run, and
          scrolling past eight figures to reach the p99 of one request is the
          reading order nobody wants. The statistics table first and the errors
          table beneath it, because the second is a breakdown of the first's
          KO column. */}
      <Tables runId={run.id} />

      {/* Below the assertions, and inside this branch only. A processing run
          (202) renders `Processing` instead and never reaches here — which is
          what keeps the four metric queries from firing against a run whose
          rows do not exist yet, and is why `api/metrics.ts` can use `apiFetch`
          rather than `fetchRun`'s three-way status branch (design §6). The
          tables above are inside the same branch for the same reason. */}
      <Overview runId={run.id} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The two parity tables, §13.2 ⑤⑥
 * ------------------------------------------------------------------ */

/**
 * The statistics table and the errors table, each fed one already-validated
 * payload — the same division of labour `Overview` makes with the charts: this
 * component fetches, the tables render, and neither table knows what a URL is.
 *
 * `statsQuery` IS ASKED FOR TWICE ON THIS PAGE — here and in `Overview` — AND
 * FETCHED ONCE. Both call sites name the same `statsQueryKey`, so TanStack
 * Query serves one request and one cache entry to both, which is precisely what
 * the key convention in `api/metrics.ts` exists for. Hoisting the query into
 * `Ready` and threading the payload down would also work, and would make the
 * chart stack take a prop for one of its four payloads and fetch the other
 * three — a shape that reads as though the two mattered differently.
 */
function Tables({ runId }: { runId: string }) {
  const stats = useQuery(statsQuery(runId));
  const errors = useQuery(errorsQuery(runId));

  return (
    <>
      <TableSection title="Statistics" query={stats}>
        {(data) => <StatisticsTable stats={data} runId={runId} />}
      </TableSection>
      <TableSection title="Errors" query={errors}>
        {(data) => <ErrorsTable errors={data} />}
      </TableSection>
    </>
  );
}

/**
 * One table, or — until its payload arrives — its heading and the reason it is
 * not there.
 *
 * A TABLE WHOSE FETCH FAILED MUST NOT SIMPLY VANISH, for the same reason
 * `Payload` renders undrawn charts rather than nothing: the statistics table IS
 * the parity surface, and a page that quietly omits it looks exactly like a run
 * that recorded no requests. Both tables already have their own "nothing was
 * recorded" wording for an EMPTY payload, and that is a different sentence from
 * this one — one says the run had no errors, the other says we could not find
 * out.
 *
 * The heading is rendered here rather than left to the table so that it is
 * present in both cases; the tables render their own when they have data, which
 * is why this branch is the only one that draws it.
 */
function TableSection<T>({
  title,
  query,
  children,
}: {
  title: string;
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xl font-semibold">{title}</h2>
      {query.isPending ? (
        <p role="status" className="text-[var(--color-text-muted)]">
          Loading…
        </p>
      ) : (
        // `role="alert"`, not a muted paragraph: this is the run's numbers
        // failing to arrive, and the server's own `detail` and `remediation`
        // are what a reader can act on.
        <p role="alert">{explain(query.error, 'table')}</p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * The Gatling overview, §13.2 ③④⑦⑦ᵇ⑧⑨⑩⑪
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

/** A chart's stable identity, so a payload that never arrives can still render
 *  the figure — heading, explanation and data table — in its §13.2 position. */
interface Slot {
  readonly id: string;
  readonly title: string;
}

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
 */
function Overview({ runId }: { runId: string }) {
  const stats = useQuery(statsQuery(runId));
  const users = useQuery(usersQuery(runId));
  const distribution = useQuery(distributionQuery(runId));
  const series = useQuery(seriesQuery(runId));

  return (
    <section aria-labelledby="overview-heading" className="flex flex-col gap-8">
      <h2 id="overview-heading" className="text-xl font-semibold">
        Overview
      </h2>

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

/**
 * One payload's charts — or, until it arrives, the same figures saying why they
 * are not drawn.
 *
 * A CHART WHOSE FETCH FAILED MUST NOT SIMPLY VANISH. Rendering nothing leaves a
 * gap in a numbered sequence the reader cannot see is incomplete: §13.2's order
 * is itself information, and a missing ⑧ silently renumbers everything after
 * it. It also removes that chart's data table, which is the parity surface —
 * so a page whose distribution 404'd would quietly stop being assertable.
 *
 * This is reachable, not defensive: `GET /v1/runs/:id/distribution` answers
 * **404** for a completed run that has no histogram at all (ParityController),
 * where `/stats`, `/series` and `/users` all answer 200 with empty payloads and
 * let their transforms explain themselves. So on the same page, seven charts
 * say "no response times were recorded" and the eighth has an error to relay.
 * Both are the reader being told what happened; only the wording differs.
 */
function Payload<T>({
  query,
  slots,
  children,
}: {
  query: UseQueryResult<T>;
  /** The charts this payload feeds, in §13.2 order. */
  slots: readonly Slot[];
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;

  const reason = query.isPending ? 'Loading…' : explain(query.error, 'chart');

  return (
    <>
      {slots.map((slot) => (
        <Undrawn key={slot.id} slot={slot} reason={reason} />
      ))}
    </>
  );
}

/**
 * The server's own sentence, not an invented one — every `/v1` error carries a
 * `detail` and a `remediation` and both are more actionable than "something
 * went wrong". Same rule the error branch at the top of this file follows.
 *
 * `what` names the figure that is missing, and only reaches the reader in the
 * branch where there is no problem document to quote — a transport failure, or
 * a schema mismatch `apiFetch` threw on. It is a parameter rather than the
 * literal "chart" it used to be because the tables use this too, and a table
 * that apologised for a chart would be describing the wrong hole in the page.
 */
function explain(error: unknown, what: string): string {
  if (error instanceof ProblemError) return `${error.detail} ${error.remediation}`;
  return error instanceof Error
    ? `This ${what}’s data could not be loaded: ${error.message}`
    : `This ${what}’s data could not be loaded.`;
}

/**
 * A chart that cannot be drawn, drawn as a chart anyway: `Chart`'s own empty
 * branch, so the figure, the heading, the explanation and the data table are
 * the SAME markup a chart with an empty payload produces. A second, bespoke
 * "unavailable" shape here would be a second thing to keep accessible.
 */
function Undrawn({ slot, reason }: { slot: Slot; reason: string }) {
  // Memoised because `Chart`'s option effect depends on `data` by identity.
  const data = useMemo<ChartData>(
    () => ({ series: [], axisLabels: [], columns: [], rows: [], empty: reason }),
    [reason],
  );
  return <Chart id={slot.id} title={slot.title} data={data} />;
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
        <p className="text-[var(--color-text-muted)]">
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
        <caption className="pb-3 text-left text-sm text-[var(--color-text-muted)]">
          Every SLA rule evaluated against this run, as the rule read at the time it was evaluated.
          <em>Not applicable</em> means the rule could not be checked at all — it is not a pass.
        </caption>
        <thead>
          <tr className="border-b border-[var(--color-border)]">
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
              className="border-b border-[var(--color-border)]"
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

