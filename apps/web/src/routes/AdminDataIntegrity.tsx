import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { DataIntegrity } from '@perfportal/contracts';
import Badge from '../components/Badge';
import { SkeletonTable } from '../components/Skeleton';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { ROW, TABLE, TD, TH, THEAD } from '../components/tableStyles';
import { ProblemError } from '../api/fetch';
import { dataIntegrityQueryKey, fetchDataIntegrity } from '../api/admin';
import { formatCount } from '../tables/StatisticsTable';
import AdminShell, { RefreshFailed, isRefusal } from './AdminShell';
import { formatInstant } from './format';
import { VERIFICATION } from './marks';
import { runPath } from './paths';
import { RecomputeLine } from './RecomputeProgress';
import { unverifiableReasonText } from './VerificationMark';

/** How often the page re-reads while runs wait for the verifier or the backfill. */
export const DATA_INTEGRITY_POLL_MS = 10_000;

/**
 * Poll ONLY while something is still moving — a run waiting to be verified, or
 * the backfill still recomputing. Once both are settled the counts cannot
 * change on their own, and a page left open on them would otherwise ask every
 * ten seconds for as long as the tab lives. The count-driven poll
 * `RecomputeProgress` and `Home`'s activity use.
 */
export function dataIntegrityPollMs(data: DataIntegrity | undefined): number | false {
  if (data === undefined) return false;
  return data.verification.pending > 0 || data.recompute.remaining > 0 ? DATA_INTEGRITY_POLL_MS : false;
}

/**
 * Administration › Data integrity: whether this org's stored figures agree
 * with the raw logs they were derived from.
 *
 * The backfill's line (`RecomputeLine`, the shell's words, from this page's
 * own answer), four counts of runs by verification state, the retention
 * setting — read-only, a deployment fact — and the runs with a problem, each
 * linked to its run, where the mark opens the detail.
 *
 * Clean UI: no description under the title; a run's reason is a cell, not a
 * paragraph.
 */
export default function AdminDataIntegrity() {
  const query = useQuery({
    queryKey: dataIntegrityQueryKey,
    queryFn: fetchDataIntegrity,
    refetchInterval: (q) => dataIntegrityPollMs(q.state.data),
  });

  return (
    <AdminShell current="data-integrity">
      {query.isPending ? (
        <LoadingState label="Loading data integrity…">
          <SkeletonTable columns={5} />
        </LoadingState>
      ) : query.data === undefined || isRefusal(query.error) ? (
        <ErrorState
          title="Data integrity could not be loaded"
          detail={query.error instanceof ProblemError ? query.error.detail : query.error?.message}
          remediation={query.error instanceof ProblemError ? query.error.remediation : undefined}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {query.isError && <RefreshFailed />}
          <RecomputeLine progress={query.data.recompute} />
          <Counts data={query.data} />
          <p data-testid="raw-log-retention" className="text-[0.8125rem] text-muted">
            {retentionText(query.data.rawLogRetentionDays)}
          </p>
          <Problems problems={query.data.problems} />
        </div>
      )}
    </AdminShell>
  );
}

function retentionText(days: number): string {
  if (days === 0) return 'Raw logs are kept indefinitely';
  return `Raw logs are kept for ${formatCount(days)} ${days === 1 ? 'day' : 'days'}`;
}

/** Four counts, as name/value pairs. "Verifying" without the mark's ellipsis:
 *  this is a number of runs, not a run in a state. */
function Counts({ data }: { readonly data: DataIntegrity }) {
  const items: readonly [string, number][] = [
    ['Verified', data.verification.verified],
    ['Verification failed', data.verification.mismatch],
    ['Not verified', data.verification.unverifiable],
    ['Verifying', data.verification.pending],
  ];
  return (
    <dl data-testid="verification-counts" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-default bg-surface px-4 py-3 shadow-panel">
          <dt className="text-[0.75rem] text-muted">{label}</dt>
          <dd className="font-mono text-xl tabular-nums">{formatCount(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Problems({ problems }: { readonly problems: DataIntegrity['problems'] }) {
  if (problems.length === 0) return <EmptyState title="No mismatched or unverified runs" />;
  return (
    <TableFrame name="Runs with problems" label="Runs with problems table">
      <table className={TABLE}>
        <caption className="sr-only">Runs with problems</caption>
        <thead className={THEAD}>
          <tr>
            <th scope="col" className={TH}>
              Run
            </th>
            <th scope="col" className={TH}>
              Project
            </th>
            <th scope="col" className={TH}>
              Verification
            </th>
            <th scope="col" className={TH}>
              Detail
            </th>
            <th scope="col" className={TH}>
              Checked
            </th>
          </tr>
        </thead>
        <tbody>
          {problems.map((p) => (
            <tr key={p.runId} className={ROW}>
              <td className={`${TD} whitespace-nowrap`}>
                {/* The id's first eight, as the run lists show one — a run's
                    number is per test and this table spans the org. */}
                <Link to={runPath(p.runId)} className="font-mono text-accent hover:underline">
                  Run {p.runId.slice(0, 8)}
                </Link>
              </td>
              {/* The slug as TEXT: a project's name is rail vocabulary. */}
              <td className={`${TD} break-all font-mono`}>{p.projectSlug}</td>
              <td className={TD}>
                <Badge mark={VERIFICATION[p.status]} />
              </td>
              <td className={TD}>
                {p.status === 'mismatch'
                  ? `${formatCount(p.mismatchCount)} ${p.mismatchCount === 1 ? 'figure differs' : 'figures differ'}`
                  : unverifiableReasonText(p.reason)}
              </td>
              <td className={`${TD} whitespace-nowrap font-mono`}>
                {p.checkedAt === null ? 'not checked' : formatInstant(p.checkedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}
