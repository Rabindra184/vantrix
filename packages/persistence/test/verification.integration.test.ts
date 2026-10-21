import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  createPrisma,
  readStoredFigures,
  VerificationRepository,
  type FigureMismatch,
} from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

const STARTED_AT = new Date('2026-08-07T10:00:00Z');
const STARTED_ON = new Date('2026-08-07T00:00:00Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;

let orgId: string;
let projectId: string;
let otherOrgId: string;
let otherProjectId: string;

interface SeedOptions {
  status?: string;
  orgId?: string;
  projectId?: string;
  /** Defaults to true: a run with one run_stat row. */
  stats?: boolean;
  createdAt?: Date;
  ingestedAt?: Date | null;
  /** Defaults to a real-looking digest; '' is a live run that never assembled one. */
  bundleSha256?: string;
  /** Defaults to the column's own default, 'exact-v1'. */
  statsMethod?: 'estimated' | 'exact-v1';
}

async function seedRun(opts: SeedOptions = {}): Promise<string> {
  const run = await prisma.run.create({
    data: {
      orgId: opts.orgId ?? orgId,
      projectId: opts.projectId ?? projectId,
      status: opts.status ?? 'complete',
      tool: 'gatling',
      bundleKey: `runs/${Math.random().toString(36).slice(2)}.tgz`,
      bundleSha256: opts.bundleSha256 ?? 'a'.repeat(64),
      bundleBytes: BigInt(1),
      startedAt: STARTED_AT,
      startedOn: STARTED_ON,
      engineOptions: {},
      statsMethod: opts.statsMethod,
      ingestedAt: opts.ingestedAt === undefined ? new Date() : opts.ingestedAt,
      // Prisma reads undefined as not provided, so the column default applies.
      createdAt: opts.createdAt,
    },
  });
  if (opts.stats ?? true) {
    await insertStat(run.id, opts.orgId ?? orgId, opts.projectId ?? projectId, 'run', '');
  }
  return run.id;
}

/**
 * One stat row in the exact engine's format (sparse-ms-v2, no sketch), so a
 * seeded run reads as exact by NOT_EXACT_RUN_SQL unless its label says
 * estimated — the shape every run ingested since exact statistics carries.
 */
async function insertStat(runId: string, org: string, project: string, scope: string, name: string): Promise<void> {
  await pool.query(
    `INSERT INTO run_stat
       (id, run_id, org_id, project_id, scope, name, family,
        count, ok_count, ko_count, error_rate,
        min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles, histogram_kind)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'response_time',
             3, 2, 1, 0.3333333333333333, 10, 30, 20, 8.16496580927726, 1.5,
             '{"p50": 20, "p99.9": 30}'::jsonb, 'sparse-ms-v2')`,
    [runId, org, project, scope, name],
  );
}

/** A verified row at `version` — what the verifier leaves on a run it checked. */
async function verified(id: string, version = 1): Promise<void> {
  await new VerificationRepository(pool).record(id, {
    status: 'verified',
    verifierVersion: version,
    figuresChecked: 1,
    mismatches: [],
    rawLogRetainedUntil: null,
    ...NO_GATLING,
  });
}

/** retentionDue's ids at verifier version 1, one page of `limit`. */
async function dueIds(repo: VerificationRepository, days = 30, limit = 100): Promise<string[]> {
  return (await repo.retentionDue(days, 1, null, limit)).runs.map((r) => r.id);
}

/** A check whose Gatling method did not run: nothing to compare, no replays. */
const NO_GATLING = { gatlingDifferences: [], gatlingReplays: null };

/** One percentile where Gatling's report differs — the shape packages/verify builds. */
const DIFFERENCE = {
  scope: 'request',
  name: 'Cart/Add To Cart',
  population: 'all',
  figure: 'p95',
  gatlingLow: 2389,
  gatlingHigh: 3410,
  exact: 2458,
};

const MISMATCH: FigureMismatch = {
  scope: 'request',
  name: 'Search',
  family: 'response_time',
  population: 'ok',
  bucket: 2000,
  table: 'run_series_bucket',
  figure: 'p95',
  stored: 412,
  recomputed: 411,
};

beforeEach(async () => {
  await resetDatabase(pool);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const other = await prisma.org.create({ data: { slug: 'globex', name: 'Globex' } });
  const otherProject = await prisma.project.create({
    data: { orgId: other.id, slug: 'search', name: 'Search', settings: {} },
  });
  orgId = org.id;
  projectId = project.id;
  otherOrgId = other.id;
  otherProjectId = otherProject.id;
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('VerificationRepository: recording', () => {
  it('round-trips a pending row, then a recorded mismatch with its JSON', async () => {
    const runId = await seedRun();
    const repo = new VerificationRepository(pool);
    expect(await repo.find(runId)).toBeNull();

    await repo.markPending(runId);
    expect(await repo.find(runId)).toEqual({
      runId,
      status: 'pending',
      checkedAt: null,
      verifierVersion: null,
      figuresChecked: 0,
      mismatches: [],
      gatlingDifferences: [],
      gatlingReplays: null,
      unverifiableReason: null,
      rawLogRetainedUntil: null,
    });

    // A stale Gatling-differences list must not survive a new check.
    await pool.query(`UPDATE run_verification SET gatling_differences = '["stale"]'::jsonb WHERE run_id = $1`, [runId]);
    const retained = new Date('2026-11-15T00:00:00Z');
    await repo.record(runId, {
      status: 'mismatch',
      verifierVersion: 3,
      figuresChecked: 1234,
      mismatches: [MISMATCH, { ...MISMATCH, population: null, bucket: null, table: 'run', figure: 'duration_ms', stored: '1', recomputed: null }],
      rawLogRetainedUntil: retained,
      ...NO_GATLING,
    });
    const found = await repo.find(runId);
    expect(found?.status).toBe('mismatch');
    expect(found?.verifierVersion).toBe(3);
    expect(found?.figuresChecked).toBe(1234);
    expect(found?.checkedAt).toBeInstanceOf(Date);
    expect(found?.mismatches).toEqual([
      MISMATCH,
      { ...MISMATCH, population: null, bucket: null, table: 'run', figure: 'duration_ms', stored: '1', recomputed: null },
    ]);
    expect(found?.unverifiableReason).toBeNull();
    expect(found?.gatlingDifferences).toEqual([]);
    expect(found?.rawLogRetainedUntil?.toISOString().slice(0, 10)).toBe('2026-11-15');
  });

  it('markPending resets a recorded row but keeps how long its raw log is retained', async () => {
    const runId = await seedRun();
    const repo = new VerificationRepository(pool);
    await repo.record(runId, {
      status: 'mismatch',
      verifierVersion: 1,
      figuresChecked: 7,
      mismatches: [MISMATCH],
      rawLogRetainedUntil: new Date('2026-11-15T00:00:00Z'),
      gatlingDifferences: [DIFFERENCE],
      gatlingReplays: 16,
    });
    await repo.markPending(runId);
    const found = await repo.find(runId);
    expect(found?.status).toBe('pending');
    expect(found?.mismatches).toEqual([]);
    expect(found?.figuresChecked).toBe(0);
    expect(found?.gatlingDifferences).toEqual([]);
    expect(found?.gatlingReplays).toBeNull();
    expect(found?.rawLogRetainedUntil?.toISOString().slice(0, 10)).toBe('2026-11-15');
  });

  /**
   * The scan's write: a run with no row gets a pending one, and a decided
   * row is left exactly as it was — the version bump that made the scan
   * select it is no reason to forget what the older verifier found.
   */
  it('ensurePending adds a pending row where there is none, and leaves a decided row whole', async () => {
    const repo = new VerificationRepository(pool);
    const fresh = await seedRun();
    const decided = await seedRun();
    await repo.record(decided, {
      status: 'mismatch',
      verifierVersion: 1,
      figuresChecked: 7,
      mismatches: [MISMATCH],
      rawLogRetainedUntil: new Date('2026-11-15T00:00:00Z'),
      gatlingDifferences: [DIFFERENCE],
      gatlingReplays: 16,
    });

    await repo.ensurePending(fresh);
    await repo.ensurePending(decided);

    expect(await repo.find(fresh)).toMatchObject({ status: 'pending', verifierVersion: null, mismatches: [] });
    expect(await repo.find(decided)).toMatchObject({
      status: 'mismatch',
      verifierVersion: 1,
      figuresChecked: 7,
      mismatches: [MISMATCH],
      gatlingDifferences: [DIFFERENCE],
      gatlingReplays: 16,
    });
  });

  /**
   * ═══ THE GATLING DIFFERENCES AND HOW MANY REPLAYS FOUND THEM ═══
   *
   * Written by record, both at once, and replaced by the next record: a run
   * re-checked by a verifier whose Gatling method did not run must not keep the
   * previous check's list or seed count.
   */
  it('records the Gatling differences and the replay count, and the next check replaces both', async () => {
    const runId = await seedRun();
    const repo = new VerificationRepository(pool);
    const other = { ...DIFFERENCE, scope: 'run', name: '', population: 'ko', figure: 'p99', gatlingLow: 2349, gatlingHigh: 2412, exact: 2401 };
    await repo.record(runId, {
      status: 'verified',
      verifierVersion: 2,
      figuresChecked: 10,
      mismatches: [],
      rawLogRetainedUntil: null,
      gatlingDifferences: [DIFFERENCE, other],
      gatlingReplays: 16,
    });
    const found = await repo.find(runId);
    expect(found?.gatlingDifferences).toEqual([DIFFERENCE, other]);
    expect(found?.gatlingReplays).toBe(16);

    await repo.record(runId, { status: 'verified', verifierVersion: 2, figuresChecked: 10, mismatches: [], rawLogRetainedUntil: null, ...NO_GATLING });
    const again = await repo.find(runId);
    expect(again?.gatlingDifferences).toEqual([]);
    expect(again?.gatlingReplays).toBeNull();
  });

  /**
   * Over a PENDING row, so the count goes through the upsert's ON CONFLICT
   * arm: the case above writes its values through the INSERT arm, and an
   * update that dropped the count would pass it.
   */
  it('records a replay count with no differences over a pending row: the method ran and Gatling agreed everywhere', async () => {
    const runId = await seedRun();
    const repo = new VerificationRepository(pool);
    await repo.markPending(runId);
    await repo.record(runId, {
      status: 'verified', verifierVersion: 2, figuresChecked: 10, mismatches: [], rawLogRetainedUntil: null,
      gatlingDifferences: [], gatlingReplays: 200,
    });
    const found = await repo.find(runId);
    expect([found?.gatlingDifferences, found?.gatlingReplays]).toEqual([[], 200]);
  });

  it('marks a run unverifiable with its reason and version', async () => {
    const runId = await seedRun();
    const repo = new VerificationRepository(pool);
    await repo.markPending(runId);
    await pool.query(
      `UPDATE run_verification SET gatling_differences = '["stale"]'::jsonb, gatling_replays = 16 WHERE run_id = $1`,
      [runId],
    );
    await repo.markUnverifiable(runId, 'raw_log_unreadable', 2);
    const found = await repo.find(runId);
    expect(found?.gatlingDifferences).toEqual([]);
    expect(found?.gatlingReplays).toBeNull();
    expect(found?.status).toBe('unverifiable');
    expect(found?.unverifiableReason).toBe('raw_log_unreadable');
    expect(found?.verifierVersion).toBe(2);
    expect(found?.checkedAt).toBeInstanceOf(Date);
  });

  /**
   * markRawLogDeleted settles only a PENDING row, which markPending left with
   * no replays — so the stale values are written straight onto the pending row
   * here: the statement must clear them itself, not rely on the row it found.
   */
  it('markRawLogDeleted clears a pending row\'s Gatling differences and replay count', async () => {
    const runId = await seedRun();
    const repo = new VerificationRepository(pool);
    await repo.markPending(runId);
    await pool.query(
      `UPDATE run_verification SET gatling_differences = '["stale"]'::jsonb, gatling_replays = 16 WHERE run_id = $1`,
      [runId],
    );
    await repo.markRawLogDeleted(runId);
    const found = await repo.find(runId);
    expect([found?.status, found?.unverifiableReason]).toEqual(['unverifiable', 'raw_log_deleted']);
    expect(found?.gatlingDifferences).toEqual([]);
    expect(found?.gatlingReplays).toBeNull();
  });

  /**
   * markPending's other arm: a run whose raw log is already gone is settled
   * as unverifiable/raw_log_deleted in the same upsert — and clears them too.
   */
  it('markPending on a deleted-log run clears a pending row\'s Gatling differences and replay count', async () => {
    const runId = await seedRun();
    const repo = new VerificationRepository(pool);
    await repo.markPending(runId);
    await pool.query(
      `UPDATE run_verification SET gatling_differences = '["stale"]'::jsonb, gatling_replays = 16 WHERE run_id = $1`,
      [runId],
    );
    await pool.query(`UPDATE run SET raw_log_deleted_at = now() WHERE id = $1`, [runId]);
    await repo.markPending(runId);
    const found = await repo.find(runId);
    expect([found?.status, found?.unverifiableReason]).toEqual(['unverifiable', 'raw_log_deleted']);
    expect(found?.gatlingDifferences).toEqual([]);
    expect(found?.gatlingReplays).toBeNull();
  });

  it('goes with its run', async () => {
    const runId = await seedRun();
    await new VerificationRepository(pool).markPending(runId);
    await prisma.run.delete({ where: { id: runId } });
    const { rows } = await pool.query(`SELECT 1 FROM run_verification WHERE run_id = $1`, [runId]);
    expect(rows).toHaveLength(0);
  });
});

describe('VerificationRepository.candidatePage', () => {
  it('selects a run with no row, a pending row and an older version; never a current one or an unfinished run', async () => {
    const repo = new VerificationRepository(pool);
    const noRow = await seedRun();
    const pending = await seedRun();
    await repo.markPending(pending);
    const older = await seedRun();
    await repo.record(older, { status: 'verified', verifierVersion: 1, figuresChecked: 1, mismatches: [], rawLogRetainedUntil: null, ...NO_GATLING });
    const current = await seedRun();
    await repo.record(current, { status: 'verified', verifierVersion: 2, figuresChecked: 1, mismatches: [], rawLogRetainedUntil: null, ...NO_GATLING });
    const currentUnverifiable = await seedRun();
    await repo.markUnverifiable(currentUnverifiable, 'raw_log_missing', 2);
    const running = await seedRun({ status: 'running', ingestedAt: null });
    const failed = await seedRun({ status: 'failed' });
    const noStats = await seedRun({ stats: false });

    const page = await repo.candidatePage(2, null, 100);
    expect(page.ids.sort()).toEqual([noRow, pending, older].sort());
    for (const id of [current, currentUnverifiable, running, failed, noStats]) expect(page.ids).not.toContain(id);
    expect(page.next).toBeNull();
  });

  it('skips a run whose raw log is gone: nothing is left to verify it against', async () => {
    const repo = new VerificationRepository(pool);
    const verifiedOld = await seedRun();
    await repo.record(verifiedOld, { status: 'verified', verifierVersion: 1, figuresChecked: 1, mismatches: [], rawLogRetainedUntil: null, ...NO_GATLING });
    await repo.markRawLogDeleted(verifiedOld);
    const kept = await seedRun();
    expect((await repo.candidatePage(2, null, 100)).ids).toEqual([kept]);
  });

  /**
   * ═══ A NOT_EXACT ROW IS TAKEN BACK ONCE A RECOMPUTE MADE THE RUN EXACT ═══
   *
   * markUnverifiable stamps the current version, so nothing in the version
   * test selects that row again. A recompute that made the run exact while
   * verification was switched off — or whose request was lost — would leave
   * it reading "estimates" for good without this clause.
   */
  it('selects an exact run still carrying a not_exact row at the current version', async () => {
    const repo = new VerificationRepository(pool);
    const recomputed = await seedRun({ statsMethod: 'exact-v1' });
    await repo.markUnverifiable(recomputed, 'not_exact', 2);
    expect((await repo.candidatePage(2, null, 100)).ids).toEqual([recomputed]);
  });

  it('does not select an estimated run carrying a not_exact row: it is still not exact', async () => {
    const repo = new VerificationRepository(pool);
    const estimated = await seedRun({ statsMethod: 'estimated' });
    await repo.markUnverifiable(estimated, 'not_exact', 2);
    // A positive beside the absence: the same run with no row IS selected.
    const fresh = await seedRun({ statsMethod: 'estimated' });
    expect((await repo.candidatePage(2, null, 100)).ids).toEqual([fresh]);
  });

  it('pages newest first through a created_at tie without skipping or repeating', async () => {
    const repo = new VerificationRepository(pool);
    const t = new Date('2026-08-07T12:00:00.000Z');
    const newest = await seedRun({ createdAt: new Date(t.getTime() + 1000) });
    const tieA = await seedRun({ createdAt: t });
    const tieB = await seedRun({ createdAt: t });
    const oldest = await seedRun({ createdAt: new Date(t.getTime() - 1000) });
    const [hi, lo] = tieA > tieB ? [tieA, tieB] : [tieB, tieA];

    const first = await repo.candidatePage(1, null, 2);
    expect(first.ids).toEqual([newest, hi]);
    expect(first.next).toEqual({ createdAt: t, id: hi });
    const second = await repo.candidatePage(1, first.next, 2);
    expect(second.ids).toEqual([lo, oldest]);
    const third = await repo.candidatePage(1, second.next, 2);
    expect(third.ids).toEqual([]);
    expect(third.next).toBeNull();
  });
});

describe('VerificationRepository: raw-log retention', () => {
  it('is due once ingested more than the retention ago, with a bundle, and not yet deleted', async () => {
    const repo = new VerificationRepository(pool);
    const now = Date.now();
    const due = await seedRun({ ingestedAt: new Date(now - 31 * DAY) });
    const justDue = await seedRun({ ingestedAt: new Date(now - 30 * DAY - HOUR) });
    const notYet = await seedRun({ ingestedAt: new Date(now - 29 * DAY) });
    const justNotYet = await seedRun({ ingestedAt: new Date(now - 30 * DAY + HOUR) });
    const deleted = await seedRun({ ingestedAt: new Date(now - 40 * DAY) });
    await repo.markRawLogDeleted(deleted);
    const noBundle = await seedRun({ ingestedAt: new Date(now - 40 * DAY), bundleSha256: '' });
    const neverIngested = await seedRun({ status: 'running', ingestedAt: null });
    // Checked against their logs, so nothing but the clock keeps them.
    for (const id of [due, justDue, notYet, justNotYet, noBundle]) await verified(id);

    const rows = (await repo.retentionDue(30, 1, null, 100)).runs;
    expect(rows.map((r) => r.id).sort()).toEqual([due, justDue].sort());
    for (const id of [notYet, justNotYet, deleted, noBundle, neverIngested]) {
      expect(rows.map((r) => r.id)).not.toContain(id);
    }
    const dueRow = rows.find((r) => r.id === due);
    const { rows: keyRows } = await pool.query<{ bundle_key: string }>(`SELECT bundle_key FROM run WHERE id = $1`, [due]);
    expect(dueRow?.bundleKey).toBe(keyRows[0]!.bundle_key);
  });

  it('keeps raw logs for ever when the retention is 0', async () => {
    const repo = new VerificationRepository(pool);
    await verified(await seedRun({ ingestedAt: new Date(Date.now() - 400 * DAY) }));
    expect(await repo.retentionDue(0, 1, null, 100)).toEqual({ runs: [], next: null });
    // A positive beside the absence: the same run IS due under a real retention.
    expect(await dueIds(repo)).toHaveLength(1);
  });

  /**
   * Keyset-paged on (ingested_at, id), oldest first: a run whose delete keeps
   * failing is behind the cursor once its page is walked, so it cannot hold
   * every run after it. A tie on ingested_at is neither skipped nor repeated.
   */
  it('pages oldest first through an ingested_at tie, without skipping or repeating', async () => {
    const repo = new VerificationRepository(pool);
    const now = Date.now();
    const t = new Date(now - 50 * DAY);
    const oldest = await seedRun({ ingestedAt: new Date(now - 60 * DAY) });
    const tieA = await seedRun({ ingestedAt: t });
    const tieB = await seedRun({ ingestedAt: t });
    const newest = await seedRun({ ingestedAt: new Date(now - 40 * DAY) });
    for (const id of [oldest, tieA, tieB, newest]) await verified(id);
    const [lo, hi] = tieA < tieB ? [tieA, tieB] : [tieB, tieA];

    const first = await repo.retentionDue(30, 1, null, 2);
    expect(first.runs.map((r) => r.id)).toEqual([oldest, lo]);
    expect(first.next).toEqual({ ingestedAt: t, id: lo });
    const second = await repo.retentionDue(30, 1, first.next, 2);
    expect(second.runs.map((r) => r.id)).toEqual([hi, newest]);
    const third = await repo.retentionDue(30, 1, second.next, 2);
    expect(third).toEqual({ runs: [], next: null });
  });

  it('answers isRetentionDue for one run by the same definition', async () => {
    const repo = new VerificationRepository(pool);
    const old = new Date(Date.now() - 40 * DAY);
    const due = await seedRun({ ingestedAt: old });
    await verified(due);
    const pending = await seedRun({ ingestedAt: old });
    await repo.markPending(pending);
    const young = await seedRun();
    await verified(young);
    expect(await repo.isRetentionDue(due, 30, 1)).toBe(true);
    expect(await repo.isRetentionDue(pending, 30, 1)).toBe(false);
    expect(await repo.isRetentionDue(young, 30, 1)).toBe(false);
    expect(await repo.isRetentionDue(due, 0, 1)).toBe(false);
    // A newer verifier still has to check it against its log.
    expect(await repo.isRetentionDue(due, 30, 2)).toBe(false);
  });

  it('a never-verified run becomes unverifiable when its raw log is deleted; a verified one stays verified', async () => {
    const repo = new VerificationRepository(pool);
    const noRow = await seedRun();
    const pending = await seedRun();
    await repo.markPending(pending);
    const verified = await seedRun();
    await repo.record(verified, { status: 'verified', verifierVersion: 1, figuresChecked: 9, mismatches: [], rawLogRetainedUntil: null, ...NO_GATLING });

    for (const id of [noRow, pending, verified]) await repo.markRawLogDeleted(id);

    for (const id of [noRow, pending]) {
      const found = await repo.find(id);
      expect(found?.status).toBe('unverifiable');
      expect(found?.unverifiableReason).toBe('raw_log_deleted');
    }
    const kept = await repo.find(verified);
    expect(kept?.status).toBe('verified');
    expect(kept?.unverifiableReason).toBeNull();
    expect(kept?.figuresChecked).toBe(9);

    const { rows } = await pool.query<{ id: string; raw_log_deleted_at: Date | null }>(
      `SELECT id, raw_log_deleted_at FROM run WHERE id = ANY($1::uuid[])`,
      [[noRow, pending, verified]],
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.raw_log_deleted_at).toBeInstanceOf(Date);
  });
});

describe('VerificationRepository: a deleted raw log settles a run, and only a verifiable one', () => {
  it('gives a run that was never verifiable no row when its raw log is deleted, but still stamps it', async () => {
    const repo = new VerificationRepository(pool);
    const counted = await seedRun(); // verifiable, no row: pending in the summary
    const failed = await seedRun({ status: 'failed', stats: false, ingestedAt: new Date(Date.now() - 40 * DAY) });
    const noStats = await seedRun({ stats: false, ingestedAt: new Date(Date.now() - 40 * DAY) });
    const before = await repo.summary(orgId);

    // Both are due: neither has figures any verify or recompute will read.
    expect((await dueIds(repo)).sort()).toEqual([failed, noStats].sort());
    await repo.markRawLogDeleted(failed);
    await repo.markRawLogDeleted(noStats);

    expect(await repo.find(failed)).toBeNull();
    expect(await repo.find(noStats)).toBeNull();
    expect(await repo.summary(orgId)).toEqual(before);
    expect(before).toEqual({ verified: 0, mismatch: 0, unverifiable: 0, pending: 1 });
    expect(await repo.problems(orgId, 10)).toEqual([]);
    const { rows } = await pool.query<{ raw_log_deleted_at: Date | null }>(
      `SELECT raw_log_deleted_at FROM run WHERE id = ANY($1::uuid[])`,
      [[failed, noStats]],
    );
    for (const r of rows) expect(r.raw_log_deleted_at).toBeInstanceOf(Date);
    // A positive beside the absences: the verifiable run still IS settled.
    await repo.markRawLogDeleted(counted);
    expect((await repo.find(counted))?.status).toBe('unverifiable');
  });

  it('markPending settles a deleted-log run as unverifiable rather than leaving it pending for ever', async () => {
    const repo = new VerificationRepository(pool);
    const deleteLog = (id: string) => pool.query(`UPDATE run SET raw_log_deleted_at = now() WHERE id = $1`, [id]);
    const noRow = await seedRun();
    await deleteLog(noRow);
    const wasPending = await seedRun();
    await repo.markPending(wasPending);
    await deleteLog(wasPending);
    const verified = await seedRun();
    await repo.record(verified, { status: 'verified', verifierVersion: 1, figuresChecked: 4, mismatches: [], rawLogRetainedUntil: null, ...NO_GATLING });
    await repo.markRawLogDeleted(verified);
    const failed = await seedRun({ status: 'failed', stats: false });
    await deleteLog(failed);

    for (const id of [noRow, wasPending, verified, failed]) await repo.markPending(id);

    for (const id of [noRow, wasPending]) {
      const found = await repo.find(id);
      expect(found?.status).toBe('unverifiable');
      expect(found?.unverifiableReason).toBe('raw_log_deleted');
    }
    // Settled while its log existed: nothing can re-check it, so it keeps its outcome.
    expect(await repo.find(verified)).toMatchObject({ status: 'verified', figuresChecked: 4 });
    expect(await repo.find(failed)).toBeNull();
    expect(await repo.summary(orgId)).toEqual({ verified: 1, mismatch: 0, unverifiable: 2, pending: 0 });

    // A run whose log is kept is still queued as before.
    const kept = await seedRun();
    await repo.markPending(kept);
    expect((await repo.find(kept))?.status).toBe('pending');
  });
});

describe('VerificationRepository: per-org reads', () => {
  it('summarises one org, counting a run with statistics and no row as pending', async () => {
    const repo = new VerificationRepository(pool);
    const v = await seedRun();
    await repo.record(v, { status: 'verified', verifierVersion: 1, figuresChecked: 1, mismatches: [], rawLogRetainedUntil: null, ...NO_GATLING });
    const m = await seedRun();
    await repo.record(m, { status: 'mismatch', verifierVersion: 1, figuresChecked: 1, mismatches: [MISMATCH], rawLogRetainedUntil: null, ...NO_GATLING });
    const u = await seedRun();
    await repo.markUnverifiable(u, 'not_exact', 1);
    await seedRun(); // no row: pending
    const p = await seedRun();
    await repo.markPending(p);
    await seedRun({ status: 'running', ingestedAt: null }); // not finished: not counted

    const elsewhere = await seedRun({ orgId: otherOrgId, projectId: otherProjectId });
    await repo.record(elsewhere, { status: 'mismatch', verifierVersion: 1, figuresChecked: 1, mismatches: [MISMATCH], rawLogRetainedUntil: null, ...NO_GATLING });

    expect(await repo.summary(orgId)).toEqual({ verified: 1, mismatch: 1, unverifiable: 1, pending: 2 });
    expect(await repo.summary(otherOrgId)).toEqual({ verified: 0, mismatch: 1, unverifiable: 0, pending: 0 });
  });

  it('lists one org\'s problems with the project slug, reason and mismatch count', async () => {
    const repo = new VerificationRepository(pool);
    const m = await seedRun();
    await repo.record(m, { status: 'mismatch', verifierVersion: 1, figuresChecked: 1, mismatches: [MISMATCH, MISMATCH], rawLogRetainedUntil: null, ...NO_GATLING });
    const u = await seedRun();
    await repo.markUnverifiable(u, 'raw_log_missing', 1);
    const v = await seedRun();
    await repo.record(v, { status: 'verified', verifierVersion: 1, figuresChecked: 1, mismatches: [], rawLogRetainedUntil: null, ...NO_GATLING });
    const elsewhere = await seedRun({ orgId: otherOrgId, projectId: otherProjectId });
    await repo.markUnverifiable(elsewhere, 'raw_log_missing', 1);

    const problems = await repo.problems(orgId, 10);
    expect(problems.map((p) => p.runId).sort()).toEqual([m, u].sort());
    const mm = problems.find((p) => p.runId === m)!;
    expect(mm).toMatchObject({ projectSlug: 'checkout', status: 'mismatch', reason: null, mismatchCount: 2 });
    expect(mm.checkedAt).toBeInstanceOf(Date);
    expect(problems.find((p) => p.runId === u)).toMatchObject({
      projectSlug: 'checkout',
      status: 'unverifiable',
      reason: 'raw_log_missing',
      mismatchCount: 0,
    });
    expect(await repo.problems(orgId, 1)).toHaveLength(1);
    expect((await repo.problems(otherOrgId, 10)).map((p) => p.runId)).toEqual([elsewhere]);
  });
});

describe('readStoredFigures', () => {
  async function seedFigures(runId: string, tag: number): Promise<void> {
    await insertStat(runId, orgId, projectId, 'request', `req-${tag}`);
    await pool.query(
      `INSERT INTO run_series_bucket
         (run_started_on, run_id, org_id, project_id, scope, name, family, start_offset_ms,
          started_count, ended_count, ok_count, ko_count, started_ok_count, started_ko_count,
          min_ms, max_ms, mean_ms, percentiles, percentiles_ok, percentiles_ko, histogram_ok)
       VALUES ($1::date, $2, $3, $4, 'run', '', 'response_time', $5,
               4, 3, 2, 1, 3, 1, 10, 40, 25, '{"p50": 20}'::jsonb, '{"p50": 18}'::jsonb, '{}'::jsonb, $6)`,
      ['2026-08-07', runId, orgId, projectId, tag * 1000, Buffer.from([1, 2, 3])],
    );
    await pool.query(
      `INSERT INTO run_error (id, run_id, org_id, project_id, scope, name, message, is_other, count)
       VALUES (gen_random_uuid(), $1, $2, $3, 'run', '', $4, false, 5),
              (gen_random_uuid(), $1, $2, $3, 'run', '', '', true, 2)`,
      [runId, orgId, projectId, `boom-${tag}`],
    );
    await pool.query(
      `INSERT INTO run_error_bucket
         (run_started_on, run_id, org_id, project_id, start_offset_ms, message, is_other, count, bucket_width_ms)
       VALUES ($1::date, $2, $3, $4, $5, $6, false, 5, 1000)`,
      ['2026-08-07', runId, orgId, projectId, tag * 1000, `boom-${tag}`],
    );
    await pool.query(
      `INSERT INTO run_user_bucket
         (run_started_on, run_id, org_id, project_id, scenario, start_offset_ms, started, ended, max_concurrent)
       VALUES ($1::date, $2, $3, $4, $5, 0, 4, 1, 3)`,
      ['2026-08-07', runId, orgId, projectId, `scn-${tag}`],
    );
    await pool.query(`UPDATE run SET duration_ms = $2, activity_ms = $3 WHERE id = $1`, [runId, 60_000 + tag, 59_000 + tag]);
  }

  it('reads every stored row of one run across the five tables, decoded, and none of another', async () => {
    const a = await seedRun();
    const b = await seedRun();
    await seedFigures(a, 1);
    await seedFigures(b, 2);

    const figures = await readStoredFigures(pool, a, STARTED_ON);
    expect(figures.run).toEqual({ durationMs: 60_001, activityMs: 59_001 });

    expect(figures.stats.map((s) => `${s.scope}/${s.name}`).sort()).toEqual(['request/req-1', 'run/']);
    const runRow = figures.stats.find((s) => s.scope === 'run')!;
    expect(runRow).toEqual({
      scope: 'run',
      name: '',
      family: 'response_time',
      count: 3,
      okCount: 2,
      koCount: 1,
      errorRate: 0.3333333333333333,
      minMs: 10,
      maxMs: 30,
      meanMs: 20,
      stddevMs: 8.16496580927726,
      throughputRps: 1.5,
      percentiles: { p50: 20, 'p99.9': 30 },
    });

    expect(figures.seriesBuckets).toEqual([
      {
        scope: 'run',
        name: '',
        family: 'response_time',
        startOffsetMs: 1000,
        startedCount: 4,
        endedCount: 3,
        okCount: 2,
        koCount: 1,
        startedOkCount: 3,
        startedKoCount: 1,
        minMs: 10,
        maxMs: 40,
        meanMs: 25,
        percentiles: { p50: 20 },
        percentilesOk: { p50: 18 },
        percentilesKo: {},
      },
    ]);
    // No histogram bytes ride along: an encoding, not a figure.
    expect(Object.keys(figures.seriesBuckets[0]!)).not.toContain('histogramOk');

    expect(figures.errors).toEqual([
      { scope: 'run', name: '', message: '', isOther: true, count: 2 },
      { scope: 'run', name: '', message: 'boom-1', isOther: false, count: 5 },
    ]);
    expect(figures.errorBuckets).toEqual([
      { startOffsetMs: 1000, message: 'boom-1', isOther: false, count: 5, bucketWidthMs: 1000 },
    ]);
    expect(figures.userBuckets).toEqual([
      { scenario: 'scn-1', startOffsetMs: 0, started: 4, ended: 1, maxConcurrent: 3 },
    ]);
  });

  it('answers empty arrays for a run with no metric rows', async () => {
    const runId = await seedRun({ stats: false });
    const figures = await readStoredFigures(pool, runId, STARTED_ON);
    expect(figures).toEqual({
      stats: [],
      seriesBuckets: [],
      errors: [],
      errorBuckets: [],
      userBuckets: [],
      run: { durationMs: null, activityMs: null },
    });
  });
});
