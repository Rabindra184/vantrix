import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import {
  AdminProjectListResponseSchema,
  AdminUserListResponseSchema,
  AdminUserSchema,
  CreateUserRequestSchema,
  DataIntegritySchema,
  OrgSettingsSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  RecomputeProgressSchema,
  SetPasswordRequestSchema,
  UpdateOrgSettingsRequestSchema,
  UpdateUserRequestSchema,
  type AdminProjectListResponse,
  type AdminUser,
  type AdminUserListResponse,
  type DataIntegrity,
  type OrgSettings,
  type RecomputeProgress,
} from '@perfportal/contracts';
import {
  OrgSettingsRepository,
  ProjectMemberRepository,
  ProjectRepository,
  RecomputeRepository,
  UserRepository,
  VerificationRepository,
  type OrgUserRow,
} from '@perfportal/persistence';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { Requires } from '../auth/access.decorator.js';
import { CONFIG } from '../auth/auth.module.js';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { badRequest, firstIssue, userNotFound } from '../common/validation.js';
import type { AppConfig } from '../config.js';
import { AdminUsersService } from './admin-users.service.js';

/** How many failed verifications the data-integrity page lists; the counts above it are whole. */
const PROBLEM_LIMIT = 100;

/**
 * The host (hostname and port) of an openai-compatible endpoint, for the
 * consent sentence beside the AI switch. `URL#host` carries neither userinfo
 * nor path nor query, so `https://user:secret@llm.internal:8443/v1?k=x`
 * names `llm.internal:8443` and nothing an admin page must not show.
 * `parseAiConfig` already refused a base URL that does not parse, so the
 * catch is for a config object built some other way: no host is said rather
 * than the raw string.
 */
