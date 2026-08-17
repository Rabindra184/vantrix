import { Controller, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { OpenLiveRunRequestSchema } from '@perfportal/contracts';
import { Scopes } from '../auth/scopes.decorator.js';
import { problem } from '../common/problem.js';
import { badRequest, uuidParam } from '../common/validation.js';
import { respondWithRun } from '../runs/runs.controller.js';
import { RunsService } from '../runs/runs.service.js';
import { LiveService } from './live.service.js';

/**
 * Reads the whole request body as a Buffer, the way multipart.ts reads the
 * "bundle" part — by consuming the raw request stream directly, rather than
 * letting a body parser buffer it under a content type it recognizes.
 * Express's default json()/urlencoded() middleware (registered globally by
 * Nest) only consumes a request whose Content-Type matches its own; a chunk
 * POST is sent as raw bytes under a different Content-Type (e.g.
 * application/octet-stream), so those parsers skip it and leave the stream
 * untouched for this to read.
 */
function readRawBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseOffsetHeader(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = value === undefined ? NaN : Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw badRequest(
      'INVALID_STREAM_OFFSET',
      `"x-stream-offset" must be a non-negative integer, not "${value ?? '(missing)'}".`,
      'Send the byte offset this chunk begins at as the "x-stream-offset" header, for example "0" for the first chunk of a run.',
    );
  }
  return n;
}

// AuthGuard is registered globally via APP_GUARD (see auth.module.ts), so
// every route authenticates by default — @UseGuards(AuthGuard) here would be
// redundant. @Scopes('stream') is still required per-route.
//
// Sharing '/v1/runs' with IngestController and RunsController is fine:
// NestJS resolves routes by their full (method, path) pair across every
// controller in the app, not by controller-unique prefixes — the same way
// IngestController's bare POST and RunsController's GET already coexist
// here today.
//
// 'live' is declared before ':id/stream'/':id/close' for readability, not
// because it must be: '/v1/runs/live' is one path segment past '/v1/runs',
// ':id/stream' and ':id/close' are two, so Express 5's exact-segment
// parameter matching (see runs.controller.ts's own note on this) never lets
// the literal collide with either regardless of declaration order.
@Controller('/v1/runs')
export class LiveController {
  constructor(
    private readonly live: LiveService,
    private readonly runs: RunsService,
  ) {}

  @Post('live')
  @Scopes('stream')
  async open(@Req() req: Request, @Res() res: Response): Promise<void> {
    // Mirrors IngestController.post's PROJECT_REQUIRED check exactly. In
    // practice this is unreachable today — 'stream' is deliberately never
    // granted to a session (scopes.decorator.ts, auth.middleware.ts), and
    // every bearer token carries a project (ApiToken.projectId is NOT
    // NULL) — but the check stays as the same defensive symmetry
    // IngestController keeps, rather than assuming that invariant silently.
    const tenant = req.tenant!;
    const projectId = tenant.projectId;
    if (!projectId) {
      throw badRequest(
        'PROJECT_REQUIRED',
        'Opening a live run requires a project-scoped credential.',
        'Open a live run with a project API token rather than a browser session.',
      );
    }

    const parsed = OpenLiveRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_LIVE_OPEN',
        `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        'Send {"tool":"gatling"} plus any optional fields. See /v1/openapi.json for the full schema.',
      );
    }

    const result = await this.live.open({ ...tenant, projectId }, parsed.data);
    res.status(201).json(result);
  }

  @Post(':id/stream')
  @Scopes('stream')
  async stream(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const tenant = req.tenant!;
    const offset = parseOffsetHeader(req.headers['x-stream-offset']);
    const bytes = await readRawBody(req);

    const outcome = await this.live.stream(
      { orgId: tenant.orgId, projectId: tenant.projectId },
      id,
      offset,
      bytes,
    );

    if (outcome.kind === 'not_found') {
      throw new NotFoundException(`No run ${id} in this project.`);
    }
    if (outcome.kind === 'rejected') {
      res
        .status(409)
        .type('application/problem+json')
        .json({
          ...problem(
            'STREAM_OFFSET_REJECTED',
            409,
            `This chunk's declared offset does not match run ${id}'s current cursor, or the ` +
              'run is no longer accepting chunks.',
            `Resume streaming from byte offset ${outcome.nextOffset}.`,
          ),
          nextOffset: outcome.nextOffset,
        });
      return;
    }
    res.status(202).json({ nextOffset: outcome.nextOffset });
  }

  @Post(':id/close')
  @Scopes('stream')
  async close(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const tenant = req.tenant!;
    const outcome = await this.live.close(
      { orgId: tenant.orgId, projectId: tenant.projectId },
      id,
    );

    if (outcome.kind === 'not_found') {
      throw new NotFoundException(`No run ${id} in this project.`);
    }
    if (outcome.kind === 'not_running') {
      res
        .status(409)
        .type('application/problem+json')
        .json(
          problem(
            'RUN_NOT_RUNNING',
            409,
            `Run ${id} is not open for streaming (already closed, or never a live run).`,
            'Only a run in the "running" state can be closed.',
          ),
        );
      return;
    }

    await respondWithRun(this.runs, outcome.run, res);
  }
}
