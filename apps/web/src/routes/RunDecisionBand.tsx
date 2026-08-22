import type { Assertion, RunIdentity, RunResponse, RunVerdict } from '@perfportal/contracts';
import { Link } from 'react-router-dom';
import Badge from '../components/Badge';
import { CompareTabIcon, DownloadIcon } from '../components/icons';
import Button, { linkButtonClasses } from '../components/Button';
import { ASSERTION_OUTCOME, STATUS, VERDICT, type Mark } from './marks';
import { countAssertions, firstFailedAssertion, type AssertionCounts } from './assertions';
import { runComparePath } from './paths';
import { downloadRunSummary, runSummaryJson } from './runExport';

/**
 * `unevaluated` IS NOT `none`, AND COLLAPSING THEM IS THE BUG THIS TYPE
 * EXISTS TO PREVENT.
 *
 * `RunShell`'s `verdict` prop states the rule: "`undefined` means NOT
 * EVALUATED YET and omits the badge; `null` means evaluated with no
 * verdict." `RunHeader` has always honoured it — a pending or running run
 * gets no verdict badge at all, because "no verdict yet" reads as
 * evaluated-and-nothing-found, a claim about a run nobody has finished
 * measuring. This band shipped rendering `VERDICT.none` for BOTH, which put
 * that exact claim one element below the header that omits it.
 *
 * So `unevaluated` has no `Mark`: there is nothing honest to stamp.
 */
type Decision = RunVerdict | 'none' | 'unevaluated';

const DECISION: Record<Exclude<Decision, 'unevaluated'>, Mark> = {
  passed: VERDICT.passed,
  failed: VERDICT.failed,
  not_evaluated: VERDICT.not_evaluated,
  none: VERDICT.none,
};

