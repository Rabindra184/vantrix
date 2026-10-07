import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './AppShell';
import AuthGate from './AuthGate';
import Login from './routes/Login';
import RouteFallback from './components/RouteFallback';
import RouteErrorBoundary from './components/RouteErrorBoundary';
import { ACCOUNT_PASSWORD_ROUTE, DEFAULT_ROUTE, HOME_ROUTE, NEW_PROJECT_ROUTE, NO_ORG_ROUTE } from './routes/paths';

/**
 * ═══ EVERY AUTHENTICATED ROUTE IS A SEPARATE CHUNK ═══
 *
 * These were static imports, and the cost was paid by the one visitor least
 * able to use any of it: the login page downloaded and parsed 1.12 MB of
 * JavaScript — the whole app, `echarts` included — to render an email field
 * and a password field. `echarts` alone is the majority of that, and it is
 * reachable from exactly five of these routes.
 *
 * `Login`, `AuthGate` and `AppShell` stay STATIC on purpose. They are on the
 * first paint of every visit (signed in or not), so deferring them would buy
 * nothing and cost a round trip before anything at all appears.
 *
 * Every route here is a module's `default` export. (A named export would need
 * `.then((m) => ({ default: m.Name }))`, because `lazy` resolves a module whose
 * `default` is the component; the two run tabs that once shared `RunDetail`'s
 * module that way are `RunSummary` now, and a module of their own.)
 */
const AccountPassword = lazy(() => import('./routes/AccountPassword'));
const GroupDetail = lazy(() => import('./routes/GroupDetail'));
const Home = lazy(() => import('./routes/Home'));
const NewProject = lazy(() => import('./routes/NewProject'));
const NoOrg = lazy(() => import('./routes/NoOrg'));
const ProjectRuns = lazy(() => import('./routes/ProjectRuns'));
const ProjectSetup = lazy(() => import('./routes/ProjectSetup'));
const ProjectPackages = lazy(() => import('./routes/ProjectPackages'));
const ProjectRulesPage = lazy(() => import('./routes/ProjectRulesPage'));
const ProjectAccess = lazy(() => import('./routes/ProjectAccess'));
const ProjectTests = lazy(() => import('./routes/ProjectTests'));
const TestRuns = lazy(() => import('./routes/TestRuns'));
const NewRunnerRun = lazy(() => import('./routes/NewRunnerRun'));
const RequestDetail = lazy(() => import('./routes/RequestDetail'));
const RunCompare = lazy(() => import('./routes/RunCompare'));
const RunLogs = lazy(() => import('./routes/RunLogs'));
const RunReport = lazy(() => import('./routes/RunReport'));
const RunSectionRedirect = lazy(() => import('./routes/RunSectionRedirect'));
const RunTrends = lazy(() => import('./routes/RunTrends'));
const RunSectionNotFound = lazy(() => import('./routes/RunSectionNotFound'));
const RunList = lazy(() => import('./routes/RunList'));
const RunDetail = lazy(() => import('./routes/RunDetail'));
const RunSummary = lazy(() => import('./routes/RunSummary'));

