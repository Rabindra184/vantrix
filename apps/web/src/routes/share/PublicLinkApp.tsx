import { lazy, useState } from 'react';
import { flushSync } from 'react-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { publicLinkSecretFromPath } from '../../api/fetch';
import { useScrollAndFragment } from '../../scrollBehaviour';
import { shareSectionPath } from '../paths';
import LinkUnavailable from './LinkUnavailable';
import PublicRunPage from './PublicRunPage';
import { createPublicLinkQueryClient, type PublicLinkRefusal } from './publicQueryClient';

/* The three tabs a link reaches, each its own chunk exactly as in the app
   (`App.tsx`). `RunShell` wraps its outlet in the route error boundary and a
   Suspense, so a chunk that fails to load is caught inside the shell. */
const RunSummary = lazy(() => import('../RunSummary'));
const RunReport = lazy(() => import('../RunReport'));
const RunLogs = lazy(() => import('../RunLogs'));

/** A share path whose segment is no secret at all: the link cannot exist. */
const NOT_A_LINK: PublicLinkRefusal = {
  code: 'LINK_NOT_FOUND',
  detail: 'This address does not name a public link.',
};

/**
 * ═══ `/share/:token` — A RUN READ THROUGH A PUBLIC LINK ═══
 *
 * Outside `AuthGate` and `AppShell` (`App.tsx`), beside `/login`, because the
 * reader may not be signed in at all — and if they are, they must read exactly
 * what a stranger reads. So nothing here mounts the session, the project list,
 * the rail, the palette or the account menu: each would ask `/auth/*` or
 * `/v1/projects`, with the cookie the link replaces.
 *
 * THE SECRET IS READ OFF `window.location`, BY THE FETCH LAYER'S OWN FUNCTION.
 * `publicLinkSecretFromPath` is what `withCredential` calls on every request,
 * on the same input, so this page makes a request only when that request will
 * carry the link. A segment it does not accept (a typo, a percent-encoded
 * character the router would have decoded) would go out with the cookie
 * instead — so such an address asks nothing and says the link does not exist.
 * `useLocation` is subscribed to so a move from one link to another re-reads
 * it; the secret then keys the page, so each link starts with a fresh client.
 */
export default function PublicLinkApp() {
  useLocation();
  // The app shell's scroll-to-top and fragment reveal, which a link's page
  // keeps: the decision band's fragment link, and a pasted `#errors`.
  useScrollAndFragment();
  const secret = publicLinkSecretFromPath(window.location.pathname);
  if (secret === null) return <LinkUnavailable refusal={NOT_A_LINK} />;
  return <PublicLink key={secret} secret={secret} />;
}

/**
 * ═══ ITS OWN QUERY CLIENT, NEVER THE APP'S ═══
 *
 * The app's client ends the session and sends the reader to sign in on any
 * 401 (`queryClient.ts`). This nested provider overrides it for every read
 * under the page, and its client hands a LINK refusal — from the first read,
 * or from a section's read long after the page rendered — to this component,
 * which replaces the page with the matching link-state page (spec 6.1). The
 * first refusal is the one shown: a link refused once does not come back on
 * this page, and a later read refused for another reason says less.
 *
 * Its routes are the three tabs a link reaches, under `PublicRunPage`. Any
 * other section — Trends, Compare, a stale address — goes to the Summary,
 * inside the share tree, never into the app.
 */
function PublicLink({ secret }: { readonly secret: string }) {
  const [refusal, setRefusal] = useState<PublicLinkRefusal | null>(null);
  /* FLUSHED, so the link-state page wins deterministically. The cache's
     `onError` runs as soon as the refused query records its error, and its
     observers are told on a later tick (TanStack schedules notifications);
     an ordinary state update is scheduled too, and the two can land in
     either order — so a section's own "could not be loaded" alert could
     commit first, and be announced, for a page about to disappear.
     `flushSync` commits the link-state page before any observer re-renders.
     (The cache calls this from the fetch's settlement, never during a render,
     where `flushSync` would be refused.) `PublicRunPage` keeps its own guard
     as the second line. */
  const [client] = useState(() =>
    createPublicLinkQueryClient((code, detail) =>
      flushSync(() => setRefusal((current) => current ?? { code, detail })),
    ),
  );

  if (refusal !== null) return <LinkUnavailable refusal={refusal} />;

  return (
    <QueryClientProvider client={client}>
      <Routes>
        <Route element={<PublicRunPage secret={secret} />}>
          <Route index element={<RunSummary />} />
          <Route path="report" element={<RunReport />} />
          <Route path="logs" element={<RunLogs />} />
          <Route path="*" element={<Navigate to={shareSectionPath(secret, 'summary')} replace />} />
        </Route>
      </Routes>
    </QueryClientProvider>
  );
}
