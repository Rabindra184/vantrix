import type { PrismaClient } from '@prisma/client';
import type { RunRecord } from './run.js';
import type { TenantScope } from './tenant.js';

/**
 * ═══ WHAT THE PORTFOLIO HOME READS ═══
 * (docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md)
 *
 * `GET /v1/activity` answers five questions about one organisation, or about
 * one token's project, and every one of them is on `run.created_at` — the
 * moment a run ARRIVED — never on `started_at`, which is when the load test
 * ran and can be earlier than a run that arrived before it:
 *
 *   days        how many runs arrived in each of seven calendar days, and how
 *               many of those were successful or need attention
 *   attention   the tests whose latest run this week needs attention
 *   running     how many runs are streaming right now
 *   byProject   the five busiest projects this week
 *   lastRun     the newest arrival ever
 *
 * The caller owns the calendar: it hands in eight boundaries, so "day" is the
 * reader's zone's day and this file never learns what a zone is.
 */

/** The attention list's cap. `attentionTotal` carries the true count, because
 *  a header counting the rows sent would say "20 tests" over 35. */
export const ACTIVITY_ATTENTION_LIMIT = 20;
/** The "Runs by project" card's cap. */
export const ACTIVITY_PROJECT_LIMIT = 5;

/** The glance is seven days, which takes eight boundaries. */
const GLANCE_DAYS = 7;

/**
 * ═══ ONE SQL SPELLING OF "NEEDS ATTENTION" ═══
 *
 * The rule lives in `needsAttention` (`@perfportal/contracts`) for rows already
 * in memory. Counting them is SQL, which cannot call it, so this is the one
 * place the rule is written in SQL, and an integration case runs it over every
 * status, verdict and checks shape and requires it to agree with the contract.
 *
 * A run needs attention when its status is failed or incomplete, or its SLA
 * verdict is failed, or one of the checks its simulation declared failed.
 *
 * TWO THINGS HERE ARE NOT WHAT THEY LOOK LIKE:
 *
 *   - The verdict is compared with IS NOT DISTINCT FROM, not `=`. A run with
 *     no verdict has a NULL one, and `NULL = 'failed'` is NULL, which turns
 *     `false OR NULL OR false` into NULL: neither needing attention nor not
 *     needing it. `NOT NULL` is NULL as well, so a complete run with no
 *     verdict would have counted as neither successful nor in need of
 *     attention, and vanished from the one number that is meant to sum.
 *   - The checks array is read through a CASE. `tool_assertions` is a JSONB
 *     column and can hold SQL NULL, the JSON value null, or something that is
 *     not an array, and `jsonb_array_elements` raises on a scalar. SQL does
 *     not promise to short-circuit AND, so a `jsonb_typeof(...) = 'array' AND`
 *     in front would not keep it from being called.
 *
 * `alias` is the run table's alias in the caller's query. It is spliced in, so
 * it is always a literal from the calling code and never a value from a request.
 */
export function needsAttentionSql(alias: string): string {
  return `(${alias}.status IN ('failed', 'incomplete')
     OR ${alias}.verdict IS NOT DISTINCT FROM 'failed'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(${alias}.tool_assertions) = 'array'
              THEN ${alias}.tool_assertions ELSE '[]'::jsonb END) AS e
       WHERE e->>'outcome' = 'failed'))`;
}

/** The tenant predicate every read here starts with: the org, and the project
 *  as well when the caller is a token. `first` is the placeholder number the
 *  org id takes; the project's, when there is one, follows it. */
function tenantFilter(
  scope: TenantScope,
  alias: string,
): { where: string; params: unknown[] } {
  const params: unknown[] = [scope.orgId];
  const filters = [`${alias}.org_id = $1::uuid`];
  if (scope.projectId) {
    params.push(scope.projectId);
    filters.push(`${alias}.project_id = $${params.length}::uuid`);
  }
  return { where: filters.join(' AND '), params };
}

function assertBoundaries(boundaries: readonly Date[]): void {
  if (boundaries.length !== GLANCE_DAYS + 1) {
    throw new Error(
      `The activity glance needs ${GLANCE_DAYS + 1} day boundaries for ${GLANCE_DAYS} days, got ${boundaries.length}.`,
    );
  }
}

