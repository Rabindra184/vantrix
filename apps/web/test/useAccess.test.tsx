import { ACCESS_ACTIONS, type AccessAction } from '@perfportal/contracts';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAdminAccess, useIsAdmin, useProjectAccess } from '../src/access/useAccess';
import { fetchProjects, projectsQueryKey } from '../src/api/projects';
import { sessionQueryKey } from '../src/api/session';
import { projectListBody, seedAccess, sessionBody } from './support/access';

/**
 * `useProjectAccess` is the web's one question — may I? — and these cases pin
 * the two halves of its answer separately, because they mean different things
 * to a page:
 *
 *   `can(action)` false means DO NOT DRAW the control. Nothing more.
 *   `known && !can(action)` means REFUSED, and is the only thing that may put
 *   a `NoAccess` sentence on screen.
 *
 * So every "not known yet" case asserts `known` is false AS WELL AS that
 * nothing is allowed: a hook answering `can() === false` with `known: true`
 * while the session is still loading would hide the controls correctly and
 * then tell the reader they lack a role they may well hold.
 */

const EVERY_ACTION = Object.keys(ACCESS_ACTIONS) as AccessAction[];

/** Every action, read through the hook's current answer. */
function allowed(access: { can(action: AccessAction): boolean }): AccessAction[] {
  return EVERY_ACTION.filter((action) => access.can(action));
}

let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;

/** The URL each `fetch` call asked for, so a case can say which endpoints the hooks reach. */
function requestedUrls(): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Nothing a case does not seed may reach a network: by default every
  // request hangs, which is exactly "pending" to a query.
  fetchMock = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useProjectAccess — admin first', () => {
  it('lets an admin who holds no membership row (role null) do everything', () => {
    seedAccess(client, { isAdmin: true, roles: {} });
    client.setQueryData(projectsQueryKey, projectListBody({ checkout: null }));

    const { result } = renderHook(() => useProjectAccess('checkout'), { wrapper });

    expect(result.current.known).toBe(true);
    expect(allowed(result.current)).toEqual(EVERY_ACTION);
  });

  it('lets an admin holding only a Viewer row do everything, whatever the row says', () => {
    seedAccess(client, { isAdmin: true, roles: { checkout: 'viewer' } });

    const { result } = renderHook(() => useProjectAccess('checkout'), { wrapper });

    expect(result.current.known).toBe(true);
    // The admin-only actions are the discriminating half: a hook that ranked
    // the Viewer row before reading the flag would refuse all of these.
    expect(result.current.can('tokens:manage')).toBe(true);
    expect(result.current.can('members:manage')).toBe(true);
    expect(allowed(result.current)).toEqual(EVERY_ACTION);
  });

  it("knows an admin's access as soon as the session is known, without the project list", () => {
    // No roles: the list is never seeded, and its request hangs.
    seedAccess(client, { isAdmin: true });

    const { result } = renderHook(() => useProjectAccess('checkout'), { wrapper });

    expect(client.getQueryState(projectsQueryKey)?.data).toBeUndefined();
    expect(result.current.known).toBe(true);
    expect(allowed(result.current)).toEqual(EVERY_ACTION);
  });
});

describe('useProjectAccess — a role in this project', () => {
  it('ranks a Member: SLA rules yes, API tokens no, members no', () => {
    seedAccess(client, { isAdmin: false, roles: { checkout: 'member' } });

    const { result } = renderHook(() => useProjectAccess('checkout'), { wrapper });

    expect(result.current.known).toBe(true);
    expect(result.current.can('rules:edit')).toBe(true);
    expect(result.current.can('tokens:manage')).toBe(false);
    expect(result.current.can('members:manage')).toBe(false);
  });

  it('allows nothing in a project the person holds no role in — and that IS known', () => {
    seedAccess(client, { isAdmin: false, roles: { search: 'manager' } });

    const { result } = renderHook(() => useProjectAccess('checkout'), { wrapper });

    expect(result.current.known).toBe(true);
    expect(allowed(result.current)).toEqual([]);
  });

  it('follows a role changed in the cache on the next render', async () => {
    seedAccess(client, { isAdmin: false, roles: { checkout: 'member' } });
    const { result } = renderHook(() => useProjectAccess('checkout'), { wrapper });
    expect(result.current.can('rules:edit')).toBe(true);

    // An admin demoted this person; `GET /v1/projects` answered again.
    // TanStack notifies its observers on its own scheduler (a timeout), not
    // inside `setQueryData`, so the re-render is waited for, not assumed.
    act(() => {
      client.setQueryData(projectsQueryKey, projectListBody({ checkout: 'viewer' }));
    });

    await waitFor(() => expect(result.current.can('rules:edit')).toBe(false));
    expect(result.current.known).toBe(true);
    expect(result.current.can('project:read')).toBe(true);
  });
});

