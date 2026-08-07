import { Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Scopes } from '../auth/scopes.decorator.js';
import { IngestService } from './ingest.service.js';
import { readMultipart } from './multipart.js';

// AuthGuard is registered globally via APP_GUARD (see auth.module.ts), so
// every route authenticates by default — @UseGuards(AuthGuard) here would be
// redundant. @Scopes('ingest') is still required per-route: the global guard
// enforces whatever scopes it finds, and the default (none) is "any token".
@Controller('/v1/runs')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Post()
  @Scopes('ingest')
  async post(@Req() req: Request, @Res() res: Response): Promise<void> {
    const upload = await readMultipart(req);
    const metadata = this.ingest.parseMetadata(upload.metadataRaw);
    const run = await this.ingest.accept(req.tenant!, metadata, upload.bundle);

    res.status(202).json({
      id: run.id,
      status: run.status,
      statusUrl: `/v1/runs/${run.id}`,
    });
  }
}
