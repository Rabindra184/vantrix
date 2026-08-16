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
      // A session is org-scoped and names no project, but a sample must belong
      // to one. Rather than guess, refuse and say what to use instead — the
      // same shape IngestController uses for the same reason. Extracting
      // projectId into its own const is also what narrows the tenant object
      // below; a property check alone does not narrow the object it came from.
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
