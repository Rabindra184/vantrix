import type { PrismaClient } from '@prisma/client';
import type { ProjectScope } from './tenant.js';

/**
 * A test as a reader's list sees it: the row, plus the two facts a list is
 * useless without and a caller cannot cheaply assemble — how many runs it has
 * and what the newest one did.
 */
export interface TestRow {
  id: string;
  slug: string;
  name: string;
  simulationClass: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  runCount: number;
  latestRun: { id: string; status: string; verdict: string | null } | null;
}

/** What a caller may change. See `UpdateTestRequestSchema` for what may not. */
export interface UpdateTestInput {
  name?: string;
  description?: string | null;
}

/**
 * Tests within one project.
 *
 * ═══ EVERY METHOD TAKES THE TENANT IN ITS `where`, NOT AS A CHECK AFTER ═══
 *
 * The same discipline `RuleRepository` and `TokenRepository` follow: a test
 * belonging to another organisation is not found rather than found-and-refused,
 * so a caller cannot learn it exists. That makes "no such test" and "not yours"
 * indistinguishable here by construction, rather than by every call site
 * remembering to conflate them.
 */
export class TestRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * ═══ WHY THE COUNT AND THE LATEST RUN ARE ONE QUERY EACH, NOT N ═══
   *
   * A project has a handful of tests, and the obvious shape — fetch the tests,
   * then per test fetch a count and a newest run — is 1 + 2N round trips for a
   * page nobody paginates. `groupBy` gives every count in one, and the latest
   * run comes from a single ordered scan the caller reduces.
   *
   * `latestRun` is chosen by `createdAt DESC, id DESC` — the SAME ordering
   * `RunRepository.list` uses, so the run a reader sees at the top of a test's
   * history is the run this reports. Two orderings would disagree exactly when
   * two runs share a timestamp, which is precisely when a reader is looking.
   */
  async listForProject(scope: ProjectScope): Promise<TestRow[]> {
    const tests = await this.prisma.test.findMany({
      where: { orgId: scope.orgId, projectId: scope.projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    if (tests.length === 0) return [];

    const ids = tests.map((t) => t.id);
    const [counts, runs] = await Promise.all([
      this.prisma.run.groupBy({
        by: ['testId'],
        where: { testId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.run.findMany({
        where: { testId: { in: ids } },
        select: { id: true, testId: true, status: true, verdict: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    const countBy = new Map(counts.map((c) => [c.testId, c._count._all]));
    // First wins, and the ordering above is what makes that the newest.
    const latestBy = new Map<string, { id: string; status: string; verdict: string | null }>();
    for (const run of runs) {
      if (run.testId !== null && !latestBy.has(run.testId)) {
        latestBy.set(run.testId, { id: run.id, status: run.status, verdict: run.verdict });
      }
    }

    return tests.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      simulationClass: t.simulationClass,
      description: t.description,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      runCount: countBy.get(t.id) ?? 0,
      latestRun: latestBy.get(t.id) ?? null,
    }));
  }

  /** One test by its slug, or null — including when it belongs elsewhere. */
  async findBySlug(scope: ProjectScope, slug: string): Promise<TestRow | null> {
    const test = await this.prisma.test.findFirst({
      where: { orgId: scope.orgId, projectId: scope.projectId, slug },
    });
    if (test === null) return null;

    const [runCount, latest] = await Promise.all([
      this.prisma.run.count({ where: { testId: test.id } }),
      this.prisma.run.findFirst({
        where: { testId: test.id },
        select: { id: true, status: true, verdict: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    return {
      id: test.id,
      slug: test.slug,
      name: test.name,
      simulationClass: test.simulationClass,
      description: test.description,
      createdAt: test.createdAt,
      updatedAt: test.updatedAt,
      runCount,
      latestRun: latest,
    };
  }

  /**
   * Rename or re-describe. Returns null when the slug names no test in this
   * project, which the caller turns into a 404.
   *
   * `updateMany` rather than `update`, for the reason every write in these
   * repositories uses it: `update` takes a UNIQUE where, so the tenant could
   * not be part of it, and the check would have to be a separate read first —
   * which is a race and an extra round trip to do worse.
   */
  async update(scope: ProjectScope, slug: string, input: UpdateTestInput): Promise<TestRow | null> {
    const result = await this.prisma.test.updateMany({
      where: { orgId: scope.orgId, projectId: scope.projectId, slug },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });
    if (result.count === 0) return null;
    return this.findBySlug(scope, slug);
  }

  /**
   * Delete a test and return what was deleted, or null when this project has
   * no such test.
   *
   * ═══ WHAT GOES WITH IT, AND WHAT DOES NOT ═══
   *
   * Its RUNS SURVIVE, un-grouped: `run.test_id` is `ON DELETE SET NULL`,
   * because a run is a record of something that happened and deleting the
   * label somebody put on it must not delete the measurement. Those runs stay
   * on the project's run list, which is the one view that shows a run
   * belonging to no test.
   *
   * Its RULES DO NOT: `sla_rule.test_id` is `ON DELETE CASCADE`, because a
   * rule is configuration, and one pointing at a test that no longer exists
   * judges nothing forever while still reading as protection in an authoring
   * list. Project-wide rules are untouched — they were never this test's.
   *
   * VERDICTS ALREADY RECORDED ARE UNAFFECTED EITHER WAY. `run_assertion`
   * carries no foreign key to `sla_rule` and keeps its own `ruleSnapshot`,
   * precisely so retiring a rule cannot rewrite the past.
   *
   * The row is read FIRST so the caller can say what it removed — a delete
   * that returns nothing leaves a UI unable to name what it just lost — and
   * `deleteMany` carries the tenant in its `where` for the same
   * no-TOCTOU reason `update` above does.
   */
  async remove(scope: ProjectScope, slug: string): Promise<TestRow | null> {
    const existing = await this.findBySlug(scope, slug);
    if (existing === null) return null;

    const { count } = await this.prisma.test.deleteMany({
      where: { orgId: scope.orgId, projectId: scope.projectId, slug },
    });
    return count === 0 ? null : existing;
  }
}
