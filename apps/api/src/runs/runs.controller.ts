import { Controller, Get, NotFoundException, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { problemFromIngestError } from '../common/problem.js';
import { badRequest, parseCursor, parseLimit, uuidParam } from '../common/validation.js';
import { IngestError, type IngestErrorCode } from '@perfportal/core';
import {
  RunStatusSchema,
  RunVerdictSchema,
  type RunListResponse,
  type RunStatus,
  type RunVerdict,
} from '@perfportal/contracts';
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
  constructor(
    private readonly runs: RunsService,
    private readonly projects: ProjectRepository,
  ) {}

  /**
   * Org-scoped by credential, not by URL. A bearer token carries a projectId
   * and stays restricted to it, exactly as before. A session carries none and
   * sees every run in its org unless "project" narrows it by slug — the
   * spread below takes the org-only branch of RunRepository.list whenever a
   * session names no project.
   */
  @Get()
  @Scopes('read')
  async list(
    @Req() req: Request,
    @Query('limit') limit = '25',
    @Query('cursor') cursor?: string,
    @Query('project') project?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('verdict') verdict?: string,
  ): Promise<RunListResponse> {
    const tenant = req.tenant!;
    let projectId = tenant.projectId;

    if (project !== undefined) {
      const named = await this.projects.findBySlugInOrg(tenant.orgId, project);
      // 404, never 403 and never an empty 200: a 403 confirms the project
      // exists, and an empty 200 describes a project that exists and happens
      // to be idle. The status code must not distinguish "no such project"
      // from "not yours".
      if (!named) throw new NotFoundException(`No project "${project}" in this organisation.`);
      // A bearer token is minted against exactly one project. Naming another
      // is a caller mistake, not a permission question — and answering with
      // that token's own runs under someone else's slug would be a silent
      // wrong answer.
      if (tenant.projectId && tenant.projectId !== named.id) {
        throw badRequest(
          'PROJECT_MISMATCH',
          `This token belongs to a different project than "${project}".`,
          'Omit "project", or use a session, which can read every project in the org.',
        );
      }
      projectId = named.id;
    }

    const parsedCursor = parseCursor(cursor);
    const filters = parseRunListFilters({ q, status, verdict });
    const page = await this.runs.runs().list(
      { orgId: tenant.orgId, ...(projectId ? { projectId } : {}) },
      {
        limit: parseLimit(limit),
        ...(parsedCursor ? { cursor: parsedCursor } : {}),
        ...filters,
      },
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
    // IDENTITY, NOT MEASUREMENTS. Every field here is already on the
    // RunRecord this function was handed — `project` is joined (see
    // RunRecord's own comment on why the worker pays that indexed join), so
    // the wider body costs no additional query. That is the whole reason this
    // is a widened 202 rather than a full `toResponse` at every status:
    // toResponse runs runAssertion.findMany and the isWindowable EXISTS, which
    // a poller would pay for every five seconds, per watcher, per live run.
    res
      .status(202)
      .set('Retry-After', String(retryAfterSeconds))
      .json({
        id: run.id,
        status: run.status,
        statusUrl: `/v1/runs/${run.id}`,
        project: run.project,
        tool: run.tool,
        toolVersion: run.toolVersion,
        environment: run.environment,
        branch: run.branch,
        commitSha: run.commitSha,
        simulation: run.simulation,
        description: run.description,
        durationMs: run.durationMs,
        startedAt: run.startedAt.toISOString(),
        toolStartedAt: run.toolStartedAt ? run.toolStartedAt.toISOString() : null,
      });
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
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('verdict') verdict?: string,
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
    const filters = parseRunListFilters({ q, status, verdict });
    const page = await this.runs.runs().list(
      { orgId: tenant.orgId, projectId },
      {
        limit: parseLimit(limit),
        ...(parsedCursor ? { cursor: parsedCursor } : {}),
        ...filters,
      },
    );
    return { items: page.items.map(toListItem), nextCursor: page.nextCursor };
  }
}

type RunVerdictFilter = RunVerdict | 'none';

function parseRunListFilters(input: {
  readonly q?: string;
  readonly status?: string;
  readonly verdict?: string;
}): { q?: string; status?: RunStatus; verdict?: RunVerdictFilter } {
  const q = input.q?.trim();
  const status = input.status?.trim();
  const verdict = input.verdict?.trim();
  const filters: { q?: string; status?: RunStatus; verdict?: RunVerdictFilter } = {};
  if (q) filters.q = q;

  if (status) {
    const parsed = RunStatusSchema.safeParse(status);
    if (!parsed.success) {
      throw badRequest(
        'RUN_FILTER_INVALID',
        `Unknown run status "${status}".`,
        'Use pending, parsing, running, complete, failed, or incomplete.',
      );
    }
    filters.status = parsed.data;
  }

  if (verdict) {
    if (verdict === 'none') {
      filters.verdict = 'none';
      return filters;
    }
    const parsed = RunVerdictSchema.safeParse(verdict);
    if (!parsed.success) {
      throw badRequest(
        'RUN_FILTER_INVALID',
        `Unknown run verdict "${verdict}".`,
        'Use passed, failed, not_evaluated, or none.',
      );
    }
    filters.verdict = parsed.data;
  }

  return filters;
}
