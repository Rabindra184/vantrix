import { Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { RunResponse } from '@perfportal/contracts';
import { errorsQuery, usersQuery } from '../api/metrics';
import RunHeader from './RunHeader';
import { peakConcurrentUsers } from './runUsers';
import RunTabs from './RunTabs';

/**
 * The chrome around one run's identity and its three tabs.
 *
 * A LAYOUT ROUTE, not three sibling routes each rendering the page with a
 * `tab` prop. The sibling shape looks simpler and remounts this component on
 * every tab click — the header would flash and the run query would re-run.
 * Here the shell mounts once and only the `<Outlet/>` swaps.
 */
export default function RunShell({ run }: { readonly run: RunResponse }) {
  // The Errors tab's own count, not the statistics row's `koCount`: that
  // figure is failed REQUESTS, a different number from the DISTINCT error
  // MESSAGES this tab is named after (24 vs 2 on the reference run). Reusing
  // the same `errorsQuery(run.id)` key `RunErrorsTab` fetches means this
  // resolves from cache once that tab has ever been visited, and otherwise
  // fires the one request the count needs on its own.
  const errors = useQuery(errorsQuery(run.id));

  // THE ONE FETCH OVERVIEW MAKES WHOSE ONLY CONSUMER HERE IS A LINE OF
  // HEADER TEXT. `/users` exists for the two charts on the Charts tab
  // (design §4b); asking for it here so the header can state a peak means
  // Overview's first paint makes one request it otherwise would not. It is
  // cached and shared under the same `usersQuery(run.id)` key `RunChartsTab`
  // uses, and `usersQuery`'s `staleTime: Infinity` (`api/metrics.ts`) is what
  // actually makes opening Charts afterward cost nothing: a completed run's
  // `/users` payload never changes, so once this fetch has resolved a later
  // mount of the same key is never stale enough to refetch. That `staleTime`
  // is load-bearing, not decorative — `main.tsx` sets no default, and
  // TanStack's own default of `0` means a newly mounted observer for
  // already-fetched data refetches on mount regardless of a shared key. This
  // comment used to claim the free reuse while that refetch was still
  // happening; the honest alternative, if the request ever matters even once
  // cached, is to drop the peak-users line, not to fetch it lazily and have
  // the header flicker a value in.
  const users = useQuery(usersQuery(run.id));

  return (
    <div className="flex flex-col gap-6">
      <RunHeader run={run} peakUsers={users.data ? peakConcurrentUsers(users.data) : null} />
      {/* `null`, not `0`, until the errors payload has actually resolved —
          the same "zero is a measurement" rule `peakUsers` above already
          follows (`runUsers.ts`). `errors.data?.errors.length ?? 0` used to
          sit here, reading "Errors (0)" for a count that had not arrived yet,
          and reading it forever if the fetch failed while the panel beneath
          it rendered `role="alert"` (`payload.tsx`'s `TableSection`) — a
          confident zero over a stated failure. */}
      <RunTabs runId={run.id} errorCount={errors.data ? errors.data.errors.length : null} />
      <Outlet />
    </div>
  );
}
