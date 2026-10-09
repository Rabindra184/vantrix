import {
  MemberListResponseSchema,
  ProjectMemberSchema,
  type AddMemberRequest,
  type MemberListResponse,
  type ProjectMember,
  type UpdateMemberRequest,
} from '@perfportal/contracts';
import { apiFetch, apiFetchNoContent } from './fetch';

/**
 * A project's members: who holds a role in it, and which — the list the
 * project's Members page shows, and the three changes an admin makes to it
 * there and from Administration › Users' edit panel.
 *
 * A change here moves both Administration lists; see `api/admin.ts` on why
 * the caller invalidates both keys.
 */
const membersPath = (slug: string): string => `/v1/projects/${encodeURIComponent(slug)}/members`;
const memberPath = (slug: string, userId: string): string => `${membersPath(slug)}/${encodeURIComponent(userId)}`;

/** One project's members, by name — readable by every role in the project (`members:read`). */
export const projectMembersQueryKey = (slug: string) => ['project-members', slug] as const;

export function fetchProjectMembers(slug: string): Promise<MemberListResponse> {
  return apiFetch(MemberListResponseSchema, membersPath(slug));
}

export function addMember(slug: string, body: AddMemberRequest): Promise<ProjectMember> {
  return apiFetch(ProjectMemberSchema, membersPath(slug), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function updateMember(slug: string, userId: string, body: UpdateMemberRequest): Promise<ProjectMember> {
  return apiFetch(ProjectMemberSchema, memberPath(slug, userId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A 204. */
export function removeMember(slug: string, userId: string): Promise<void> {
  return apiFetchNoContent(memberPath(slug, userId), { method: 'DELETE' });
}
