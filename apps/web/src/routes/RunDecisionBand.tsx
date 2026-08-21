import type { Assertion, RunIdentity, RunResponse, RunVerdict } from '@perfportal/contracts';
import { Link } from 'react-router-dom';
import Badge from '../components/Badge';
import { CompareTabIcon, DownloadIcon } from '../components/icons';
import Button, { linkButtonClasses } from '../components/Button';
import { ASSERTION_OUTCOME, VERDICT, type Mark } from './marks';
import { runComparePath } from './paths';
import { downloadRunSummary, runSummaryJson } from './runExport';

type AssertionCounts = {
  readonly passed: number;
  readonly failed: number;
  readonly notApplicable: number;
};

type Decision = RunVerdict | 'pending';

const DECISION: Record<Decision, Mark> = {
  passed: VERDICT.passed,
  failed: VERDICT.failed,
  not_evaluated: VERDICT.not_evaluated,
  pending: VERDICT.none,
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
  readonly assertions?: readonly Assertion[];
}) {
  const counts = countAssertions(assertions ?? []);
  const failed = firstFailed(assertions ?? []);
  const decision = verdict === undefined ? 'pending' : verdict ?? 'pending';
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
            <Badge mark={DECISION[decision]} />
            {assertions !== undefined && (
              <span className="text-[12px] font-medium text-muted">
                {counts.passed} passed · {counts.failed} failed · {counts.notApplicable} not applicable
              </span>
            )}
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-primary sm:text-xl">{title}</h2>
            <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">{detail}</p>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3 bg-sunken/45 p-4 lg:p-5">
          <div className="grid grid-cols-3 gap-2">
            <DecisionCount label="Passed" value={counts.passed} mark={ASSERTION_OUTCOME.passed} />
            <DecisionCount label="Failed" value={counts.failed} mark={ASSERTION_OUTCOME.failed} />
            <DecisionCount
              label="N/A"
              value={counts.notApplicable}
              mark={ASSERTION_OUTCOME.not_applicable}
            />
          </div>
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

function countAssertions(assertions: readonly Assertion[]): AssertionCounts {
  return assertions.reduce<AssertionCounts>(
    (next, assertion) => {
      if (assertion.outcome === 'passed') return { ...next, passed: next.passed + 1 };
      if (assertion.outcome === 'failed') return { ...next, failed: next.failed + 1 };
      return { ...next, notApplicable: next.notApplicable + 1 };
    },
    { passed: 0, failed: 0, notApplicable: 0 },
  );
}

function firstFailed(assertions: readonly Assertion[]): Assertion | undefined {
  return assertions.find((assertion) => assertion.outcome === 'failed');
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
  return 'The run has not finished evaluation yet.';
}
