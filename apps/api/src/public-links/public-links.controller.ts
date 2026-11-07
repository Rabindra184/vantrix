import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  CreatePublicLinkRequestSchema,
  CreatePublicLinkResponseSchema,
  PUBLIC_LINK_MAX_EXPIRY_DAYS,
  PUBLIC_LINK_MIN_LEAD_MS,
  PublicLinkListResponseSchema,
  PublicLinkSchema,
  publicLinkExpiryProblem,
  publicLinkState,
  type CreatePublicLinkResponse,
  type PublicLink,
  type PublicLinkListResponse,
} from '@perfportal/contracts';
import { hashPublicLinkSecret, mintPublicLinkSecret } from '@perfportal/core';
import {
  OrgSettingsRepository,
  PublicLinkRepository,
  RunRepository,
  type PublicLinkRecord,
  type RunRecord,
} from '@perfportal/persistence';
import type { Request } from 'express';
import { Requires } from '../auth/access.decorator.js';
import type { Tenant } from '../auth/auth.guard.js';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { accessDenied, badRequest, conflict, firstIssue, notFound, runNotFound, uuidParam } from '../common/validation.js';

/**
 * The statuses a run may be shared in: a finished run, whether its stream
 * ended on its own or stopped early. An ALLOWLIST, so a run status added later
 * is refused until somebody decides it can be shared — the `statusFor` trap,
 * where a status nobody listed fell into the wrong branch, turned the safe way.
 */
const SHAREABLE: ReadonlySet<string> = new Set(['complete', 'incomplete']);

/** What a reader can do about a run that may not be shared yet, by its status. */
function notShareableRemediation(status: string): string {
  if (status === 'failed') {
    return (
      'A failed run has no Summary to share: GET /v1/runs/{id} answers it with its ingest problem. ' +
      'Fix what that problem names, upload the run again, and share the new run.'
    );
  }
  return 'Wait for the run to finish — GET /v1/runs/{id} reports its status — and share it then.';
}

const EXPIRY_REMEDIATION =
  'Send {"expiresAt": "<ISO 8601 instant, e.g. 2026-12-06T09:00:00.000Z>"} more than ' +
  `${PUBLIC_LINK_MIN_LEAD_MS / 1000} seconds and at most ${PUBLIC_LINK_MAX_EXPIRY_DAYS} days from now. ` +
  'Every link expires, and no other field is accepted.';

/**
 * ═══ A RUN'S PUBLIC LINKS — CREATE, LIST, REVOKE ═══
 * (docs/superpowers/specs/2026-11-06-public-links-and-custom-report-design.md, section 4.1)
 *
 * Under `/v1/runs/:id` like every other run-scoped route, which is what puts
 * the GET in the guards derived from that prefix: session-auth's cross-org
 * list and the OpenAPI route/document join. `run:share` on all three: a
 * Member and up, the role that may write a run's note or ask for its
 * analysis.
 *
 * SESSION-ONLY ON THE CLASS, so a fourth handler added later inherits it. A
 * link shows a run to someone outside the organisation, which is a person's
 * decision: a machine credential names nobody to record as having made it,
 * and a CI token that could mint links would publish every run it can read.
 *
 * ═══ THE RUN IS RESOLVED BEFORE THE REPOSITORY IS TOUCHED ═══
 *
 * `AccessGuard` already answers a non-admin outside the run's project with
 * the missing run's 404 — but an admin passes it without a lookup, so each
 * handler looks the run up through the caller's org itself. That is also what
 * keeps the repository's two sharp edges unreachable: `create` throws on a run
 * outside the scope it is given, and a malformed id would reach a uuid cast
 * (`uuidParam` refuses it first). The repository scope is the RUN's own
 * project, never the tenant's: a session names no project.
 */
@Controller('/v1/runs/:id')
@UseGuards(SessionOnlyGuard)
export class PublicLinksController {
  constructor(
    private readonly runs: RunRepository,
    private readonly links: PublicLinkRepository,
    private readonly orgs: OrgSettingsRepository,
  ) {}

