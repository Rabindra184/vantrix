import { Body, ConflictException, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  CreateProjectRequestSchema,
  ProjectListResponseSchema,
  ProjectSummarySchema,
  type ProjectListResponse,
  type ProjectSummary,
  type RunStatus,
  type RunVerdict,
} from '@perfportal/contracts';
import { ProjectRepository } from '@perfportal/persistence';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { Scopes } from '../auth/scopes.decorator.js';
import { badRequest } from '../common/validation.js';

// AuthGuard is registered globally via APP_GUARD (see auth.module.ts), so
// every route authenticates by default. @Scopes('read') is still required
// per-route.
@Controller('/v1/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectRepository) {}

  /**
   * The projects this credential can see — one rule, not two. A session
   * names no project and sees its whole org's; a bearer token is minted
   * against exactly one and sees that one, as a one-element list. Not a 400
   * for the token: asking what it can see is a reasonable question with a
   * correct answer, and a CI job resolving its own slug is the caller.
   */
  @Get()
  @Scopes('read')
  async list(@Req() req: Request): Promise<ProjectListResponse> {
    const tenant = req.tenant!;
    const rows = await this.projects.listForOrg(tenant.orgId, tenant.projectId);
    // The repository reads status and verdict off raw SQL, so they arrive as
    // `string`. Narrowed here rather than in the repository, which has no
    // business importing the contract's enums — and the assembled response
    // is parsed through ProjectListResponseSchema below, so these casts are
    // provisional, not the actual validation. There is no global validation
    // pipe (see main.ts): without the parse below, a malformed stored value
    // would have escaped as a 200 that violates its own contract. A row that
    // fails to parse now produces a 500 instead — the right trade, and the
    // same stance apiFetch's docstring takes on the client (apps/web/src/api/fetch.ts):
    // a response the schema rejects is a bug, not data.
    return ProjectListResponseSchema.parse({
      items: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        latestRun:
          r.latestRun === null
            ? null
            : {
                id: r.latestRun.id,
                status: r.latestRun.status as RunStatus,
                verdict: r.latestRun.verdict as RunVerdict | null,
              },
      })),
    });
  }

  @Post()
  @HttpCode(201)
  @UseGuards(SessionOnlyGuard)
  async create(@Req() req: Request, @Body() body: unknown): Promise<ProjectSummary> {
    const tenant = req.tenant!;
    const parsed = CreateProjectRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_PROJECT_REQUEST',
        `The project request is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        'Send a non-empty "name" and a lowercase URL slug such as "checkout-api".',
      );
    }

    const project = await this.projects.createInOrg({
      orgId: tenant.orgId,
      name: parsed.data.name,
      slug: parsed.data.slug,
    });
    if (project === null) {
      throw new ConflictException(`A project with slug "${parsed.data.slug}" already exists in this organisation.`);
    }

    return ProjectSummarySchema.parse({
      id: project.id,
      slug: project.slug,
      name: project.name,
      latestRun: null,
    });
  }
}
