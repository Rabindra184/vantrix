import { useQuery } from '@tanstack/react-query';
import type { FigureMismatch, GatlingDifference, Verification } from '@perfportal/contracts';
import InfoTip from '../components/InfoTip';
import TableFrame from '../components/TableFrame';
import { ROW, TABLE, TD, TD_NUM, TH, TH_NUM, THEAD } from '../components/tableStyles';
import { fetchVerification, verificationQueryKey } from '../api/verification';
import { formatCount, formatMs } from '../tables/StatisticsTable';
import { formatInstant, formatOffset } from './format';

/** How many mismatches — and how many Gatling differences — the panel
 *  tabulates before it counts the rest. */
export const MISMATCH_ROWS = 50;

/**
 * What the run header's verification mark opens onto: the figures checked,
 * the verifier's version, when it ran, what became of the raw log — and on a
 * mismatch, each figure that disagreed with both its values; and where
 * Gatling's own report of this run would print a different percentile. Nothing
 * else (clean UI); the reason a run is NOT verified is the mark's own ⓘ.
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
  const keys = mismatchKeys(shown);
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
                <tr key={keys[index]} className={ROW}>
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
      <GatlingDifferences differences={v.gatlingDifferences ?? []} />
    </div>
  );
}

/** The table's name, and the words above it. */
const DIFFERENCES_NAME = 'Differences from Gatling’s report';

/**
 * The ⓘ beside it: why a report of the same run can say otherwise — and over
 * what. Both columns count every request, warm-up included, because Gatling
 * knows no warm-up; the run's own statistics leave a configured warm-up out,
 * so on such a run the PerfPortal column can differ from the run's table too,
 * and without the last sentence the claim "the actual value at that rank"
 * would read as a claim about that table.
 */
const DIFFERENCES_INFO =
  'Gatling’s report estimates percentiles with t-digest, and its estimate can change between two reports of the same run; PerfPortal reports the actual value at that rank. Both count every request and group record, warm-up included, as Gatling does.';

/**
 * Each percentile where Gatling's own method, replayed over this run's raw
 * log, does not come out at the exact value PerfPortal stores — so a reader
 * holding Gatling's report beside this run knows which of its figures will
 * disagree, and that the disagreement is the report's.
 *
 * DRAWN ONLY WHEN THERE IS ONE: an empty list (nothing differs, or the method
 * did not run) and an absent field (an API older than this) both draw
 * nothing — no title, no ⓘ. A caveat about a table that is not there explains
 * nothing.
 *
 * NO HEADING, for the reason `VerificationPanel` has none: this is shell
 * chrome. The title is a `<p>` with the ⓘ beside it, and the table is named
 * by its `sr-only` caption.
 *
 * A VISIBLE TITLE, NOT `TableFrame`'s `info` SLOT. The mismatch table above
 * needs no title — the mark already said "mismatch" — but this one sits under
 * a mark that says "verified", and a table of disagreeing numbers with no
 * words over it reads as the mismatch it is not. The slot would put only an
 * unlabelled ⓘ at the frame's corner. The cost, accepted: in browse mode a
 * screen reader hears the name twice, once as the title and once as the
 * table's caption.
 *
 * CAPPED LIKE THE MISMATCH LIST, at `MISMATCH_ROWS` and then "and N more":
 * four figures in three populations per request makes a long run's list long.
 */
function GatlingDifferences({ differences }: { readonly differences: readonly GatlingDifference[] }) {
  if (differences.length === 0) return null;
  const shown = differences.slice(0, MISMATCH_ROWS);
  const rest = differences.length - shown.length;
  return (
    <div className="flex flex-col gap-2" data-testid="gatling-differences">
      <p className="flex items-center gap-1 font-medium">
        {DIFFERENCES_NAME}
        <InfoTip label="About differences from Gatling’s report">{DIFFERENCES_INFO}</InfoTip>
      </p>
      <TableFrame name={DIFFERENCES_NAME} label="Differences from Gatling’s report table">
        <table className={TABLE}>
          <caption className="sr-only">{DIFFERENCES_NAME}</caption>
          <thead className={THEAD}>
            <tr>
              <th scope="col" className={TH}>
                Request
              </th>
              <th scope="col" className={TH}>
                Figure
              </th>
              <th scope="col" className={TH_NUM}>
                Gatling’s report
              </th>
              <th scope="col" className={TH_NUM}>
                PerfPortal
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={differenceKey(d)} className={ROW}>
                <td className={`${TD} break-all`}>{differenceRowLabel(d)}</td>
                <td className={`${TD} font-mono`}>
                  {d.population === 'all' ? d.figure : `${d.figure} (${d.population.toUpperCase()})`}
                </td>
                <td className={TD_NUM}>
                  {d.gatlingLow === d.gatlingHigh
                    ? formatMs(d.gatlingLow)
                    : `${formatMs(d.gatlingLow)}–${formatMs(d.gatlingHigh)}`}
                </td>
                <td className={TD_NUM}>{formatMs(d.exact)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
      {rest > 0 && <p className="text-muted">and {formatCount(rest)} more</p>}
    </div>
  );
}

/**
 * Which row a difference is about: "All requests" for the run, and otherwise
 * "scope · name" — `rowLabel`'s rule for the mismatch table, so a group reads
 * as a group. A group's p95 is its CUMULATED response time, and a group named
 * like a request must not pass for that request's figure.
 */
function differenceRowLabel(d: GatlingDifference): string {
  return d.scope === 'run' ? 'All requests' : `${d.scope} · ${d.name}`;
}

/**
 * A React key from what a difference IS — the verifier writes one row per
 * (scope, name, population, figure), so that tuple is unique without an
 * occurrence suffix, and a row keeps its key when one above it goes.
 */
function differenceKey(d: GatlingDifference): string {
  return [d.scope, d.name, d.population, d.figure].join('\u0000');
}

/**
 * A React key per mismatch, from what the mismatch IS — its table, row,
 * bucket, figure and population — rather than where it sits in the list, so a
 * row keeps its key when the list above it changes on a re-check. Two
 * mismatches can name the same place (a duplicated stored row is reported
 * once per extra copy), so a repeat takes its occurrence as a suffix.
 */
export function mismatchKeys(mismatches: readonly FigureMismatch[]): string[] {
  const seen = new Map<string, number>();
  return mismatches.map((m) => {
    const base = [m.table, m.scope, m.name, m.family, String(m.bucket), m.figure, String(m.population)].join('\u0000');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}\u0000${String(n)}`;
  });
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
  run_agent_duration_bucket: 'Connection and DNS timings',
  run_agent_metric_bucket: 'Agent counters',
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
