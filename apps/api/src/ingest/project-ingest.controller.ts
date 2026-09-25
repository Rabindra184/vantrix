import { Controller, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProjectRepository } from '@perfportal/persistence';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import { respondWithRun } from '../runs/runs.controller.js';
import { RunsService } from '../runs/runs.service.js';
import { TerminalWaiter } from '../runs/terminal-waiter.js';
import { IngestService } from './ingest.service.js';
import { readMultipart } from './multipart.js';
import { notFound } from '../common/validation.js';

/**
 * Uploading a bundle from a BROWSER (review 09-13 M05).
 *
 * ═══ WHY THIS ROUTE HAD TO EXIST BEFORE THE FILE PICKER COULD ═══
 *
 * M05 asks Add results for "a real file picker with accepted formats,
 * validation, progress, and processing state". That reads like pure frontend
 * work and is not: `POST /v1/runs` is the only route that accepted a bundle,
 * and it refuses a session by design — its handler reads `tenant.projectId`
 * and answers PROJECT_REQUIRED, because a session is ORG-scoped and names no
 * project while a token is minted against exactly one.
 *
 * So the picker was blocked on a route that did not exist, which is why the
 * card has been labelled "Import via API" in the meantime — the interim the
 * finding itself specifies. This is that route.
 *
 * ═══ THE PROJECT COMES FROM THE URL, WHICH IS THE ESTABLISHED PATTERN HERE ═══
 *
 * `findBySlugInOrg(tenant.orgId, slug)` — the same resolution
 * `TokensController` has always used for a session-only project route, and
 * for the same reason: the session proves the ORG, and the slug names which of
 * that org's projects. A slug outside the caller's org is a 404 and never a
 * 403, so the response cannot confirm that another organisation has it.
 *
 * NOT TO BE CONFUSED WITH THE RULING ON `ProjectRunsController.list`. That
 * route considered slug resolution for a session and rejected it, because a
 * session-holder already has `GET /v1/runs` across the whole org — resolution
 * there would have been new surface for no new capability. Here there is no
 * alternative at all: without this, a browser cannot deliver a bundle by any
 * means, which is the entire finding.
 *
 * ═══ SESSION ONLY, AND DELIBERATELY NOT A SECOND WAY IN FOR TOKENS ═══
 *
 * `@UseGuards(SessionOnlyGuard)` on the class and no `@Scopes()` anywhere, the
 * shape `TokensController` already uses. A project token has `POST /v1/runs`
 * and needs nothing here; accepting one would add a second authenticated path
 * to the same capability, which is surface bought for no reader.
 *
 * It shares a path prefix with `ProjectRunsController` (which owns the GET)
 * rather than joining it, because the two have different guard models: a
 * class-level `SessionOnlyGuard` there would refuse the token-based list that
 * route exists for.
 */
@Controller('/v1/projects/:slug/runs')
@UseGuards(SessionOnlyGuard)
export class ProjectIngestController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly ingest: IngestService,
    private readonly runs: RunsService,
    private readonly waiter: TerminalWaiter,
    private readonly projects: ProjectRepository,
  ) {}

  @Post()
  async post(@Param('slug') slug: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const tenant = req.tenant!;
    const project = await this.projects.findBySlugInOrg(tenant.orgId, slug);
    // 404, never 403 — see the class docstring.
    if (!project) throw notFound(`No project "${slug}" in this organisation.`, 'Check the slug, or list the projects this credential can reach with GET /v1/projects.');

    /* Everything below is `IngestController.post` verbatim, with the project
       resolved from the URL instead of read off the credential. Shared through
       `IngestService.accept` rather than copied logic: a second ingest path
       that parsed metadata or accepted bundles differently would be the
       two-decoders failure this repo already refuses one layer down. */
    const upload = await readMultipart(req);
    const metadata = this.ingest.parseMetadata(upload.metadataRaw);
    const accepted = await this.ingest.accept(
      { ...tenant, projectId: project.id },
      metadata,
      upload.bundle,
    );

    const waitMs = metadata.waitMs ?? this.config.defaultWaitMs;
    await this.waiter.waitFor(accepted.id, waitMs);

    // Re-read: the wait may have timed out, or the worker may have finished
    // before the subscription was registered. The row is the source of truth,
    // never the notification.
    const current =
      (await this.runs
        .runs()
        .findById({ orgId: tenant.orgId, projectId: project.id }, accepted.id)) ?? accepted;

    await respondWithRun(this.runs, current, res);
  }
}
