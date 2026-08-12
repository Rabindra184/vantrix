import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Assertion, RunResponse } from '@perfportal/contracts';
import { ProblemError } from '../api/fetch';
import { POLL_CAP_MS, fetchRun, pollIntervalFor, runQueryKey } from '../api/run';
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
 * to static markup with both values of `capReached`. That test exists because
 * the cap UI below is otherwise unreachable from any suite: the only way to
 * reach it through `RunDetail` is to let two real minutes elapse in a browser.
 * Taking `capReached` as a prop rather than reading the timer itself is what
 * makes this component renderable without one.
 */
export function Processing({
  status,
  capReached,
  onRetry,
}: {
  status: string;
  capReached: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-2xl font-semibold">Run in progress</h1>
      <p role="status">This run is still processing.</p>
      <p className="text-[var(--color-text-muted)]">
        <Marked mark={STATUS[status === 'parsing' ? 'parsing' : 'pending']} />
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
    </div>
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

