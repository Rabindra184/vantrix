import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './AppShell';
import AuthGate from './AuthGate';
import GroupDetail from './routes/GroupDetail';
import Login from './routes/Login';
import NoOrg from './routes/NoOrg';
import ProjectRuns from './routes/ProjectRuns';
import RequestDetail from './routes/RequestDetail';
import RunCompare from './routes/RunCompare';
import RunTrends from './routes/RunTrends';
import RunDetail, { RunChartsTab, RunErrorsTab, RunOverviewTab } from './routes/RunDetail';
import RunList from './routes/RunList';
import { DEFAULT_ROUTE, NO_ORG_ROUTE } from './routes/paths';

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
          <Route path="/projects/:slug" element={<ProjectRuns />} />
          <Route path="/runs/:runId" element={<RunDetail />}>
            <Route index element={<RunOverviewTab />} />
            <Route path="charts" element={<RunChartsTab />} />
            <Route path="errors" element={<RunErrorsTab />} />
            <Route path="trends" element={<RunTrends />} />
            <Route path="compare" element={<RunCompare />} />
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
