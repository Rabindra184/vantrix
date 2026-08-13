import { useId } from 'react';
import type { ErrorsResponse } from '@perfportal/contracts';

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

export default function ErrorsTable({ errors }: { errors: ErrorsResponse }) {
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
   * it, and the two are equal by construction anyway (measured in task 1: 15 +
   * 9 = 24 = the run row's `koCount`). Not the request count either: 24 of 895
   * requests failed, and a reader who reads "62.5%" as "62.5% of requests"
   * has misread the table by a factor of thirty-seven. The caption says which.
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
      <section aria-labelledby={headingId} className="flex flex-col gap-2">
        <h2 id={headingId} className="text-xl font-semibold">
          Errors
        </h2>
        {/* No table at all, rather than headings over nothing: an empty table
            reads as a table that failed to load, and a run with no failures is
            the good outcome — it should say so in words. */}
        <p>No errors were recorded for this run.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-xl font-semibold">
        Errors
      </h2>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          {/* The caption is the table's ACCESSIBLE NAME as well as its
              explanation — `getByRole('table', { name: /errors/i })` is how
              this suite and the Playwright specs find it.

              It names the DENOMINATOR, from the same `total` the shares are
              divided by, so the table cannot tell a reader it is showing
              shares of 24 errors while dividing by something else. */}
          <caption className="pb-3 text-left text-sm text-[var(--color-text-muted)]">
            Every distinct error message recorded in this run, most frequent first. Each percentage
            is that message’s share of the {total} {total === 1 ? 'error' : 'errors'} this run
            recorded — not of the requests it made.
          </caption>

          <thead>
            <tr className="border-b border-[var(--color-border)]">
              {/* Gatling's own three headings, in its own order. */}
              <th scope="col" className="py-2 pr-4 font-semibold">
                Error
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Count
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Percentage
              </th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => {
              const share = shareOf(row.count);
              return (
                // Keyed by the message, which is what makes a row distinct:
                // the engine's `ErrorRollup` counts into a Map KEYED BY
                // MESSAGE, so a scope's rows cannot repeat one.
                <tr
                  key={row.message}
                  data-testid="error-row"
                  className="border-b border-[var(--color-border)]"
                >
                  {/* `<th scope="row">`: the message is what makes "15" mean
                      something when a screen reader announces it out of
                      context. `break-words` because these are raw assertion
                      strings and some of them are long. */}
                  <th
                    scope="row"
                    data-column="message"
                    className="py-1 pr-4 font-normal break-words"
                  >
                    {row.message}
                  </th>
                  <td
                    data-column="count"
                    data-value={String(row.count)}
                    className="py-1 pr-4 tabular-nums"
                  >
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
                    className="py-1 pr-4 tabular-nums"
                  >
                    {share === undefined ? '—' : formatShare(share)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
