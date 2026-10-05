import type { PrismaClient } from '@prisma/client';
import { escapeLike } from './like.js';
import { runP95, type RunRecord } from './run.js';
import type { ProjectScope, TenantScope } from './tenant.js';

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
 * A test's newest run, as the org-wide list shows it.
 *
 * "Newest" is by ARRIVAL (`created_at DESC, id DESC`) — the order a run's
 * number follows, and the one `listForProject` and `findBySlug` report — and
 * NOT the run list's by-start order. `startedAt` is therefore when the load
 * test RAN, which can be earlier than a run that arrived before this one.
 */
export interface OrgTestLatestRun {
  id: string;
  runNumber: number | null;
  status: string;
  verdict: string | null;
  /** `COALESCE(tool_started_at, started_at)`: when the load test ran. */
  startedAt: Date;
  durationMs: number | null;
  toolAssertions: RunRecord['toolAssertions'];
  /** The run-scope p95, clamped; null where it has none. See `runP95`. */
  p95Ms: number | null;
}

/** One point of a test's p95 history. */
export interface OrgTestP95Point {
  runId: string;
  runNumber: number | null;
  p95Ms: number;
}

/** A test as the org-wide list sees it: the row, its project, its newest run. */
export interface OrgTestRow {
  id: string;
  slug: string;
  name: string;
  simulationClass: string;
  runCount: number;
  project: { slug: string; name: string };
  latestRun: OrgTestLatestRun | null;
  /** At most `P95_HISTORY_POINTS`, complete runs only, oldest first. */
  p95History: OrgTestP95Point[];
}

export interface ListOrgTestsOptions {
  readonly limit: number;
  /** A test id: the last item of the previous page. */
  readonly cursor?: string;
  /** Free text over the test's name, slug and class and its project's name
   *  and slug. Already trimmed by the caller; matched literally. */
  readonly q?: string;
}

/**
 * How many points a test's p95 history carries. The wire schema caps it at the
 * same number, and a query that returned one more would make the browser's
 * parse of the WHOLE response throw — so the cap lives in the query, not in
 * whoever remembers to slice.
 */
export const P95_HISTORY_POINTS = 10;

/**
 * The newest ARRIVAL per test, as a LATERAL join the list's ORDER BY and its
 * cursor lookup both read — one definition, because the keyset is only correct
 * while the order it resumes and the order it was sorted by are the same
 * expression. Served by `run_test_id_created_at_idx`.
 */
const LATEST_ARRIVAL_JOIN = `
  LEFT JOIN LATERAL (
    SELECT r.created_at FROM run r WHERE r.test_id = t.id
    ORDER BY r.created_at DESC, r.id DESC LIMIT 1
  ) lr ON true`;

/**
 * The run-scope response-time statistics row — the same selection the stats
 * endpoint calls a run's totals and `RunRepository.list` joins, so a test's
 * p95 and the run page's cannot disagree about which row it is.
 */
const RUN_SCOPE_STAT_ON = `
       AND s.scope = 'run'
       AND s.name = ''
       AND s.family = 'response_time'`;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OrgTestSqlRow {
  id: string;
  slug: string;
  name: string;
  simulationClass: string;
  projectSlug: string;
  projectName: string;
}

interface LatestRunSqlRow {
  testId: string;
  id: string;
  runNumber: number | null;
  status: string;
  verdict: string | null;
  startedAt: Date;
  durationMs: number | null;
  toolAssertions: unknown;
  statPercentiles: unknown;
  statMinMs: number | null;
  statMaxMs: number | null;
}

interface HistorySqlRow {
  testId: string;
  runId: string;
  runNumber: number | null;
  statPercentiles: unknown;
  statMinMs: number | null;
  statMaxMs: number | null;
}

/**
 * The four fields a project's test list and a single test report for their
 * latest run, taken off the fuller shape `latestRuns` reads for the org-wide
 * list — so the three readers share one query and one ordering and differ only
 * in how much of its answer they show.
 */
