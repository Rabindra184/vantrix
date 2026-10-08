import { canPerform, type AccessAction, type ProjectRole } from '@perfportal/contracts';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchProjects, projectsQueryKey } from '../api/projects';
import { getSession, sessionQueryKey } from '../api/session';

/**
 * ═══ THE WEB'S ONE QUESTION: MAY I? ═══
 *
 * Every control a role gates asks here, and nowhere else. The API is the
 * authority — `AccessGuard` refuses a request whatever this module says — so
 * hiding is for clarity: a reader should not be offered a button whose click
 * answers 403. The rule itself is not restated here. `canPerform` in
 * `@perfportal/contracts` is the same function the API's guard is pinned
 * against, and this module only gathers its two inputs:
 *
 *   the admin flag  — the session's `user.role === 'admin'` (Better Auth's
 *                     admin plugin), the same read `AppShell` makes;
 *   the role        — the caller's `role` on the matching project in
 *                     `GET /v1/projects`.
 *
 * Both are `useQuery` calls on the EXISTING keys with the existing fetchers,
 * so they share one cache entry with `AuthGate`, `AppShell` and the rail: on
 * an authenticated page they are cache reads, and a role the API changes
 * reaches every gated control the moment that list answers again.
 *
 * ═══ `can` FALSE MEANS "DO NOT DRAW", NEVER "REFUSED" ═══
 *
 * The two answers mean different things to a page, and only one of them may
 * put words on screen:
 *
 *   `can(action)` false  — do not draw the control. That is all. It is false
 *                          while nothing is known, too.
 *   `known && !can(action)` — refused. This, and only this, justifies a
 *                          `NoAccess` sentence.
 *
 * Not known, so neither drawn nor refused: the session still pending; for a
 * non-admin, the project list still pending, or failed with no data (a
 * failure is not an answer about anyone's role); and no project at all. Data
 * KEPT from a failed refetch is still an answer — TanStack holds the last
 * good list across the failure — so access stays known on it, as the rail
 * keeps drawing it.
 *
 * ADMIN FIRST. An admin may do everything, whatever `role` says — `GET
 * /v1/projects` gives an admin their own membership row's role, or `null`,
 * and neither narrows them. So an admin's access is known as soon as the
 * session is, without waiting for the list, and `canPerform` reads the flag
 * before it ever looks at the role.
 *
 * A ROLE OF `undefined` IS A RESPONSE WITH NO `role` FIELD — an API older
 * than the field (`ProjectSummarySchema.role` is optional for that rolling
 * deploy) — not a list that has not loaded: "not loaded" lives in `known`
 * here, and is never read off the role. `canPerform` treats it as no role, so
 * nothing is drawn. The list HAS loaded, though, so it counts as known.
 */

/** What a gated control asks: is access known, and does it allow `action`? */
export interface ProjectAccess {
  readonly known: boolean;
  can(action: AccessAction): boolean;
}

/**
 * The admin plugin's flag: `undefined` while the session has not answered,
 * then `true` for an install-wide admin and `false` for anyone else.
 *
 * Optional at every hop, as `AppShell` reads it: a body with no `user`, or an
 * API older than the plugin sending no `role`, reads as not an admin — the
 * safe way round for what gets drawn. A `null` session is AuthGate's signal
 * to send the reader to sign-in, which it does before any gated page renders.
 */
export function useIsAdmin(): boolean | undefined {
  const session = useQuery({ queryKey: sessionQueryKey, queryFn: getSession });
  if (session.data === undefined) return undefined;
  return session.data?.user?.role === 'admin';
}

/**
 * Access to an action that belongs to no project — New project, the
 * Administration pages. Only the flag decides those, so they are known as
 * soon as the session is. `isAdmin` is false until then, which hides the
 * control; `known` is what says whether that false is a refusal.
 */
export function useAdminAccess(): { readonly known: boolean; readonly isAdmin: boolean } {
  const isAdmin = useIsAdmin();
  return { known: isAdmin !== undefined, isAdmin: isAdmin === true };
}

/**
 * Access to actions in the project named by `slug`, or in none when `slug`
 * is undefined — a run with no project, say — which is not known for anyone,
 * an admin included: there is no project to ask about.
 */
export function useProjectAccess(slug: string | undefined): ProjectAccess {
  const isAdmin = useIsAdmin();
  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });

  /* `null` when the list holds no such project: this person has no role
     there. The project's own `role` otherwise, which is `undefined` only for
     a response with no such field (see the module docstring). */
  const project = slug === undefined ? undefined : projects.data?.items.find((p) => p.slug === slug);
  const role: ProjectRole | null | undefined = project === undefined ? null : project.role;

  const known = slug !== undefined && isAdmin !== undefined && (isAdmin || projects.data !== undefined);

  /* Memoised on the three values the answer depends on, so a control that
     puts `access` in an effect's dependencies is not re-run by every render
     that changed nothing about it. */
  return useMemo<ProjectAccess>(
    () => ({
      known,
      can: (action) => known && canPerform(action, { isAdmin: isAdmin === true, role }),
    }),
    [known, isAdmin, role],
  );
}
