import type { Assertion, RunIdentity, RunResponse, RunVerdict } from '@perfportal/contracts';
import { Link } from 'react-router-dom';
import Badge from '../components/Badge';
import { CompareTabIcon, DownloadIcon } from '../components/icons';
import Button, { linkButtonClasses } from '../components/Button';
import { ASSERTION_OUTCOME, VERDICT, type Mark } from './marks';
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
  const title = decisionTitle(decision, counts);
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
      <div className="grid grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
        <div className="flex min-w-0 flex-col gap-3 border-b border-divider p-4 lg:border-r lg:border-b-0 lg:p-5">
          <div className="flex flex-wrap items-center gap-2">
            {decision !== 'unevaluated' && <Badge mark={DECISION[decision]} />}
            {evaluated && (
              <span className="text-[12px] font-medium text-muted">
                {counts.passed} passed · {counts.failed} failed · {counts.not_applicable} not applicable
              </span>
            )}
          </div>
          {/* NOT AN `<h2>`, though it looks like one and shipped as one.
              This band is SHELL CHROME — `RunShell` renders it above the
              `<Outlet/>`, so it is on all five tabs — and every `<h2>` on
              this page belongs to the tab CONTENT's own sections
              (`run-tables.spec.ts` asserts the Overview tab's outline is
              exactly Assertions / Simulation assertions / Statistics, and
              the Errors tab's is exactly Errors). Its two neighbours in the
              shell, `SlaBanner` and `LiveStatusStrip`, contribute no heading
              for the same reason; `RunHeader` owns the one `<h1>`.

              It would also be the only heading on the page whose WORDS
              change per run — "Release gate failed" on one, "Release gate
              pending" on the next — which makes a heading-navigation
              outline that reads differently for every run.

              The section is still reachable: `aria-label="Release decision"`
              above names the landmark, which is how both neighbours are
              reached too. */}
          <div className="min-w-0">
            <p className="text-lg font-semibold tracking-tight text-primary sm:text-xl">{title}</p>
            <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">{detail}</p>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3 bg-sunken/45 p-4 lg:p-5">
          {/* The counts, or nothing — never three zeros over a run whose
              rules have not been evaluated. See `assertions` above. */}
          {evaluated && (
            <div className="grid grid-cols-3 gap-2">
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

function DecisionCount({ label, value, mark }: { readonly label: string; readonly value: number; readonly mark: Mark }) {
  return (
    <div className="rounded-lg border border-default bg-surface px-3 py-2" style={{ color: mark.colour }}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold leading-none tabular-nums text-primary">{value}</p>
    </div>
  );
}

function decisionTitle(decision: Decision, counts: AssertionCounts): string {
  if (decision === 'failed') return 'Release gate failed';
  if (decision === 'passed') return 'Release gate passed';
  if (decision === 'not_evaluated') return 'No release gate was evaluated';
  if (counts.failed > 0) return 'Release gate needs attention';
  return 'Release gate pending';
}

function decisionDetail(decision: Decision, counts: AssertionCounts): string {
  if (decision === 'failed') return 'One or more SLA rules failed. Start with the failed assertions below.';
  if (decision === 'passed') return 'All evaluated SLA rules passed for this run.';
  if (decision === 'not_evaluated') return 'This run completed, but no SLA rule produced a release verdict.';
  if (counts.failed > 0) return 'Assertions are available, but the run verdict is still resolving.';
  if (decision === 'none') return 'This run carries no release verdict yet.';
  return 'The run has not finished evaluation yet.';
}
