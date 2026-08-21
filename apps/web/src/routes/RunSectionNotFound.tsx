import { Link, useParams } from 'react-router-dom';
import { EmptyState } from '../components/States';
import { linkButtonClasses } from '../components/Button';
import { runPath } from './paths';

/**
 * A run URL naming a section this run page does not have.
 *
 * WHY IT IS A CHILD ROUTE AND NOT THE GLOBAL CATCH-ALL. Anything unmatched
 * used to fall through to `App.tsx`'s `<Route path="*">`, which redirects to
 * `/runs` — so a stale bookmark to a renamed section (the Load generators tab
 * lived at `/telemetry` before it was `/load-generators`) silently teleported
 * the reader from a run they had open to the top of the run list, with
 * nothing on screen accounting for it. Rendered here instead, inside
 * `RunShell`'s `<Outlet/>`, the header, the decision band and the tab strip
 * all stay put: the reader keeps the run, is told which part of the URL was
 * not understood, and the tabs they DID want are one click away.
 *
 * It names no section by name. The set of tabs is `App.tsx`'s to know, and a
 * list restated here would go stale the next time one is added — the tab
 * strip directly above this panel is already the authoritative list, on
 * screen, at the moment the reader needs it.
 */
export default function RunSectionNotFound() {
  const { runId } = useParams<{ runId: string }>();

  return (
    <EmptyState
      title="This run has no such section"
      body="The address named a part of the run that does not exist — most likely a link from before a tab was renamed. The tabs above are this run’s real sections."
      action={
        runId === undefined ? undefined : (
          <Link to={runPath(runId)} className={linkButtonClasses}>
            Back to the overview
          </Link>
        )
      }
    />
  );
}
