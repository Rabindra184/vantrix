import { Controller, Get, Param, Req } from '@nestjs/common';
import { VerificationSchema, type Verification } from '@perfportal/contracts';
import { RunRepository, VerificationRepository } from '@perfportal/persistence';
import type { Request } from 'express';
import { Requires } from '../auth/access.decorator.js';
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
 */
@Controller('/v1/runs/:id')
export class RunVerificationController {
  constructor(
    private readonly runs: RunRepository,
    private readonly verifications: VerificationRepository,
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
      // The UTC calendar day `VerificationRepository.find` read the date
      // column as — never through a local-zone Date, which would move it.
      rawLogRetainedUntil: row?.rawLogRetainedUntil?.toISOString().slice(0, 10) ?? null,
      rawLogDeleted: run.rawLogDeletedAt !== null,
    });
  }
}
