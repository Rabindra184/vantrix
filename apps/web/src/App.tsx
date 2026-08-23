import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './AppShell';
import AuthGate from './AuthGate';
import GroupDetail from './routes/GroupDetail';
import Login from './routes/Login';
import NewProject from './routes/NewProject';
import NoOrg from './routes/NoOrg';
import ProjectRuns from './routes/ProjectRuns';
import ProjectSetup from './routes/ProjectSetup';
import ProjectTests from './routes/ProjectTests';
import TestRuns from './routes/TestRuns';
import NewRunnerRun from './routes/NewRunnerRun';
import RequestDetail from './routes/RequestDetail';
import RunCompare from './routes/RunCompare';
import RunTelemetry from './routes/RunTelemetry';
import RunTrends from './routes/RunTrends';
import RunSectionNotFound from './routes/RunSectionNotFound';
import RunDetail, { RunChartsTab, RunErrorsTab, RunOverviewTab } from './routes/RunDetail';
import RunList from './routes/RunList';
import { DEFAULT_ROUTE, NEW_PROJECT_ROUTE, NO_ORG_ROUTE } from './routes/paths';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to={DEFAULT_ROUTE} replace />} />
      <Route path="/login" element={<Login />} />
      {/* Outside AuthGate on purpose: the gate is what redirects here, so
          gating this route would send a membership-less user in a circle —
          the exact loop the 403 branch exists to prevent. */}
      <Route path={NO_ORG_ROUTE} element={<NoOrg />} />

      <Route element={<AuthGate />}>
        <Route element={<AppShell />}>
          <Route path="/runs" element={<RunList />} />
          {/* Declared from the constant, not a second literal: the segment
              has to stay one no project slug can be (see `NEW_PROJECT_ROUTE`),
              and a hand-typed copy here could quietly drift back to `/new`. */}
          <Route path={NEW_PROJECT_ROUTE} element={<NewProject />} />
          <Route path="/projects/:slug/run/new" element={<NewRunnerRun />} />
          <Route path="/projects/:slug/setup" element={<ProjectSetup />} />
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
            <Route index element={<RunOverviewTab />} />
            <Route path="charts" element={<RunChartsTab />} />
            <Route path="load-generators" element={<RunTelemetry />} />
            <Route path="errors" element={<RunErrorsTab />} />
            <Route path="trends" element={<RunTrends />} />
            <Route path="compare" element={<RunCompare />} />
            {/* A section this run does not have — a stale link to a renamed
                tab, most often. Handled HERE rather than by the catch-all at
                the bottom of this file, which would redirect to `/runs` and
                lose the run the reader was looking at. See
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
              `/runs` — without these two routes a reader who clicked a row
              would land silently on the run list. */}
          <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
          <Route path="/runs/:runId/groups/:name" element={<GroupDetail />} />
        </Route>
      </Route>

      {/* An unknown path is not a reason to show a stranger a login form for
          a page that does not exist; send it to the app's front door and let
          the gate decide. */}
      <Route path="*" element={<Navigate to={DEFAULT_ROUTE} replace />} />
    </Routes>
  );
}
