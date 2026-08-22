import type { PrismaClient } from '@prisma/client';
import type { ProjectScope } from './tenant.js';

export interface SlaRuleRecord {
  id: string;
  scope: 'run' | 'scenario' | 'group' | 'request';
  targetName: string | null;
  family: 'response_time' | 'latency' | 'group_cumulated' | 'group_duration';
  metric: string;
  comparator: 'lte' | 'gte';
  threshold: number;
}

/**
 * A rule as the AUTHORING surface sees it: everything `SlaRuleRecord` carries,
 * plus the three columns a managed list needs and evaluation has no use for.
 *
 * A SEPARATE TYPE, deliberately. `SlaRuleRecord` is what the evaluator reads —
 * six fields and an id — and widening it would put a name and two timestamps
 * into the object the pipeline and the fold owner map over on every run, for
 * no reason other than that a different caller wanted them.
 */
export interface SlaRuleRow extends SlaRuleRecord {
  name: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The fields a caller may set when creating a rule. */
export interface CreateSlaRuleInput {
  name?: string | null;
  scope: SlaRuleRecord['scope'];
  targetName: string | null;
  family: SlaRuleRecord['family'];
  metric: string;
  comparator: SlaRuleRecord['comparator'];
  threshold: number;
}

/**
 * What may change about a rule that already exists — and the absences are the
 * design. `scope`, `family`, `metric` and `comparator` are what the rule
 * MEASURES; re-aiming one keeps its id while every assertion recorded against
 * that id refers to a measurement it never took. `run_assertion.ruleSnapshot`
 * survives a threshold change and cannot help with that.
 */
export interface UpdateSlaRuleInput {
  name?: string | null;
  threshold?: number;
  enabled?: boolean;
}

interface RuleRow {
  id: string;
  scope: string;
  targetName: string | null;
  family: string;
  metric: string;
  comparator: string;
  threshold: number;
  name: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toRow(r: RuleRow): SlaRuleRow {
  return {
    id: r.id,
    scope: r.scope as SlaRuleRecord['scope'],
    targetName: r.targetName,
    family: r.family as SlaRuleRecord['family'],
    metric: r.metric,
    comparator: r.comparator as SlaRuleRecord['comparator'],
    threshold: r.threshold,
    name: r.name,
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class RuleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listEnabled(scope: ProjectScope): Promise<SlaRuleRecord[]> {
    const rows = await this.prisma.slaRule.findMany({
      where: { orgId: scope.orgId, projectId: scope.projectId, enabled: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r: {
      id: string;
      scope: string;
      targetName: string | null;
      family: string;
      metric: string;
      comparator: string;
      threshold: number;
    }) => ({
      id: r.id,
      scope: r.scope as SlaRuleRecord['scope'],
      targetName: r.targetName,
      family: r.family as SlaRuleRecord['family'],
      metric: r.metric,
      comparator: r.comparator as SlaRuleRecord['comparator'],
      threshold: r.threshold,
    }));
  }

  /**
   * Every rule in a project, enabled or not, newest first.
   *
   * NOT `listEnabled` with the filter dropped: an authoring list must show a
   * disabled rule, because "disabled" is a state a reader put it in and needs
   * to be able to undo. `listEnabled` stays exactly as narrow as evaluation
   * needs, and keeps riding the `[projectId, enabled]` index.
   *
   * Ordered by `createdAt desc` — which is why the column exists. Before it,
   * the only stable order available was `id asc`, i.e. UUID order, i.e.
   * arbitrary.
   */
  async listForProject(scope: ProjectScope): Promise<SlaRuleRow[]> {
    const rows = await this.prisma.slaRule.findMany({
      where: { orgId: scope.orgId, projectId: scope.projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(toRow);
  }

  async create(scope: ProjectScope, input: CreateSlaRuleInput): Promise<SlaRuleRow> {
    const row = await this.prisma.slaRule.create({
      data: {
        orgId: scope.orgId,
        projectId: scope.projectId,
        name: input.name ?? null,
        scope: input.scope,
        targetName: input.targetName,
        family: input.family,
        metric: input.metric,
        comparator: input.comparator,
        threshold: input.threshold,
      },
    });
    return toRow(row);
  }

  /**
   * Retune a rule, or `null` when this project has no such rule.
   *
   * TENANT IN THE `where`, NOT CHECKED AFTER THE READ, and that is the whole
   * safety property: `updateMany` scoped by `orgId` + `projectId` cannot touch
   * a row belonging to another org even if the caller guessed a real id. A
   * `findUnique` followed by an ownership check would work too, and would be
   * one refactor away from a TOCTOU gap.
   *
   * The `null` becomes a 404 in the controller rather than a 403 — the same
   * rule `resolveProject` follows for a slug outside the caller's org: a
   * tenant learns nothing about what exists elsewhere.
   */
  async update(
    scope: ProjectScope,
    id: string,
    patch: UpdateSlaRuleInput,
  ): Promise<SlaRuleRow | null> {
    const data: UpdateSlaRuleInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.threshold !== undefined) data.threshold = patch.threshold;
    if (patch.enabled !== undefined) data.enabled = patch.enabled;

    const { count } = await this.prisma.slaRule.updateMany({
      where: { id, orgId: scope.orgId, projectId: scope.projectId },
      data,
    });
    if (count === 0) return null;

    const row = await this.prisma.slaRule.findUnique({ where: { id } });
    return row === null ? null : toRow(row);
  }

  /**
   * Delete a rule and return what was deleted, or `null` when this project has
   * no such rule.
   *
   * `deleteMany` for the same tenant-in-the-`where` reason as `update`. The row
   * is read FIRST so the caller can be told what it removed — a delete that
   * returns nothing leaves a UI unable to say which rule it just lost.
   *
   * NOTHING CASCADES. `run_assertion.rule_id` carries no foreign key to this
   * table by design (see the `ruleSnapshot` docstring in schema.prisma): a
   * verdict already recorded is history, and history must survive the rule
   * that produced it being retired. The id in those rows simply stops
   * resolving, which nothing joins on.
   */
  async remove(scope: ProjectScope, id: string): Promise<SlaRuleRow | null> {
    const existing = await this.prisma.slaRule.findFirst({
      where: { id, orgId: scope.orgId, projectId: scope.projectId },
    });
    if (existing === null) return null;

    const { count } = await this.prisma.slaRule.deleteMany({
      where: { id, orgId: scope.orgId, projectId: scope.projectId },
    });
    return count === 0 ? null : toRow(existing);
  }
}
