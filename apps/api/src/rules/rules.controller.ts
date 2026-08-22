import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CreateSlaRuleRequestSchema,
  SlaRuleListResponseSchema,
  SlaRuleSchema,
  UpdateSlaRuleRequestSchema,
  type SlaRule,
  type SlaRuleListResponse,
} from '@perfportal/contracts';
import { ProjectRepository, RuleRepository, type SlaRuleRow } from '@perfportal/persistence';
import type { Request } from 'express';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { badRequest, uuidParam } from '../common/validation.js';

/**
 * Authoring the SLA rules a project's runs are judged against.
 *
 * `@UseGuards(SessionOnlyGuard)` on the CLASS, following `TokensController`
 * rather than `ProjectsController`. Every route here writes or reads release
 * gates, and a CI bearer token has no business editing the thing that decides
 * whether CI passes — a credential that could raise its own threshold is a
 * gate that does not gate. `ProjectsController` guards per-handler precisely
 * because its `list` must stay bearer-reachable; nothing here is.
 *
 * THE VALIDATION IS THE FEATURE. `resolveMetric` returns `null` for a metric
 * name it cannot resolve and `evaluateRules` records `not_applicable` rather
 * than failing — correct, because a rule may legitimately name a metric a
 * given run has no data for. The cost is that `p95th` instead of `p95` authors
 * a gate that reads "not checked" on every run forever while looking like
 * protection. The engine is right to degrade; the author is the one who has to
 * be told, and this is the only place that can tell them.
 */
@Controller('/v1/projects/:slug/rules')
@UseGuards(SessionOnlyGuard)
export class RulesController {
  constructor(
    private readonly rules: RuleRepository,
    private readonly projects: ProjectRepository,
  ) {}

  /**
   * 201, and it is earned rather than assumed. `openapi.integration.test.ts`
   * forbids a declared 201 unless the operation is in its allowlist, whose
   * standard is a handler that "awaits a single Prisma insert and returns the
   * row it just wrote… complete and addressable the instant the response is
   * sent". This is that, as opposed to `POST /v1/runs`, whose row is a promise
   * to parse something later.
   */
  @Post()
  @HttpCode(201)
  async create(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<SlaRule> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, slug);

    const parsed = CreateSlaRuleRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(
        'INVALID_SLA_RULE',
        `The rule is not valid: ${issue?.path.join('.') ?? 'request'} ${issue?.message ?? 'is invalid'}`,
        'A rule needs a scope, a family, a comparator, a finite threshold, and a metric the evaluator can resolve — one of count, mean, min, max, stddev, error_rate, throughput_rps, or a percentile like p95. A run-scoped rule takes no target name; any other scope needs one.',
      );
    }

    const row = await this.rules.create(
      { orgId: tenant.orgId, projectId: project.id },
      {
        name: parsed.data.name ?? null,
        scope: parsed.data.scope,
        targetName: parsed.data.targetName,
        family: parsed.data.family,
        metric: parsed.data.metric,
        comparator: parsed.data.comparator,
        threshold: parsed.data.threshold,
      },
    );
    return toRule(row);
  }

  @Get()
  async list(@Param('slug') slug: string, @Req() req: Request): Promise<SlaRuleListResponse> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, slug);
    const rows = await this.rules.listForProject({ orgId: tenant.orgId, projectId: project.id });
    // Parsed on the way out, like every other list here: a response this
    // schema rejects is a bug in the server, not data a client should see.
    return SlaRuleListResponseSchema.parse({ rules: rows.map(toRule) });
  }

  /**
   * Retune or silence a rule. What may change is deliberately narrow — see
   * `UpdateSlaRuleRequestSchema`: a rule's identity is what it MEASURES, and
   * re-aiming one would leave every assertion already recorded against its id
   * describing a measurement it never took.
   */
  @Patch(':ruleId')
  async update(
    @Param('slug') slug: string,
    @Param('ruleId', uuidParam('ruleId')) ruleId: string,
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<SlaRule> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, slug);

    const parsed = UpdateSlaRuleRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(
        'INVALID_SLA_RULE_UPDATE',
        `The update is not valid: ${issue?.message ?? 'unknown'}`,
        'Send at least one of "name", "threshold" or "enabled". A rule\'s scope, family, metric and comparator are fixed — create a new rule to measure something else.',
      );
    }

    const row = await this.rules.update(
      { orgId: tenant.orgId, projectId: project.id },
      ruleId,
      parsed.data,
    );
    if (row === null) throw this.noSuchRule(ruleId);
    return toRule(row);
  }

  /**
   * Returns the rule it deleted, rather than 204. A UI that has just removed a
   * row needs to be able to say WHICH — and the read that makes that possible
   * is the same one that decides whether there was anything to delete.
   */
  @Delete(':ruleId')
  async remove(
    @Param('slug') slug: string,
    @Param('ruleId', uuidParam('ruleId')) ruleId: string,
    @Req() req: Request,
  ): Promise<SlaRule> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, slug);

    const row = await this.rules.remove({ orgId: tenant.orgId, projectId: project.id }, ruleId);
    if (row === null) throw this.noSuchRule(ruleId);
    return toRule(row);
  }

  /**
   * 404, NEVER 403, for a project outside the caller's org — the same rule
   * `TokensController` follows. A tenant learns nothing about what exists
   * elsewhere, including whether it exists.
   */
  private async resolveProject(orgId: string, slug: string): Promise<{ id: string }> {
    const project = await this.projects.findBySlugInOrg(orgId, slug);
    if (project === null) throw new NotFoundException(`No project "${slug}" in this organisation.`);
    return project;
  }

  /**
   * The same 404 for a rule id that does not exist AND for one belonging to
   * another org — the repository puts the tenant in its `where`, so the two
   * are indistinguishable here by construction rather than by remembering to
   * conflate them.
   */
  private noSuchRule(ruleId: string): NotFoundException {
    return new NotFoundException(`No SLA rule "${ruleId}" in this project.`);
  }
}

/** A stored row on the wire: instants as ISO strings, then through the schema. */
function toRule(row: SlaRuleRow): SlaRule {
  return SlaRuleSchema.parse({
    id: row.id,
    name: row.name,
    scope: row.scope,
    targetName: row.targetName,
    family: row.family,
    metric: row.metric,
    comparator: row.comparator,
    threshold: row.threshold,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