function baseUrlHost(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

function toAdminUser(row: OrgUserRow): AdminUser {
  return AdminUserSchema.parse({
    id: row.id,
    name: row.name,
    email: row.email,
    isAdmin: row.role === 'admin',
    disabled: row.banned,
    mustChangePassword: row.mustChangePassword,
    memberships: row.memberships.map((m) => ({ projectSlug: m.projectSlug, projectName: m.projectName, role: m.role })),
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Administration (docs/superpowers/specs/2026-10-07-project-access-design.md,
 * section 3): every account in the install, and every project. Every handler
 * is `users:manage`, an admin's action, which `AccessGuard` refuses anyone
 * else ADMIN_REQUIRED before a handler runs. Session-only on the CLASS, so a
 * route added here later cannot forget it: a bearer token names no person,
 * and an account is a person's to manage.
 *
 * ═══ AN ACCOUNT OUTSIDE THE ORG IS NOT FOUND ═══
 *
 * Every `:userId` resolves through `UserRepository.findInOrg` with the
 * caller's own org FIRST, before the body is read or anything else is
 * decided: an account of another org, one in no org, and an id naming nobody
 * all answer the same 404, so an admin of one install can neither change nor
 * probe another's accounts.
 *
 * The controller parses, scopes, refuses what a caller may not do to their
 * own account, and shapes the answer; `AdminUsersService` makes the Better
 * Auth calls and holds the org's admin lock.
 */
@Controller('/v1/admin')
@UseGuards(SessionOnlyGuard)
export class AdminController {
  constructor(
    private readonly users: UserRepository,
    private readonly projects: ProjectRepository,
    private readonly projectMembers: ProjectMemberRepository,
    private readonly service: AdminUsersService,
    private readonly recompute: RecomputeRepository,
    private readonly verifications: VerificationRepository,
    private readonly orgSettings: OrgSettingsRepository,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Every account with a membership of this org, by name. */
  @Get('users')
  @Requires('users:manage')
  async listUsers(@Req() req: Request): Promise<AdminUserListResponse> {
    const rows = await this.users.listInOrg(req.tenant!.orgId);
    return AdminUserListResponseSchema.parse({ users: rows.map(toAdminUser) });
  }

  /**
   * Creates an account that must choose its own password at first sign-in.
   * 201: the account, its membership of the org and its project roles are
   * all written before this answers, and it is listed at once.
   */
  @Post('users')
  @Requires('users:manage')
  @HttpCode(201)
  async createUser(@Req() req: Request, @Body() body: unknown): Promise<AdminUser> {
    const tenant = req.tenant!;
    const parsed = CreateUserRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_USER_REQUEST',
        `The user request is not valid: ${firstIssue(parsed.error)}`,
        `Send "email", "name" and a "password" of ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters; ` +
          '"isAdmin" and "projects" ([{ "projectSlug", "role" }]) are optional, and no other field is taken.',
      );
    }
    const userId = await this.service.create(
      tenant.orgId,
      tenant.userId!,
      parsed.data,
      fromNodeHeaders(req.headers),
    );
    return this.answer(tenant.orgId, userId);
  }

  /**
   * Renames an account, makes or unmakes it an admin, and disables or
   * enables it. Disabling yourself is refused (400 CANNOT_DISABLE_SELF): it
   * would end the session asking. Taking the last active admin out — your own
   * admin included — is refused 409 LAST_ADMIN.
   */
  @Patch('users/:userId')
  @Requires('users:manage')
  async updateUser(@Req() req: Request, @Param('userId') userId: string, @Body() body: unknown): Promise<AdminUser> {
    const tenant = req.tenant!;
    await this.inOrg(tenant.orgId, userId);
    const parsed = UpdateUserRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_USER_UPDATE',
        `The user update is not valid: ${firstIssue(parsed.error)}`,
        'Send at least one of "name", "isAdmin" or "disabled", and no other field.',
      );
    }
    if (parsed.data.disabled === true && userId === tenant.userId) {
      throw badRequest('CANNOT_DISABLE_SELF', 'You cannot disable your own account.', 'Ask another admin to disable it.');
    }
    await this.service.update(tenant.orgId, userId, parsed.data, fromNodeHeaders(req.headers));
    return this.answer(tenant.orgId, userId);
  }

  /**
   * Resets someone else's password to a temporary one, which they must
   * replace at their next sign-in; every session they hold ends. Your own is
   * refused: it is changed with your current password, at PUT /v1/me/password.
   */
  @Put('users/:userId/password')
  @Requires('users:manage')
  @HttpCode(204)
  async resetPassword(@Req() req: Request, @Param('userId') userId: string, @Body() body: unknown): Promise<void> {
    const tenant = req.tenant!;
    await this.inOrg(tenant.orgId, userId);
    if (userId === tenant.userId) {
      throw badRequest(
        'CANNOT_RESET_OWN_PASSWORD',
        'You cannot reset your own password here.',
        'Change your own password with PUT /v1/me/password.',
      );
    }
    const parsed = SetPasswordRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_PASSWORD_RESET',
        `The password reset is not valid: ${firstIssue(parsed.error)}`,
        `Send a "password" of ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters, and no other field.`,
      );
    }
    await this.service.resetPassword(userId, parsed.data.password, fromNodeHeaders(req.headers));
  }

  /** Removes an account. Yourself is refused; so is the last active admin. */
  @Delete('users/:userId')
  @Requires('users:manage')
  @HttpCode(204)
  async removeUser(@Req() req: Request, @Param('userId') userId: string): Promise<void> {
    const tenant = req.tenant!;
    await this.inOrg(tenant.orgId, userId);
    if (userId === tenant.userId) {
      throw badRequest('CANNOT_REMOVE_SELF', 'You cannot remove your own account.', 'Ask another admin to remove it.');
    }
    await this.service.remove(tenant.orgId, userId, fromNodeHeaders(req.headers));
  }

  /** Every project in the org, by name, with how many people hold a role in it. */
  @Get('projects')
  @Requires('users:manage')
  async listProjects(@Req() req: Request): Promise<AdminProjectListResponse> {
    const rows = await this.projects.listForAdmin(req.tenant!.orgId);
    const counts = await this.projectMembers.memberCounts(rows.map((r) => r.id));
    return AdminProjectListResponseSchema.parse({
      projects: rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        memberCount: counts.get(r.id) ?? 0,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  }

  /**
   * How far the exact-statistics backfill has got in this org: finished runs
   * with statistics, the ones still estimated, and the ones it gave up on.
   * Scoped to the caller's org like every route here — another org's runs are
   * never counted.
   */
  @Get('recompute')
  @Requires('users:manage')
  async recomputeProgress(@Req() req: Request): Promise<RecomputeProgress> {
    return RecomputeProgressSchema.parse(await this.recompute.progress(req.tenant!.orgId));
  }

  /**
   * Administration › Data integrity for this org: the backfill's progress
   * (the route above's own answer), the org's verifiable runs by
   * verification status, the mismatched and unverifiable runs — most recently
   * checked first, at most `PROBLEM_LIMIT` — and the raw-log retention the
   * worker applies, stated read-only. Every count and every listed run is the
   * caller's own org's: each repository call is scoped by it.
   */
  @Get('data-integrity')
  @Requires('users:manage')
  async dataIntegrity(@Req() req: Request): Promise<DataIntegrity> {
    const orgId = req.tenant!.orgId;
    const [recompute, verification, problems] = await Promise.all([
      this.recompute.progress(orgId),
      this.verifications.summary(orgId),
      this.verifications.problems(orgId, PROBLEM_LIMIT),
    ]);
    return DataIntegritySchema.parse({
      recompute,
      verification,
      problems: problems.map((p) => ({ ...p, checkedAt: p.checkedAt?.toISOString() ?? null })),
      rawLogRetentionDays: this.config.rawLogRetentionDays,
    });
  }

  /**
   * The org's own settings: the AI run analysis switch, and — read-only —
   * whether the DEPLOYMENT configures a provider, which one and which model,
   * so Administration can say whether there is anything to switch on and
   * what leaves the deployment when it is. Never the key.
   */
  @Get('settings')
  @Requires('users:manage')
  async settings(@Req() req: Request): Promise<OrgSettings> {
    return this.#settings(req.tenant!.orgId);
  }

  /**
   * Turn AI run analysis on or off for this org. The switch is the only
   * field: the provider and model are the environment's, and the schema is
   * `.strict()`, so a body that tries to set them is refused rather than
   * answered as though it had worked. Off stops new analyses AND hides stored
   * ones; a job queued just before is re-checked by the worker and sends
   * nothing.
   */
  @Put('settings')
  @Requires('users:manage')
  async updateSettings(@Req() req: Request, @Body() body: unknown): Promise<OrgSettings> {
    const parsed = UpdateOrgSettingsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_ORG_SETTINGS',
        `The settings are not valid: ${firstIssue(parsed.error)}`,
        'Send {"aiEnabled": true} or {"aiEnabled": false}. No other field is accepted: the AI provider and ' +
          'model are the deployment\'s environment (AI_PROVIDER, AI_MODEL), not an organisation setting.',
      );
    }
    const orgId = req.tenant!.orgId;
    await this.orgSettings.setAiEnabled(orgId, parsed.data.aiEnabled);
    return this.#settings(orgId);
  }

  async #settings(orgId: string): Promise<OrgSettings> {
    const ai = this.config.ai;
    return OrgSettingsSchema.parse({
      aiEnabled: await this.orgSettings.aiEnabled(orgId),
      aiProviderConfigured: ai !== null,
      aiProvider: ai?.provider ?? null,
      aiModel: ai?.model ?? null,
      aiBaseUrlHost: ai?.provider === 'openai-compatible' ? baseUrlHost(ai.baseUrl) : null,
    });
  }

  /** The org-scoped lookup every `:userId` starts with: not in this org is 404. */
  private async inOrg(orgId: string, userId: string): Promise<OrgUserRow> {
    const row = await this.users.findInOrg(orgId, userId);
    if (row === null) throw userNotFound(userId);
    return row;
  }

  /** The account as it now stands, read back after a change. */
  private async answer(orgId: string, userId: string): Promise<AdminUser> {
    return toAdminUser(await this.inOrg(orgId, userId));
  }
}
