import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import useDocumentTitle from '../useDocumentTitle';
import { ADMIN_PROJECTS_ROUTE, ADMIN_USERS_ROUTE } from './paths';

/**
 * The chrome both Administration pages share: one `<h1>`, and a two-tab strip
 * between Users and Projects — `ProjectShell`'s shape, one level up.
 *
 * As there, the `<h1>` names the area and the section is not a heading: the
 * strip's `aria-current="page"` says which one is showing, and neither page
 * repeats its own name above its content.
 *
 * There is no `/admin` page (ruling W9). The account menu links to Users, and
 * the two tabs link each other.
 */
export type AdminSection = 'users' | 'projects';

const SECTIONS: readonly { section: AdminSection; label: string; path: string }[] = [
  { section: 'users', label: 'Users', path: ADMIN_USERS_ROUTE },
  { section: 'projects', label: 'Projects', path: ADMIN_PROJECTS_ROUTE },
];

/**
 * `children` is a node rather than `ProjectShell`'s function: there is nothing
 * to hand down — no slug, no lookup — so each page renders its own content.
 *
 * The shell draws even while the page's list is loading or has been refused:
 * a `403 ADMIN_REQUIRED` is shown under the heading and the tabs, so the
 * reader still sees where they are.
 */
export default function AdminShell({
  current,
  children,
}: {
  readonly current: AdminSection;
  readonly children: ReactNode;
}) {
  const label = SECTIONS.find((s) => s.section === current)?.label ?? '';

  /* ONE CALL FOR THE WHOLE PAGE, as `ProjectShell` makes it: the section
     first, so two open tabs are told apart in the browser's tab strip. */
  useDocumentTitle(`${label} · Administration`);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">Administration</h1>

      {/* A NAMED `<nav>`, because the rail is another one on every page, and
          two anonymous navigation landmarks are told apart only by exploring
          them. Plain `<Link>`s and an explicit `current`, for the reason
          `ProjectShell` gives: the section a page belongs to is the page's own
          claim to make. */}
      <nav
        aria-label="Administration sections"
        className="-mb-px flex gap-1 overflow-x-auto border-b border-divider"
      >
        {SECTIONS.map(({ section, label: tabLabel, path }) => {
          const active = section === current;
          return (
            <Link
              key={section}
              to={path}
              aria-current={active ? 'page' : undefined}
              className={`transition-ui shrink-0 border-b-2 px-3 py-2 text-[0.8125rem] font-medium ${
                active
                  ? 'border-accent text-primary'
                  : 'border-transparent text-muted hover:text-primary'
              }`}
            >
              {tabLabel}
            </Link>
          );
        })}
      </nav>

      {children}
    </div>
  );
}
