import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  createPrisma,
  MetricWriter,
  RecomputeRepository,
  RunRepository,
} from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

const STARTED_AT = new Date('2026-08-07T10:00:00Z');
const STARTED_ON = new Date('2026-08-07T00:00:00Z');

let orgId: string;
let projectId: string;

interface SeedOptions {
  statsMethod?: 'estimated' | 'exact-v1';
  status?: string;
  /** Defaults to the file's own `checkout` project. */
  projectId?: string;
  orgId?: string;
}

interface StatRowOptions extends SeedOptions {
  /** A legacy DDSketch blob (true) or none (false). Defaults to true. */
  sketch?: boolean;
  /** Defaults to the legacy 'sparse-ms-v1'. */
  histogramKind?: string | null;
}

/**
 * A run with NO statistics rows. `stats_method` is set with a raw UPDATE
 * because the column's default (what every insert gets) is 'exact-v1', and a
 * legacy run is exactly the one whose label has to be written by hand here.
 */
async function seedRun(opts: SeedOptions = {}): Promise<string> {
  const run = await prisma.run.create({
    data: {
      orgId: opts.orgId ?? orgId,
      projectId: opts.projectId ?? projectId,
      status: opts.status ?? 'complete',
      tool: 'gatling',
      bundleKey: 'k',
      bundleSha256: 'a'.repeat(64),
      bundleBytes: BigInt(1),
      startedAt: STARTED_AT,
      startedOn: STARTED_ON,
      engineOptions: {},
    },
  });
  await pool.query(`UPDATE run SET stats_method = $2 WHERE id = $1`, [
    run.id,
    opts.statsMethod ?? 'exact-v1',
  ]);
  return run.id;
}

async function seedRunWithStatRow(opts: StatRowOptions = {}): Promise<string> {
  const runId = await seedRun({ statsMethod: 'estimated', ...opts });
  const { rows } = await pool.query<{ org_id: string; project_id: string }>(
    `SELECT org_id, project_id FROM run WHERE id = $1`,
    [runId],
  );
  const owner = rows[0]!;
  const sketch = opts.sketch ?? true;
  await pool.query(
    `INSERT INTO run_stat
       (id, run_id, org_id, project_id, scope, name, family,
        count, ok_count, ko_count, error_rate,
        min_ms, max_ms, mean_ms, stddev_ms, throughput_rps,
        percentiles, sketch, sketch_kind, histogram_ok, histogram_ko, histogram_kind)
     VALUES (gen_random_uuid(), $1, $2, $3, 'run', '', 'response_time',
             1, 1, 0, 0, 10, 10, 10, 0, 1,
             '{}'::jsonb, $4, $5, $6, NULL, $7)`,
    [
      runId,
      owner.org_id,
      owner.project_id,
      sketch ? Buffer.from([1]) : null,
      sketch ? 'ddsketch-v1' : null,
      Buffer.from([1]),
      opts.histogramKind === undefined ? 'sparse-ms-v1' : opts.histogramKind,
    ],
  );
  return runId;
}

