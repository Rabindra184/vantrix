import { Controller, Get, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  AI_PENDING_REQUEUE_AFTER_MS,
  AiAnalysisResponseSchema,
  type AiAnalysisResponse,
  type AiUnavailableReason,
} from '@perfportal/contracts';
import {
  AiAnalysisRepository,
  aiUnavailableReason,
  OrgSettingsRepository,
  RunRepository,
  type AiAnalysisRecord,
  type AiEligibility,
} from '@perfportal/persistence';
import type { Request, Response } from 'express';
import { Requires } from '../auth/access.decorator.js';
import { CONFIG } from '../auth/auth.module.js';
import { Scopes } from '../auth/scopes.decorator.js';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { conflict, runNotFound, uuidParam } from '../common/validation.js';
import type { AppConfig } from '../config.js';
import { AiAnalysisQueue } from './ai-analysis-queue.js';

/*
 * `AI_PENDING_REQUEUE_AFTER_MS`: how long a pending row is trusted to have a
 * job behind it. Its arithmetic is in `@perfportal/contracts`, beside the
 * `requestedAt` field the card reads it against.
 * Past this a POST queues it again: a job BullMQ failed for stalling never
 * reaches the worker's service, so nothing else would ever settle its row, and
 * the queue keeps no failed job, so the re-queue is not ignored.
 *
 * Not counted: time the job spends WAITING behind other runs' analyses (the
 * consumer takes one at a time). That costs nothing: a POST past the window
 * while the job still waits re-marks the row pending and adds a job under the
 * same id, which BullMQ ignores while that job exists.
 */

/** What a reader can do about each reason, for the POST's 409. */
const UNAVAILABLE_REMEDIATION: Readonly<Record<AiUnavailableReason, string>> = {
  not_configured:
    'This deployment configures no AI provider. An operator sets AI_PROVIDER and its companion variables ' +
    '(DEPLOYMENT.md, "AI run analysis") and restarts the API and the worker.',
  org_disabled:
    'An admin turns AI run analysis on for this organisation under Administration, or with ' +
    'PUT /v1/admin/settings {"aiEnabled": true}.',
  not_terminal: 'Wait for the run to finish — GET /v1/runs/{id} reports its status — and ask again.',
  no_statistics: 'The run recorded no statistics, so there is nothing to analyse. Analyse a run that measured requests.',
  estimated:
    'Its statistics predate exact statistics. Recompute it from its raw log (pnpm recompute --run <id>) and ask again.',
  verification_mismatch:
    'Its stored figures disagree with its raw log (GET /v1/runs/{id}/verification). Recompute the run so the ' +
    'verification passes, and ask again.',
};

/**
 * ═══ A RUN'S AI ANALYSIS — READ IT, OR ASK FOR ONE ═══
 * (docs/superpowers/specs/2026-11-02-ai-run-analysis-design.md, section 5)
 *
 * Under `/v1/runs/:id` like every other run-scoped read, which is what puts
 * the GET in the guards derived from that prefix: session-auth's cross-org
 * list and the OpenAPI route/document join. The run is resolved through the
 * caller's own org and project FIRST, so another org's run answers the
 * missing run's 404.
 *
 * ═══ ONE RULE FOR WHETHER A RUN MAY BE ANALYSED ═══
 *
 * Both handlers ask `aiUnavailableReason`, the persistence rule the worker
 * re-checks before calling the provider, so the page is never offered a card
 * the worker then skips. It needs the deployment's provider (`config.ai`) and
 * the org's switch; nothing is ever sent unless BOTH are on. The reason wins
 * over a stored row: an org that switched AI off sees no analysis at all,
 * even one written while it was on.
 *
 * ═══ THE API NEVER CALLS A MODEL ═══
 *
 * The POST marks the row pending and queues a job; the worker builds the
 * facts, calls the provider, checks the answer and stores it. An analysis
 * never changes a verdict, an assertion, a run's status or an alert — there
 * is nothing here that could.
 *
 * ═══ A STORED ROW THAT DOES NOT PARSE IS A 500, ON PURPOSE ═══
 *
 * Only the worker writes the content, and only after
 * `AiAnalysisContentSchema` accepted it; a refusal here means the row was
 * edited by hand, and a card quietly showing part of it would misstate it —
 * the verification read's rule.
 */