export default function RunDecisionBand({
  identity,
  status,
  verdict,
  assertions,
}: {
  readonly identity: Partial<RunIdentity> & { readonly id: string };
  readonly status: RunResponse['status'];
  readonly verdict: RunResponse['verdict'] | undefined;
  /**
   * `undefined` until the run has been evaluated — NOT an empty array. The
   * counts below are drawn only when this is present, for the same reason
   * `RunShell` passes `null` rather than `0` for an error count that has not
   * arrived: three zeros are three measurements, and nobody took them.
   */
  readonly assertions?: readonly Assertion[];
}) {
  const evaluated = assertions !== undefined;
  const counts = countAssertions(assertions ?? []);
  const failed = firstFailedAssertion(assertions ?? []);
  const decision: Decision = verdict === undefined ? 'unevaluated' : (verdict ?? 'none');
  const word = decisionWord(decision, counts);
  const detail = failed?.message ?? decisionDetail(decision, counts);
  const runId = identity.id;
  const exportRun = () =>
    downloadRunSummary(
      `perfportal-${runId}-run.json`,
      runSummaryJson({ identity, status, verdict, assertions }),
    );

  return (
    <section
      aria-label="Release decision"
      className="overflow-hidden rounded-xl border border-default bg-surface shadow-panel"
    >
      <div className="grid grid-cols-1 gap-0 lg:grid-cols-[minmax(9rem,auto)_minmax(0,1fr)_minmax(18rem,auto)]">
        {/* THE VERDICT WORD — the redesign's signature, and NOT AN `<h2>`,
            though it is the largest text on the page. This band is SHELL
            CHROME — `RunShell` renders it above the `<Outlet/>`, so it is on
            all five tabs — and every `<h2>` on this page belongs to the tab
            CONTENT's own sections (`run-tables.spec.ts` asserts the Overview
            tab's outline is exactly Assertions / Simulation assertions /
            Statistics, and the Errors tab's is exactly Errors). Its two
            neighbours in the shell, `SlaBanner` and `LiveStatusStrip`,
            contribute no heading for the same reason; `RunHeader` owns the
            one `<h1>`. It would also be the only heading whose WORDS change
            per run. The section stays reachable through
            `aria-label="Release decision"`, like both neighbours.

            The word's colour is the decision mark's TEXT colour — the
            4.5:1-gated palette, as inline style from mark data, the same
            route `Badge` takes — and colour is never the only signal: the
            WORD differs per state, and the overline beneath names what it
            is a verdict OF. Reading order is word then overline —
            "Failed — release gate" — which is the verdict-first order the
            whole band exists to put on screen. */}
        <div className="flex min-w-0 flex-col justify-center gap-1 border-b border-divider p-4 lg:border-r lg:border-b-0 lg:p-5">
          {/* 36px, rising to 48px from `sm`. The first cut was 30px flat and
              read as a large label rather than as the page's verdict — this
              band is the one place the redesign spends size, and at 30px the
              `<h1>` above it (24px) was close enough to compete. It stays
              BELOW the heading in the document's semantics and above it in
              the type scale, which is the whole point of shell chrome that
              answers ship/no-ship. `break-words` because "Not evaluated" is
              two words and must wrap inside its column rather than widen it. */}
          <p
            className="font-display text-4xl leading-none font-semibold tracking-tight break-words sm:text-5xl"
            style={{ color: decisionColour(decision, counts) }}
          >
            {word}
          </p>
          {/* An overline, not a heading — same rule as `ProjectRail`'s
              "Projects" label, and `uppercase` is safe here for the same
              reason: nothing queries a `<p>` by accessible name. */}
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Release gate
          </p>
        </div>

        <div className="flex min-w-0 flex-col justify-center gap-2.5 border-b border-divider p-4 lg:border-r lg:border-b-0 lg:p-5">
          <div className="flex flex-wrap items-center gap-2">
            {decision !== 'unevaluated' && <Badge mark={DECISION[decision]} />}
            {evaluated && (
              <span className="text-[12px] font-medium text-muted">
                {counts.passed} passed · {counts.failed} failed · {counts.not_applicable} not applicable
              </span>
            )}
          </div>
          {/* THE TICK STRIP — one tick per SLA rule, in the order the counts
              sentence above reads them. `aria-hidden` because it repeats
              exactly what that sentence already says; it is the sentence's
              picture, not a second fact. Rendered only when `evaluated`, the
              same gate as the sentence and the counts — a strip of grey
              ticks over rules nobody has evaluated would be the three-zeros
              overclaim in bar form. `flex-wrap`, no cap: a run with two
              hundred rules wraps to more rows rather than silently showing
              fewer ticks than rules ("no silent caps"). Tick colours are the
              outcome marks' own, as data through style — the `Badge`
              pattern. */}
          {evaluated && (
            <div aria-hidden="true" data-testid="gate-ticks" className="flex flex-wrap items-center gap-1">
              {tickMarks(counts).map((mark, index) => (
                // 10px × 32px, squared rather than pill: this is a TEST STRIP,
                // and a strip's ticks are bars. At 4px wide and fully rounded
                // they read as dots — a row of beads that says "some things
                // happened" rather than "here is every rule, and these two
                // failed". Width is what makes an individual tick findable.
                <span
                  key={index}
                  className="h-8 w-2.5 rounded-sm"
                  style={{ backgroundColor: mark.colour }}
                />
              ))}
            </div>
          )}
          <p className="max-w-3xl text-[13px] leading-relaxed text-muted">{detail}</p>
        </div>

        <div className="flex min-w-0 flex-col justify-center gap-3 bg-sunken/45 p-4 lg:p-5">
          {/* The counts, or nothing — never three zeros over a run whose
              rules have not been evaluated. See `assertions` above. */}
          {evaluated && (
            <div className="flex flex-wrap gap-2">
              <DecisionCount label="Passed" value={counts.passed} mark={ASSERTION_OUTCOME.passed} />
              <DecisionCount label="Failed" value={counts.failed} mark={ASSERTION_OUTCOME.failed} />
              <DecisionCount
                label="N/A"
                value={counts.not_applicable}
                mark={ASSERTION_OUTCOME.not_applicable}
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Link to={runComparePath(runId)} className={linkButtonClasses}>
              <CompareTabIcon className="h-3.5 w-3.5" />
              Compare previous
            </Link>
            <Button type="button" variant="secondary" onClick={exportRun}>
              <DownloadIcon className="h-3.5 w-3.5" />
              Export run
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The tick strip's marks, one per rule, in the counts sentence's own order —
 * passed, failed, not applicable — so the picture and the words agree about
 * sequence as well as number.
 */
function tickMarks(counts: AssertionCounts): readonly Mark[] {
  return [
    ...Array.from({ length: counts.passed }, () => ASSERTION_OUTCOME.passed),
    ...Array.from({ length: counts.failed }, () => ASSERTION_OUTCOME.failed),
    ...Array.from({ length: counts.not_applicable }, () => ASSERTION_OUTCOME.not_applicable),
  ];
}

function DecisionCount({ label, value, mark }: { readonly label: string; readonly value: number; readonly mark: Mark }) {
  return (
    <div
      className="flex items-baseline gap-1.5 rounded-lg border border-default bg-surface px-2.5 py-1.5"
      style={{ color: mark.colour }}
    >
      <p className="text-[10px] font-semibold tracking-[0.08em] text-muted">{label}</p>
      <p className="font-mono text-base font-semibold leading-none tabular-nums text-primary">{value}</p>
    </div>
  );
}

/**
 * The big word, and the sentence it replaced. "Release gate failed" carried
 * subject and verdict in one string; the redesign splits them — the verdict
 * as the word, the subject as the constant overline beneath it — so the
 * mapping here is the old `decisionTitle` minus the words the overline now
 * owns. Same branches, same order, same honesty rules.
 */
function decisionWord(decision: Decision, counts: AssertionCounts): string {
  if (decision === 'failed') return 'Failed';
  if (decision === 'passed') return 'Passed';
  if (decision === 'not_evaluated') return 'Not evaluated';
  if (counts.failed > 0) return 'Needs attention';
  return 'Pending';
}

/**
 * The word's colour, from mark DATA like every status colour in this app —
 * the text palette, gated at 4.5:1 against the card. `unevaluated` and the
 * needs-attention state borrow `STATUS.pending`'s amber: both are
 * still-in-motion states, and the run list already teaches that amber means
 * in flight.
 */
function decisionColour(decision: Decision, counts: AssertionCounts): string {
  if (decision === 'unevaluated') return STATUS.pending.colour;
  if (decision === 'none' && counts.failed > 0) return STATUS.pending.colour;
  return DECISION[decision].colour;
}

function decisionDetail(decision: Decision, counts: AssertionCounts): string {
  if (decision === 'failed') return 'One or more SLA rules failed. Start with the failed assertions below.';
  if (decision === 'passed') return 'All evaluated SLA rules passed for this run.';
  if (decision === 'not_evaluated') return 'This run completed, but no SLA rule produced a release verdict.';
  if (counts.failed > 0) return 'Assertions are available, but the run verdict is still resolving.';
  if (decision === 'none') return 'This run carries no release verdict yet.';
  return 'The run has not finished evaluation yet.';
}
