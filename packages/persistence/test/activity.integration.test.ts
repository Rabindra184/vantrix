import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { needsAttention, type RunStatus, type RunVerdict } from '@perfportal/contracts';
import {
  activityDaysQuery,
  ActivityRepository,
  ACTIVITY_ATTENTION_LIMIT,
  createPool,
  createPrisma,
  needsAttentionSql,
  SCHEMA_TABLES,
  type ActivityWindow,
} from '../src/index.js';

/**
 * ═══ WHAT THE PORTFOLIO HOME READS, BY ARRIVAL ═══
 * (docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md)
 *
 * `ActivityRepository.read` answers five questions about one organisation (or
 * one token's project) and every one of them is on `run.created_at`, the
 * moment a run ARRIVED. Three things in it are easy to get subtly wrong:
 *
 *   - the attention rule is written twice, once in the contracts package for
 *     rows already in memory and once in SQL for counting them. They have to
 *     agree on every status, verdict and checks shape, including the shapes a
 *     JSONB column can hold that a TypeScript type cannot: SQL NULL, JSON
 *     `null`, and an empty array. The first case runs all of them.
 *   - "latest run in the window" per test is `created_at DESC, id DESC` among
 *     that test's runs INSIDE the window, so a test that failed on Tuesday and
 *     passed on Wednesday is not listed. Every attention fixture here puts the
 *     older run's status on the side the newer one must override.
 *   - the cap on the list is 20 and the count that heads it is the true count.
 *     A header counting the rows sent would say "20 tests" over 35.
 */
const pool = createPool(process.env.DATABASE_URL ?? '');
const prisma = createPrisma(process.env.DATABASE_URL ?? '');
const repo = new ActivityRepository(prisma);

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** One instant for the whole file, so a fixture "ten hours ago" and the window
 *  the read is handed agree about what "ago" means. */
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms);

/** Today's UTC midnight. The home page's boundaries are the caller's zone's;
 *  UTC midnights are the simplest set of eight that obey the same contract. */
const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
/** Eight boundaries: day `i` is `[b[i], b[i + 1])` and the last is tomorrow. */
const boundaries = Array.from({ length: 8 }, (_, i) => new Date(todayStart + (i - 6) * DAY));
/** Somewhere inside glance day `i` that is not its first millisecond. */
const inDay = (i: number) => new Date(boundaries[i]!.getTime() + 12 * HOUR);

/** The window the endpoint hands in: from the first glance boundary to now, so
 *  the attention list and the day counts cover the same seven days. */
const window: ActivityWindow = {
  attentionFrom: boundaries[0]!,
  attentionTo: now,
  dayBoundaries: boundaries,
};

let orgId = '';
let projectId = '';

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${SCHEMA_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  orgId = org.id;
  projectId = project.id;
});

const scope = () => ({ orgId });

const newProject = (slug: string, name: string, forOrg = orgId) =>
  prisma.project.create({ data: { orgId: forOrg, slug, name, settings: {} } });

const newTest = (
  slug: string,
  over: { name?: string; projectId?: string; orgId?: string } = {},
) =>
  prisma.test.create({
    data: {
      orgId: over.orgId ?? orgId,
      projectId: over.projectId ?? projectId,
      slug,
      name: over.name ?? slug,
      simulationClass: `example.${slug}`,
    },
  });

interface RunOpts {
  testId?: string | null;
  /** When the run ARRIVED. Always explicit: a fixture with every row stamped
   *  by one `now()` orders nothing. */
  createdAt: Date;
  /** When the load test ran. Deliberately independent of `createdAt`. */
  toolStartedAt?: Date | null;
  /** When the platform received the run; a minute before arrival unless a
   *  case needs it elsewhere — after a LATER arrival, say. */
  startedAt?: Date;
  status?: string;
  verdict?: string | null;
  runNumber?: number | null;
  durationMs?: number | null;
  simulation?: string | null;
  /** `Prisma.DbNull` is SQL NULL and `Prisma.JsonNull` is the JSON value
   *  `null`: two different cells that a reader of the column must both treat as
   *  "no checks recorded". */
  toolAssertions?: unknown;
  projectId?: string;
  orgId?: string;
}

