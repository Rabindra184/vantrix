import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminProject, AdminUser, ProjectMember } from '@perfportal/contracts';
import { ProblemError } from '../src/api/fetch';
import {
  adminProjectsQueryKey,
  adminUsersQueryKey,
  createUser,
  fetchAdminProjects,
  fetchAdminUsers,
  removeUser,
  resetUserPassword,
  updateUser,
} from '../src/api/admin';
import { addMember, removeMember, updateMember } from '../src/api/members';

/**
 * The Administration clients, below the pages.
 *
 * Task 7's pages call only `fetchAdminUsers`, `fetchAdminProjects` and
 * `createUser`; the rest exist for the Users row menu (Task 8), so nothing
 * renders them yet. What a page test cannot see — and what these pin — is
 * whether each request is the one the route reads: the method, the URL with
 * its id encoded, the body, and that a 204 resolves without a body being read.
 */

const USER: AdminUser = {
  id: 'user-1',
  name: 'Asha Rao',
  email: 'asha@example.test',
  isAdmin: false,
  disabled: false,
  mustChangePassword: true,
  memberships: [{ projectSlug: 'checkout', projectName: 'Checkout', role: 'member' }],
  createdAt: '2026-10-01T09:30:00.000Z',
};

const PROJECT: AdminProject = {
  slug: 'checkout',
  name: 'Checkout',
  memberCount: 1,
  createdAt: '2026-09-20T08:00:00.000Z',
};

const MEMBER: ProjectMember = {
  userId: 'user-1',
  name: 'Asha Rao',
  email: 'asha@example.test',
  role: 'manager',
  addedAt: '2026-10-02T10:00:00.000Z',
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const PROBLEM = {
  type: 'about:blank',
  title: 'Conflict',
  status: 409,
  code: 'LAST_ADMIN',
  detail: 'Asha Rao is the last admin.',
  remediation: 'Make someone else an admin first.',
};

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly contentType: string | null;
  readonly body: unknown;
  readonly credentials: RequestCredentials | undefined;
}

let sent: Sent[];
let answer: () => Response;

beforeEach(() => {
  sent = [];
  answer = () => json(200, {});
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      contentType: new Headers(init?.headers).get('Content-Type'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      credentials: init?.credentials,
    });
    return Promise.resolve(answer());
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('query keys', () => {
  /* Two keys, because a membership change moves both lists: the Users table's
     project counts and the Projects table's member counts. */
  it('names the users list and the projects list separately', () => {
    expect(adminUsersQueryKey).toEqual(['admin-users']);
    expect(adminProjectsQueryKey).toEqual(['admin-projects']);
  });
});

describe('the admin accounts client', () => {
  it('reads the users list', async () => {
    answer = () => json(200, { users: [USER] });
    await expect(fetchAdminUsers()).resolves.toEqual({ users: [USER] });
    expect(sent).toEqual([
      { url: '/v1/admin/users', method: 'GET', contentType: null, body: undefined, credentials: 'same-origin' },
    ]);
  });

  it('creates a user with the body it is given, as JSON', async () => {
    answer = () => json(201, USER);
    const body = {
      email: 'asha@example.test',
      name: 'Asha Rao',
      password: 'temporary-1',
      isAdmin: false,
      projects: [{ projectSlug: 'checkout', role: 'member' as const }],
    };
    await expect(createUser(body)).resolves.toEqual(USER);
    expect(sent).toEqual([
      { url: '/v1/admin/users', method: 'POST', contentType: 'application/json', body, credentials: 'same-origin' },
    ]);
  });

  it('patches one user by its encoded id', async () => {
    answer = () => json(200, { ...USER, disabled: true });
    await updateUser('user/1', { disabled: true });
    expect(sent).toEqual([
      {
        url: '/v1/admin/users/user%2F1',
        method: 'PATCH',
        contentType: 'application/json',
        body: { disabled: true },
        credentials: 'same-origin',
      },
    ]);
  });

  /* A 204 has no body; reading one would reject a reset that succeeded. */
  it('puts a temporary password and resolves on a 204 without reading a body', async () => {
    const reply = new Response(null, { status: 204 });
    answer = () => reply;
    await expect(resetUserPassword('user-1', { password: 'temporary-2' })).resolves.toBeUndefined();
    expect(reply.bodyUsed).toBe(false);
    expect(sent).toEqual([
      {
        url: '/v1/admin/users/user-1/password',
        method: 'PUT',
        contentType: 'application/json',
        body: { password: 'temporary-2' },
        credentials: 'same-origin',
      },
    ]);
  });

  it('deletes one user and resolves on a 204', async () => {
    answer = () => new Response(null, { status: 204 });
    await expect(removeUser('user-1')).resolves.toBeUndefined();
    expect(sent.map(({ url, method }) => ({ url, method }))).toEqual([{ url: '/v1/admin/users/user-1', method: 'DELETE' }]);
  });

  it('rejects a refusal as the API’s ProblemError, detail and remediation included', async () => {
    answer = () => json(409, PROBLEM);
    const error = await removeUser('user-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect(error).toMatchObject({ status: 409, code: 'LAST_ADMIN', detail: PROBLEM.detail, remediation: PROBLEM.remediation });
  });

  it('reads the projects list', async () => {
    answer = () => json(200, { projects: [PROJECT] });
    await expect(fetchAdminProjects()).resolves.toEqual({ projects: [PROJECT] });
    expect(sent.map(({ url, method }) => ({ url, method }))).toEqual([{ url: '/v1/admin/projects', method: 'GET' }]);
  });
});

describe('the project members client', () => {
  it('adds a member to an encoded project slug', async () => {
    answer = () => json(201, MEMBER);
    await expect(addMember('Checkout API', { userId: 'user-1', role: 'manager' })).resolves.toEqual(MEMBER);
    expect(sent).toEqual([
      {
        url: '/v1/projects/Checkout%20API/members',
        method: 'POST',
        contentType: 'application/json',
        body: { userId: 'user-1', role: 'manager' },
        credentials: 'same-origin',
      },
    ]);
  });

  it('changes one member’s role, both path segments encoded', async () => {
    answer = () => json(200, MEMBER);
    await updateMember('checkout', 'user/1', { role: 'manager' });
    expect(sent).toEqual([
      {
        url: '/v1/projects/checkout/members/user%2F1',
        method: 'PATCH',
        contentType: 'application/json',
        body: { role: 'manager' },
        credentials: 'same-origin',
      },
    ]);
  });

  it('removes a member and resolves on a 204', async () => {
    answer = () => new Response(null, { status: 204 });
    await expect(removeMember('checkout', 'user-1')).resolves.toBeUndefined();
    expect(sent.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: '/v1/projects/checkout/members/user-1', method: 'DELETE' },
    ]);
  });
});
