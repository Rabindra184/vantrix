import { Controller, Inject, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ingestError } from '@perfportal/core';
import { OpenLiveRunRequestSchema } from '@perfportal/contracts';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
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
 *
 * ═══ AN ALREADY-CONSUMED STREAM IS A 400, NOT A WAIT ═══
 *
 * That "so those parsers skip it" is a property of the CALLER's headers, not
 * something this route can enforce, and getting it wrong used to hang the
 * request forever. Send a chunk as `application/json` or
 * `application/x-www-form-urlencoded` and Express's global parser drains the
 * whole body before this handler is entered; the listeners below then attach
 * to a stream that has already ended, 'end' never fires a second time, and
 * this promise never settles — no response written, and the socket plus the
 * promise leaked, per request, with no timeout anywhere on this path.
 * `readableEnded` is the precise test for that state: it is set only once
 * 'end' has actually been emitted, so a body nobody has read yet (including
 * a legitimate zero-byte chunk, whose 'end' fires as soon as this attaches)
 * still reads `false` here.
 *
 * The sibling `readMultipart` never had this problem, which is why the
 * asymmetry is easy to miss: `req.pipe(bb)` on an ended stream fires 'close'
 * and rejects on its own.
 *
 * `maxBytes` bounds a SINGLE request, independent of `LiveService.stream`'s
 * cumulative per-run check (which needs the run's current cursor and so can
 * only run once this whole body is in hand). Without it, buffering a
 * request has no upper bound at all: `LiveChunkStore.put` passes
 * `bytes.length` as `BlobStore.putStream`'s own `maxBytes`, which makes
 * that guard a no-op (a value can never exceed its own length), and
 * nothing else bounds a single POST.
 *
 * ═══ AND IT IS ITS OWN LIMIT, NOT THE BUNDLE LIMIT ═══
 *
 * This used to pass `config.maxBundleBytes` — "the same number the upload
 * path already enforces, rather than inventing a second limit". That was
 * the wrong call, because the two numbers bound different things.
 * `maxBundleBytes` bounds a WHOLE RUN (512 MB by default); a chunk is by
 * construction a fraction of one, and `LiveService.stream` enforces the
 * cumulative per-run bound separately and correctly. Sharing the number
 * meant one request could pin 512 MB of heap — and, because this buffering
 * completes before `LiveService.stream` ever inspects the offset, it pinned
 * it even for a chunk that was about to be refused as a gap. N in-flight
 * requests held N × that. `readMultipart`'s own docstring already states
 * the rule this violated: the API "must not hold a multi-hundred-megabyte
 * body in memory while the worker is the component sized for that".
 *
 * Once over the limit, this stops RETAINING bytes (bounding memory) but
 * deliberately does not `req.destroy()` the connection: `IncomingMessage
 * .destroy()` tears down the underlying socket, which on a keep-alive
 * connection is the SAME socket the 413 response needs to be written back
 * on — killing it here would mean the caller never sees why it failed,
 * only a broken connection. Draining to a natural 'end' before rejecting
 * costs receiving (and discarding) the oversized tail, the same tradeoff
 * the metering Transform in BlobStore.putStream already makes for the
 * upload path, which errors its pipeline rather than reaching into the
 * request socket either.
 */
function readRawBody(req: Request, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (req.readableEnded) {
      reject(
        badRequest(
          'STREAM_BODY_CONSUMED',
          `This chunk's body was already consumed by a body parser before it reached the ` +
            `stream handler, which happens when Content-Type is one Express parses ` +
            `("${req.headers['content-type'] ?? '(none)'}" here) rather than raw bytes.`,
          'Send the chunk with "Content-Type: application/octet-stream" and the raw bytes as the body.',
        ),
      );
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        overLimit = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overLimit) {
        reject(
          ingestError('BUNDLE_TOO_LARGE', {
            message: `This chunk exceeds the ${maxBytes}-byte per-chunk limit.`,
            remediation:
              'Split the run into smaller chunks, or raise MAX_STREAM_CHUNK_BYTES. This is the ' +
              "per-chunk limit, not the run's cumulative size limit.",
            detail: { maxBytes },
          }),
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
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
    @Inject(CONFIG) private readonly config: AppConfig,
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
    // Body BEFORE header validation, deliberately. Throwing out of
    // parseOffsetHeader with the request stream still unread means Node
    // answers while the client is mid-upload, and a 400 written onto a
    // socket with an undrained body reaches the caller as a connection
    // reset rather than as the problem+json explaining what was wrong with
    // their header. Draining first costs receiving (and discarding) a body
    // this request was never going to use — the same tradeoff readRawBody
    // already makes for its own 413, and for the same reason.
    const bytes = await readRawBody(req, this.config.maxStreamChunkBytes);
    const offset = parseOffsetHeader(req.headers['x-stream-offset']);

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
            `This chunk's declared offset is ahead of run ${id}'s current cursor (a gap), or ` +
              'the run is no longer accepting chunks. A replay (an offset behind the cursor) ' +
              'is not an error and answers 202 instead.',
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