function summaryOf(run: OrgTestLatestRun | undefined): TestRow['latestRun'] {
  return run === undefined
    ? null
    : { id: run.id, status: run.status, verdict: run.verdict, runNumber: run.runNumber };
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
   * page nobody paginates. `groupBy` gives every count in one, and `latestRuns`
   * gives every newest run in one.
   *
   * It used to load EVERY run of EVERY test and keep the first per test. That
   * was right for a handful of runs and a scan of the whole history for a
   * project that has been running for a year; the newest-per-test read is a
   * LATERAL over `run_test_id_created_at_idx` now, one index probe per test.
   *
   * `latestRun` is chosen by `createdAt DESC, id DESC` — the SAME ordering
   * `RunRepository.list` uses for its tiebreak and `latestRuns` uses for its
   * whole order, so the run a reader sees at the top of a test's history is the
   * run this reports. Two orderings would disagree exactly when two runs share
   * a timestamp, which is precisely when a reader is looking.
   */
  async listForProject(scope: ProjectScope): Promise<TestRow[]> {
    const tests = await this.prisma.test.findMany({
      where: { orgId: scope.orgId, projectId: scope.projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    if (tests.length === 0) return [];

    const ids = tests.map((t) => t.id);
    const [counts, latest] = await Promise.all([
      this.prisma.run.groupBy({
        by: ['testId'],
        where: { testId: { in: ids } },
        _count: { _all: true },
      }),
      this.latestRuns(ids),
    ]);

    const countBy = new Map(counts.map((c) => [c.testId, c._count._all]));

    return tests.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      simulationClass: t.simulationClass,
      description: t.description,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      runCount: countBy.get(t.id) ?? 0,
      latestRun: summaryOf(latest.get(t.id)),
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
      this.latestRuns([test.id]),
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
      latestRun: summaryOf(latest.get(test.id)),
    };
  }

  /**
   * ═══ EVERY TEST IN THE ORG (OR THE TOKEN'S PROJECT), NEWEST ACTIVITY FIRST ═══
   *
   * What `GET /v1/tests` reads: the portfolio's list and the command palette's
   * test search. It is raw SQL for the reason `RunRepository.list` is — Prisma's
   * builder cannot ORDER BY a LATERAL's column — and it paginates by keyset for
   * the same reason that one does: an offset would resurface or skip rows as
   * tests arrive between pages.
   *
   * THE ORDER IS `latest arrival DESC NULLS LAST, name ASC, id ASC`. A test
   * that has run floats to the top by when its newest run ARRIVED; tests that
   * have never run sit below them, alphabetically, because there is nothing
   * else to sort a never-run test by. `NULLS LAST` has to be written out: a
   * descending sort puts nulls FIRST by default, which would lead the page with
   * the tests that have done nothing.
   *
   * THE CURSOR IS A TEST ID, resolved first to the `(latest arrival, name, id)`
   * it sorts by, and the next page is everything strictly after that tuple in
   * the same order. There are three boundaries to resume across and each has
   * its own predicate:
   *
   *   - dated to dated      later arrival, or the same arrival and a later name/id
   *   - dated to never-run  every never-run test follows a dated one
   *   - never-run to same   a never-run cursor continues by name/id alone
   *
   * A cursor that no longer resolves — another org's, a deleted test, not a
   * uuid at all — answers an EMPTY page rather than starting over, because a
   * silent restart resurfaces tests the reader already saw. The run list's
   * rule, and the reason it is spelled the same way here.
   *
   * `latestRuns` and `p95Histories` are separate reads over the page's ids
   * rather than columns of this one: they are per-test lookups against the run
   * table, and joining them in would multiply the page's rows.
   */
  async listOrg(
    scope: TenantScope,
    opts: ListOrgTestsOptions,
  ): Promise<{ items: OrgTestRow[]; nextCursor: string | null }> {
    const none = { items: [], nextCursor: null };

    const filters: string[] = ['t.org_id = $1::uuid'];
    const params: unknown[] = [scope.orgId];
    if (scope.projectId) {
      params.push(scope.projectId);
      filters.push(`t.project_id = $${params.length}::uuid`);
    }

    if (opts.cursor) {
      const at = await this.resolveCursor(scope, opts.cursor);
      if (at === null) return none;
      params.push(at.name, opts.cursor);
      const name = `$${params.length - 1}::text`;
      const id = `$${params.length}::uuid`;
      if (at.latestAt === null) {
        filters.push(`(lr.created_at IS NULL AND (t.name, t.id) > (${name}, ${id}))`);
      } else {
        params.push(at.latestAt);
        const when = `$${params.length}::timestamptz(3)`;
        filters.push(
          `(lr.created_at < ${when}` +
            ` OR (lr.created_at = ${when} AND (t.name, t.id) > (${name}, ${id}))` +
            ` OR lr.created_at IS NULL)`,
        );
      }
    }

    // FREE TEXT over the test's own words and its project's. Unlike the run
    // list's search this does not resolve the projects first: a project has a
    // handful of tests and an organisation a handful of projects, so there is
    // no index worth keeping a BitmapOr for, and one join is the plainer query.
    if (opts.q) {
      params.push(`%${escapeLike(opts.q)}%`);
      const q = `$${params.length}`;
      filters.push(
        `(t.name ILIKE ${q} ESCAPE '\\' OR t.slug ILIKE ${q} ESCAPE '\\'` +
          ` OR t.simulation_class ILIKE ${q} ESCAPE '\\'` +
          ` OR p.name ILIKE ${q} ESCAPE '\\' OR p.slug ILIKE ${q} ESCAPE '\\')`,
      );
    }
    params.push(opts.limit + 1);

    const rows = await this.prisma.$queryRawUnsafe<OrgTestSqlRow[]>(
      `
      SELECT t.id, t.slug, t.name, t.simulation_class AS "simulationClass",
             p.slug AS "projectSlug", p.name AS "projectName"
      FROM test t
      JOIN project p ON p.id = t.project_id
      ${LATEST_ARRIVAL_JOIN}
      WHERE ${filters.join(' AND ')}
      ORDER BY lr.created_at DESC NULLS LAST, t.name ASC, t.id ASC
      LIMIT $${params.length}
      `,
      ...params,
    );
    const page = rows.slice(0, opts.limit);
    if (page.length === 0) return none;
    const nextCursor = rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null;

    const ids = page.map((row) => row.id);
    const [counts, latest, history] = await Promise.all([
      this.prisma.run.groupBy({
        by: ['testId'],
        where: { testId: { in: ids } },
        _count: { _all: true },
      }),
      this.latestRuns(ids),
      this.p95Histories(ids),
    ]);
    const countBy = new Map(counts.map((c) => [c.testId, c._count._all]));

    return {
      items: page.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        simulationClass: row.simulationClass,
        runCount: countBy.get(row.id) ?? 0,
        project: { slug: row.projectSlug, name: row.projectName },
        latestRun: latest.get(row.id) ?? null,
        p95History: history.get(row.id) ?? [],
      })),
      nextCursor,
    };
  }

  /**
   * A cursor test's sort key, or null when it is not a test this caller can
   * see. Tenant-scoped like the list it resumes: a cursor from another org
   * must not read as "start after that test", and must not reveal that the
   * test exists.
   *
   * The shape check comes first because the column is a uuid and an unguarded
   * `::uuid` cast on a hand-edited cursor would THROW — a 500 for what the
   * list answers, for every other unresolvable cursor, with an empty page.
   */
  private async resolveCursor(
    scope: TenantScope,
    cursor: string,
  ): Promise<{ name: string; latestAt: Date | null } | null> {
    if (!UUID_SHAPE.test(cursor)) return null;
    const params: unknown[] = [cursor, scope.orgId];
    let project = '';
    if (scope.projectId) {
      params.push(scope.projectId);
      project = 'AND t.project_id = $3::uuid';
    }
    const rows = await this.prisma.$queryRawUnsafe<{ name: string; latestAt: Date | null }[]>(
      `
      SELECT t.name, lr.created_at AS "latestAt"
      FROM test t
      ${LATEST_ARRIVAL_JOIN}
      WHERE t.id = $1::uuid AND t.org_id = $2::uuid ${project}
      `,
      ...params,
    );
    return rows[0] ?? null;
  }

  /**
   * Each given test's newest run by ARRIVAL, keyed by test id; a test with no
   * run is simply absent. One probe per test against
   * `run_test_id_created_at_idx` — no scan of the history.
   *
   * THE IDS ARE ALREADY TENANT-SCOPED: every caller resolved them through a
   * query that carried the scope, and a run belongs to its test's org, so this
   * adds no tenant filter of its own and cannot be handed another org's ids by
   * a caller that skipped one.
   *
   * The run-scope statistics row rides along (LEFT: a run still parsing has
   * none) so `p95Ms` costs no second round trip and is the SAME number the
   * run list's row shows, through `runP95`.
   */
  private async latestRuns(testIds: string[]): Promise<Map<string, OrgTestLatestRun>> {
    const rows = await this.prisma.$queryRawUnsafe<LatestRunSqlRow[]>(
      `
      SELECT lr.test_id AS "testId", lr.id, lr.run_number AS "runNumber", lr.status, lr.verdict,
             COALESCE(lr.tool_started_at, lr.started_at) AS "startedAt",
             lr.duration_ms AS "durationMs", lr.tool_assertions AS "toolAssertions",
             s.percentiles AS "statPercentiles", s.min_ms AS "statMinMs", s.max_ms AS "statMaxMs"
      FROM unnest($1::uuid[]) AS t(id)
      CROSS JOIN LATERAL (
        SELECT r.test_id, r.id, r.org_id, r.project_id, r.run_number, r.status, r.verdict,
               r.tool_started_at, r.started_at, r.duration_ms, r.tool_assertions
        FROM run r WHERE r.test_id = t.id
        ORDER BY r.created_at DESC, r.id DESC LIMIT 1
      ) lr
      LEFT JOIN run_stat s
        ON s.run_id = lr.id
       AND s.org_id = lr.org_id
       AND s.project_id = lr.project_id${RUN_SCOPE_STAT_ON}
      `,
      testIds,
    );
    return new Map(
      rows.map((row) => [
        row.testId,
        {
          id: row.id,
          runNumber: row.runNumber,
          status: row.status,
          verdict: row.verdict,
          startedAt: row.startedAt,
          durationMs: row.durationMs,
          toolAssertions: (row.toolAssertions ?? null) as RunRecord['toolAssertions'],
          p95Ms: runP95({
            percentiles: row.statPercentiles,
            minMs: row.statMinMs,
            maxMs: row.statMaxMs,
          }),
        },
      ]),
    );
  }

  /**
   * Each given test's p95 over its last `P95_HISTORY_POINTS` MEASURED complete
   * runs, keyed by test id, oldest first.
   *
   * The statistics row is an INNER join and the window is cut AFTER it: the
   * history is of runs that were measured, so a newer run that never produced
   * statistics does not push a measured one out of the ten. A run whose row has
   * no usable p95 (a project whose percentile set omits it) still takes its
   * place in the ten and then contributes no point — dropped here rather than
   * in SQL, because "usable" is `runP95`'s question and not a second
   * definition kept in a WHERE clause.
   *
   * Newest-first inside the LATERAL so `LIMIT` keeps the most recent, reversed
   * here so a sparkline reads left to right. Ordered again on the way out
   * because a LATERAL's inner order is not a promise about its outer rows.
   */
  private async p95Histories(testIds: string[]): Promise<Map<string, OrgTestP95Point[]>> {
    const rows = await this.prisma.$queryRawUnsafe<HistorySqlRow[]>(
      `
      SELECT h.test_id AS "testId", h.id AS "runId", h.run_number AS "runNumber",
             h.percentiles AS "statPercentiles", h.min_ms AS "statMinMs", h.max_ms AS "statMaxMs"
      FROM unnest($1::uuid[]) AS t(id)
      CROSS JOIN LATERAL (
        SELECT r.test_id, r.id, r.run_number, r.created_at,
               s.percentiles, s.min_ms, s.max_ms
        FROM run r
        JOIN run_stat s
          ON s.run_id = r.id
         AND s.org_id = r.org_id
         AND s.project_id = r.project_id${RUN_SCOPE_STAT_ON}
        WHERE r.test_id = t.id AND r.status = 'complete'
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${P95_HISTORY_POINTS}
      ) h
      ORDER BY h.test_id, h.created_at DESC, h.id DESC
      `,
      testIds,
    );
    const byTest = new Map<string, OrgTestP95Point[]>();
    for (const row of rows) {
      const p95Ms = runP95({
        percentiles: row.statPercentiles,
        minMs: row.statMinMs,
        maxMs: row.statMaxMs,
      });
      if (p95Ms === null) continue;
      const points = byTest.get(row.testId) ?? [];
      points.push({ runId: row.runId, runNumber: row.runNumber, p95Ms });
      byTest.set(row.testId, points);
    }
    for (const points of byTest.values()) points.reverse();
    return byTest;
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
