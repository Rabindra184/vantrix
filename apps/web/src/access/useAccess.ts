import { canPerform, type AccessAction, type ProjectRole, type ProjectSummary } from '@perfportal/contracts';
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
 *                     admin plugin), `useIsAdmin` below — which is also how
 *                     `AppShell` reads it for the chrome;
 *   the role        — the caller's `role` on the matching project in
 *                     `GET /v1/projects`.
 *
 * Both are `useQuery` calls on the EXISTING keys with the existing fetchers,
 * so they share one cache entry with `AuthGate`, `AppShell` and the rail: on
 * an authenticated page the answer is already there to draw from, and a role
 * the API changes reaches every gated control the moment that list answers
 * again. They are not free reads, though: neither key sets a `staleTime`, so
 * every new observer refetches both on mount — which is why a page asks once
 * and passes `access` down (Ruling P8).
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
 * failure is not an answer about anyone's role), or listing the project with
 * no `role` field (below); and no project at all. Data KEPT from a failed
 * refetch is still an answer — TanStack holds the last good list across the
 * failure — so access stays known on it, as the rail keeps drawing it.
 *
 * ADMIN FIRST. An admin may do everything, whatever `role` says — `GET
 * /v1/projects` gives an admin their own membership row's role, or `null`,
 * and neither narrows them. So an admin's access is known as soon as the
 * session is, without waiting for the list, and `canPerform` reads the flag
 * before it ever looks at the role.
 *
 * ═══ A PROJECT WITH NO `role` FIELD IS UNKNOWN; `role: null` IS NOT ═══
 *
 * A role of `undefined` is a response with no `role` field — an API older
 * than the field (`ProjectSummarySchema.role` is optional for that rolling
 * deploy) — not a list that has not loaded: "not loaded" lives in `known`,
 * and is never read off the role. For a non-admin it is still NOT KNOWN. A
 * non-admin's list holds only projects they hold a role in, so the project's
 * presence says they hold one; the response just does not say which. Reading
 * that as refused would put "needs the Member role" in front of somebody who
 * may well be a Manager — the false refusal the `known`/`can` split exists to
 * prevent. So nothing is drawn and no `NoAccess` is either — `canPerform`
 * alone would have hidden the controls, but only `known` keeps the sentence
 * away. An admin is unaffected: the flag decides, and the role is not read.
 *
 * Two answers that look alike stay KNOWN and refused, because each is the API
 * saying something: `role: null` (it holds no role in this project) and a
 * project missing from a list that has loaded (no role, and not visible).
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
 * Optional at every hop: a body with no `user`, or an API older than the
 * plugin sending no `role`, reads as not an admin — the safe way round for
 * what gets drawn. A `null` session is AuthGate's signal to send the reader
 * to sign-in, which it does before any gated page renders.
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

/** A project as the list answers it: only the two fields the decision reads. */
type ListedProject = Readonly<Pick<ProjectSummary, 'slug' | 'role'>>;

/**
 * The decision's two values, from the hook's inputs: is access known, and
 * which role is read. Every rule in the module docstring is applied here and
 * nowhere else — `projectAccess` and `useProjectAccess` both start from it.
 */
function decide(
  isAdmin: boolean | undefined,
  items: readonly ListedProject[] | undefined,
  slug: string | undefined,
): { readonly known: boolean; readonly role: ProjectRole | null | undefined } {
  /* `null` when the list holds no such project: this person has no role
     there. The project's own `role` otherwise, which is `undefined` only for
     a response with no such field (see the module docstring). */
  const project = slug === undefined ? undefined : items?.find((p) => p.slug === slug);
  const role: ProjectRole | null | undefined = project === undefined ? null : project.role;

  /* For a non-admin: a list has answered, AND it did not leave the role out.
     `role !== undefined` is what makes a field-less item unknown rather than
     refused; `null` and a missing project both pass it, and stay known. */
  const known =
    slug !== undefined &&
    isAdmin !== undefined &&
    (isAdmin || (items !== undefined && role !== undefined));

  return { known, role };
}

/** The answer a control reads, built from the decision. */
function grant(known: boolean, isAdmin: boolean | undefined, role: ProjectRole | null | undefined): ProjectAccess {
  return {
    known,
    can: (action) => known && canPerform(action, { isAdmin: isAdmin === true, role }),
  };
}

/**
 * The same answer `useProjectAccess` gives, as a pure function of the two
 * things it reads: `useIsAdmin`'s answer (`undefined` while the session is
 * pending) and the project list's items (`undefined` while it has no data).
 *
 * For a caller that needs the answer for a project it did not mount a hook
 * for — the command palette offers the pages of whichever project a query is
 * about, out of the list it already holds. It is the hook's own decision, not
 * a copy of it: a second spelling of "admin first" or of the field-less item
 * is exactly the drift this module exists to prevent.
 */
export function projectAccess(
  isAdmin: boolean | undefined,
  items: readonly ListedProject[] | undefined,
  slug: string | undefined,
): ProjectAccess {
  const { known, role } = decide(isAdmin, items, slug);
  return grant(known, isAdmin, role);
}

/**
 * Access to actions in the project named by `slug`, or in none when `slug`
 * is undefined — a run with no project, say — which is not known for anyone,
 * an admin included: there is no project to ask about.
 */
export function useProjectAccess(slug: string | undefined): ProjectAccess {
  const isAdmin = useIsAdmin();
  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  const { known, role } = decide(isAdmin, projects.data?.items, slug);

  /* Memoised on the three values the answer depends on, so a control that
     puts `access` in an effect's dependencies is not re-run by every render
     that changed nothing about it. */
  return useMemo<ProjectAccess>(() => grant(known, isAdmin, role), [known, isAdmin, role]);
}
