import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { describeSlaOutcome, formatSlaMeasured } from '@perfportal/contracts';
import type { Assertion, StatRow, ToolAssertion } from '@perfportal/contracts';
import Button from '../components/Button';
import CollapsibleSection from '../components/CollapsibleSection';
import { DownloadIcon } from '../components/icons';
import { downloadCsv } from '../tables/csv';
import { assertionsCsv } from './assertionExport';
import { describeAssertionRuleForReader } from './assertions';
import { ASSERTION_OUTCOME, Marked } from './marks';
import { projectRulesPath } from './paths';
import { formatActual, toolAssertionParts } from './toolAssertion';
import { useWindowSuffix } from './useRunWindow';

type Outcome = 'passed' | 'failed' | 'not_applicable';

/**
 * GE's bar text ("1 assertion failed, 1 assertion successful"), in this
 * product's words (review N01: passed / failed / not applicable). Failed first
 * because it is what the reader opened the run to find; a zero is not said.
 */
export function outcomeSummary(items: readonly { readonly outcome: Outcome }[]): string {
  const count = (o: Outcome) => items.filter((i) => i.outcome === o).length;
  return (
    [
      [count('failed'), 'failed'],
      [count('passed'), 'passed'],
      [count('not_applicable'), 'not applicable'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(', ');
}

/** Failed first, then the rest in the order the run recorded them. */
function failedFirst<T extends { readonly outcome: Outcome }>(items: readonly T[]): readonly T[] {
  return [
    ...items.filter((i) => i.outcome === 'failed'),
    ...items.filter((i) => i.outcome !== 'failed'),
  ];
}

/**
 * The organisation's SLA rules, as GE's collapsible bar — one of TWO bars,
 * never merged with the simulation's own (review N01: two systems, decided by
 * different people).
 *
 * ONE DEVIATION FROM GE, AND IT IS THE POINT OF THE BAR: GE keeps its bar shut
 * even when an assertion failed (measured). Here a bar holding a failure opens
 * itself, so a failed gate is never a click away.
 *
 * Nothing to show keeps the decision band's three distinctions word for word,
 * because they are three different facts: not reported yet (live), not
 * evaluated (nothing ran — `rulesRan`), not configured (the project has no rule).
 *
 * THE TWO BRANCHES CARRY DIFFERENT `key`s, AND THAT IS WHAT MAKES THE DEVIATION
 * TRUE ON A LIVE RUN. `defaultOpen` is read once, at mount. A run opened while
 * streaming has `assertions === undefined` ("not reported yet", shut); when it
 * finishes with a failed gate this component re-renders into the populated
 * branch — and both branches return a `CollapsibleSection` at the same spot, so
 * without a key React keeps ONE instance, its state says shut, and the failure
 * is a click away on exactly the run where somebody was watching for it.
 */
export function PlatformGatesBar({
  runId,
  projectSlug,
  assertions,
  ran,
}: {
  readonly runId: string;
  readonly projectSlug?: string;
  readonly assertions: readonly Assertion[] | undefined;
  readonly ran: boolean;
}) {
  if (assertions === undefined || !ran || assertions.length === 0) {
    const words =
      assertions === undefined
        ? 'not reported yet'
        : !ran
          ? 'not evaluated — the run left nothing to judge'
          : 'not configured — no SLA rule judged this run';
    return (
      <CollapsibleSection
        key="nothing-to-show"
        id="platform-gates"
        title="Platform gates"
        summary={words}
      >
        {() =>
          assertions !== undefined && ran ? (
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[0.8125rem] text-muted">
              <span>No SLA rules judged this run — adding one affects future runs, not this one.</span>
              {projectSlug !== undefined && (
                <Link
                  to={projectRulesPath(projectSlug)}
                  className="font-medium text-accent underline-offset-2 hover:underline"
                >
                  Configure SLA rules
                </Link>
              )}
            </p>
          ) : (
            <p className="text-[0.8125rem] text-muted">
              {assertions === undefined
                ? 'Platform gates are judged once the run finishes.'
                : 'The run stopped before anything could be processed, so no SLA rule ran.'}
            </p>
          )
        }
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection
      key="judged"
      id="platform-gates"
      title="Platform gates"
      defaultOpen={assertions.some((a) => a.outcome === 'failed')}
      summary={outcomeSummary(assertions)}
      actions={
        <Button size="sm" onClick={() => downloadCsv(`run-${runId}-assertions.csv`, assertionsCsv(assertions))}>
          <DownloadIcon className="h-3.5 w-3.5" />
          Export CSV
        </Button>
      }
    >
      {() => (
        <ul className="flex flex-col gap-2">
          {failedFirst(assertions).map((a) => (
            <li
              key={a.ruleId}
              data-testid="gate-card"
              className="flex flex-col gap-1 rounded-lg border border-default bg-sunken px-3 py-2"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-primary">{describeAssertionRuleForReader(a.rule)}</span>
                <span data-testid="gate-outcome">
                  <Marked mark={ASSERTION_OUTCOME[a.outcome]} />
                </span>
              </div>
              {/* The same two cells the gates table carried: the measured
                  value through the rule's own formatter, and the outcome in
                  words — the stored message only for a not-applicable gate.
                  A dash, never `0`, where nothing was measured. A
                  MEASUREMENT, so it is rounded for reading and widened where
                  rounding would make it read as equal to the rule's own bound
                  in the line above — `Actual: 100 ms` under `≤ 100 ms` on a
                  gate that FAILED is the contradiction the guard prevents. */}
              <p className="text-[0.8125rem] tabular-nums text-primary">
                Actual:{' '}
                {a.actualValue === null ? '—' : formatSlaMeasured(a.rule.metric, a.actualValue, a.rule.threshold)}
              </p>
              <p className="text-[0.8125rem] text-muted">{describeSlaOutcome(a) ?? a.message}</p>
            </li>
          ))}
        </ul>
      )}
    </CollapsibleSection>
  );
}

/**
 * The assertions the SIMULATION declared — Appendix A G-05 — as GE's second
 * bar, beside the platform's and never merged with it. A card is GE's card
 * ("Global: 95th percentile … — Succeeded with value 20"): the tool's own
 * sentence verbatim (G-05's tolerance is exact WORDING, and it is the only
 * thing that can describe an assertion shape this build does not recognise),
 * then the outcome, the actual with its unit, and the target link.
 *
 * NULL AND [] ARE DIFFERENT, AND ONLY ONE OF THEM DRAWS. `[]` is a fact: the
 * simulation declared none, and the bar says so. `null` is the absence of one —
 * the run was ingested before the decoder existed, so its definitions were
 * discarded and survive only in the raw bundle. Nothing true can be said about
 * it, so the bar is omitted rather than reading as "this simulation had none".
 */
export function SimulationAssertionsBar({
  runId,
  assertions,
  stats,
}: {
  readonly runId: string;
  readonly assertions: readonly ToolAssertion[] | null | undefined;
  /** This run's statistics rows, or null until they load. */
  readonly stats: readonly StatRow[] | null;
}) {
  /* ═══ WHICH NAMES THIS RUN CAN ACTUALLY DRILL INTO ═══
   *
   * BEFORE the early returns: a hook cannot sit behind one. CLAUDE.md records
   * this exact shape — "Rendered more hooks than during the previous render" —
   * being shipped twice on the run page, and `assertions` does flip from
   * undefined to a list while a run loads.
   *
   * A Gatling `details(...)` path can name a request or a group and the log
   * does not say which — `rowFor` in `@perfportal/statistics` resolves it by
   * trying `request <name>` and then `group <name>` against the run's own
   * statistics, and this mirrors that exactly so a link cannot disagree with
   * the evaluation it sits beside. A name in neither gets NO link, which is
   * the honest answer: that is the `not_applicable` row, and sending a reader
   * to a page that will tell them the request does not exist is a dead end.
   *
   * ═══ THE FAMILY FILTER IS PART OF THE MIRROR, NOT A TIDY-UP ═══
   *
   * A request and the run live in `response_time`; a GROUP has no row in that
   * family at all, because `engine.ts` files a group's timings under
   * `group_cumulated` and `group_duration`. `rowFor` reads BOTH — one family
   * per scope — and so does this. Both moved together when the evaluator
   * learned to resolve groups, which is the only arrangement in which the link
   * and the verdict cannot disagree — see `evaluateToolAssertions`, whose
   * comment carries the measurements.
   */
  const recorded = useMemo(() => {
    const byName = new Map<string, 'requests' | 'groups'>();
    for (const row of stats ?? []) {
      // REQUEST WINS, in the same order `rowFor` tries them: a name that is
      // both resolves to the request, so the link has to go there too.
      if (row.scope === 'request' && row.family === 'response_time') {
        byName.set(row.name, 'requests');
      } else if (
        row.scope === 'group' &&
        row.family === 'group_cumulated' &&
        !byName.has(row.name)
      ) {
        byName.set(row.name, 'groups');
      }
    }
    return byName;
  }, [stats]);

  if (assertions === null || assertions === undefined) return null;

  if (assertions.length === 0) {
    return (
      <CollapsibleSection id="simulation-assertions" title="Simulation assertions" summary="none declared">
        {() => (
          <p className="text-[0.8125rem] text-muted">
            This simulation declared no assertions. Assertions are written in the simulation itself
            and read from the result file; this run’s tool reported none.
          </p>
        )}
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection
      id="simulation-assertions"
      title="Simulation assertions"
      defaultOpen={assertions.some((a) => a.outcome === 'failed')}
      summary={outcomeSummary(assertions)}
    >
      {() => (
        <ul className="flex flex-col gap-2">
          {failedFirst(assertions).map((a, i) => (
            // The expression is not unique — a simulation may assert the same
            // thing twice, and `forAll` expands to one row per request with
            // only the name differing. The index is the card's identity because
            // this list is a fixed projection of the run's own order.
            <li
              key={`${a.expression}-${i}`}
              data-testid="simulation-card"
              className="flex flex-col gap-1 rounded-lg border border-default bg-sunken px-3 py-2"
            >
              <p className="font-mono text-[0.75rem] text-primary">{a.expression}</p>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[0.8125rem]">
                <span data-testid="simulation-outcome">
                  <Marked mark={ASSERTION_OUTCOME[a.outcome]} />
                </span>
                {/* WITH ITS UNIT. A bare 2643 left the reader to know it is
                    milliseconds — and `not_applicable` still renders a dash,
                    never a zero, because nothing was measured. */}
                <span className="tabular-nums text-primary">Actual: {formatActual(a)}</span>
                {toolAssertionParts(a).target !== null && (
                  <span className="text-muted">
                    Target: <AssertionTarget assertion={a} runId={runId} recorded={recorded} />
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </CollapsibleSection>
  );
}

/**
 * The Target — a link into that request's or group's own analysis when this
 * run recorded one, and plain text when it did not. (review 09-13 M13)
 *
 * ═══ WHY THIS IS NOT JUST `<Link to={...}>` ═══
 *
 * Three of the four target shapes have nowhere to go. `global` is the run,
 * which is the page the reader is already on; `forAll` ranges over every
 * request rather than naming one, and the row's own request name survives only
 * in the tool's prose, which `toolAssertion.ts` exists specifically not to
 * parse. Only a `details` path names something, and even then only when this
 * run has a row for it — a `not_applicable` row names a request that is not
 * there, and a link is the last thing it should offer.
 *
 * THE WINDOW TRAVELS WITH THE LINK, as it does from the statistics table's rows.
 * The Summary never APPLIES a window, but its URL can carry `from`/`to` —
 * every tab link carries them, so a reader arrives here from a windowed Report
 * with them in the address bar — and a drill-down built from the bare path
 * would drop them: the request page's "Back to this run" and the Report tab
 * beside it would then have lost the interval they came with.
 * `useWindowSuffix` owns which parameters travel.
 *
 * (This was a copy while `RunDetail.tsx` still rendered the table that owned the
 * original; that table went with the Overview tab, and this is the only one.)
 */
function AssertionTarget({
  assertion,
  runId,
  recorded,
}: {
  readonly assertion: ToolAssertion;
  readonly runId: string;
  readonly recorded: ReadonlyMap<string, 'requests' | 'groups'>;
}) {
  // Above the early returns: the hook order must not depend on the assertion.
  const windowSuffix = useWindowSuffix();
  const label = toolAssertionParts(assertion).target;
  if (label === null) return <>—</>;

  /* THE IDENTITY IS JOINED WITH NO SPACES and the LABEL with them — `Cart /
     Search` reads as a path and `Cart/Search` is one. `rowFor` in
     `@perfportal/statistics` and `buildTree`'s own `SEPARATOR` both use the
     bare form, so that is what a row is keyed and addressed by. */
  const parts = assertion.assertion?.path.parts;
  const name = parts === undefined || parts.length === 0 ? null : parts.join('/');
  const section = name === null ? undefined : recorded.get(name);
  if (name === null || section === undefined) return <>{label}</>;

  return (
    <Link
      to={`/runs/${encodeURIComponent(runId)}/${section}/${encodeURIComponent(name)}${windowSuffix}`}
      className="underline"
    >
      {label}
    </Link>
  );
}