@Controller('/v1/runs/:id')
export class RunAiAnalysisController {
  constructor(
    private readonly runs: RunRepository,
    private readonly analyses: AiAnalysisRepository,
    private readonly orgs: OrgSettingsRepository,
    private readonly queue: AiAnalysisQueue,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The analysis, or why there is none. Any role may read it, with a session
   * or a bearer token; `state: 'none'` is a run nobody has asked about yet.
   */
  @Get('ai-analysis')
  @Requires('project:read')
  @Scopes('read')
  async read(@Param('id', uuidParam('id')) id: string, @Req() req: Request): Promise<AiAnalysisResponse> {
    const { run, reason } = await this.#resolve(req, id);
    if (reason !== null) return { available: false, reason };
    return toResponse(await this.analyses.find(id), run);
  }

  /**
   * Ask for an analysis. Session-only and `run:analyze` (a member and up): it
   * spends the operator's money, and a machine credential names nobody to
   * record as having asked.
   *
   * 409 `AI_ANALYSIS_UNAVAILABLE` naming the reason when the run may not be
   * analysed. A pending row younger than `AI_PENDING_REQUEUE_AFTER_MS` answers
   * 202 as it stands, and a ready one that is not stale 200: neither queues
   * again, so a double click costs nothing. Anything else — no row, a failed
   * attempt, a stale analysis, a pending row nothing is working on — is marked
   * pending and queued, 202.
   *
   * MARKED BEFORE IT IS QUEUED, for the verify queue's reason: queued first,
   * a fast worker could store its answer and the mark land on top of it,
   * leaving the card reading "Analysing…" over a finished analysis. A queue
   * that refuses the add leaves the row pending and answers 500; the next
   * POST after `AI_PENDING_REQUEUE_AFTER_MS` re-queues it.
   *
   * `@Res()` because the status depends on the row, 200 or 202.
   */
  @Post('ai-analysis')
  @Requires('run:analyze')
  @UseGuards(SessionOnlyGuard)
  async generate(@Param('id', uuidParam('id')) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const tenant = req.tenant!;
    // SessionOnlyGuard admits sessions alone, and authenticateSession sets
    // userId on every one; the run note's invariant, for the same reason.
    if (tenant.userId === undefined) {
      throw new Error('A signed-in session reached the AI analysis route without a user id.');
    }
    const { run, reason } = await this.#resolve(req, id);
    if (reason !== null) {
      throw conflict(
        'AI_ANALYSIS_UNAVAILABLE',
        `Run ${id} cannot be analysed: ${reason}.`,
        UNAVAILABLE_REMEDIATION[reason],
      );
    }

    const row = await this.analyses.find(id);
    if (row?.status === 'pending' && Date.now() - row.requestedAt.getTime() < AI_PENDING_REQUEUE_AFTER_MS) {
      res.status(202).json(toResponse(row, run));
      return;
    }
    if (row?.status === 'ready' && !isStale(row, run)) {
      res.status(200).json(toResponse(row, run));
      return;
    }

    await this.analyses.markPending(id, tenant.userId);
    await this.queue.add(id);
    const pending = await this.analyses.find(id);
    // The run was deleted between the lookup and the mark: no row was written.
    if (pending === null) throw runNotFound(id);
    res.status(202).json(toResponse(pending, run));
  }

  /** The run in the caller's reach (404 otherwise), and why it may not be analysed. */
  async #resolve(req: Request, id: string): Promise<{ run: AiEligibility; reason: AiUnavailableReason | null }> {
    const tenant = req.tenant!;
    const found = await this.runs.findById({ orgId: tenant.orgId, projectId: tenant.projectId }, id);
    if (!found) throw runNotFound(id);
    const run = await this.analyses.eligibility(id);
    if (run === null) throw runNotFound(id);
    const reason = aiUnavailableReason(run, {
      configured: this.config.ai !== null,
      orgEnabled: await this.orgs.aiEnabled(tenant.orgId),
    });
    return { run, reason };
  }
}

/**
 * Whether the run's statistics were rewritten after the analysis was:
 * `recomputed_at` or `ingested_at` later than `generated_at`. Only a written
 * analysis can be stale. A facts-version bump in a release is deliberately
 * NOT staleness — an upgrade must not invite paid regeneration across an
 * install.
 */
function isStale(row: AiAnalysisRecord, run: AiEligibility): boolean {
  const generated = row.generatedAt;
  if (generated === null) return false;
  return [run.recomputedAt, run.ingestedAt].some((at) => at !== null && at.getTime() > generated.getTime());
}

/** A row (or none) in the contract's one available shape: every field, null where the state has none. */
function toResponse(row: AiAnalysisRecord | null, run: AiEligibility): AiAnalysisResponse {
  if (row === null) {
    return AiAnalysisResponseSchema.parse({
      available: true,
      state: 'none',
      content: null,
      failureReason: null,
      generatedAt: null,
      model: null,
      stale: false,
      requestedAt: null,
    });
  }
  return AiAnalysisResponseSchema.parse({
    available: true,
    state: row.status,
    content: row.status === 'ready' ? row.content : null,
    // Free-form, as the worker recorded it: `provider_error`, `refused`, `numbers_not_in_facts: …`.
    failureReason: row.failureReason,
    generatedAt: row.generatedAt?.toISOString() ?? null,
    model: row.model,
    stale: isStale(row, run),
    requestedAt: row.requestedAt.toISOString(),
  });
}
