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
  /**
   * The test this rule applies to, or null for a project-wide rule.
   *
   * The whole ref rather than an id, for the same reason `RunRecord.test`
   * carries one: an authoring list has to NAME what each rule judges, and an
   * id names nothing. It is on `SlaRuleRow` and NOT on `SlaRuleRecord` for the
   * reason that split exists at all — the evaluator has already had the
   * applicability question answered for it by `listEnabled`'s filter, and does
   * not need the answer restated on every rule it maps over.
   */
  test: { id: string; slug: string; name: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The fields a caller may set when creating a rule. */
export interface CreateSlaRuleInput {
  name?: string | null;
  /**
   * Null (or absent) creates a PROJECT-WIDE rule, which is what every rule
   * was before this existed. A test id narrows it to that test's runs.
   *
   * The caller resolves a slug to this id, because a test slug is unique per
   * project rather than per org — the same resolution `RunsController` does
   * for `?test=`, and for the same reason.
   */
  testId?: string | null;
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
  /**
   * The joined test, or null. `undefined` is what a query that did NOT ask for
   * the join produces, and it has to read as project-wide rather than throwing
   * — `update` re-reads with `findUnique`, and forgetting the include there
   * would otherwise turn every retune into a crash rather than into a rule
   * that merely forgot its test.
   */
  test?: { id: string; slug: string; name: string } | null;
}

/** Every read below asks for exactly this, so no two of them can disagree
 *  about which test columns a rule row carries. */
const WITH_TEST = { test: { select: { id: true, slug: true, name: true } } } as const;

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
    test: r.test ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class RuleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The rules that judge ONE RUN: this project's enabled project-wide rules,
   * plus the enabled rules of the test that run belongs to.
   *
   * ═══ `testId` IS REQUIRED, AND THAT IS ON PURPOSE ═══
   *
   * It could have defaulted to `null`, and every existing call site would have
   * kept compiling. That is precisely why it does not: the two callers
   * (`PipelineService` and `LiveFoldOwner`) pass different values for
   * different reasons, and a silent default would have let the pipeline —
   * which DOES know the run's test — carry on evaluating project-wide rules
   * only, with nothing failing and no test-scoped gate ever firing.
   *
   * `null` means the run belongs to no test, and gets project-wide rules
   * alone. That is the honest answer rather than a degraded one: a run with no
   * test is not a run of anything a test-scoped rule could be about.
   */
  async listEnabled(scope: ProjectScope, testId: string | null): Promise<SlaRuleRecord[]> {
    const rows = await this.prisma.slaRule.findMany({
      where: {
        orgId: scope.orgId,
        projectId: scope.projectId,
        enabled: true,
        // A plain `{ testId: null }` when the run has no test, NOT an `OR`
        // whose two branches are the same predicate. `{ OR: [{ testId: null },
        // { testId: null }] }` would be correct and would read as though the
        // second branch meant something.
        ...(testId === null ? { testId: null } : { OR: [{ testId: null }, { testId }] }),
      },
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
  async listForProject(
    scope: ProjectScope,
    /**
     * When given, narrows the list to the rules that JUDGE that test — its own
     * plus the project-wide ones. That union is the question a reader on a
     * test's page is actually asking ("what gates this?"), and it is not the
     * same as "rules whose test_id is this one", which would hide every gate
     * the project applies to everything.
     */
    appliesToTestId?: string,
  ): Promise<SlaRuleRow[]> {
    const rows = await this.prisma.slaRule.findMany({
      where: {
        orgId: scope.orgId,
        projectId: scope.projectId,
        ...(appliesToTestId === undefined
          ? {}
          : { OR: [{ testId: null }, { testId: appliesToTestId }] }),
      },
      include: WITH_TEST,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(toRow);
  }

  async create(scope: ProjectScope, input: CreateSlaRuleInput): Promise<SlaRuleRow> {
    const row = await this.prisma.slaRule.create({
      include: WITH_TEST,
      data: {
        orgId: scope.orgId,
        projectId: scope.projectId,
        // `?? null` rather than a spread: absent and explicitly-null both mean
        // project-wide, and there is no third meaning for this field to carry.
        testId: input.testId ?? null,
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

    const row = await this.prisma.slaRule.findUnique({ where: { id }, include: WITH_TEST });
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
      include: WITH_TEST,
    });
    if (existing === null) return null;

    const { count } = await this.prisma.slaRule.deleteMany({
      where: { id, orgId: scope.orgId, projectId: scope.projectId },
    });
    return count === 0 ? null : toRow(existing);
  }
}
