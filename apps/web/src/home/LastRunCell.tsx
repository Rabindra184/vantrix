import { Link } from 'react-router-dom';
import type { AttentionReason, RunStatus, RunVerdict } from '@perfportal/contracts';
import Badge from '../components/Badge';
import { runName } from '../runNumber';
import { formatListInstant } from '../routes/format';
import { runPath } from '../routes/paths';
import { reasonMark } from './homeFormat';

/**
 * ═══ A TEST'S LAST RUN, TINTED BY HOW IT WENT (home page) ═══
 *
 * The cell both of the home page's tables share: the run's name as a link to
 * it, when it started, and — only when something is wrong — one badge per
 * reason the run needs attention. A reader scanning down a column should be
 * able to tell the failed ones from the rest without reading a word, so the
 * cell carries a 3 px rule down its left edge in the outcome's colour:
 *
 *   needs attention   the failed colour        any reason at all
 *   in flight         the pending colour       pending, parsing, running
 *   passed            the passed colour        a `passed` verdict, nothing wrong
 *   anything else     the card's own line      finished, but judged by nothing
 *
 * A RULE, NEVER COLOURED TEXT. The run's name is a link and stays the link
 * colour; the tint is a non-text mark that needs 3:1 where coloured text needs
 * 4.5:1, and `FormField`'s notices make the same choice for the same reason.
 * Colour is also never the only signal: a reason's badge names it in words,
 * and a run that is fine says nothing.
 *
 * The order matters. A run can be in flight AND already have a reason (a
 * stream that has failed an assertion so far), and that is the fact a reader
 * triaging by colour wants first.
 *
 * `reasons` is passed IN rather than derived here, because the two callers
 * learn it differently: the attention table is told which clauses held by the
 * API, and the tests table computes them from the run it was sent with
 * `attentionReasons`. A component that derived them itself would need `checks`
 * for the rule and the badge both, and would disagree with the endpoint on the
 * day the two rules drifted — which `attention.ts` is written to prevent.
 *
 * `checks` is optional and exists for ONE reason: the label of an
 * `assertion_failed` badge is a count, and the count is in the checks. A caller
 * with no checks to give still gets a truthful badge, just without a number.
 */

/** The statuses of a run nobody has finished yet. */
const IN_FLIGHT: readonly RunStatus[] = ['pending', 'parsing', 'running'];

function ruleColour(
  run: { readonly status: RunStatus; readonly verdict: RunVerdict | null },
  reasons: readonly AttentionReason[],
): string {
  if (reasons.length > 0) return 'var(--color-status-failed)';
  if (IN_FLIGHT.includes(run.status)) return 'var(--color-status-pending)';
  if (run.verdict === 'passed') return 'var(--color-status-passed)';
  return 'var(--color-border)';
}

export default function LastRunCell({
  run,
  reasons,
}: {
  readonly run: {
    readonly id: string;
    readonly runNumber: number | null;
    readonly status: RunStatus;
    readonly verdict: RunVerdict | null;
    readonly startedAt: string;
    readonly checks?: { readonly failed: number; readonly total: number } | null;
  };
  readonly reasons: readonly AttentionReason[];
}) {
  const name = run.runNumber === null ? `Run ${run.id.slice(0, 8)}` : runName(run.runNumber);
  return (
    <div
      data-testid="last-run-cell"
      className="flex min-w-0 flex-col gap-1 border-l-[3px] py-0.5 pl-3"
      style={{ borderLeftColor: ruleColour(run, reasons) }}
    >
      <Link
        to={runPath(run.id)}
        className="transition-ui w-fit max-w-full font-medium text-accent wrap-anywhere hover:underline hover:underline-offset-2"
      >
        {name}
      </Link>
      <span className="text-[0.75rem] text-muted">{formatListInstant(run.startedAt)}</span>
      {reasons.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {reasons.map((reason) => (
            <Badge key={reason} mark={reasonMark(reason, run.checks ?? null)} size="compact" />
          ))}
        </div>
      )}
    </div>
  );
}
