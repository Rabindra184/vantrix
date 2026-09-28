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
  latestRun: { id: string; status: string; verdict: string | null; runNumber: number | null } | null;
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
        select: { id: true, testId: true, status: true, verdict: true, runNumber: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    const countBy = new Map(counts.map((c) => [c.testId, c._count._all]));
    // First wins, and the ordering above is what makes that the newest.
    const latestBy = new Map<
      string,
      { id: string; status: string; verdict: string | null; runNumber: number | null }
    >();
    for (const run of runs) {
      if (run.testId !== null && !latestBy.has(run.testId)) {
        latestBy.set(run.testId, {
          id: run.id, status: run.status, verdict: run.verdict, runNumber: run.runNumber,
        });
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
        select: { id: true, status: true, verdict: true, runNumber: true },
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
        name: input.name !== undefined ? input.name : undefined,
        description: input.description !== undefined ? input.description : undefined,
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
   *
   * ═══ AND ITS RUNS LOSE THEIR NUMBERS ═══
   *
   * A run's number counts within its test (spec 2026-09-27-run-number), and
   * `ON DELETE SET NULL` can clear `test_id` but not a second column. So the
   * delete is one transaction of THREE statements: (1) clear `run_number` on
   * the runs committed in this test, (2) delete the test, whose cascade
   * ungroups them, and (3) clear `run_number` on every ungrouped-but-numbered
   * run in the project — which, by the invariant below, is exactly the runs
   * that joined this test after (1) read it, ungrouped by (2)'s cascade still
   * carrying their numbers. Together they keep the invariant the worker's numbering relies
   * on — UNGROUPED ⇒ UNNUMBERED, a run never reports a number with no test to
   * count it in. A test later recreated under the same slug is a new row and
   * starts at 1.
   *
   * ═══ (1) IS THERE FOR LOCK ORDER, NOT ONLY FOR CLEARING ═══
   *
   * `attachLiveRunToTest` and `numberRunForTest` (`apps/worker`) lock a RUN
   * row and then the TEST row; the delete in (2) locks the test first and its
   * cascade then locks runs. (1) takes the runs committed in this test BEFORE
   * the test row, while this transaction holds no lock on it — including a
   * run already in the test with no number, which it rewrites unchanged. So a
   * finalize holding one of those runs FOR UPDATE is waited for here, before
   * (2) asks for the test, and it can get the test and finish; afterwards its
   * statement finds the test gone and fails its foreign key (23503), the
   * outcome a finalize racing its test's deletion has always met. Without (1), a
   * finalize numbering a run already in this test (the self-heal arm) takes
   * that run, queues on the test behind this delete, and the cascade then
   * needs the run it holds: 40P01. The worker's run-number suite pins it —
   * "does not deadlock a delete against a finalize that numbers a run already
   * in the test" fails on every run with (1) removed.
   *
   * Once (2) holds the test, this transaction waits only on runs committed in
   * the test that (1) did not lock — runs that joined it after (1) read, whose
   * joining writer needed a lock on the test row and so has already committed
   * — and on ungrouped-but-numbered runs, which by the invariant are only the
   * ones its own cascade made. TWO RESIDUALS are not covered, and in each
   * Postgres aborts one side with 40P01. FIRST, a live run that joins the
   * test after (1) read and is then taken by its FINALIZE before the cascade
   * reaches it: that finalize waits on the test (in its allocation if an older
   * worker attached the run unnumbered, or in the terminal UPDATE's
   * foreign-key check if it is numbered) while this transaction waits on the
   * run. SECOND, upgrade window only: a run already in the test with NO
   * number whose finalize has inserted its assertion rows, whose foreign-key
   * checks hold the run FOR KEY SHARE. (1) rewrites that number NULL to NULL,
   * changes no key column, takes only FOR NO KEY UPDATE and so does not wait
   * behind the KEY SHARE; (2) then holds the test, the cascade (test_id is a
   * key column) waits on the KEY SHARE, and the finalize waits on (1). A
   * NUMBERED run cannot do this — clearing its number changes a key column,
   * so (1) takes FOR UPDATE and waits before (2).
   * The full argument is in `numberRunForTest`'s module docstring
   * (apps/worker/src/pipeline/run-number.ts). Widening either clearing
   * statement — (1)'s `testId` match or (3)'s ungrouped-but-numbered match —
   * needs that argument re-made.
   */
  async remove(scope: ProjectScope, slug: string): Promise<TestRow | null> {
    const existing = await this.findBySlug(scope, slug);
    if (existing === null) return null;

    const [, { count }] = await this.prisma.$transaction([
      // (1) The runs committed in this test, BEFORE the test row — for LOCK
      // ORDER as much as for clearing. It takes their RUN rows while this
      // transaction holds no lock on the test, so a writer holding one of
      // them FOR UPDATE is waited for here, before (2) asks for the test, and
      // can get the test and finish. Delete it and a finalize that self-heals
      // a run already in this test deadlocks against the delete (see the
      // docstring above; the worker's run-number suite pins it). It does NOT
      // wait behind a finalize's FOR KEY SHARE on an unnumbered run — the
      // docstring's SECOND residual.
      this.prisma.run.updateMany({
        where: { orgId: scope.orgId, projectId: scope.projectId, testId: existing.id },
        data: { runNumber: null },
      }),
      // (2) The test. Its cascade (`run.test_id ON DELETE SET NULL`)
      // ungroups every run committed in it by now.
      this.prisma.test.deleteMany({
        where: { orgId: scope.orgId, projectId: scope.projectId, slug },
      }),
      // (3) Any run that joined the test after (1) read it — a writer that
      // committed in between — has just been ungrouped by (2)'s cascade
      // still carrying its number; this clears it. It matches only
      // ungrouped-but-numbered runs, so a numbered run still in a live test
      // is untouched.
      this.prisma.run.updateMany({
        where: {
          orgId: scope.orgId,
          projectId: scope.projectId,
          testId: null,
          runNumber: { not: null },
        },
        data: { runNumber: null },
      }),
    ]);
    return count === 0 ? null : existing;
  }
}
