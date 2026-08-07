import { Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Scopes } from '../auth/scopes.decorator.js';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import { respondWithRun } from '../runs/runs.controller.js';
import { RunsService } from '../runs/runs.service.js';
import { TerminalWaiter } from '../runs/terminal-waiter.js';
import { IngestService } from './ingest.service.js';
import { readMultipart } from './multipart.js';

// AuthGuard is registered globally via APP_GUARD (see auth.module.ts), so
// every route authenticates by default — @UseGuards(AuthGuard) here would be
// redundant. @Scopes('ingest') is still required per-route: the global guard
// enforces whatever scopes it finds, and the default (none) is "any token".
@Controller('/v1/runs')
export class IngestController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly ingest: IngestService,
    private readonly runs: RunsService,
    private readonly waiter: TerminalWaiter,
  ) {}

  @Post()
  @Scopes('ingest')
  async post(@Req() req: Request, @Res() res: Response): Promise<void> {
    const upload = await readMultipart(req);
    const metadata = this.ingest.parseMetadata(upload.metadataRaw);
    const accepted = await this.ingest.accept(req.tenant!, metadata, upload.bundle);

    const waitMs = metadata.waitMs ?? this.config.defaultWaitMs;
    await this.waiter.waitFor(accepted.id, waitMs);

    // Re-read: the wait may have timed out, or the worker may have finished
    // before the subscription was registered. The row is the source of truth,
    // never the notification.
    const tenant = req.tenant!;
    const current =
      (await this.runs
        .runs()
        .findById({ orgId: tenant.orgId, projectId: tenant.projectId }, accepted.id)) ?? accepted;

    await respondWithRun(this.runs, current, res);
  }
}
