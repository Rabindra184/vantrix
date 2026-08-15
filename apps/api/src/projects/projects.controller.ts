import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { ProjectListResponse, RunStatus, RunVerdict } from '@perfportal/contracts';
import { ProjectRepository } from '@perfportal/persistence';
import { Scopes } from '../auth/scopes.decorator.js';

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
    return {
      items: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        // The repository reads status and verdict off raw SQL, so they
        // arrive as `string`. Narrowed here rather than in the repository,
        // which has no business importing the contract's enums — and the
        // Zod schema is what actually validates the value on the way out.
        latestRun:
          r.latestRun === null
            ? null
            : {
                id: r.latestRun.id,
                status: r.latestRun.status as RunStatus,
                verdict: r.latestRun.verdict as RunVerdict | null,
              },
      })),
    };
  }
}