describe('useProjectAccess — unknown is not refused', () => {
  it('knows nothing while the session is pending, even with a Manager row cached', () => {
    // The list alone would allow everything a Manager may do; without the
    // session nobody can say whether the flag would allow more, so nothing
    // is known.
    client.setQueryData(projectsQueryKey, projectListBody({ checkout: 'manager' }));

    const { result } = renderHook(() => useProjectAccess('checkout'), { wrapper });

    expect(result.current.known).toBe(false);
    expect(allowed(result.current)).toEqual([]);
    // The real fetcher, under the shared key, is what is waiting.
    expect(requestedUrls()).toContain('/auth/get-session');
  });

  it("knows nothing for a non-admin while the project list is pending", () => {
    client.setQueryData(sessionQueryKey, sessionBody(false));

    const { result } = renderHook(() => useProjectAccess('checkout'), { wrapper });

    expect(result.current.known).toBe(false);
    expect(allowed(result.current)).toEqual([]);
    expect(requestedUrls()).toContain('/v1/projects');
  });

  it('knows nothing for a non-admin whose project list failed with no data', async () => {
    client.setQueryData(sessionQueryKey, sessionBody(false));
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));

    const { result } = renderHook(() => useProjectAccess('checkout'), { wrapper });

    await waitFor(() => expect(client.getQueryState(projectsQueryKey)?.status).toBe('error'));
    expect(client.getQueryState(projectsQueryKey)?.data).toBeUndefined();
    expect(result.current.known).toBe(false);
    expect(allowed(result.current)).toEqual([]);
  });

  it('still knows after a refetch fails, because the last answer is kept', async () => {
    seedAccess(client, { isAdmin: false, roles: { checkout: 'member' } });
    // The list's own state is read in the SAME render as the access answer.
    // The cache's state alone is not enough: TanStack notifies observers on
    // its own scheduler, so `result.current` can still be the render from
    // before the refetch — and a hook that went unknown on the failure would
    // then pass, reporting the answer it gave while the refetch was in flight.
    const { result } = renderHook(
      () => ({
        access: useProjectAccess('checkout'),
        list: useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects }),
      }),
      { wrapper },
    );
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));

    await act(() => client.refetchQueries({ queryKey: projectsQueryKey }));

    // The precondition, so this cannot pass on a refetch that never failed.
    await waitFor(() => expect(result.current.list.status).toBe('error'));
    expect(result.current.list.data).toBeDefined();
    expect(result.current.access.known).toBe(true);
    expect(result.current.access.can('rules:edit')).toBe(true);
  });

  it('knows nothing without a project, even for an admin', () => {
    seedAccess(client, { isAdmin: true, roles: { checkout: 'manager' } });

    const { result } = renderHook(() => useProjectAccess(undefined), { wrapper });

    expect(result.current.known).toBe(false);
    expect(allowed(result.current)).toEqual([]);
  });
});

describe('useIsAdmin and useAdminAccess — actions on no project', () => {
  it('reads undefined, and knows nothing, while the session is pending', () => {
    const { result } = renderHook(() => ({ isAdmin: useIsAdmin(), access: useAdminAccess() }), { wrapper });

    expect(result.current.isAdmin).toBeUndefined();
    expect(result.current.access).toEqual({ known: false, isAdmin: false });
  });

  it("reads the admin plugin's flag once the session is known", () => {
    seedAccess(client, { isAdmin: true });
    const admin = renderHook(() => ({ isAdmin: useIsAdmin(), access: useAdminAccess() }), { wrapper });
    expect(admin.result.current.isAdmin).toBe(true);
    expect(admin.result.current.access).toEqual({ known: true, isAdmin: true });
    admin.unmount();

    client.setQueryData(sessionQueryKey, sessionBody(false));
    const person = renderHook(() => ({ isAdmin: useIsAdmin(), access: useAdminAccess() }), { wrapper });
    expect(person.result.current.isAdmin).toBe(false);
    expect(person.result.current.access).toEqual({ known: true, isAdmin: false });
  });
});
