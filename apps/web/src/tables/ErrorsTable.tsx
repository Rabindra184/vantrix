import { useId } from 'react';
import type { ErrorsResponse } from '@perfportal/contracts';
import InfoTip from '../components/InfoTip';
import SectionHeading from '../components/SectionHeading';
import { EmptyState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { ROW, TABLE, TD_NUM, TH, THEAD, TH_ROW } from '../components/tableStyles';
// The chart directly above this table on the same tab folds its own remainder
// and names it. IMPORTED RATHER THAN RETYPED so the two cannot drift: a reader
// seeing "Other errors" on the chart and something else in the table would
// reasonably conclude they are different things.
import { OTHER_LABEL } from '../charts/transforms/errorSeries';

/**
 * Three: the message, its count, and its share of everything that failed.
 *
 * EXPORTED SO A LOADING PLACEHOLDER CANNOT DISAGREE WITH IT. `TableSection`
 * draws a `SkeletonTable` for this table, and drew SIX columns for it — double
 * — because one hard-coded number was shared by every section that component
 * wraps. The number now comes from the table itself, so a fourth column here
 * moves the placeholder with it. (D-8 below is why there is no fourth.)
 */
export const ERRORS_TABLE_COLUMNS = 3;

/**
 * §13.2 ⑥ the errors table — Appendix A G-17.
 *
 * Three columns, as Gatling's own errors table names them: the distinct error
 * message, how many times it happened, and its share of everything that failed
 * in this run. `ErrorsResponse` is `{ runId, errors: [{ message, count }] }`
 * and carries nothing else, so — unlike the statistics table — there is no
 * tree, no sort and no filter here: everything this component knows is in the
 * two fields it is handed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO AFFECTED-ENDPOINT COLUMN — DEVIATION D-8
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * §13.2 ⑥ specifies four columns: "distinct error message, count, percentage
 * of total errors, **affected endpoint count**; expandable to per-endpoint
 * breakdown". This renders the first three. The fourth is ABSENT ON PURPOSE,
 * and the design spec records it as deviation D-8 (§5 of
 * `docs/superpowers/specs/2026-08-13-perf-portal-parity-tables-design.md`):
 *
 *   - The percentage is derivable from what we are given; the endpoint count
 *     is NOT. Nothing in this payload links a message to the endpoints it
 *     occurred on. The engine writes one `run_error` row per (scope, name) per
 *     message and `/errors` selects ONE of those pairs — run scope by default
 *     — so a message's endpoints could only be recovered client-side by
 *     issuing one request per endpoint and building a reverse index. That is a
 *     different endpoint, not a rendering decision.
 *   - The question it answers is answered better from the other direction. The
 *     request detail page (RQ-11, "Errors for this request") shows a single
 *     endpoint's failures with their context, which is what a reader who asks
 *     "where did this happen" actually wants. Piece 3 builds it.
 *
 * So this table shows the run's failures, and a column filled with a plausible
 * guess would be worse than a column that is not there. `ErrorsTable.test.tsx`
 * pins the exact three-column set, so a fourth column cannot be added without
 * meeting this decision on the way.
 */

/* ======================================================================== *
 * 1. HOW A NUMBER IS WRITTEN DOWN
 * ======================================================================== */

/**
 * A share, written as Gatling's own errors table writes it: `62.5%`, `37.5%`
 * — read out of the reference report's `table#container_errors`
 * (`fixtures/gatling-3.15.1.2/reference-report/index.html`), which is the
 * table this one is a parity surface for.
 *
 * At most two decimals, trailing zeros trimmed. THE FIXTURE CANNOT DISTINGUISH
 * Gatling's own format more finely than that: both of its shares (62.5 and
 * 37.5) are exact at one decimal, so `#.#` and `#.##` produce identical output
 * on every number in this run. The wider one is chosen deliberately — this
 * run's smallest possible non-zero share is 1 of 24 (4.17%), and a run with
 * hundreds of failures has shares that only become non-zero at the second
 * decimal, where dropping it would print `0%` beside a real count.
 *
 * Written plain, with no locale grouping, for the same reason `formatCount` in
 * `StatisticsTable` is: these cells are compared against numbers Gatling
 * writes plain, and a separator would make what a test reads depend on where
 * it ran.
 */
const formatShare = (percent: number): string => `${Number(percent.toFixed(2))}%`;

/* ======================================================================== *
 * 2. THE COMPONENT
 * ======================================================================== */

export default function ErrorsTable({
  errors,
  scopeLabel,
}: {
  readonly errors: ErrorsResponse;
  /**
   * What these rows actually cover, when it is not the whole run.
   *
   * ═══ A SCOPED EMPTY RESULT IS NOT A WHOLE-RUN CONCLUSION ═══
   *
   * `RequestDetail` renders this component over `errorsQuery(runId,
   * 'request', name)`. Search has no failures of its own, so the empty branch
   * fired and said "No errors were recorded for this run" and "Every request
   * this run made came back OK" — while that run had 24 failed requests out
   * of 895. Not a broken screen: a confident, precisely wrong sentence, read
   * by someone checking whether a regression touched this request.
   *
   * The component cannot know its own scope — the payload carries a runId and
   * nothing narrower — so the caller has to say. Leaving it undefined keeps
   * the whole-run wording, which is what the Summary's call site wants.
   */
  readonly scopeLabel?: string;
}) {
  const headingId = useId();

  /**
   * THE ROWS ARE RENDERED IN THE ORDER THEY ARRIVE, most frequent first.
   *
   * That order is already decided, once, where it belongs:
   * `packages/persistence/src/metrics/read.ts` selects `ORDER BY count DESC,
   * message ASC`, and the engine's own rollup sorts the same way before it
   * writes. Re-sorting here would give the product two answers to "what order
   * are errors in" — the same reason `StatisticsTable` passes the filter query
   * straight through to `filterTree` rather than re-deciding what a query is.
   */
  const rows = errors.errors;

  /**
   * THE DENOMINATOR: the run's TOTAL failures, which is the sum of these
   * counts and nothing else.
   *
   * Not `koCount` from the statistics payload — this component is not handed
   * it, and THEY ARE NOT THE SAME NUMBER, which this comment used to claim
   * they were ("equal by construction anyway (measured in task 1: 15 + 9 =
   * 24 = the run row's `koCount`)"). That measurement was right about the
   * reference run and wrong about runs in general: Gatling emits a standalone
   * ERROR record for a session or EL failure, which belongs to no request and
   * is therefore counted here and NOT in any row's `koCount`. Measured on a
   * real 1,724-request run, the gap is 16 — 310 recorded errors against 294
   * KO requests, the difference being eight `Add To Cart: No attribute named
   * 'sessionId' is defined` and eight of the same for `Place Order`.
   *
   * THE REFERENCE FIXTURE CANNOT TELL THE TWO APART, which is why the claim
   * survived: its 15 + 9 = 24 really does equal its `koCount`, because that
   * simulation emits no standalone ERROR record at all. Not the request count
   * either: a reader who reads "62.5%" as "62.5% of requests" has misread the
   * table by a factor of thirty-seven. The heading's info says which.
   */
  const total = rows.reduce((sum, row) => sum + row.count, 0);

  /**
   * `undefined`, not zero, when there is nothing to take a share OF. A payload
   * of zero-count rows is a division by zero, and `NaN%` in a percentage
   * column reads as a broken product rather than as an empty measurement.
   */
  const shareOf = (count: number): number | undefined =>
    total > 0 ? (count * 100) / total : undefined;

  if (rows.length === 0) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <SectionHeading id={headingId}>Errors</SectionHeading>
        {/* No table at all, rather than headings over nothing: an empty table
            reads as a table that failed to load, and a run with no failures is
            the good outcome — it should say so in words.

            `EmptyState`, not `ErrorState`, and the distinction is the whole
            point of this branch: a run with no errors is the GOOD outcome, and
            `ErrorState`'s `role="alert"` would interrupt a screen reader to
            announce success as a problem. */}
        <EmptyState
          title={
            scopeLabel === undefined
              ? 'No errors were recorded for this run'
              : `No errors recorded for ${scopeLabel}`
          }
          /* ONE LINE (clean UI, PR 2): the title is the answer, and a body
             only restated it. The scoped title names its scope and says
             nothing about the run — the sentence review C01 removed ("Every
             request this run made came back OK") was a claim about the whole
             run drawn from one request's empty array. */
        />
      </section>
    );
  }

  // The table's accessible NAME keeps its scope: a screen reader moving by
  // table — or a screenshot — must not read one request's failures as the
  // run's. The DENOMINATOR caveat, from the same `total` the shares are
  // divided by, rides behind the section heading's info (the clean-UI text
  // rule); "every distinct error message, most frequent first" only described
  // what the table plainly shows, so it is gone.
  const name = scopeLabel === undefined ? 'Errors' : `Errors for ${scopeLabel}`;
  const noun = total === 1 ? 'error' : 'errors';
  const info =
    scopeLabel === undefined
      ? `Each percentage is that message’s share of the ${total} ${noun} this run recorded — not of the requests it made.`
      : `Shares are of the ${total} ${noun} ${scopeLabel} recorded, not of the requests it made.`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading id={headingId} info={<InfoTip label="About Errors">{info}</InfoTip>}>
        Errors
      </SectionHeading>

      {/* TWO COUNTS, AN ORDER OF MAGNITUDE APART, BOTH TRUE. The tab strip
          counts distinct MESSAGES ("Errors (2)") and this line counts the
          OCCURRENCES they sum to — so a reader reconciling them assumes one
          is wrong. This table already holds both: the row count and the
          `total` it divides its shares by. It simply never said which was
          which.

          AND IT SAID "failed requests", WHICH IS THE ONE THING `total` IS
          NOT. A Gatling ERROR record — a session or EL failure — is recorded
          here and belongs to no request, so on a real run this line read
          "310 failed requests" on a page whose own KO tile read 294. The
          caption beneath it had it right all along ("share of the 310
          errors this run recorded — not of the requests it made"); the two
          halves of one component disagreed about one number's noun.

          THE NOUN IS NOW THE CAVEAT'S. Naming the KO count here instead is
          not available: `koCount` lives in the statistics payload and this
          component is deliberately not handed it (see `total` above). */}
      <p data-testid="errors-tally" className="text-[0.8125rem] text-primary">
        {rows.length} {rows.length === 1 ? 'error type' : 'error types'} ·{' '}
        {total} {total === 1 ? 'recorded error' : 'recorded errors'}
      </p>

      <TableFrame name={name} label="Errors table">
        <table className={TABLE}>
          {/* The table's accessible NAME — `getByRole('table', { name:
              /errors/i })` is how this suite and the Playwright specs find it.
              The denominator caveat is the section heading's info now. */}
          <caption className="sr-only">{name}</caption>

          <thead className={THEAD}>
            <tr className={ROW}>
              {/* Gatling's own three headings, in its own order. */}
              <th scope="col" className={TH}>
                Error
              </th>
              <th scope="col" className={TH}>
                Count
              </th>
              {/* "Share of errors", not "Percentage" (review 09-13 M15). A
                  bare percentage has no denominator, so the caption had to
                  carry one — and a reader who took it for a share of REQUESTS
                  misread the table by a factor of thirty-seven (24 failures of
                  895 requests). The header names the denominator now, which is
                  where a reader looks when they wonder what a column means. */}
              <th scope="col" className={TH}>
                Share of errors
              </th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => {
              const share = shareOf(row.count);
              return (
                // Keyed by the message, which is what makes a row distinct:
                // the engine's `ErrorRollup` counts into a Map KEYED BY
                // MESSAGE, so a scope's rows cannot repeat one. The folded
                // remainder is `null` — a value no message can take, and at
                // most one row carries it — so it keys itself.
                <tr key={row.message ?? '\u0000other'} data-testid="error-row" className={ROW}>
                  {/* `<th scope="row">`: the message is what makes "15" mean
                      something when a screen reader announces it out of
                      context. `break-words` because these are raw assertion
                      strings and some of them are long.

                      THE REMAINDER IS NAMED, not left blank. `null` means
                      "every message past the top 200, summed", and an empty
                      header cell would read as a failure with no message —
                      which is a different thing the engine spells
                      "(no message)". Same words as the chart on this tab. */}
                  <th scope="row" data-column="message" className={`${TH_ROW} break-words`}>
                    {row.message ?? OTHER_LABEL}
                  </th>
                  <td data-column="count" data-value={String(row.count)} className={TD_NUM}>
                    {row.count}
                  </td>
                  {/* THE EXACT VALUE beside the rounded one, the same split
                      `StatisticsTable` makes: the text is what a reader
                      compares against Gatling, `data-value` is what a parity
                      spec working from the API's own numbers reads. Omitted
                      entirely for a gap, so present and absent mean what the
                      cell shows. */}
                  <td
                    data-testid="error-share"
                    data-column="share"
                    data-value={share === undefined ? undefined : String(share)}
                    className={TD_NUM}
                  >
                    {share === undefined ? '—' : formatShare(share)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableFrame>
    </section>
  );
}
