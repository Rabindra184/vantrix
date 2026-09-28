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
   * delete is one transaction of THREE statements: (1) UNGROUP the runs
   * committed in this test, test_id and run_number both to NULL, (2) delete
   * the test, and (3) clear `run_number` on every ungrouped-but-numbered run
   * in the project — which, by the invariant below, is exactly the runs that
   * joined this test after (1) read it, ungrouped by (2)'s cascade still
   * carrying their numbers. Together they keep the invariant the worker's
   * numbering relies on — UNGROUPED ⇒ UNNUMBERED, a run never reports a
   * number with no test to count it in. A test later recreated under the same
   * slug is a new row and starts at 1.
   *
   * ═══ (1) IS THERE FOR LOCK ORDER, AND ITS LOCK MODE IS THE POINT ═══
   *
   * `attachLiveRunToTest` and `numberRunForTest` (`apps/worker`) lock a RUN
   * row and then, sometimes, the TEST row; the delete in (2) locks the test
   * first and its cascade then locks runs. (1) takes the runs committed in
   * this test BEFORE the test row, while this transaction holds no lock on
   * it. A finalize already holding one of them is waited for here — before
   * (2) asks for the test — so it can get the test and commit, and (1) then
   * ungroups the run it numbered. A finalize arriving after (1) waits on (1)
   * instead, and once the delete commits its statement finds the test gone
   * and fails its foreign key (23503): the outcome a finalize losing the
   * race to its test's deletion has always met.
   *
   * It UNGROUPS rather than only clearing the number, and that is what makes
   * the wait happen every time. Changing test_id, a key column (half of the
   * unique index on test_id and run_number), takes the run FOR UPDATE, which
   * waits behind every lock a writer can hold — including the FOR KEY SHARE a
   * finalize's run_assertion inserts take through their foreign key. The
   * earlier form only rewrote the number; on a run with none that is NULL to
   * NULL, changes no key column, takes FOR NO KEY UPDATE and passes a KEY
   * SHARE, so the delete then held the test while its cascade waited on the
   * KEY SHARE and the finalize waited on (1): 40P01. Now the finalize, the
   * run's sole locker, upgrades its own lock without queueing behind (1),
   * numbers the run from a test nobody holds, and commits first.
   *
   * (1) names the test by its SLUG, inside the transaction, as (2) does — not
   * by the id `findBySlug` read before it — so both statements address the
   * same row even if the test was deleted and re-created in between.
   *
   * The worker's run-number suite pins both halves. "does not deadlock a
   * delete against a self-healing finalize that already wrote its
   * assertions" deadlocks with (1) removed OR back to rewriting the number
   * alone, every time — a pure cycle, nothing racing. With (1) removed, "...
   * keeping the number of a run that joined mid-delete" also fails, its
   * attach refused by a lock_timeout rather than let wait. The older "...
   * numbers a run already in the test" deadlocks with (1) removed only when
   * the delete wins a race for the test row's new version once the third
   * transaction commits: measured 5 of 6, so it is not the guard.
   *
   * Once (2) holds the test, this transaction waits only on runs committed in
   * the test that (1) did not see — runs that joined after (1) read, whose
   * joining writer needed the test row to join and so has already committed
   * — and on ungrouped-but-numbered runs, which by the invariant are only the
   * ones its own cascade made. A joiner that arrived numbered is finalized by
   * `numberRunForTest`'s keep arm, which writes nothing and never asks for
   * the test. ONE WINDOW is left, while a deployment of this version rolls
   * out: a joiner an OLDER worker attached with no number, whose finalize
   * must take the test to number it; with a third transaction numbering into
   * the same test it deadlocks, Postgres aborting one side (40P01, never a
   * hang). The full argument is in `numberRunForTest`'s module docstring
   * (apps/worker/src/pipeline/run-number.ts). Widening either clearing
   * statement — (1)'s test match or (3)'s ungrouped-but-numbered match —
   * needs that argument re-made.
   */
  async remove(scope: ProjectScope, slug: string): Promise<TestRow | null> {
    const existing = await this.findBySlug(scope, slug);
    if (existing === null) return null;

    const [, { count }] = await this.prisma.$transaction([
      // (1) UNGROUP the runs committed in this test, BEFORE the test row — for
      // LOCK ORDER as much as for clearing. Changing test_id takes each run
      // FOR UPDATE while this transaction holds no lock on the test, so a
      // finalize holding one of them — even only by the KEY SHARE its
      // assertion rows take — is waited for here, before (2) asks for the
      // test, and can get the test and finish (see the docstring above; the
      // worker's run-number suite pins it). Named by slug, as (2) is.
      this.prisma.$executeRaw`
        UPDATE run SET test_id = NULL, run_number = NULL
         WHERE org_id = ${scope.orgId}::uuid AND project_id = ${scope.projectId}::uuid
           AND test_id = (SELECT id FROM test
                           WHERE org_id = ${scope.orgId}::uuid
                             AND project_id = ${scope.projectId}::uuid
                             AND slug = ${slug})`,
      // (2) The test. Its cascade (`run.test_id ON DELETE SET NULL`)
      // ungroups any run that joined it after (1) read.
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