  /**
   * Creates a link and answers its secret — the only copy there will ever be;
   * the row holds its SHA-256.
   *
   * Refused in the order the spec's table lists, each before anything is
   * written: the org's switch off (403 PUBLIC_LINKS_DISABLED — whatever else
   * the request says, there is nothing it could do), a run that is not
   * finished (409 RUN_NOT_SHAREABLE), then the body and its expiry (400
   * INVALID_PUBLIC_LINK). The expiry window is judged against THIS server's
   * clock, once, with the same `now` the answer's `state` is read at.
   *
   * 201: it awaits one insert and answers the row it wrote, so the link is
   * complete and addressable the moment the response is sent — the list
   * carries it, and the DELETE works on its id.
   *
   * `Cache-Control: no-store` on this operation alone: its answer is the only
   * copy of a credential, so no cache — a proxy's or the browser's own — may
   * keep it. Nest sets the header once the guards pass, before the pipes and
   * this handler run, so the handler's own refusals (and a malformed id's 400)
   * carry it too; a guard's refusal does not. Neither matters — a refusal
   * carries no secret. The list and the revoke carry none and are left alone.
   */
  @Post('public-links')
  @Requires('run:share')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async create(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<CreatePublicLinkResponse> {
    const tenant = req.tenant!;
    const userId = sessionUserId(tenant);
    const run = await this.#run(tenant, id);

    if (!(await this.orgs.publicLinksEnabled(tenant.orgId))) {
      throw accessDenied(
        'PUBLIC_LINKS_DISABLED',
        'Public links are turned off for this organisation.',
        'Ask an admin to turn on public links in Administration › Settings.',
      );
    }
    if (!SHAREABLE.has(run.status)) {
      throw conflict(
        'RUN_NOT_SHAREABLE',
        `Run ${id} is ${run.status}: only a finished run can be shared.`,
        notShareableRemediation(run.status),
      );
    }

    const parsed = CreatePublicLinkRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('INVALID_PUBLIC_LINK', `The link request is not valid: ${firstIssue(parsed.error)}`, EXPIRY_REMEDIATION);
    }
    const now = new Date();
    const expiresAt = new Date(parsed.data.expiresAt);
    const problem = publicLinkExpiryProblem(expiresAt, now);
    if (problem !== null) throw badRequest('INVALID_PUBLIC_LINK', problem, EXPIRY_REMEDIATION);

    const secret = mintPublicLinkSecret();
    let record: PublicLinkRecord;
    try {
      record = await this.links.create({
        orgId: run.orgId,
        projectId: run.projectId,
        runId: run.id,
        tokenHash: hashPublicLinkSecret(secret),
        createdBy: userId,
        expiresAt,
      });
    } catch (err) {
      // The insert takes its tenant from the run row and inserts nothing when
      // the run is gone, which the repository throws for. A run deleted
      // between the lookup above and this insert is that run's 404, not a 500.
      if ((await this.runs.findById({ orgId: tenant.orgId }, id)) === null) throw runNotFound(id);
      throw err;
    }
    return CreatePublicLinkResponseSchema.parse({ link: toPublicLink(record, now), secret });
  }

  /**
   * The run's links, newest first, expired and revoked ones included, so a
   * reader can see what was shared and when it stopped. Never a secret, never
   * a hash.
   *
   * `enabled` is the org's switch, so a Member's dialog can say an admin has
   * turned public links off without that Member being able to read
   * Administration's settings. The links are listed whatever it says: a
   * reader deciding what to revoke needs them most when sharing is off.
   */
  @Get('public-links')
  @Requires('run:share')
  async list(@Param('id', uuidParam('id')) id: string, @Req() req: Request): Promise<PublicLinkListResponse> {
    const tenant = req.tenant!;
    const run = await this.#run(tenant, id);
    const [enabled, records] = await Promise.all([
      this.orgs.publicLinksEnabled(tenant.orgId),
      this.links.listForRun({ orgId: run.orgId, projectId: run.projectId }, run.id),
    ]);
    const now = new Date();
    return PublicLinkListResponseSchema.parse({ enabled, items: records.map((r) => toPublicLink(r, now)) });
  }

  /**
   * Revokes one of this run's links. IDEMPOTENT: a link already revoked
   * answers 204 and keeps its first revocation, so a retry after a timeout
   * cannot move when the link actually stopped. Any Member may revoke any of
   * the project's links, with no creator check: stopping a link is the safe
   * direction, and its creator may be away. Allowed whatever the switch and
   * the run's status say, for the same reason.
   *
   * A link that is not one of THIS run's — another run's, another project's,
   * or none at all — answers 404, and nothing changes.
   */
  @Delete('public-links/:linkId')
  @Requires('run:share')
  @HttpCode(204)
  async revoke(
    @Param('id', uuidParam('id')) id: string,
    @Param('linkId', uuidParam('linkId')) linkId: string,
    @Req() req: Request,
  ): Promise<void> {
    const tenant = req.tenant!;
    const userId = sessionUserId(tenant);
    const run = await this.#run(tenant, id);
    const outcome = await this.links.revoke({ orgId: run.orgId, projectId: run.projectId }, run.id, linkId, userId);
    if (outcome === 'not_found') {
      throw notFound(
        `No public link ${linkId} on run ${id}.`,
        'Check the link id. GET /v1/runs/{id}/public-links lists the links of this run.',
      );
    }
  }

  /** The run in the caller's reach, or the missing run's 404. */
  async #run(tenant: Tenant, id: string): Promise<RunRecord> {
    const run = await this.runs.findById({ orgId: tenant.orgId, projectId: tenant.projectId }, id);
    if (run === null) throw runNotFound(id);
    return run;
  }
}

/**
 * SessionOnlyGuard admits sessions alone, and `authenticateSession` sets
 * `userId` on every one. Refusing here rather than writing a link nobody made
 * keeps a future change to either from failing silently — the run note's
 * invariant, for the same reason.
 */
function sessionUserId(tenant: Tenant): string {
  if (tenant.userId === undefined) {
    throw new Error('A signed-in session reached the public-links route without a user id.');
  }
  return tenant.userId;
}

/**
 * A stored link as the contract describes it, its `state` read at `now`: one
 * instant for a whole answer, so two links of one list cannot be judged a
 * moment apart.
 */
function toPublicLink(r: PublicLinkRecord, now: Date): PublicLink {
  const expiresAt = r.expiresAt.toISOString();
  const revokedAt = r.revokedAt === null ? null : r.revokedAt.toISOString();
  return PublicLinkSchema.parse({
    id: r.id,
    state: publicLinkState({ revokedAt, expiresAt }, now),
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdByName === null ? null : { name: r.createdByName },
    expiresAt,
    revokedAt,
    revokedBy: r.revokedByName === null ? null : { name: r.revokedByName },
    lastUsedAt: r.lastUsedAt === null ? null : r.lastUsedAt.toISOString(),
  });
}
