import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import {
  AddMemberRequestSchema,
  MemberListResponseSchema,
  PROJECT_ROLES,
  ProjectMemberSchema,
  UpdateMemberRequestSchema,
  type MemberListResponse,
  type ProjectMember,
} from '@perfportal/contracts';
import {
  ProjectMemberRepository,
  ProjectRepository,
  UserRepository,
  type OrgUserRow,
  type ProjectMemberRow,
  type ProjectRecord,
} from '@perfportal/persistence';
import type { Request } from 'express';
import { Requires } from '../auth/access.decorator.js';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { isUniqueViolationOn, prismaCode, prismaMeta } from '../common/prisma-errors.js';
import { badRequest, conflict, firstIssue, notFound, projectNotFound, userNotFound } from '../common/validation.js';

/** The three roles as a reader writes them in a sentence, lowest first: "viewer", "member" or "manager". */
const ROLES_IN_WORDS = `${PROJECT_ROLES.slice(0, -1).map((r) => `"${r}"`).join(', ')} or "${PROJECT_ROLES.at(-1)}"`;

/**
 * Someone in the org who holds no role in this project. The remediation keeps
 * the route's own placeholders, as every remediation here names a route: the
 * slug and the id are already in the detail beside it.
 */
function memberNotFound(slug: string, userId: string) {
  return notFound(
    `No member ${userId} in project "${slug}".`,
    'List the members with GET /v1/projects/{slug}/members.',
  );
}

function memberExists(name: string) {
  return conflict(
    'MEMBER_EXISTS',
    `${name} is already a member of this project.`,
    'Change their role with PATCH /v1/projects/{slug}/members/{userId}.',
  );
}

/**
 * The membership's primary key, (project_id, user_id), as Prisma names it in a
 * P2002's `meta.target` (measured: `['project_id', 'user_id']`). Matched as a
 * set of exactly those two, so a unique index added to the table later, which
 * would refuse for some other reason, is never reported as "already a member".
 */
const MEMBERSHIP_KEY = ['project_id', 'user_id'] as const;

/** The membership's foreign key to the person it is for, `project_member_user_id_fkey`. */
function isUserForeignKey(meta: Record<string, unknown> | undefined): boolean {
  return [meta?.constraint, meta?.field_name].some((v) => typeof v === 'string' && v.includes('user_id'));
}

function toMember(row: ProjectMemberRow): ProjectMember {
  return ProjectMemberSchema.parse({
    userId: row.userId,
    name: row.name,
    email: row.email,
    role: row.role,
    addedAt: row.addedAt.toISOString(),
  });
}

/**
 * Who holds a role in a project (docs/superpowers/specs/2026-10-07-project-
 * access-design.md, sections 1 and 2). Listing is `members:read`, which every
 * role in the project has. Adding, changing and removing are `members:manage`,
 * an admin's action: `AccessGuard` refuses anyone else ADMIN_REQUIRED before
 * any lookup, so a slug that does not exist and one the caller cannot see get
 * the same answer. Session-only on the CLASS, as `/v1/admin` is: a membership
 * is a person's access, and a bearer token names no person.
 *
 * An admin needs no row to see a project, so the list holds only the people
 * who need one. A role granted, changed or taken away here is in force on
 * that person's next request: roles are read per request and never cached.
 *
 * ═══ AN ACCOUNT OUTSIDE THE ORG IS NOT FOUND ═══
 *
 * Every person these routes name — the body's `userId` on POST, the path's
 * on PATCH and DELETE — resolves through `UserRepository.findInOrg` with the
 * caller's own org first, as `/v1/admin` does: an account of another org, one
 * in no org, and an id naming nobody all answer the same 404 (`userNotFound`),
 * and nothing changes. Only someone in the org who holds no role in the
 * project gets the members 404, which names the project.
 */