/**
 * ═══ THE SEVEN DAY COUNTS, AS ONE STATEMENT ═══
 *
 * Exported with its parameters for the reason `SERIES_SQL` is: the plan test
 * EXPLAINs the exact statement `read` runs, not a copy of it.
 *
 * One row per glance day, always seven: the days are a `generate_series` and
 * each takes its counts from a LATERAL aggregate over its own half-open range
 * `[b[i], b[i + 1])`, so a boundary belongs to the day it starts. An aggregate
 * with no GROUP BY returns a row even over nothing, so a day no run arrived in
 * is a row of zeros and the caller never fills a gap.
 *
 * THE LATERAL IS WHAT PUTS THE RANGE IN THE INDEX CONDITION. The first draft
 * LEFT JOINed the runs onto the seven days instead, and the planner named
 * `run_org_id_created_at_idx` for it, took only the org out of the index and
 * applied each day's range as a join filter over every run the organisation
 * has ever had, once per day. A per-day aggregate is a parameterised range
 * scan over `(org_id, created_at)`: a day costs its own runs.
 *
 * `successful` is a COMPLETE run that does not need attention. An in-flight
 * run (pending, parsing, running) counts toward `total` only: it has not
 * succeeded and has not failed, and a day's three numbers are not meant to add
 * up to its total. Days are numbered from 1 because SQL arrays are, and
 * returned from 0.
 */
export function activityDaysQuery(
  scope: TenantScope,
  boundaries: readonly Date[],
): { sql: string; params: unknown[] } {
  assertBoundaries(boundaries);
  const tenant = tenantFilter(scope, 'a');
  const params = [...tenant.params, boundaries.map((b) => b.toISOString())];
  const bounds = `$${params.length}::timestamptz[]`;
  const sql = `
    SELECT (d.i - 1)::int AS day, c.total, c.successful, c."needsAttention"
    FROM generate_series(1, ${GLANCE_DAYS}) AS d(i)
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS total,
             (count(*) FILTER (WHERE a.status = 'complete' AND NOT ${needsAttentionSql('a')}))::int
               AS successful,
             (count(*) FILTER (WHERE ${needsAttentionSql('a')}))::int AS "needsAttention"
      FROM run a
      WHERE ${tenant.where}
        AND a.created_at >= (${bounds})[d.i]
        AND a.created_at < (${bounds})[d.i + 1]
    ) c
    ORDER BY d.i`;
  return { sql, params };
}

/** What `read` needs besides the tenant: the attention window, and the eight
 *  boundaries of the seven glance days. */
export interface ActivityWindow {
  /** Inclusive. The attention window is the week before now. */
  readonly attentionFrom: Date;
  /** Inclusive. */
  readonly attentionTo: Date;
  /** Eight instants: day `i` is `[b[i], b[i + 1])`, and the last is the first
   *  instant after the last day. */
  readonly dayBoundaries: readonly Date[];
}

/** A run as the attention list shows it. */
export interface ActivityRunRow {
  id: string;
  runNumber: number | null;
  status: string;
  verdict: string | null;
  /** `COALESCE(tool_started_at, started_at)`: when the load test ran. */
  startedAt: Date;
  durationMs: number | null;
  simulation: string | null;
  toolAssertions: RunRecord['toolAssertions'];
}

export interface ActivityAttentionRow {
  /** Null for a run no test claims: an upload that never resolved one. */
  test: { slug: string; name: string } | null;
  project: { slug: string; name: string };
  run: ActivityRunRow;
}

export interface ActivityRows {
  /** Seven, oldest first, in the order of the boundaries. */
  days: Array<{ total: number; successful: number; needsAttention: number }>;
  running: number;
  byProject: Array<{ project: { slug: string; name: string }; runs: number }>;
  /** At most `ACTIVITY_ATTENTION_LIMIT`, newest arrival first. */
  attention: ActivityAttentionRow[];
  /** How many tests (and test-less runs) need attention, however many of them
   *  `attention` carries. */
  attentionTotal: number;
  /** The newest arrival in the scope, with no window. Null for an empty one. */
  lastRun: {
    id: string;
    runNumber: number | null;
    test: { slug: string; name: string } | null;
    project: { slug: string; name: string };
    startedAt: Date;
  } | null;
}

