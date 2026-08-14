import { useMemo, type ReactNode } from 'react';
import { type UseQueryResult } from '@tanstack/react-query';
import { ProblemError } from '../api/fetch';
import Chart from '../charts/Chart';
import type { ChartData } from '../charts/types';

/** A chart's stable identity, so a payload that never arrives can still render
 *  the figure — heading, explanation and data table — in its §13.2 position. */
export interface Slot {
  readonly id: string;
  readonly title: string;
}

/**
 * One payload's charts — or, until it arrives, the same figures saying why they
 * are not drawn.
 *
 * A CHART WHOSE FETCH FAILED MUST NOT SIMPLY VANISH. Rendering nothing leaves a
 * gap in a numbered sequence the reader cannot see is incomplete: §13.2's order
 * is itself information, and a missing ⑧ silently renumbers everything after
 * it. It also removes that chart's data table, which is the parity surface —
 * so a page whose distribution 404'd would quietly stop being assertable.
 *
 * This is reachable, not defensive: `GET /v1/runs/:id/distribution` answers
 * **404** for a completed run that has no histogram at all (ParityController),
 * where `/stats`, `/series` and `/users` all answer 200 with empty payloads and
 * let their transforms explain themselves. So on the same page, seven charts
 * say "no response times were recorded" and the eighth has an error to relay.
 * Both are the reader being told what happened; only the wording differs.
 */
export function Payload<T>({
  query,
  slots,
  children,
}: {
  query: UseQueryResult<T>;
  /** The charts this payload feeds, in §13.2 order. */
  slots: readonly Slot[];
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;

  const reason = query.isPending ? 'Loading…' : explain(query.error, 'chart');

  return (
    <>
      {slots.map((slot) => (
        <Undrawn key={slot.id} slot={slot} reason={reason} />
      ))}
    </>
  );
}

/**
 * The server's own sentence, not an invented one — every `/v1` error carries a
 * `detail` and a `remediation` and both are more actionable than "something
 * went wrong". Same rule the error branch at the top of this file follows.
 *
 * `what` names the figure that is missing, and only reaches the reader in the
 * branch where there is no problem document to quote — a transport failure, or
 * a schema mismatch `apiFetch` threw on. It is a parameter rather than the
 * literal "chart" it used to be because the tables use this too, and a table
 * that apologised for a chart would be describing the wrong hole in the page.
 */
function explain(error: unknown, what: string): string {
  if (error instanceof ProblemError) return `${error.detail} ${error.remediation}`;
  return error instanceof Error
    ? `This ${what}’s data could not be loaded: ${error.message}`
    : `This ${what}’s data could not be loaded.`;
}

/**
 * A chart that cannot be drawn, drawn as a chart anyway: `Chart`'s own empty
 * branch, so the figure, the heading, the explanation and the data table are
 * the SAME markup a chart with an empty payload produces. A second, bespoke
 * "unavailable" shape here would be a second thing to keep accessible.
 *
 * EXPORTED for a chart whose query DID resolve, but whose payload itself says
 * the data was never recorded for this run — a case `Payload`'s own loading
 * and error branches do not cover, because the fetch neither is pending nor
 * failed. GroupDetail's percentiles-over-time chart is the caller: it renders
 * this from inside a `Payload` child, after `/series` has answered 200, once
 * it reads `groupSeriesAvailable: false` on that response (D-14 — the run was
 * ingested before per-group series existed). The figure must still appear in
 * its §13.4 position, saying why, for exactly the reason a failed fetch must:
 * a silently missing chart is indistinguishable from one that was measured
 * and found empty.
 */
export function Undrawn({ slot, reason }: { slot: Slot; reason: string }) {
  // Memoised because `Chart`'s option effect depends on `data` by identity.
  const data = useMemo<ChartData>(
    () => ({ series: [], axisLabels: [], columns: [], rows: [], empty: reason }),
    [reason],
  );
  return <Chart id={slot.id} title={slot.title} data={data} />;
}

/**
 * One table, or — until its payload arrives — its heading and the reason it is
 * not there.
 *
 * A TABLE WHOSE FETCH FAILED MUST NOT SIMPLY VANISH, for the same reason
 * `Payload` renders undrawn charts rather than nothing: the statistics table IS
 * the parity surface, and a page that quietly omits it looks exactly like a run
 * that recorded no requests. Both tables already have their own "nothing was
 * recorded" wording for an EMPTY payload, and that is a different sentence from
 * this one — one says the run had no errors, the other says we could not find
 * out.
 *
 * The heading is rendered here rather than left to the table so that it is
 * present in both cases; the tables render their own when they have data, which
 * is why this branch is the only one that draws it.
 */
export function TableSection<T>({
  title,
  query,
  children,
}: {
  title: string;
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xl font-semibold">{title}</h2>
      {query.isPending ? (
        <p role="status" className="text-[var(--color-text-muted)]">
          Loading…
        </p>
      ) : (
        // `role="alert"`, not a muted paragraph: this is the run's numbers
        // failing to arrive, and the server's own `detail` and `remediation`
        // are what a reader can act on.
        <p role="alert">{explain(query.error, 'table')}</p>
      )}
    </section>
  );
}
