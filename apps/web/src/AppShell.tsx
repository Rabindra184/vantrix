import { Outlet } from 'react-router-dom';
import ProjectRail from './ProjectRail';
import SignOutButton from './SignOutButton';

/**
 * The chrome around every authenticated page: rendered only inside
 * `AuthGate`, so its presence on screen is itself the proof that a session
 * survived — which is what the reload test asserts.
 *
 * Two columns on wide screens, one stacked column below `lg`, with DOM order
 * rail → header → main in both. No CSS reordering, so a screen reader and a
 * sighted reader traverse the same sequence.
 *
 * The brand moved into the rail; this header keeps `SignOutButton` and
 * nothing else yet. It renders ONCE — a second copy hidden by a `lg:` class
 * would make Playwright's `getByRole('button', { name: 'Sign out' })` resolve
 * to two nodes and throw under strict mode, and two identical controls
 * sharing one accessible name is a defect whatever the CSS says.
 */
export default function AppShell() {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
      <ProjectRail />
      <div>
        <header className="flex items-center justify-end border-b border-default px-6 py-3">
          <SignOutButton />
        </header>
        <main className="p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
