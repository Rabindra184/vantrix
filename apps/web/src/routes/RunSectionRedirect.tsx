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
