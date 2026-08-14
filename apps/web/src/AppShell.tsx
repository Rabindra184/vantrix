import { Outlet } from 'react-router-dom';
import SignOutButton from './SignOutButton';

/**
 * The chrome around every authenticated page: rendered only inside
 * `AuthGate`, so its presence on screen is itself the proof that a session
 * survived — which is what the reload test asserts.
 *
 * Deliberately empty of content. Task 6 renders the run list into the
 * `<Outlet/>` and Task 7 the run detail; a placeholder table here would be a
 * competing implementation for them to delete rather than a foundation to
 * build on.
 */
export default function AppShell() {
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-default px-6 py-3">
        <span className="font-semibold">PerfPortal</span>
        <SignOutButton />
      </header>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}
