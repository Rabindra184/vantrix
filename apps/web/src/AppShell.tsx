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
 *
 * The skip link is the FIRST child, before the rail. Before this branch a
 * keyboard user reached page content after one tab stop; the rail now puts
 * brand + **All runs** + one link per project ahead of it on every
 * authenticated page — 2 + N identical stops with no way past them. The link
 * is visually hidden until it receives focus (`sr-only focus:not-sr-only`)
 * and jumps to `#main`, which is given `tabIndex={-1}` so activating the link
 * actually moves focus onto `<main>` rather than merely scrolling to it —
 * `<main>` is not natively focusable, and a skip link that scrolls without
 * refocusing leaves a screen-reader user's focus behind at the link.
 */
export default function AppShell() {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:px-3 focus:py-2 focus:text-sm focus:font-medium"
        style={{ backgroundColor: 'var(--color-accent-base)', color: 'var(--color-accent-foreground)' }}
      >
        Skip to content
      </a>
      <ProjectRail />
      <div>
        <header className="flex items-center justify-end border-b border-default px-6 py-3">
          <SignOutButton />
        </header>
        <main id="main" tabIndex={-1} className="p-6 outline-none">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
