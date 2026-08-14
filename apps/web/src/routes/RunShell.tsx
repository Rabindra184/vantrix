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
  // Overview's first paint costs one request it otherwise would not. It is
  // cached and shared under the same `usersQuery(run.id)` key `RunChartsTab`
  // uses, so opening Charts afterward costs nothing — but the honest
  // alternative, if that first request ever matters, is to drop the peak-users
  // line, not to fetch it lazily and have the header flicker a value in.
  const users = useQuery(usersQuery(run.id));

  return (
    <div className="flex flex-col gap-6">
      <RunHeader run={run} peakUsers={users.data ? peakConcurrentUsers(users.data) : null} />
      <RunTabs runId={run.id} errorCount={errors.data?.errors.length ?? 0} />
      <Outlet />
    </div>
  );
}
