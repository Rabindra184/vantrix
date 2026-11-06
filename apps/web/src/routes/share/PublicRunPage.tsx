import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProjectAccess } from '../../access/useAccess';
import { ProblemError } from '../../api/fetch';
import { publicLinkQueryKey, resolvePublicLink } from '../../api/publicLinks';
import type { RunDetail } from '../../api/run';
import { ErrorState, LoadingState } from '../../components/States';
import { runName } from '../../runNumber';
import { RunPresentationProvider, type RunPresentation } from '../presentation';
import RunShell from '../RunShell';
import { useRunTerminal } from '../useRunWindow';
import PublicHeader from './PublicHeader';
import { isPublicLinkRefusal } from './publicQueryClient';

/**
 * What a public link's reader may do in the run's project: nothing, and that
 * is KNOWN rather than pending — so a control gated on an action is simply
 * absent, and nothing asks `/auth/*` or `/v1/projects` to find out
 * (spec 6.3). The note reads but cannot be edited, and every rule and access
 * link hides itself as it already does for a Viewer.
 */
const PUBLIC_ACCESS: ProjectAccess = { known: true, can: () => false };

/**
 * The tab's title: the run's name, then its test — `Run 3 · Checkout smoke`.
 * A run with no number is named as `RunShell` names it, by its simulation or
 * its short id; one in no test is its name alone.
 */
function publicRunTitle(run: RunDetail['run']): string {
  const name =
    run.runNumber !== null && run.runNumber !== undefined
      ? runName(run.runNumber)
      : (run.simulation ?? `Run ${run.id.slice(0, 8)}`);
  return run.test ? `${name} · ${run.test.name}` : name;
}

/**
 * ═══ ONE RUN, READ THROUGH A LINK, IN THE SAME SHELL THE APP USES ═══
 *
 * The URL carries only the secret, so the first read is `GET /v1/public-link`,
 * which names the run and the link's expiry; the run itself is then read
 * through the same `useRunTerminal` every tab uses (spec 6.3). Every request
 * carries the link and no cookie — the fetch layer decides that from the URL
 * (`withCredential`), so nothing here passes a header.
 *
 * The shell is `RunShell`, unchanged, inside `RunPresentationProvider` with
 * the public presentation: that is what tells the run's own components where
 * a link may go (`useRunPaths`). Its props are filled from the run's detail
 * exactly as `RunDetail` fills them, with three differences: the access allows
 * nothing, there is no live socket (`live = null` — a link reads a finished
 * run, and the socket would need a session), and nothing polls, so the polling
 * cap is never reached.
 *
 * ═══ A REFUSAL IS NOT THIS PAGE'S TO DRAW ═══
 *
 * A read the API refuses as a LINK refusal is reported by the page's query
 * client to `PublicLinkApp`, which replaces this whole page with the matching
 * link-state page. Until it does, this page keeps its loading line rather than
 * flashing an error the reader is about to lose. Any OTHER failure of the two
 * reads is this page's, and is shown with the API's own words — with no way
 * back into the app, because there is none from here.
 *
 * ═══ THE DOCUMENT TITLE ═══
 *
 * Written here, after `RunShell` writes its own app-shaped title: passive
 * effects run child first, so this one — the ancestor's — lands last on the
 * commit both change in, and both change only when the run does.
 * `PublicLinkApp.test.tsx` pins the result.
 */
export default function PublicRunPage({ secret }: { readonly secret: string }) {
  const link = useQuery({ queryKey: publicLinkQueryKey, queryFn: resolvePublicLink });
  const { detail: run } = useRunTerminal(link.data?.runId);

  const title = run.data === undefined ? null : publicRunTitle(run.data.run);
  useEffect(() => {
    if (title !== null) document.title = `${title} — PerfPortal`;
  }, [title]);

  return (
    <div className="min-h-screen">
      <PublicHeader expiresAt={link.data?.expiresAt ?? null} />
      {/* `id="main"` because the fragment reveal (`useScrollAndFragment`)
          observes this column, as it observes the app's own. */}
      <main id="main" tabIndex={-1} className="min-w-0 p-4 outline-none sm:p-6">
        {link.isError ? (
          <Failure
            error={link.error}
            title="This link could not be opened"
          />
        ) : link.isPending || run.isPending ? (
          <LoadingState label="Loading run…" />
        ) : run.isError ? (
          <Failure error={run.error} title="This run could not be loaded" />
        ) : (
          <PublicShell
            secret={secret}
            expiresAt={link.data.expiresAt}
            detail={run.data}
            onRetry={() => void run.refetch()}
          />
        )}
      </main>
    </div>
  );
}

/** A failed read: a link refusal waits for `PublicLinkApp` to replace the
 *  page; anything else says what the API said. */
function Failure({ error, title }: { readonly error: Error; readonly title: string }) {
  if (isPublicLinkRefusal(error)) return <LoadingState label="Loading run…" />;
  const problem = error instanceof ProblemError ? error : null;
  return (
    <ErrorState
      titleAs="h1"
      title={title}
      detail={problem?.detail ?? error.message}
      remediation={problem?.remediation}
    />
  );
}

function PublicShell({
  secret,
  expiresAt,
  detail,
  onRetry,
}: {
  readonly secret: string;
  readonly expiresAt: string;
  readonly detail: RunDetail;
  readonly onRetry: () => void;
}) {
  // Memoised: `useRunPaths` memoises on the presentation's identity, and a
  // fresh object every render would rebuild every link on the page.
  const presentation = useMemo<RunPresentation>(() => ({ kind: 'public', secret, expiresAt }), [secret, expiresAt]);
  return (
    <RunPresentationProvider value={presentation}>
      <RunShell
        identity={detail.run}
        status={detail.run.status}
        terminal={detail.state === 'ready'}
        verdict={detail.state === 'ready' ? detail.run.verdict : undefined}
        assertions={detail.state === 'ready' ? detail.run.assertions : undefined}
        toolAssertions={detail.state === 'ready' ? detail.run.toolAssertions : undefined}
        windowable={detail.state === 'ready' ? detail.run.windowable : undefined}
        projectAccess={PUBLIC_ACCESS}
        live={null}
        capReached={false}
        onRetry={onRetry}
      />
    </RunPresentationProvider>
  );
}
