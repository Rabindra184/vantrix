import { Controller, Get, Param, Req } from '@nestjs/common';
import type { RunEventsResponse } from '@perfportal/contracts';
import { RunnerRepository, RunRepository } from '@perfportal/persistence';
import type { Request } from 'express';
import { Scopes } from '../auth/scopes.decorator.js';
import { notFound, uuidParam } from '../common/validation.js';

/**
 * ═══ A RUN'S LIFECYCLE EVENTS — WHAT THE LOGS TAB READS ═══
 * (docs/superpowers/specs/2026-09-29-run-logs-design.md)
 *
 * Under `/v1/runs/:id` like every other run-scoped read, which is what puts it
 * in the two guards derived from that prefix: session-auth's cross-org list
 * and the OpenAPI route/document join.
 *
 * `recorded: false` is a run no on-prem runner job produced — an upload, or a
 * run the Gradle plugin streamed. The run page offers no Logs tab for one; a
 * typed URL still reaches this, and the answer says why there is nothing.
 */
@Controller('/v1/runs/:id')
export class RunEventsController {
  constructor(
    private readonly runs: RunRepository,
    private readonly runner: RunnerRepository,
  ) {}

  @Get('events')
  @Scopes('read')
  async events(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
  ): Promise<RunEventsResponse> {
    const tenant = req.tenant!;
    const run = await this.runs.findById({ orgId: tenant.orgId, projectId: tenant.projectId }, id);
    if (!run) {
      throw notFound(
        `No run ${id} in this project.`,
        'Check the run id. GET /v1/runs lists the runs a signed-in user can reach; '
          + 'GET /v1/projects/{slug}/runs lists those a project token can.',
      );
    }
    const found = await this.runner.listEventsForRun(run.orgId, run.projectId, run.id);
    return {
      runId: run.id,
      recorded: found !== null,
      events: (found?.events ?? []).map((event) => ({
        at: event.at.toISOString(),
        source: event.source,
        message: event.message,
        phase: event.phase,
      })),
    };
  }
}
