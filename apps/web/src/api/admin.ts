import {
  AdminProjectListResponseSchema,
  AdminUserListResponseSchema,
  AdminUserSchema,
  type AdminProjectListResponse,
  type AdminUser,
  type AdminUserListResponse,
  type CreateUserRequest,
  type SetPasswordRequest,
  type UpdateUserRequest,
} from '@perfportal/contracts';
import { apiFetch, apiFetchNoContent } from './fetch';

/**
 * `/v1/admin`: every account and every project in the install, for an admin.
 * A session that is not one is refused `403 ADMIN_REQUIRED` on every route
 * here, which `apiFetch` rejects as a `ProblemError` like any other refusal.
 *
 * TWO QUERY KEYS, AND A MEMBERSHIP CHANGE MOVES BOTH. The Users table counts
 * each account's projects and the Projects table counts each project's
 * members, so anything that grants or withdraws a role has made both lists
 * stale — the caller invalidates both (ruling W7).
 */
export const adminUsersQueryKey = ['admin-users'] as const;
export const adminProjectsQueryKey = ['admin-projects'] as const;

const usersPath = '/v1/admin/users';
const userPath = (userId: string): string => `${usersPath}/${encodeURIComponent(userId)}`;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function fetchAdminUsers(): Promise<AdminUserListResponse> {
  return apiFetch(AdminUserListResponseSchema, usersPath);
}

/** `body` is the PARSED request — defaults applied, email lowercased — so what
 *  is sent is what `CreateUserRequestSchema` produced, not what was typed. */
export function createUser(body: CreateUserRequest): Promise<AdminUser> {
  return apiFetch(AdminUserSchema, usersPath, jsonInit('POST', body));
}

export function updateUser(userId: string, body: UpdateUserRequest): Promise<AdminUser> {
  return apiFetch(AdminUserSchema, userPath(userId), jsonInit('PATCH', body));
}

/** A 204: the new temporary password is not echoed back. */
export function resetUserPassword(userId: string, body: SetPasswordRequest): Promise<void> {
  return apiFetchNoContent(`${userPath(userId)}/password`, jsonInit('PUT', body));
}

/** A 204. */
export function removeUser(userId: string): Promise<void> {
  return apiFetchNoContent(userPath(userId), { method: 'DELETE' });
}

export function fetchAdminProjects(): Promise<AdminProjectListResponse> {
  return apiFetch(AdminProjectListResponseSchema, '/v1/admin/projects');
}
