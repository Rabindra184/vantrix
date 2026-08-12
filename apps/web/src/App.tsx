import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './AppShell';
import AuthGate from './AuthGate';
import Login from './routes/Login';
import NoOrg from './routes/NoOrg';
import RunDetail from './routes/RunDetail';
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
          <Route path="/runs/:runId" element={<RunDetail />} />
        </Route>
      </Route>

      {/* An unknown path is not a reason to show a stranger a login form for
          a page that does not exist; send it to the app's front door and let
          the gate decide. */}
      <Route path="*" element={<Navigate to={DEFAULT_ROUTE} replace />} />
    </Routes>
  );
}
