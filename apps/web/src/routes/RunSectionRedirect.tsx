import { Navigate, useLocation, useParams } from 'react-router-dom';
import { runPath, runReportPath } from './paths';

/**
 * An old run tab's URL, sent to where its content lives now (backlog #7).
 *
 * EVERY QUERY PARAMETER TRAVELS. A link pasted into a ticket carries the
 * window it was looking at (`from`/`to`) or the request it narrowed to
 * (`request`), and dropping either lands the reader somewhere that looks
 * right and answers a different question. `replace`, so Back does not bounce
 * the reader into the redirect again.
 *
 * The fragment is how a section is named — `CollapsibleSection` opens the one
 * a fragment matches, and `AppShell` scrolls to it.
 *
 * `/load-generators`, not `/telemetry`, is the URL that still resolves here,
 * and the naming is worth keeping. The URL is the reader's, and "load
 * generators" is what Gatling calls this section and what the question in the
 * reader's head sounds like — "was the generator the bottleneck?"; the
 * endpoint keeps the engineering name. It sends the reader to the Report's
 * Load generators section, which `paths.ts` no longer has a helper for because
 * nothing links to the old address any more.
 */
export default function RunSectionRedirect({
  to,
  hash,
}: {
  readonly to: 'summary' | 'report';
  readonly hash?: string;
}) {
  const { runId } = useParams<{ runId: string }>();
  const { search } = useLocation();
  if (runId === undefined) return null;
  const base = to === 'report' ? runReportPath(runId) : runPath(runId);
  return <Navigate replace to={`${base}${search}${hash === undefined ? '' : `#${hash}`}`} />;
}
