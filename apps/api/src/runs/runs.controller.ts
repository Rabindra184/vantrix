import { Controller, Get, NotFoundException, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { problemFromIngestError } from '../common/problem.js';
import { badRequest, parseCursor, parseLimit, uuidParam } from '../common/validation.js';
import { IngestError, type IngestErrorCode } from '@perfportal/core';
import type { RunListResponse } from '@perfportal/contracts';
import { ProjectRepository, type RunRecord } from '@perfportal/persistence';
import { Scopes } from '../auth/scopes.decorator.js';
import { RunsService } from './runs.service.js';

// AuthGuard is registered globally via APP_GUARD (see auth.module.ts), so
// every route authenticates by default — @UseGuards(AuthGuard) here would be
// redundant. @Scopes('read') is still required per-route.
//
// @Get() is declared before @Get(':id') for readability, not because it must
// be: Express 5's named parameter (:id) matches exactly one NON-EMPTY path
// segment, so GET /v1/runs and GET /v1/runs/:id never overlap in the first
// place — declaration order between them is behaviourally irrelevant. Proved
// by reordering them and re-running session-auth.integration.test.ts (still
// 14/14); see the Task 9 report for that run.
@Controller('/v1/runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  /**
   * Org-scoped by credential, not by URL. A bearer token carries a projectId
   * and stays restricted to it, exactly as before. A session carries none and
   * sees every run in its org — the spread below is what expresses that, and
   * it is the only production caller of RunRepository.list's org-only branch.
   */
  @Get()
  @Scopes('read')
  async list(
    @Req() req: Request,
    @Query('limit') limit = '25',
    @Query('cursor') cursor?: string,
  ): Promise<RunListResponse> {
    const tenant = req.tenant!;
    const parsedCursor = parseCursor(cursor);
    const page = await this.runs.runs().list(
      { orgId: tenant.orgId, ...(tenant.projectId ? { projectId: tenant.projectId } : {}) },
      { limit: parseLimit(limit), ...(parsedCursor ? { cursor: parsedCursor } : {}) },
    );
    return { items: page.items.map(toListItem), nextCursor: page.nextCursor };
  }

  @Get(':id')
  @Scopes('read')
  async get(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const tenant = req.tenant!;
    const run = await this.runs
      .runs()
      .findById({ orgId: tenant.orgId, projectId: tenant.projectId }, id);
    if (!run) throw new NotFoundException(`No run ${id} in this project.`);

    await respondWithRun(this.runs, run, res);
  }
}

/**
 * Shared by RunsController.list and ProjectRunsController.list so the two
 * response shapes cannot drift — the same "same code for the same state"
 * guarantee respondWithRun makes for a single run's status mapping.
 */
function toListItem(r: RunRecord): RunListResponse['items'][number] {
  return {
    id: r.id,
    project: r.project,
    simulation: r.simulation,
    status: r.status as RunListResponse['items'][number]['status'],
    verdict: (r.verdict ?? null) as RunListResponse['items'][number]['verdict'],
    tool: r.tool,
    startedAt: r.startedAt.toISOString(),
    toolStartedAt: r.toolStartedAt ? r.toolStartedAt.toISOString() : null,
  };
}

/**
 * Shared by GET and POST so the two cannot drift. This function IS the
 * "same code for the same state" guarantee.
 */
export async function respondWithRun(
  runs: RunsService,
  run: RunRecord,
  res: Response,
  retryAfterSeconds = 5,
): Promise<void> {
  const status = runs.statusFor(run);

  if (status === 202) {
    res
      .status(202)
      .set('Retry-After', String(retryAfterSeconds))
      .json({ id: run.id, status: run.status, statusUrl: `/v1/runs/${run.id}` });
    return;
  }

  if (run.status === 'failed') {
    const err = run.error ?? {
      code: 'INTERNAL',
      message: 'The run could not be ingested.',
      remediation: 'Retry the upload.',
    };
    const body = problemFromIngestError(
      new IngestError(err.code as IngestErrorCode, {
        message: err.message,
        remediation: err.remediation,
      }),
    );
    // `status` came from runs.statusFor(run) above, which now maps a failed
    // run through the same statusForCode(...) helper problemFromIngestError
    // uses internally to set body.status — so the two are guaranteed to
    // agree by construction. Using `status` here (rather than recomputing
    // via body.status) is what makes statusFor() authoritative rather than
    // decorative.
    res.status(status).type('application/problem+json').json(body);
    return;
  }

  res.status(status).json(await runs.toResponse(run));
}

// AuthGuard is registered globally via APP_GUARD (see auth.module.ts), so
// every route authenticates by default — @UseGuards(AuthGuard) here would be
// redundant. @Scopes('read') is still required per-route.
@Controller('/v1/projects/:slug/runs')
export class ProjectRunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly projects: ProjectRepository,
  ) {}

  @Get()
  @Scopes('read')
  async list(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Query('limit') limit = '25',
    @Query('cursor') cursor?: string,
  ): Promise<RunListResponse> {
    const tenant = req.tenant!;
    // A session names no project, but this route names one in its URL and
    // has no other tenancy check: RunRepository.list (below) drops the
    // project filter entirely when projectId is absent, so skipping this
    // guard would list every run in the org under a single-project URL.
    // Resolving the project by slug within the org instead was considered
    // and rejected (human-ruled) — a session-holder uses GET /v1/runs,
    // which already lists across the whole org.
    const projectId = tenant.projectId;
    if (!projectId) {
      throw badRequest(
        'PROJECT_REQUIRED',
        'This endpoint requires a project-scoped credential.',
        'Use GET /v1/runs with a session, or a project API token here.',
      );
    }

    const project = await this.projects.byId(projectId);
    // The token names the project; the slug must agree with it. A token cannot
    // read a project it does not belong to by naming a different slug.
    if (!project || project.slug !== slug) {
      throw new NotFoundException(`No project "${slug}" available to this token.`);
    }

    const parsedCursor = parseCursor(cursor);
    const page = await this.runs.runs().list(
      { orgId: tenant.orgId, projectId },
      { limit: parseLimit(limit), ...(parsedCursor ? { cursor: parsedCursor } : {}) },
    );
    return { items: page.items.map(toListItem), nextCursor: page.nextCursor };
  }
}
