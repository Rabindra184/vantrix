import {
  ProjectListResponseSchema,
  type ProjectListResponse,
  type ProjectRole,
} from '@perfportal/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { projectsQueryKey } from '../../src/api/projects';
import { sessionQueryKey, type Session } from '../../src/api/session';

/**
 * ═══ SEEDING WHO IS LOOKING, FOR A COMPONENT THAT ASKS "MAY I?" ═══
 *
 * Every control gated on access is hidden until access is KNOWN
 * (`src/access/useAccess.ts`), so a test of such a component that seeds
 * nothing tests the component with its controls withheld — and a claim like
 * "Rename renames the test" fails on a button that was never drawn, or worse,
 * an absence assertion passes for the wrong reason. These helpers put an
 * answer in the two caches the hooks read, under the keys and in the shapes
 * the real fetchers produce.
 *
 * The bodies are what the API would send, not stand-ins for it: the project
 * list goes through `ProjectListResponseSchema` here, so a helper that drifted
 * from the contract throws in the test that used it instead of seeding a body
 * the real fetcher would have refused. That also makes them safe to SERVE —
 * a test that lets `fetchProjects` or `getSession` run against a fetch stub
 * can answer with `projectListBody(...)` and `sessionBody(...)` and the real
 * fetcher parses them.
 */

/** One instant for every timestamp a seeded body carries: the values are never what a test asserts. */
const SEEDED_AT = '2026-10-01T00:00:00.000Z';

/**
 * A signed-in session, shaped like `Session`, for an install-wide admin or for
 * an ordinary account.
 *
 * `user.role` is the admin plugin's own vocabulary (`'admin'` or `'user'`),
 * and `mustChangePassword` is false so `AuthGate` lets the person through.
 * The two people have different ids, names and emails, so a test that seeds
 * one and reads `user.id` back cannot be satisfied by the other.
 */
export function sessionBody(isAdmin: boolean): Session {
  const person = isAdmin
    ? { id: 'a0000000-0000-4000-8000-000000000001', name: 'Ada Admin', email: 'ada.admin@example.test' }
    : { id: 'b0000000-0000-4000-8000-000000000002', name: 'Pat Person', email: 'pat.person@example.test' };
  return {
    session: {
      id: `session-${person.id}`,
      userId: person.id,
      expiresAt: '2026-11-01T00:00:00.000Z',
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
      ipAddress: null,
      userAgent: null,
    },
    user: {
      id: person.id,
      email: person.email,
      emailVerified: true,
      name: person.name,
      image: null,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
      role: isAdmin ? 'admin' : 'user',
      mustChangePassword: false,
    },
  };
}

/**
 * A project's display name from its slug, a word at a time: `checkout` reads
 * "Checkout" and `search-service` "Search Service". That is the pair most
 * fixtures in this suite already use, and the name differs from the slug in
 * case, so a page that fell back to the slug is still told apart from one
 * that read the name.
 */
function nameFor(slug: string): string {
  return slug
    .split('-')
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

/**
 * A `GET /v1/projects` body: one project per entry, holding that role, in the
 * order given, with no latest run.
 *
 * `null` is accepted beside the three roles because the API sends it — for an
 * admin who holds no membership row in a project they can see — and the
 * admin-first rule is only proven against it. `seedAccess` takes roles only,
 * since a non-admin never sees a project they hold none in.
 */
export function projectListBody(roles: Readonly<Record<string, ProjectRole | null>>): ProjectListResponse {
  return ProjectListResponseSchema.parse({
    items: Object.entries(roles).map(([slug, role], index) => ({
      id: `c0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      slug,
      name: nameFor(slug),
      latestRun: null,
      role,
    })),
  });
}

/**
 * Writes who is looking into `client`'s cache: the session and, except in the
 * one case below, the project list the API would give that person — each
 * written with `staleTime: Infinity` so no mount or focus refetches it over
 * the seed. (An explicit invalidation or `refetchQueries` still runs the real
 * fetcher, as it would in the app.)
 *
 * `roles` maps a project slug to the role this person holds there.
 *
 * ═══ AN ADMIN WITHOUT `roles` LEAVES THE PROJECT LIST UNCACHED ═══
 *
 * `{ isAdmin: true }` with no `roles` writes the session only. The project
 * list is not touched — no data, no `staleTime` default — so it stays
 * uncached and the page's own fetcher answers it. Passing `roles`, even
 * `{}`, writes the list; do that when the list is part of what the test is
 * about. An admin's access is known from the session alone, so nothing is
 * lost by leaving it out, and that is deliberate: the tests that seed an
 * admin are mostly existing tests of a page that serves its OWN
 * `GET /v1/projects` fixture — a project's name, its latest run — and an
 * empty list written over it would not merely lose the name: `ProjectShell`
 * reads a project missing from a list that has loaded as "Project not found".
 *
 * A non-admin always gets a list — `{}` when no `roles` are given, which is
 * the person on no project at all — because for them the list IS the access.
 */
export function seedAccess(
  client: QueryClient,
  who: { isAdmin: boolean; roles?: Readonly<Record<string, ProjectRole>> },
): void {
  client.setQueryDefaults(sessionQueryKey, { staleTime: Infinity });
  client.setQueryData(sessionQueryKey, sessionBody(who.isAdmin));

  if (who.isAdmin && who.roles === undefined) return;

  client.setQueryDefaults(projectsQueryKey, { staleTime: Infinity });
  client.setQueryData(projectsQueryKey, projectListBody(who.roles ?? {}));
}