@Controller('/v1/projects/:slug/members')
@UseGuards(SessionOnlyGuard)
export class MembersController {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly members: ProjectMemberRepository,
    private readonly users: UserRepository,
  ) {}

  /** Everyone holding a role in the project, by name. */
  @Get()
  @Requires('members:read')
  async list(@Req() req: Request, @Param('slug') slug: string): Promise<MemberListResponse> {
    const project = await this.resolveProject(req.tenant!.orgId, slug);
    const rows = await this.members.listForProject(project.id);
    return MemberListResponseSchema.parse({ members: rows.map(toMember) });
  }

  /**
   * Gives someone in the org a role in the project. 201: the membership is
   * written before this answers, and listed at once. Someone who already holds
   * a role is refused 409 MEMBER_EXISTS rather than having it changed — that
   * is PATCH's, and a POST that quietly re-roled someone would make two admins
   * adding one person at once disagree about what they did.
   */
  @Post()
  @Requires('members:manage')
  @HttpCode(201)
  async add(@Req() req: Request, @Param('slug') slug: string, @Body() body: unknown): Promise<ProjectMember> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, slug);
    const parsed = AddMemberRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_MEMBER_REQUEST',
        `The member request is not valid: ${firstIssue(parsed.error)}`,
        `Send a "userId" from GET /v1/admin/users and a "role" of ${ROLES_IN_WORDS}, and no other field.`,
      );
    }
    const { userId, role } = parsed.data;
    const person = await this.inOrg(tenant.orgId, userId);

    // ONE judge of "already a member": the primary key, (project_id,
    // user_id). A read of the person's memberships first would agree with it
    // on every reachable state but one — an add that commits between that
    // read and this INSERT — so the read could only ever mask the key, never
    // replace it. The key answers the plain case and the race alike, with the
    // same 409; a unique violation on any OTHER index is not this, and stays
    // an error.
    try {
      await this.members.add({ projectId: project.id, userId, role, addedBy: tenant.userId! });
    } catch (err) {
      if (isUniqueViolationOn(err, MEMBERSHIP_KEY)) throw memberExists(person.name);
      // The person's account removed after the org check above, before this
      // INSERT's foreign-key check: the 404 any account outside the org gets.
      // Prisma 6 names the constraint in `meta.constraint` (measured:
      // project_member_user_id_fkey); `field_name` is the older spelling. Any
      // other key — the adder's own account gone — is not this, and stays an
      // error.
      if (prismaCode(err) === 'P2003' && isUserForeignKey(prismaMeta(err))) throw userNotFound(userId);
      throw err;
    }
    return this.answer(slug, project.id, userId);
  }

  /** Changes someone's role in the project. Someone without one is a 404: this never adds. */
  @Patch(':userId')
  @Requires('members:manage')
  async update(
    @Req() req: Request,
    @Param('slug') slug: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<ProjectMember> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, slug);
    await this.inOrg(tenant.orgId, userId);
    const parsed = UpdateMemberRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_MEMBER_UPDATE',
        `The member update is not valid: ${firstIssue(parsed.error)}`,
        `Send a "role" of ${ROLES_IN_WORDS}, and no other field.`,
      );
    }
    if (!(await this.members.setRole(project.id, userId, parsed.data.role))) throw memberNotFound(slug, userId);
    return this.answer(slug, project.id, userId);
  }

  /**
   * Takes someone's role in the project away. Their account, their place in
   * the org and their other memberships stay; with none left, their next
   * `GET /v1/projects` is empty.
   */
  @Delete(':userId')
  @Requires('members:manage')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('slug') slug: string, @Param('userId') userId: string): Promise<void> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, slug);
    await this.inOrg(tenant.orgId, userId);
    if (!(await this.members.remove(project.id, userId))) throw memberNotFound(slug, userId);
  }

  /**
   * 404, never 403, for a slug outside the caller's org. An admin reaches here
   * for any slug; anyone else only for a project the guard has already found
   * them a role in.
   */
  private async resolveProject(orgId: string, slug: string): Promise<ProjectRecord> {
    const project = await this.projects.findBySlugInOrg(orgId, slug);
    if (!project) throw projectNotFound(slug);
    return project;
  }

  /** The org-scoped lookup every person named here starts with: not in this org is 404. */
  private async inOrg(orgId: string, userId: string): Promise<OrgUserRow> {
    const row = await this.users.findInOrg(orgId, userId);
    if (row === null) throw userNotFound(userId);
    return row;
  }

  /**
   * The membership as it now stands, read back after a change. Gone by then —
   * removed by a request that landed in between — is the members 404, which
   * is what is true of it.
   */
  private async answer(slug: string, projectId: string, userId: string): Promise<ProjectMember> {
    const row = await this.members.find(projectId, userId);
    if (row === null) throw memberNotFound(slug, userId);
    return toMember(row);
  }
}