interface DaySqlRow {
  day: number;
  total: number;
  successful: number;
  needsAttention: number;
}

interface AttentionSqlRow {
  id: string;
  runNumber: number | null;
  status: string;
  verdict: string | null;
  startedAt: Date;
  durationMs: number | null;
  simulation: string | null;
  toolAssertions: unknown;
  testSlug: string | null;
  testName: string | null;
  projectSlug: string;
  projectName: string;
  total: number;
}

interface ProjectSqlRow {
  slug: string;
  name: string;
  runs: number;
}

interface LastRunSqlRow {
  id: string;
  runNumber: number | null;
  startedAt: Date;
  testSlug: string | null;
  testName: string | null;
  projectSlug: string;
  projectName: string;
}

/**
 * What `GET /v1/activity` reads. Every read takes the tenant in its `WHERE`,
 * the org always and the project as well for a token, so a run of another
 * organisation is not counted rather than counted and then hidden.
 *
 * The five reads are independent and run in parallel.
 */
export class ActivityRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async read(scope: TenantScope, window: ActivityWindow): Promise<ActivityRows> {
    assertBoundaries(window.dayBoundaries);
    const [days, running, byProject, attention, lastRun] = await Promise.all([
      this.#days(scope, window.dayBoundaries),
      this.#running(scope),
      this.#byProject(scope, window.dayBoundaries),
      this.#attention(scope, window),
      this.#lastRun(scope),
    ]);
    return { days, running, byProject, attention: attention.rows, attentionTotal: attention.total, lastRun };
  }

  async #days(scope: TenantScope, boundaries: readonly Date[]): Promise<ActivityRows['days']> {
    const { sql, params } = activityDaysQuery(scope, boundaries);
    const rows = await this.prisma.$queryRawUnsafe<DaySqlRow[]>(sql, ...params);
    // `activityDaysQuery` ends in ORDER BY the day, so these are already the
    // seven days oldest first.
    return rows.map((row) => ({
      total: row.total,
      successful: row.successful,
      needsAttention: row.needsAttention,
    }));
  }

  /** Streaming right now, whenever it arrived: a soak test that started a month
   *  ago is still running, and a window would stop counting it. */
  async #running(scope: TenantScope): Promise<number> {
    const tenant = tenantFilter(scope, 'a');
    const rows = await this.prisma.$queryRawUnsafe<{ running: number }[]>(
      `SELECT count(*)::int AS running FROM run a WHERE ${tenant.where} AND a.status = 'running'`,
      ...tenant.params,
    );
    return rows[0]?.running ?? 0;
  }

  /**
   * Runs that ARRIVED in the seven glance days, per project: the half-open
   * range from the first boundary to the last. Busiest first, then by name,
   * then by slug so two projects sharing a name still have one order.
   */
  async #byProject(
    scope: TenantScope,
    boundaries: readonly Date[],
  ): Promise<ActivityRows['byProject']> {
    const tenant = tenantFilter(scope, 'a');
    const params = [...tenant.params, boundaries[0], boundaries[GLANCE_DAYS], ACTIVITY_PROJECT_LIMIT];
    const from = `$${params.length - 2}::timestamptz(3)`;
    const to = `$${params.length - 1}::timestamptz(3)`;
    const rows = await this.prisma.$queryRawUnsafe<ProjectSqlRow[]>(
      `
      SELECT p.slug, p.name, count(*)::int AS runs
      FROM run a
      JOIN project p ON p.id = a.project_id
      WHERE ${tenant.where} AND a.created_at >= ${from} AND a.created_at < ${to}
      GROUP BY p.id, p.slug, p.name
      ORDER BY runs DESC, p.name ASC, p.slug ASC
      LIMIT $${params.length}::int
      `,
      ...params,
    );
    return rows.map((row) => ({ project: { slug: row.slug, name: row.name }, runs: row.runs }));
  }

  /**
   * ═══ A TEST IS LISTED WHEN ITS LATEST RUN THIS WEEK NEEDS ATTENTION ═══
   *
   * "Latest" is the newest ARRIVAL INSIDE the window, `created_at DESC, id DESC`
   * (`DISTINCT ON` over the test, in that order). So a test that failed on
   * Tuesday and passed on Wednesday is not listed, and one whose only runs are
   * outside the window is not listed at all.
   *
   * A run no test claims has no later run to supersede it, so each one is its
   * own row: UNION ALL with every in-window run whose `test_id` is NULL. An
   * in-flight one is not an attention case (none of the four clauses holds for
   * a run that has not finished), so the same predicate drops it.
   *
   * The predicate is applied AFTER the latest-per-test cut. Filtering first
   * would list a test whose latest run passed, because its older failure would
   * become the latest one that was left.
   *
   * `count(*) OVER ()` is evaluated before `LIMIT`, so every row carries the
   * full count and `attentionTotal` is the true one however many rows come back.
   */
  async #attention(
    scope: TenantScope,
    window: ActivityWindow,
  ): Promise<{ rows: ActivityAttentionRow[]; total: number }> {
    const tenant = tenantFilter(scope, 'a');
    const params = [...tenant.params, window.attentionFrom, window.attentionTo, ACTIVITY_ATTENTION_LIMIT];
    const from = `$${params.length - 2}::timestamptz(3)`;
    const to = `$${params.length - 1}::timestamptz(3)`;
    const inWindow = `${tenant.where} AND a.created_at >= ${from} AND a.created_at <= ${to}`;
    const columns = `a.id, a.run_number, a.status, a.verdict, a.tool_started_at, a.started_at,
             a.duration_ms, a.simulation, a.tool_assertions, a.test_id, a.project_id, a.created_at`;
    const rows = await this.prisma.$queryRawUnsafe<AttentionSqlRow[]>(
      `
      WITH latest_per_test AS (
        SELECT DISTINCT ON (a.test_id) ${columns}
        FROM run a
        WHERE ${inWindow} AND a.test_id IS NOT NULL
        ORDER BY a.test_id, a.created_at DESC, a.id DESC
      ),
      candidates AS (
        SELECT * FROM latest_per_test
        UNION ALL
        SELECT ${columns}
        FROM run a
        WHERE ${inWindow} AND a.test_id IS NULL
      )
      SELECT a.id, a.run_number AS "runNumber", a.status, a.verdict,
             COALESCE(a.tool_started_at, a.started_at) AS "startedAt",
             a.duration_ms AS "durationMs", a.simulation,
             a.tool_assertions AS "toolAssertions",
             t.slug AS "testSlug", t.name AS "testName",
             p.slug AS "projectSlug", p.name AS "projectName",
             (count(*) OVER ())::int AS total
      FROM candidates a
      JOIN project p ON p.id = a.project_id
      LEFT JOIN test t ON t.id = a.test_id
      WHERE ${needsAttentionSql('a')}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${params.length}::int
      `,
      ...params,
    );
    return {
      rows: rows.map((row) => ({
        test: row.testSlug === null || row.testName === null ? null : { slug: row.testSlug, name: row.testName },
        project: { slug: row.projectSlug, name: row.projectName },
        run: {
          id: row.id,
          runNumber: row.runNumber,
          status: row.status,
          verdict: row.verdict,
          startedAt: row.startedAt,
          durationMs: row.durationMs,
          simulation: row.simulation,
          toolAssertions: (row.toolAssertions ?? null) as RunRecord['toolAssertions'],
        },
      })),
      total: rows[0]?.total ?? 0,
    };
  }

  /** The newest arrival, with no window: "last run" is a fact about the whole
   *  organisation and stays true in a quiet week. */
  async #lastRun(scope: TenantScope): Promise<ActivityRows['lastRun']> {
    const tenant = tenantFilter(scope, 'a');
    const rows = await this.prisma.$queryRawUnsafe<LastRunSqlRow[]>(
      `
      SELECT a.id, a.run_number AS "runNumber",
             COALESCE(a.tool_started_at, a.started_at) AS "startedAt",
             t.slug AS "testSlug", t.name AS "testName",
             p.slug AS "projectSlug", p.name AS "projectName"
      FROM run a
      JOIN project p ON p.id = a.project_id
      LEFT JOIN test t ON t.id = a.test_id
      WHERE ${tenant.where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 1
      `,
      ...tenant.params,
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      runNumber: row.runNumber,
      test: row.testSlug === null || row.testName === null ? null : { slug: row.testSlug, name: row.testName },
      project: { slug: row.projectSlug, name: row.projectName },
      startedAt: row.startedAt,
    };
  }
}
