import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { TelemetryBatchSchema } from '@perfportal/contracts';
import { TelemetryStore } from '@perfportal/persistence';
import type { Request } from 'express';
import { Scopes } from '../auth/scopes.decorator.js';
import { badRequest } from '../common/validation.js';

/**
 * The agent's one endpoint.
 *
 * NOT under /v1/runs. An agent knows nothing about runs — a run does not exist
 * in PerfPortal until its bundle is POSTed, which happens after the test
 * finishes. A run selects whatever samples overlap its own window; see
 * GET /v1/runs/:id/telemetry.
 */
@Controller('/v1/telemetry')
export class TelemetryController {
  constructor(private readonly store: TelemetryStore) {}

  @Post()
  @Scopes('telemetry')
  @HttpCode(202)
  async post(@Req() req: Request, @Body() body: unknown): Promise<{ accepted: number }> {
    const tenant = req.tenant!;
    const projectId = tenant.projectId;
    if (!projectId) {
      // UNREACHABLE IN PRACTICE, unlike IngestController's identical-looking
      // branch. @Scopes('telemetry') above already refused any caller
      // without the "telemetry" scope before this handler runs, and a
      // session's scopes are always exactly ['read', 'ingest']
      // (auth.middleware.ts) — no session has ever been minted with
      // "telemetry", so one can never reach here. Every credential that DOES
      // reach here is therefore a bearer token, and ApiToken.projectId is
      // non-nullable, so `projectId` is always set too. Kept anyway as
      // defence-in-depth: it costs nothing at runtime, and it stops a future
      // change that widens session scopes to include "telemetry" from
      // silently shipping a payload-adjacent tenant bug instead of this
      // clean 400. See auth.guard.ts (scope check runs before the handler)
      // and auth.middleware.ts (session scopes) for the reachability
      // argument; no test exercises this branch, since there is no
      // credential that can reach it.
      throw badRequest(
        'PROJECT_REQUIRED',
        'Telemetry requires a project-scoped credential.',
        'Run the agent with a project API token carrying the "telemetry" scope.',
      );
    }

    const parsed = TelemetryBatchSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_TELEMETRY',
        `The telemetry batch is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        'Send raw cumulative counters and no tenant fields; org and project come from the token.',
      );
    }

    // ═══ THE TENANT COMES FROM THE TOKEN ═══
    // Never from `parsed.data`, which has no such fields and rejects them.
    const accepted = await this.store.insert(
      { orgId: tenant.orgId, projectId },
      parsed.data.host,
      parsed.data.samples.map((s) => ({ ...s, sampledAtMs: Date.parse(s.sampledAt) })),
    );
    return { accepted };
  }
}
