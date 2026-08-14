import { Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { RunResponse } from '@perfportal/contracts';
import { errorsQuery } from '../api/metrics';
import RunTabs from './RunTabs';

/**
 * The chrome around one run's three tabs.
 *
 * A LAYOUT ROUTE, not three sibling routes each rendering the page with a
 * `tab` prop. The sibling shape looks simpler and remounts this component on
 * every tab click — the header would flash and the run query would re-run.
 * Here the shell mounts once and only the `<Outlet/>` swaps.
 */
export default function RunShell({ run }: { readonly run: RunResponse }) {
  // `run` itself is still not read here beyond `run.id` — Task 3's header is
  // the first consumer of the rest of it. Taking the whole prop now rather
  // than adding it when the header lands keeps `Ready`'s call site
  // (`RunDetail.tsx`) stable across that later change.

  // The Errors tab's own count, not the statistics row's `koCount`: that
  // figure is failed REQUESTS, a different number from the DISTINCT error
  // MESSAGES this tab is named after (24 vs 2 on the reference run). Reusing
  // the same `errorsQuery(run.id)` key `RunErrorsTab` fetches means this
  // resolves from cache once that tab has ever been visited, and otherwise
  // fires the one request the count needs on its own.
  const errors = useQuery(errorsQuery(run.id));

  return (
    <div className="flex flex-col gap-6">
      <RunTabs runId={run.id} errorCount={errors.data?.errors.length ?? 0} />
      <Outlet />
    </div>
  );
}