async function seedRun(opts: RunOpts): Promise<string> {
  const id = randomUUID();
  const project = opts.projectId ?? projectId;
  await prisma.run.create({
    data: {
      id,
      orgId: opts.orgId ?? orgId,
      projectId: project,
      testId: opts.testId ?? null,
      runNumber: opts.runNumber ?? null,
      status: opts.status ?? 'complete',
      verdict: opts.verdict === undefined ? 'passed' : opts.verdict,
      tool: 'gatling',
      bundleKey: `runs/${project}/${id}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n,
      createdAt: opts.createdAt,
      // `started_at` is the platform's own receipt time and `created_at` is
      // bookkeeping for the row; they are separate columns, and a fixture that
      // stamps both the same cannot tell a reader of one from a reader of the
      // other.
      startedAt: opts.startedAt ?? new Date(opts.createdAt.getTime() - 60_000),
      startedOn: new Date(opts.createdAt.toISOString().slice(0, 10)),
      toolStartedAt: opts.toolStartedAt ?? null,
      durationMs: opts.durationMs ?? null,
      simulation: opts.simulation ?? null,
      toolAssertions:
        opts.toolAssertions === undefined ? Prisma.DbNull : (opts.toolAssertions as never),
      engineOptions: {},
    },
  });
  return id;
}

const failedRun = (over: Partial<RunOpts> & { createdAt: Date }) =>
  seedRun({ status: 'failed', verdict: null, ...over });

const attentionIds = (rows: { run: { id: string } }[]) => rows.map((r) => r.run.id);

const STATUSES: RunStatus[] = ['pending', 'parsing', 'running', 'complete', 'failed', 'incomplete'];
const VERDICTS: (RunVerdict | null)[] = ['passed', 'failed', 'not_evaluated', null];
/** Every cell a `tool_assertions` column can hold that the rule has to read. */
const CHECKS: { label: string; stored: unknown; tally: { failed: number; total: number } | null }[] = [
  { label: 'SQL NULL', stored: Prisma.DbNull, tally: null },
  { label: 'JSON null', stored: Prisma.JsonNull, tally: null },
  { label: 'an empty array', stored: [], tally: null },
  {
    label: 'one passed',
    stored: [{ expression: 'a', actualValue: 1, outcome: 'passed' }],
    tally: { failed: 0, total: 1 },
  },
  {
    label: 'one passed, one failed',
    stored: [
      { expression: 'a', actualValue: 1, outcome: 'passed' },
      { expression: 'b', actualValue: 9, outcome: 'failed' },
    ],
    tally: { failed: 1, total: 2 },
  },
];

describe('needsAttentionSql', () => {
  it('agrees with needsAttention on every status × verdict × checks combination', async () => {
    const expected = new Map<string, { needs: boolean; status: RunStatus }>();
    for (const status of STATUSES) {
      for (const verdict of VERDICTS) {
        for (const checks of CHECKS) {
          const id = await seedRun({
            createdAt: inDay(6),
            status,
            verdict,
            toolAssertions: checks.stored,
          });
          expected.set(id, {
            needs: needsAttention({ status, verdict, checks: checks.tally }),
            status,
          });
        }
      }
    }
    expect(expected.size).toBe(6 * 4 * 5);

    // (a) The predicate itself, row by row. `toBe(false)` rather than a
    //     truthiness check: SQL has three truth values, and a clause that
    //     answers NULL for a run with no verdict is neither true nor false.
    const { rows } = await pool.query<{ id: string; needs: boolean | null }>(
      `SELECT r.id, ${needsAttentionSql('r')} AS needs FROM run r`,
    );
    expect(rows).toHaveLength(expected.size);
    for (const row of rows) {
      expect(row.needs, `run ${row.id}: ${JSON.stringify(expected.get(row.id))}`).toBe(
        expected.get(row.id)!.needs,
      );
    }

    // (b) The same rule through the day counts: total, successful and
    //     needsAttention for the one day every run landed in.
    const all = [...expected.values()];
    const result = await repo.read(scope(), window);
    expect(result.days[6]).toEqual({
      total: all.length,
      successful: all.filter((r) => r.status === 'complete' && !r.needs).length,
      needsAttention: all.filter((r) => r.needs).length,
    });
    expect(result.days.slice(0, 6)).toEqual(Array(6).fill({ total: 0, successful: 0, needsAttention: 0 }));
  });
});

describe('ActivityRepository.read', () => {
  it('lists a test only when its latest run in the window needs attention', async () => {
    const a = await newTest('test-a');
    const b = await newTest('test-b');
    // Start and arrival disagree on ORDER here: each test's older arrival is
    // given the later start. (In life the same disagreement comes the other
    // way round — the NEWER arrival is a late upload of an EARLIER load test —
    // but either way only the order matters.) So "latest" read off the start
    // instead of the arrival picks the other run of each and gets both wrong.
    const startedLater = { startedAt: ago(1 * HOUR), toolStartedAt: ago(1 * HOUR) };
    await failedRun({ testId: a.id, createdAt: ago(5 * HOUR), ...startedLater });
    await seedRun({ testId: a.id, createdAt: ago(2 * HOUR) });
    await seedRun({ testId: b.id, createdAt: ago(5 * HOUR), ...startedLater });
    const bFailed = await failedRun({ testId: b.id, createdAt: ago(2 * HOUR) });

    const { attention, attentionTotal } = await repo.read(scope(), window);

    expect(attentionTotal).toBe(1);
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({
      test: { slug: 'test-b', name: 'test-b' },
      project: { slug: 'checkout', name: 'Checkout' },
      run: { id: bFailed, status: 'failed', verdict: null },
    });
  });

  it('carries the run fields the row renders, with startedAt from the load test when it has one', async () => {
    const t = await newTest('test-a');
    const id = await seedRun({
      testId: t.id,
      createdAt: ago(3 * HOUR),
      toolStartedAt: ago(4 * HOUR),
      status: 'complete',
      verdict: 'failed',
      runNumber: 7,
      durationMs: 61_000,
      simulation: 'example.TestA',
      toolAssertions: [{ expression: 'x', actualValue: 2, outcome: 'failed' }],
    });
    // And one with no tool start, which falls back to the platform's own.
    const u = await newTest('test-u');
    const fallback = await failedRun({ testId: u.id, createdAt: ago(2 * HOUR) });

    const { attention } = await repo.read(scope(), window);
    const byId = new Map(attention.map((row) => [row.run.id, row.run]));

    expect(byId.get(id)).toEqual({
      id,
      runNumber: 7,
      status: 'complete',
      verdict: 'failed',
      startedAt: ago(4 * HOUR),
      durationMs: 61_000,
      simulation: 'example.TestA',
      toolAssertions: [{ expression: 'x', actualValue: 2, outcome: 'failed' }],
    });
    expect(byId.get(fallback)).toMatchObject({
      runNumber: null,
      verdict: null,
      durationMs: null,
      simulation: null,
      toolAssertions: null,
      startedAt: new Date(ago(2 * HOUR).getTime() - 60_000),
    });
  });

  it('lists each failed upload with no test as its own row, and not an in-flight one', async () => {
    // The older arrival STARTED later, so the newest-first order is pinned to
    // arrival: sorted by start, `one` would come first.
    const one = await failedRun({ createdAt: ago(3 * HOUR), startedAt: ago(1 * HOUR), toolStartedAt: ago(1 * HOUR) });
    const two = await failedRun({ createdAt: ago(2 * HOUR) });
    await seedRun({ createdAt: ago(1 * HOUR), status: 'pending', verdict: null });

    const { attention, attentionTotal } = await repo.read(scope(), window);

    expect(attentionTotal).toBe(2);
    expect(attentionIds(attention)).toEqual([two, one]);
    expect(attention.map((row) => row.test)).toEqual([null, null]);
  });

  it('bounds the attention window at the instant it is handed, inclusive, and at its own end', async () => {
    const inside = await newTest('inside');
    const outside = await newTest('outside');
    const afterwards = await newTest('afterwards');
    // The first instant of the window is in it, and the millisecond before is
    // not — whatever the 168 hours before now would have said about it. And
    // it is ARRIVAL that is windowed: the run inside STARTED a day before the
    // window, and the run outside started an hour ago, so a window on the
    // start would have it the other way round.
    const listed = await failedRun({
      testId: inside.id,
      createdAt: boundaries[0]!,
      startedAt: new Date(boundaries[0]!.getTime() - DAY),
      toolStartedAt: new Date(boundaries[0]!.getTime() - DAY),
    });
    await failedRun({
      testId: outside.id,
      createdAt: new Date(boundaries[0]!.getTime() - 1),
      startedAt: ago(1 * HOUR),
      toolStartedAt: ago(1 * HOUR),
    });
    // The window ends at the instant the caller named, so a run that arrived
    // after it is not in it, however failed it is.
    await failedRun({ testId: afterwards.id, createdAt: new Date(now.getTime() + HOUR) });

    const { attention, attentionTotal } = await repo.read(scope(), window);

    expect(attentionTotal).toBe(1);
    expect(attentionIds(attention)).toEqual([listed]);
  });

  it('reports the true total beyond the limit', async () => {
    expect(ACTIVITY_ATTENTION_LIMIT).toBe(20);
    const ids: string[] = [];
    for (let i = 0; i < 22; i += 1) {
      const t = await newTest(`t-${String(i).padStart(2, '0')}`);
      // Run `i` arrived `i + 1` hours ago, so t-00 is the newest.
      ids.push(await failedRun({ testId: t.id, createdAt: ago((i + 1) * HOUR) }));
    }

    const { attention, attentionTotal } = await repo.read(scope(), window);

    expect(attention).toHaveLength(20);
    expect(attentionTotal).toBe(22);
    expect(attentionIds(attention)).toEqual(ids.slice(0, 20));
  });

  it('counts running regardless of the window', async () => {
    await seedRun({ createdAt: ago(30 * DAY), status: 'running', verdict: null });
    await seedRun({ createdAt: ago(1 * HOUR), status: 'pending', verdict: null });
    await seedRun({ createdAt: ago(1 * HOUR), status: 'complete' });

    const { running } = await repo.read(scope(), window);

    expect(running).toBe(1);
  });

  it('orders byProject by runs, then name, and keeps five', async () => {
    const counts: [string, string, number][] = [
      ['delta', 'Delta', 3],
      ['bravo', 'Bravo', 2],
      ['alpha', 'Alpha', 2],
      ['echo', 'Echo', 1],
      ['charlie', 'Charlie', 1],
      ['foxtrot', 'Foxtrot', 1],
    ];
    for (const [slug, name, runs] of counts) {
      const p = await newProject(slug, name);
      for (let i = 0; i < runs; i += 1) {
        await seedRun({ projectId: p.id, createdAt: inDay(6 - i) });
      }
    }
    // A run that arrived before the first boundary belongs to no glance day,
    // so it belongs to no project's count either.
    const old = await newProject('golf', 'Golf');
    await seedRun({ projectId: old.id, createdAt: ago(10 * DAY) });

    const { byProject } = await repo.read(scope(), window);

    expect(byProject).toEqual([
      { project: { slug: 'delta', name: 'Delta' }, runs: 3 },
      { project: { slug: 'alpha', name: 'Alpha' }, runs: 2 },
      { project: { slug: 'bravo', name: 'Bravo' }, runs: 2 },
      { project: { slug: 'charlie', name: 'Charlie' }, runs: 1 },
      { project: { slug: 'echo', name: 'Echo' }, runs: 1 },
    ]);
  });

  it('puts a run in the day whose half-open interval holds it', async () => {
    await seedRun({ createdAt: boundaries[2]! });
    await seedRun({ createdAt: new Date(boundaries[3]!.getTime() - 1) });
    // Exactly the last boundary is tomorrow's first instant: counted nowhere.
    await seedRun({ createdAt: boundaries[7]! });

    const { days, byProject } = await repo.read(scope(), window);

    expect(days.map((d) => d.total)).toEqual([0, 0, 2, 0, 0, 0, 0]);
    expect(byProject).toEqual([{ project: { slug: 'checkout', name: 'Checkout' }, runs: 2 }]);
  });

  it('never counts another org’s runs, and a token sees its own project', async () => {
    const mine = await newTest('mine');
    await seedRun({ testId: mine.id, createdAt: ago(5 * HOUR) });
    const mineFailed = await failedRun({ testId: mine.id, createdAt: ago(4 * HOUR), runNumber: 1 });
    await seedRun({ createdAt: ago(40 * DAY), status: 'running', verdict: null });
    const before = await repo.read(scope(), window);

    // Another organisation with a project and runs in EVERY bucket, including
    // the newest arrival in the database.
    const other = await prisma.org.create({ data: { slug: 'other', name: 'Other' } });
    const otherProject = await newProject('theirs', 'Theirs', other.id);
    const theirs = await newTest('theirs-test', { orgId: other.id, projectId: otherProject.id });
    const foreign = { orgId: other.id, projectId: otherProject.id };
    await seedRun({ ...foreign, testId: theirs.id, createdAt: ago(1 * HOUR) });
    await failedRun({ ...foreign, testId: theirs.id, createdAt: ago(30_000) });
    await failedRun({ ...foreign, createdAt: ago(40_000) });
    await seedRun({ ...foreign, createdAt: ago(40 * DAY), status: 'running', verdict: null });

    expect(await repo.read(scope(), window)).toEqual(before);

    // A token is minted against one project of its organisation. The second
    // project's failed run is the newest arrival in the whole org.
    const second = await newProject('search', 'Search');
    const secondTest = await newTest('second', { projectId: second.id });
    await failedRun({ projectId: second.id, testId: secondTest.id, createdAt: ago(10_000) });
    await seedRun({ projectId: second.id, createdAt: ago(20 * DAY), status: 'running', verdict: null });

    const token = await repo.read({ orgId, projectId }, window);
    // Summed over the days: which glance day an hour-old run falls in depends
    // on what time this file runs, and what is being asserted is who is counted.
    const sum = (key: 'total' | 'successful' | 'needsAttention') =>
      token.days.reduce((n, d) => n + d[key], 0);
    expect([sum('total'), sum('successful'), sum('needsAttention')]).toEqual([2, 1, 1]);
    expect(token.running).toBe(1);
    expect(token.byProject).toEqual([{ project: { slug: 'checkout', name: 'Checkout' }, runs: 2 }]);
    expect(attentionIds(token.attention)).toEqual([mineFailed]);
    expect(token.attentionTotal).toBe(1);
    expect(token.lastRun?.project.slug).toBe('checkout');

    // And the session, which is org-wide, sees both projects.
    const session = await repo.read(scope(), window);
    expect(session.running).toBe(2);
    expect(session.attentionTotal).toBe(2);
    expect(session.lastRun?.project.slug).toBe('search');
  });

  it('answers lastRun by arrival with no window', async () => {
    const t = await newTest('old-test');
    // Start and arrival disagree on order: the older arrival is given the later
    // start (in life, the newer arrival would be a late upload of an earlier
    // load test — only the order matters), so "last" read off the start would
    // name it instead.
    await seedRun({
      testId: t.id,
      createdAt: ago(61 * DAY),
      startedAt: ago(59 * DAY),
      toolStartedAt: ago(59 * DAY),
      runNumber: 1,
    });
    const newest = await seedRun({
      testId: t.id,
      createdAt: ago(60 * DAY),
      toolStartedAt: ago(60 * DAY + 2 * HOUR),
      runNumber: 2,
    });

    const result = await repo.read(scope(), window);

    expect(result.days.every((d) => d.total === 0 && d.successful === 0 && d.needsAttention === 0)).toBe(true);
    expect(result.running).toBe(0);
    expect(result.attention).toEqual([]);
    expect(result.attentionTotal).toBe(0);
    expect(result.byProject).toEqual([]);
    expect(result.lastRun).toEqual({
      id: newest,
      runNumber: 2,
      test: { slug: 'old-test', name: 'old-test' },
      project: { slug: 'checkout', name: 'Checkout' },
      startedAt: ago(60 * DAY + 2 * HOUR),
    });
  });

  it('answers lastRun with a null test for a run no test claims, and null for an empty org', async () => {
    expect((await repo.read(scope(), window)).lastRun).toBeNull();

    const id = await seedRun({ createdAt: ago(HOUR) });
    const { lastRun } = await repo.read(scope(), window);
    expect(lastRun).toMatchObject({ id, test: null, runNumber: null });
  });

  it('refuses a boundary list that is not eight instants', async () => {
    await expect(
      repo.read(scope(), { ...window, dayBoundaries: boundaries.slice(0, 7) }),
    ).rejects.toThrow(/8 day boundaries/);
  });
});

describe('the day counts', () => {
  /**
   * THE PLAN, NOT JUST THE ROWS — every row assertion above passes against a
   * sequential scan, so nothing else can tell the new index from a decorative
   * one. `GET /v1/activity` is the first thing `AuthGate` asks on every cold
   * load and nothing served an organisation-wide arrival range before it.
   * `SET LOCAL` inside a transaction because Prisma hands out a pooled
   * connection and a bare `SET` would leak onto whichever test drew it next.
   *
   * BUILT FROM THE SAME FUNCTION `read` builds from, so a change to the real
   * query is a change to this one.
   */
  it('is served by run_org_id_created_at_idx', async () => {
    await seedRun({ createdAt: inDay(6) });
    const { sql, params } = activityDaysQuery(scope(), boundaries);

    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN (COSTS OFF) ${sql}`, ...params);
    });
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');

    // Guard first: EXPLAIN really did return a plan.
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('run_org_id_created_at_idx');
    expect(text).not.toContain('Seq Scan on run');
    // NAMING THE INDEX IS NOT ENOUGH, and it was measured not to be: a LEFT
    // JOIN of the runs onto the seven days names this index, takes only the
    // org out of it, and applies each day's range as a join filter over every
    // run the org has ever had, seven times. The RANGE has to be in the index
    // condition, which is what makes a day cost its own runs and not the
    // organisation's whole history.
    expect(text).toMatch(/Index Cond:[^\n]*created_at/);
  });

  /**
   * A NON-ADMIN SESSION ASKS THE SAME QUESTION WITH ONE MORE PREDICATE — its
   * projects, as `project_id = ANY(...)` — and that predicate is a second way
   * in for the planner: `run_project_id_started_at_idx` leads on project_id.
   * A plan that took it would hold the project in its index condition and
   * apply each day's range as a filter over every run those projects have
   * had, the shape the case above refuses for the org. So the member-scoped
   * statement is held to the same requirement: the day's range in an index
   * condition, whichever index carries it.
   *
   * ON A HISTORY, WITH FRESH STATISTICS — NOT ONE RUN AFTER A TRUNCATE. With
   * a single row both indexes cost the same, and the planner's pick follows
   * whatever `pg_statistic` an earlier ANALYZE left behind (TRUNCATE does not
   * clear it): measured, the same one-run case passed on one run of this file
   * and planned `run_project_id_started_at_idx` with the range as a Filter on
   * the next, with an autoanalyze between the two. Two projects' worth of
   * runs over sixty days, ANALYZEd, is the question this guard is about — a
   * member of a project with a past — and on it the planner reads the day
   * from `run_org_id_created_at_idx`. The rows and the column statistics are
   * rolled back; the row estimate ANALYZE writes into `pg_class` in place is
   * not, and the next TRUNCATE resets it.
   */
  it('keeps the day range in an index condition for a member-scoped session', async () => {
    const other = await newProject('other', 'Other');
    const rolledBack = new Error('roll back the seeded history and its statistics');
    let text = '';
    await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO run (id, org_id, project_id, status, verdict, tool, bundle_key,
                            bundle_sha256, bundle_bytes, created_at, started_at, started_on,
                            engine_options)
           SELECT gen_random_uuid(), $1::uuid, ($2::uuid[])[1 + g % 2], 'complete', 'passed',
                  'gatling', 'runs/history/' || g, repeat('a', 64), 1,
                  now() - (g % 60) * interval '1 day' - (g % 24) * interval '1 hour',
                  now() - (g % 60) * interval '1 day' - (g % 24) * interval '1 hour',
                  (now() - (g % 60) * interval '1 day')::date, '{}'::jsonb
             FROM generate_series(1, 400) AS g`,
          orgId,
          [projectId, other.id],
        );
        await tx.$executeRawUnsafe('ANALYZE run');
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        const { sql, params } = activityDaysQuery({ orgId, projectIds: [projectId] }, boundaries);
        const plan = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
          `EXPLAIN (COSTS OFF) ${sql}`,
          ...params,
        );
        text = plan.map((row) => row['QUERY PLAN']).join('\n');
        throw rolledBack;
      })
      .catch((err: unknown) => {
        if (err !== rolledBack) throw err;
      });

    // Guard first: EXPLAIN really did return a plan, and the member predicate
    // is in it — otherwise this is the case above again.
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/project_id = ANY/);
    expect(text).not.toContain('Seq Scan on run');
    // The range in THIS index's own condition, the line straight after it.
    // "created_at in some Index Cond" is not enough, measured: with this index
    // dropped the planner took run_status_created_at_idx, then (that dropped
    // too) run_test_id_created_at_idx, each with the range as a condition on
    // its SECOND column — checked against every entry of the index rather
    // than seeking to one day — and the loose pattern accepts both plans.
    expect(text).toMatch(/run_org_id_created_at_idx[^\n]*\n\s*Index Cond:[^\n]*created_at/);
  });
});