export default function App() {
  /* The boundary sits OUTSIDE `Suspense`, so it catches what `Suspense`
     cannot: a promise that REJECTS. Suspense handles a chunk that has not
     arrived yet; a chunk that will never arrive throws, and before this there
     was nothing above it — measured against the built bundle, `#root` held
     zero children and the reader got a blank page. */
  return (
    <RouteErrorBoundary>
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* Outside AuthGate on purpose: the gate is what redirects here, so
            gating this route would send a membership-less user in a circle —
            the exact loop the 403 branch exists to prevent. */}
        <Route path={NO_ORG_ROUTE} element={<NoOrg />} />

        <Route element={<AuthGate />}>
          <Route element={<AppShell />}>
            {/* `/` IS A PAGE, the portfolio home. It was a redirect to the run
                list until the home page existed; inside the gate and the shell
                like every other page, so a signed-out visitor is asked to sign
                in and then lands here, which is also where `DEFAULT_ROUTE`
                sends them. */}
            <Route path={HOME_ROUTE} element={<Home />} />
            <Route path="/runs" element={<RunList />} />
            {/* Declared from the constant, not a second literal: the segment
                has to stay one no project slug can be (see `NEW_PROJECT_ROUTE`),
                and a hand-typed copy here could quietly drift back to `/new`. */}
            <Route path={NEW_PROJECT_ROUTE} element={<NewProject />} />
            {/* The account menu's Change password. The forced change at first
                sign-in is not this route: the gate above shows it in place of
                whatever was asked for. */}
            <Route path={ACCOUNT_PASSWORD_ROUTE} element={<AccountPassword />} />
            <Route path="/projects/:slug/run/new" element={<NewRunnerRun />} />
            <Route path="/projects/:slug/setup" element={<ProjectSetup />} />
            <Route path="/projects/:slug/packages" element={<ProjectPackages />} />
            {/* Rules and Access were sections of the setup page until review M15
                asked for them to be separate destinations. The setup SEGMENT is
                unchanged on purpose — see `projectSetupPath`. */}
            <Route path="/projects/:slug/rules" element={<ProjectRulesPage />} />
            <Route path="/projects/:slug/access" element={<ProjectAccess />} />
            {/* `Organization → Project → Test → Run`. A project's own page is
                its TESTS; the run list across every test moved one segment
                deeper rather than the test list taking a child segment, so an
                existing bookmark to `/projects/:slug` still resolves and still
                lands on the project it named. See `paths.ts`.

                Both of these are second-level literals, which the slug-shadowing
                rule `paths.test.ts` enforces does not reach: that rule is about
                a literal sitting where `:slug` itself goes. Nothing dynamic
                competes with `runs` or `tests` at this depth. */}
            <Route path="/projects/:slug/runs" element={<ProjectRuns />} />
            <Route path="/projects/:slug/tests/:testSlug" element={<TestRuns />} />
            <Route path="/projects/:slug" element={<ProjectTests />} />
            <Route path="/runs/:runId" element={<RunDetail />}>
              <Route index element={<RunSummary />} />
              {/* The Report holds what the Charts and Load generators tabs did,
                  and the Summary what the Overview and Errors tabs did. Their
                  old URLs redirect, every query parameter kept — see
                  `RunSectionRedirect`. */}
              <Route path="report" element={<RunReport />} />
              <Route path="charts" element={<RunSectionRedirect to="report" />} />
              <Route path="load-generators" element={<RunSectionRedirect to="report" hash="load-generators" />} />
              <Route path="errors" element={<RunSectionRedirect to="summary" hash="errors" />} />
              <Route path="logs" element={<RunLogs />} />
              <Route path="trends" element={<RunTrends />} />
              <Route path="compare" element={<RunCompare />} />
              {/* A section this run does not have — a stale link to a renamed
                  tab, most often. Handled HERE rather than by the catch-all at
                  the bottom of this file, which would redirect to the home page
                  and lose the run the reader was looking at. See
                  `RunSectionNotFound`.

                  It cannot shadow the two `/runs/:runId/...` routes below: a
                  splat is the lowest-ranked segment type in React Router's
                  match ordering, so `/requests/:name` and `/groups/:name` — two
                  real segments each — are still preferred. `request-detail.spec.ts`
                  and `run-tables.spec.ts` both navigate to those and would fail
                  loudly if that ever stopped being true. */}
              <Route path="*" element={<RunSectionNotFound />} />
            </Route>
            {/* G-16's destinations. Inside the gate and the shell like every
                other run page: these are addresses of the product, not of a
                construction site, and a signed-out visitor to one should be
                asked to sign in and then land here — which is what AuthGate's
                `?next=` already does for free.

                ONE `:name` SEGMENT, and a group's separators arrive inside it —
                `detailPathFor` encodes the full path with encodeURIComponent, so
                `Catalog/Recommendations` is `Catalog%2FRecommendations`, which
                matches this pattern and decodes back to the path. Spelling these
                as `/groups/*` instead would match the same URLs and hand piece 4
                a splat to reassemble, which is one more place for the separator
                rule to be got wrong.

                BEFORE the catch-all below, which redirects anything unmatched to
                the home page — without these two routes a reader who clicked a
                row would land silently on it. */}
            <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
            <Route path="/runs/:runId/groups/:name" element={<GroupDetail />} />
          </Route>
        </Route>

        {/* An unknown path is not a reason to show a stranger a login form for
            a page that does not exist; send it to the app's front door and let
            the gate decide. */}
        <Route path="*" element={<Navigate to={DEFAULT_ROUTE} replace />} />
      </Routes>
    </Suspense>
    </RouteErrorBoundary>
  );
}
