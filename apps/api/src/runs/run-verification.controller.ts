import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { VerificationSchema, type Verification } from '@perfportal/contracts';
import { retainedUntil } from '@perfportal/core';
import { RunRepository, VerificationRepository } from '@perfportal/persistence';
import type { Request } from 'express';
import { Requires } from '../auth/access.decorator.js';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import { Scopes } from '../auth/scopes.decorator.js';
import { runNotFound, uuidParam } from '../common/validation.js';

/**
 * ═══ A RUN'S VERIFICATION — WHAT THE RUN HEADER'S MARK OPENS ═══
 * (docs/superpowers/plans/2026-10-16-exact-statistics-pr3-verifier.md)
 *
 * Whether this run's stored figures were re-derived from its raw log and
 * agreed: the status, why it could not be checked, when and by which version
 * of the verifier, every figure that disagreed with both values, and how long
 * the raw log is kept.
 *
 * Under `/v1/runs/:id` like every other run-scoped read, which is what puts it
 * in the two guards derived from that prefix: session-auth's cross-org list
 * and the OpenAPI route/document join. The run is resolved through the
 * caller's own org and project FIRST, so another org's run — verification row
 * and all — answers the missing run's 404.
 *
 * A run with no row yet answers `pending` with nothing recorded: the run
 * header treats a missing row as pending too, and a panel saying "not
 * checked yet" is the honest answer to a typed URL. `rawLogDeleted` is the
 * RUN's own stamp, not the row's reason: a run verified before retention
 * removed its log stays verified and still says the log is gone.
 *
 * ═══ THE RETENTION DATE IS DERIVED HERE, NOT READ ═══
 *
 * `rawLogRetainedUntil` is the day retention may delete the log under the
 * deployment's CURRENT setting: null once the log is gone or when logs are
 * kept for ever, otherwise the ingest's UTC day plus the days — core's
 * `retainedUntil`, the one rule the worker stores the column by. The stored
 * column was computed once, at verify time, and goes stale the moment the
 * operator changes RAW_LOG_RETENTION_DAYS or retention deletes the log; it is
 * not read.
 *
 * ═══ A STORED ROW THAT DOES NOT PARSE IS A 500, ON PURPOSE ═══
 *
 * The run header's mark drops a bad row and logs it (`verificationSummaryOf`);
 * this read does not, so a mismatch list the contract refuses answers 500.
 * Only the worker writes the column, from typed values, and a NaN figure
 * serialises to null, which the contract allows — so a refusal here means the
 * row was edited by hand, and a panel quietly showing part of it would
 * misstate the very record the reader opened.
 */
@Controller('/v1/runs/:id')
export class RunVerificationController {
  constructor(
    private readonly runs: RunRepository,
    private readonly verifications: VerificationRepository,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('verification')
  @Requires('project:read')
  @Scopes('read')
  async verification(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
  ): Promise<Verification> {
    const tenant = req.tenant!;
    const run = await this.runs.findById({ orgId: tenant.orgId, projectId: tenant.projectId }, id);
    if (!run) throw runNotFound(id);
    const row = await this.verifications.find(run.id);
    return VerificationSchema.parse({
      status: row?.status ?? 'pending',
      reason: row?.unverifiableReason ?? null,
      checkedAt: row?.checkedAt?.toISOString() ?? null,
      verifierVersion: row?.verifierVersion ?? null,
      figuresChecked: row?.figuresChecked ?? 0,
      mismatches: row?.mismatches ?? [],
      rawLogRetainedUntil: retentionDay(run.rawLogDeletedAt, run.ingestedAt, this.config.rawLogRetentionDays),
      rawLogDeleted: run.rawLogDeletedAt !== null,
    });
  }
}

/**
 * The day retention may delete this run's raw log, as the calendar day the
 * contract carries: null once it is deleted, when logs are kept for ever, or
 * for a run with no ingest yet (nothing starts its clock). A UTC day from a
 * UTC midnight — never through a local-zone Date, which would move it.
 */
function retentionDay(deletedAt: Date | null, ingestedAt: Date | null, days: number): string | null {
  if (deletedAt !== null || ingestedAt === null) return null;
  return retainedUntil(ingestedAt, days)?.toISOString().slice(0, 10) ?? null;
}
