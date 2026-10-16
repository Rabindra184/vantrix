import { useQuery } from '@tanstack/react-query';
import type { FigureMismatch, Verification } from '@perfportal/contracts';
import TableFrame from '../components/TableFrame';
import { ROW, TABLE, TD, TD_NUM, TH, TH_NUM, THEAD } from '../components/tableStyles';
import { fetchVerification, verificationQueryKey } from '../api/verification';
import { formatCount } from '../tables/StatisticsTable';
import { formatInstant, formatOffset } from './format';

/** How many mismatches the panel tabulates before it counts the rest. */
export const MISMATCH_ROWS = 50;

/**
 * What the run header's verification mark opens onto: the figures checked,
 * the verifier's version, when it ran, what became of the raw log — and on a
 * mismatch, each figure that disagreed with both its values. Nothing else
 * (clean UI); the reason a run is NOT verified is the mark's own ⓘ.
 *
 * Mounted only while the panel is open (`VerificationMark`), so this query is
 * the fetch-on-open. No heading: it is shell chrome, which contributes none to
 * the page's outline; the panel is named by its `aria-label`.
 */
export default function VerificationPanel({ runId }: { readonly runId: string }) {
  const query = useQuery({ queryKey: verificationQueryKey(runId), queryFn: () => fetchVerification(runId) });
  if (query.isPending) return <p className="text-muted">Loading…</p>;
  // ONE SENTENCE, NO TABLE: the mark beside the status already says what the
  // verifier found; this panel is its detail, and a failed read of detail is
  // not an alert over the page.
  if (query.isError) return <p>The verification could not be loaded.</p>;
  return <Detail verification={query.data} />;
}

function Detail({ verification: v }: { readonly verification: Verification }) {
  if (v.status === 'pending' && v.checkedAt === null) {
    return <p>This run has not been checked yet.</p>;
  }
  const shown = v.mismatches.slice(0, MISMATCH_ROWS);
  const rest = v.mismatches.length - shown.length;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">Figures checked</dt>
        <dd className="font-mono tabular-nums">{formatCount(v.figuresChecked)}</dd>
        {v.verifierVersion !== null && (
          <>
            <dt className="text-muted">Verifier version</dt>
            <dd className="font-mono tabular-nums">{v.verifierVersion}</dd>
          </>
        )}
        {v.checkedAt !== null && (
          <>
            <dt className="text-muted">Checked</dt>
            <dd className="font-mono">{formatInstant(v.checkedAt)}</dd>
          </>
        )}
        <dt className="text-muted">Raw log</dt>
        <dd data-testid="verification-raw-log">{rawLogText(v)}</dd>
      </dl>
      {shown.length > 0 && (
        <TableFrame name="Mismatches" label="Mismatches table">
          <table className={TABLE}>
            <caption className="sr-only">Mismatches</caption>
            <thead className={THEAD}>
              <tr>
                <th scope="col" className={TH}>
                  Table
                </th>
                <th scope="col" className={TH}>
                  Row
                </th>
                <th scope="col" className={TH}>
                  Figure
                </th>
                <th scope="col" className={TH_NUM}>
                  Stored
                </th>
                <th scope="col" className={TH_NUM}>
                  Recomputed
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m, index) => (
                <tr key={index} className={ROW}>
                  <td className={`${TD} whitespace-nowrap`}>{TABLE_NAMES[m.table]}</td>
                  <td className={`${TD} break-all`}>{rowLabel(m)}</td>
                  <td className={`${TD} font-mono`}>{figureLabel(m)}</td>
                  <td className={TD_NUM}>{valueText(m.stored)}</td>
                  <td className={TD_NUM}>{valueText(m.recomputed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      )}
      {rest > 0 && <p className="text-muted">and {formatCount(rest)} more</p>}
    </div>
  );
}

/** "deleted", "kept until 2027-01-14", or "kept indefinitely" — a calendar
 *  day as the column holds it, not an instant dressed up with a zone. */
function rawLogText(v: Verification): string {
  if (v.rawLogDeleted) return 'deleted';
  if (v.rawLogRetainedUntil !== null) return `kept until ${v.rawLogRetainedUntil}`;
  return 'kept indefinitely';
}

/** The stored tables, in the words the run page uses for what they hold. */
const TABLE_NAMES: Record<FigureMismatch['table'], string> = {
  run: 'Run',
  run_stat: 'Statistics',
  run_series_bucket: 'Series',
  run_error: 'Errors',
  run_error_bucket: 'Errors over time',
  run_user_bucket: 'Users',
};

/**
 * Which row disagreed: "scope · name · family", and the bucket's offset when
 * the row is one second of a series.
 *
 * ═══ ON THE TWO ERROR TABLES, `family` IS THE ERROR MESSAGE ═══
 *
 * The verifier keys an error row by its message in the slot a statistics row
 * keys by family, so there the slot is quoted as the message it is — and an
 * empty message is the folded remainder, "other errors", never a blank that
 * reads as a missing family.
 */
export function rowLabel(m: FigureMismatch): string {
  const errorTable = m.table === 'run_error' || m.table === 'run_error_bucket';
  const last = errorTable ? (m.family === '' ? 'other errors' : `“${m.family}”`) : m.family;
  const label = [m.scope, m.name, last].filter((part) => part !== '').join(' · ');
  return m.bucket === null ? label : `${label} · at ${formatOffset(m.bucket)}`;
}

/** The figure, with its population when the row splits OK from KO. */
function figureLabel(m: FigureMismatch): string {
  return m.population === null || m.population === 'all' ? m.figure : `${m.figure} (${m.population.toUpperCase()})`;
}

/** The value as stored — exact, never rounded: a mismatch can be in the ninth
 *  decimal. `none` for the side that has no such row. */
function valueText(value: FigureMismatch['stored']): string {
  return value === null ? 'none' : String(value);
}
