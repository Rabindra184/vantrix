import { Outlet } from 'react-router-dom';
import type { RunResponse } from '@perfportal/contracts';

/**
 * The chrome around one run's three tabs.
 *
 * A LAYOUT ROUTE, not three sibling routes each rendering the page with a
 * `tab` prop. The sibling shape looks simpler and remounts this component on
 * every tab click — the header would flash and the run query would re-run.
 * Here the shell mounts once and only the `<Outlet/>` swaps.
 */
export default function RunShell({ run }: { readonly run: RunResponse }) {
  // Not read yet — Task 3's header is the first consumer. Taking the prop now
  // rather than adding it when the header lands keeps `Ready`'s call site
  // (`RunDetail.tsx`) stable across that later change.
  void run;

  return (
    <div className="flex flex-col gap-6">
      <Outlet />
    </div>
  );
}
