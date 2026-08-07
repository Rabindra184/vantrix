import { Controller, Get, NotFoundException, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { problemFromIngestError } from '../common/problem.js';
import { IngestError, type IngestErrorCode } from '@perfportal/core';
import type { RunRecord } from '@perfportal/persistence';
import { Scopes } from '../auth/scopes.decorator.js';
import { RunsService } from './runs.service.js';

// AuthGuard is registered globally via APP_GUARD (see auth.module.ts), so
// every route authenticates by default — @UseGuards(AuthGuard) here would be
// redundant. @Scopes('read') is still required per-route.
@Controller('/v1/runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get(':id')
  @Scopes('read')
  async get(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const tenant = req.tenant!;
    const run = await this.runs
      .runs()
      .findById({ orgId: tenant.orgId, projectId: tenant.projectId }, id);
    if (!run) throw new NotFoundException(`No run ${id} in this project.`);

    await respondWithRun(this.runs, run, res);
  }
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