beforeEach(async () => {
  await resetDatabase(pool);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  orgId = org.id;
  projectId = project.id;
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('RecomputeRepository', () => {
  it('selects a run labelled estimated, and one labelled exact whose rows are still legacy', async () => {
    const a = await seedRunWithStatRow({ statsMethod: 'estimated', sketch: true, histogramKind: 'sparse-ms-v1' });
    const b = await seedRunWithStatRow({ statsMethod: 'exact-v1', sketch: true, histogramKind: 'sparse-ms-v1' });
    const c = await seedRunWithStatRow({ statsMethod: 'exact-v1', sketch: false, histogramKind: 'sparse-ms-v2' });
    const ids = await new RecomputeRepository(pool).candidates({}, 100);
    expect(ids.sort()).toEqual([a, b].sort());
    expect(ids).not.toContain(c);
  });

  it('skips a failed run, a run with no stat rows and a run marked unrecoverable', async () => {
    const failed = await seedRunWithStatRow({ statsMethod: 'estimated', status: 'failed' });
    const noRows = await seedRun({ statsMethod: 'estimated', status: 'complete' }); // no run_stat row
    const lost = await seedRunWithStatRow({ statsMethod: 'estimated' });
    await new RecomputeRepository(pool).markFailed(lost, 'raw_log_missing');
    const ids = await new RecomputeRepository(pool).candidates({}, 100);
    expect(ids).not.toContain(failed);
    expect(ids).not.toContain(noRows);
    expect(ids).not.toContain(lost);
    // A positive beside the absences: a repository that answers nothing at
    // all satisfies all three of them.
    const kept = await seedRunWithStatRow({ statsMethod: 'estimated' });
    expect(await new RecomputeRepository(pool).candidates({}, 100)).toEqual([kept]);
  });

  it('counts progress per org: total runs with statistics, remaining candidates, failed', async () => {
    await seedRunWithStatRow({ statsMethod: 'exact-v1', sketch: false, histogramKind: 'sparse-ms-v2' });
    await seedRunWithStatRow({ statsMethod: 'estimated' });
    const lost = await seedRunWithStatRow({ statsMethod: 'estimated' });
    await new RecomputeRepository(pool).markFailed(lost, 'raw_log_missing');
    expect(await new RecomputeRepository(pool).progress(orgId)).toEqual({ total: 3, remaining: 1, failed: 1 });
  });

  it('counts an exact-labelled run over legacy rows, marked failed, as failed', async () => {
    // Never recomputed again, so it keeps its legacy figures whatever its
    // label says. A count that filtered failures by label would lose it from
    // remaining (the error excludes it) AND from failed.
    const mislabelled = await seedRunWithStatRow({ statsMethod: 'exact-v1', sketch: true, histogramKind: 'sparse-ms-v1' });
    await new RecomputeRepository(pool).markFailed(mislabelled, 'parse_failed');
    expect(await new RecomputeRepository(pool).progress(orgId)).toEqual({ total: 1, remaining: 0, failed: 1 });
  });

  it('selects an exact-labelled run on either half of the legacy-format test alone', async () => {
    // Each half of the format branch, with the other half false, so neither
    // can be dropped without a case going red.
    const legacyKindOnly = await seedRunWithStatRow({ statsMethod: 'exact-v1', sketch: false, histogramKind: 'sparse-ms-v1' });
    const sketchOnly = await seedRunWithStatRow({ statsMethod: 'exact-v1', sketch: true, histogramKind: 'sparse-ms-v2' });
    // A NULL kind is legacy too: an equality test would read it as unknown
    // and skip the run, which is why the predicate says IS DISTINCT FROM.
    const nullKind = await seedRunWithStatRow({ statsMethod: 'exact-v1', sketch: false, histogramKind: null });
    const exact = await seedRunWithStatRow({ statsMethod: 'exact-v1', sketch: false, histogramKind: 'sparse-ms-v2' });
    const ids = await new RecomputeRepository(pool).candidates({}, 100);
    expect(ids.sort()).toEqual([legacyKindOnly, sketchOnly, nullKind].sort());
    expect(ids).not.toContain(exact);
  });

  it('filters candidates by project slug and by run id', async () => {
    const other = await prisma.project.create({
      data: { orgId, slug: 'payments', name: 'Payments', settings: {} },
    });
    const inCheckout = await seedRunWithStatRow({ statsMethod: 'estimated' });
    const inPayments = await seedRunWithStatRow({ statsMethod: 'estimated', projectId: other.id });
    const repo = new RecomputeRepository(pool);

    // Unfiltered first, so the narrowed answers below cannot pass against a
    // repository that only ever finds one run.
    expect((await repo.candidates({}, 100)).sort()).toEqual([inCheckout, inPayments].sort());
    expect(await repo.candidates({ projectSlug: 'checkout' }, 100)).toEqual([inCheckout]);
    expect(await repo.candidates({ projectSlug: 'payments' }, 100)).toEqual([inPayments]);
    expect(await repo.candidates({ runId: inPayments }, 100)).toEqual([inPayments]);
    expect(await repo.candidates({ runId: inCheckout }, 100)).toEqual([inCheckout]);
  });

  it('filters candidates by org', async () => {
    const otherOrg = await prisma.org.create({ data: { slug: 'globex', name: 'Globex' } });
    const otherProject = await prisma.project.create({
      data: { orgId: otherOrg.id, slug: 'checkout', name: 'Checkout', settings: {} },
    });
    const mine = await seedRunWithStatRow({ statsMethod: 'estimated' });
    const theirs = await seedRunWithStatRow({
      statsMethod: 'estimated',
      orgId: otherOrg.id,
      projectId: otherProject.id,
    });
    const repo = new RecomputeRepository(pool);
    expect(await repo.candidates({ orgId }, 100)).toEqual([mine]);
    expect(await repo.candidates({ orgId: otherOrg.id }, 100)).toEqual([theirs]);
  });

  it('records the reason a run cannot be recomputed, and the run reads it back', async () => {
    const lost = await seedRunWithStatRow({ statsMethod: 'estimated' });
    const runs = new RunRepository(prisma);
    const before = await runs.findByIdUnscoped(lost);
    expect(before?.recomputeError).toBeNull();
    expect(before?.recomputedAt).toBeNull();

    await new RecomputeRepository(pool).markFailed(lost, 'checksum_mismatch');
    expect((await runs.findByIdUnscoped(lost))?.recomputeError).toBe('checksum_mismatch');

    // The list builds its records from hand-written SQL, so it has to name
    // the columns itself; a select that forgot them reads undefined here.
    const { items } = await runs.list({ orgId }, { limit: 10 });
    const listed = items.find((i) => i.id === lost);
    expect(listed?.recomputeError).toBe('checksum_mismatch');
    expect(listed?.recomputedAt).toBeNull();
  });

  it('refuses a recompute error outside the three it knows', async () => {
    const run = await seedRunWithStatRow({ statsMethod: 'estimated' });
    await expect(
      pool.query(`UPDATE run SET recompute_error = 'gone' WHERE id = $1`, [run]),
    ).rejects.toThrow(/run_recompute_error_check/);
  });

  it('reads a run\'s verdict changes back in the order they were recorded', async () => {
    const run = await seedRunWithStatRow({ statsMethod: 'estimated' });
    const repo = new RecomputeRepository(pool);
    expect(await repo.verdictChanges(run)).toEqual([]);

    const snapshot = { metric: 'p95', comparator: 'lte', threshold: 800 };
    await pool.query(
      `INSERT INTO run_verdict_change
         (id, run_id, org_id, project_id, rule_snapshot, old_outcome, new_outcome,
          old_value, new_value, old_verdict, new_verdict, changed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'passed', 'failed', 790.5, 812, 'passed', 'failed',
               '2026-10-16T10:00:00Z'),
              (gen_random_uuid(), $1, $2, $3, $4, 'not_applicable', 'passed', NULL, 3, 'passed', 'failed',
               '2026-10-16T10:00:01Z')`,
      [run, orgId, projectId, JSON.stringify(snapshot)],
    );
    const changes = await repo.verdictChanges(run);
    expect(changes).toEqual([
      {
        ruleSnapshot: snapshot,
        oldOutcome: 'passed',
        newOutcome: 'failed',
        oldValue: 790.5,
        newValue: 812,
        oldVerdict: 'passed',
        newVerdict: 'failed',
        changedAt: new Date('2026-10-16T10:00:00Z'),
      },
      {
        ruleSnapshot: snapshot,
        oldOutcome: 'not_applicable',
        newOutcome: 'passed',
        oldValue: null,
        newValue: 3,
        oldVerdict: 'passed',
        newVerdict: 'failed',
        changedAt: new Date('2026-10-16T10:00:01Z'),
      },
    ]);

    // The table hangs off run with ON DELETE CASCADE: a deleted run takes its
    // history with it rather than leaving rows nothing can reach.
    await prisma.run.delete({ where: { id: run } });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM run_verdict_change`);
    expect(rows[0].n).toBe(0);
  });
});

describe('MetricWriter#deleteForRun', () => {
  const METRIC_TABLES = [
    'run_stat',
    'run_error',
    'run_series_bucket',
    'run_user_bucket',
    'run_error_bucket',
    'run_assertion',
  ] as const;

  /** One row in each of the six tables for this run, inserted directly. */
  async function seedEveryTable(runId: string): Promise<void> {
    await pool.query(
      `INSERT INTO run_stat
         (id, run_id, org_id, project_id, scope, name, family, count, ok_count, ko_count,
          error_rate, min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles)
       VALUES (gen_random_uuid(), $1, $2, $3, 'run', '', 'response_time', 1, 1, 0, 0, 1, 1, 1, 0, 1, '{}'::jsonb)`,
      [runId, orgId, projectId],
    );
    await pool.query(
      `INSERT INTO run_error (id, run_id, org_id, project_id, message, count, scope, name, is_other)
       VALUES (gen_random_uuid(), $1, $2, $3, 'boom', 1, 'run', '', false)`,
      [runId, orgId, projectId],
    );
    // The partition key is bound as the same Date the writer binds, so the
    // row lands on the day deleteForRun will address whatever this machine's
    // zone is.
    await pool.query(
      `INSERT INTO run_series_bucket
         (run_started_on, run_id, org_id, project_id, scope, name, family, start_offset_ms,
          started_count, ended_count, ok_count, ko_count, min_ms, max_ms, mean_ms, percentiles)
       VALUES ($4, $1, $2, $3, 'run', '', 'response_time', 0, 1, 1, 1, 0, 1, 1, 1, '{}'::jsonb)`,
      [runId, orgId, projectId, STARTED_ON],
    );
    await pool.query(
      `INSERT INTO run_user_bucket
         (run_started_on, run_id, org_id, project_id, scenario, start_offset_ms, started, ended, max_concurrent)
       VALUES ($4, $1, $2, $3, 'S', 0, 1, 1, 1)`,
      [runId, orgId, projectId, STARTED_ON],
    );
    await pool.query(
      `INSERT INTO run_error_bucket
         (run_started_on, run_id, org_id, project_id, start_offset_ms, message, is_other, count, bucket_width_ms)
       VALUES ($4, $1, $2, $3, 0, 'boom', false, 1, 1000)`,
      [runId, orgId, projectId, STARTED_ON],
    );
    await pool.query(
      `INSERT INTO run_assertion
         (id, run_id, org_id, project_id, rule_id, rule_snapshot, outcome, actual_value, message)
       VALUES (gen_random_uuid(), $1, $2, $3, gen_random_uuid(), '{}'::jsonb, 'passed', 1, 'ok')`,
      [runId, orgId, projectId],
    );
  }

  async function countsFor(runId: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of METRIC_TABLES) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE run_id = $1`,
        [runId],
      );
      out[table] = rows[0]!.n;
    }
    return out;
  }

  it('removes every metric and assertion row of that run and no other', async () => {
    const first = await seedRun();
    const second = await seedRun();
    await seedEveryTable(first);
    await seedEveryTable(second);
    const one = Object.fromEntries(METRIC_TABLES.map((t) => [t, 1]));
    expect(await countsFor(first)).toEqual(one);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await new MetricWriter().deleteForRun(client, { runId: first, runStartedOn: STARTED_ON });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    expect(await countsFor(first)).toEqual(Object.fromEntries(METRIC_TABLES.map((t) => [t, 0])));
    expect(await countsFor(second)).toEqual(one);
  });
});

describe('RecomputeRepository#candidatePage', () => {
  async function at(runId: string, createdAt: string): Promise<void> {
    await pool.query(`UPDATE run SET created_at = $2::timestamptz WHERE id = $1`, [runId, createdAt]);
  }

  it('walks every candidate exactly once, newest first, across pages that split a shared created_at', async () => {
    const newest = await seedRunWithStatRow();
    const tieA = await seedRunWithStatRow();
    const tieB = await seedRunWithStatRow();
    const older = await seedRunWithStatRow();
    const oldest = await seedRunWithStatRow();
    const notACandidate = await seedRunWithStatRow({ statsMethod: 'exact-v1', sketch: false, histogramKind: 'sparse-ms-v2' });
    await at(newest, '2026-08-07T10:00:03.000Z');
    // Same millisecond: only the id orders them, and limit 2 puts the page
    // boundary between them.
    await at(tieA, '2026-08-07T10:00:02.000Z');
    await at(tieB, '2026-08-07T10:00:02.000Z');
    await at(notACandidate, '2026-08-07T10:00:01.500Z');
    await at(older, '2026-08-07T10:00:01.000Z');
    await at(oldest, '2026-08-07T10:00:00.000Z');

    const repo = new RecomputeRepository(pool);
    const pages: string[][] = [];
    let page = await repo.candidatePage({}, 2);
    pages.push(page.ids);
    while (page.next) {
      page = await repo.candidatePage({}, 2, page.next);
      pages.push(page.ids);
      expect(pages.length).toBeLessThan(10); // a cursor that never advances must not hang the suite
    }

    const walked = pages.flat();
    const [tieFirst, tieSecond] = [tieA, tieB].sort().reverse();
    expect(walked).toEqual([newest, tieFirst, tieSecond, older, oldest]);
    expect(new Set(walked).size).toBe(walked.length);
    // The tie really was split across a page boundary, which is the case a
    // cursor on created_at alone gets wrong.
    expect(pages[0]).toEqual([newest, tieFirst]);
    expect(pages[1]).toEqual([tieSecond, older]);
    expect(pages[2]).toEqual([oldest]);
  });

  it('answers next = null for a page that came back short, and for no candidates at all', async () => {
    const repo = new RecomputeRepository(pool);
    expect(await repo.candidatePage({}, 2)).toEqual({ ids: [], next: null });
    const only = await seedRunWithStatRow();
    expect(await repo.candidatePage({}, 2)).toEqual({ ids: [only], next: null });
  });
});
