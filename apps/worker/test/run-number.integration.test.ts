import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createPool, createPrisma, SCHEMA_TABLES, TestRepository } from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { PipelineService } from '../src/pipeline/pipeline.service.js';
import { attachLiveRunToTest, numberRunForTest } from '../src/pipeline/run-number.js';

/**
 * ═══ A RUN'S NUMBER, AT THE TWO PLACES A RUN JOINS ITS TEST ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * THE REAL STATEMENTS, NOT A MIRROR OF THEIR SQL: both writers call these two
 * functions, and this file calls them too. CLAUDE.md records a test-entity
 * suite that mirrored the resolver's SQL and stopped being valid the day the
 * rule moved out of the schema; this rule lives in code from the start.
 */
const config = loadWorkerConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' });
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);

/** For a step that must NOT wait on a lock. The deadlock cases below hold
 *  transactions open from the harness itself, so a change that makes such a
 *  step wait would wait behind the harness for ever — the run hangs rather
 *  than failing. With a lock_timeout the step fails (55P03) and names itself. */
const withLockTimeout = (url: string): string => {
  const u = new URL(url);
  u.searchParams.set('options', '-c lock_timeout=5000');
  return u.toString();
};
const bounded = createPool(withLockTimeout(config.databaseUrl));

afterAll(async () => {
  await pool.end();
  await bounded.end();
  await prisma.$disconnect();
});

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

const testRow = (slug: string, nextRunNumber = 1) =>
  prisma.test.create({
    data: { orgId, projectId, slug, name: slug, simulationClass: `example.${slug}`, nextRunNumber },
  });

const runRow = (status: 'running' | 'parsing' | 'complete', testId: string | null = null, runNumber: number | null = null) =>
  prisma.run.create({
    data: {
      orgId,
      projectId,
      testId,
      runNumber,
      status,
      tool: 'gatling',
      bundleKey: `runs/${projectId}/${randomUUID()}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n,
      startedAt: new Date('2026-09-27T09:00:00Z'),
      startedOn: new Date('2026-09-27T00:00:00Z'),
      engineOptions: {},
    },
  });

const numberOf = async (runId: string) =>
  (await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { testId: true, runNumber: true } }));
const counterOf = async (testId: string) =>
  (await prisma.test.findUniqueOrThrow({ where: { id: testId } })).nextRunNumber;

/** One finalize transaction, the way PipelineService opens it. */
async function inFinalize<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

describe('a live run joining its test at the log header', () => {
  it('numbers successive runs 1, 2 and moves the counter past them', async () => {
    const test = await testRow('checkout-smoke');
    const first = await runRow('running');
    const second = await runRow('running');

    expect(await attachLiveRunToTest(pool, first.id, test.id)).toBe(1);
    expect(await attachLiveRunToTest(pool, second.id, test.id)).toBe(2);

    expect(await numberOf(first.id)).toEqual({ testId: test.id, runNumber: 1 });
    expect(await numberOf(second.id)).toEqual({ testId: test.id, runNumber: 2 });
    expect(await counterOf(test.id)).toBe(3);
  });

  /** A re-claimed fold (crash, rolling deploy) identifies the run again. It
   *  must find the run already in its test and take NOTHING. */
  it('burns no number when the same run is attached a second time', async () => {
    const test = await testRow('checkout-smoke');
    const run = await runRow('running');

    await attachLiveRunToTest(pool, run.id, test.id);
    expect(await attachLiveRunToTest(pool, run.id, test.id)).toBeNull();

    expect(await numberOf(run.id)).toEqual({ testId: test.id, runNumber: 1 });
    expect(await counterOf(test.id)).toBe(2);
  });
});

describe('the pipeline deciding the number at finalize', () => {
  it('numbers an upload, which had no test until now', async () => {
    const test = await testRow('checkout-smoke');
    const run = await runRow('parsing');

    expect(await inFinalize((c) => numberRunForTest(c, run.id, test.id))).toBe(1);
    expect(await numberOf(run.id)).toEqual({ testId: test.id, runNumber: 1 });
    expect(await counterOf(test.id)).toBe(2);
  });

  it('keeps the number a live run took at its header when the test is the same', async () => {
    const test = await testRow('checkout-smoke');
    const run = await runRow('running');
    await attachLiveRunToTest(pool, run.id, test.id);

    expect(await inFinalize((c) => numberRunForTest(c, run.id, test.id))).toBe(1);
    expect(await counterOf(test.id)).toBe(2);
  });

  /** B already holds runs, so its next number is 3 — a value the run's OLD
   *  number (1) cannot coincide with, which is what lets this tell "took B's
   *  next" from "kept A's". */
  it('takes the new test’s next number when finalize re-matches it, leaving a gap behind', async () => {
    const a = await testRow('checkout-smoke');
    const b = await testRow('checkout-soak', 3);
    const run = await runRow('running');
    await attachLiveRunToTest(pool, run.id, a.id);

    expect(await inFinalize((c) => numberRunForTest(c, run.id, b.id))).toBe(3);
    expect(await numberOf(run.id)).toEqual({ testId: b.id, runNumber: 3 });
    expect(await counterOf(b.id)).toBe(4);
    // A's 1 is spent and not given back: numbers are never reused.
    expect(await counterOf(a.id)).toBe(2);
  });

  /** An upgrade window: the OLD worker attached this run to its test (set
   *  `test_id`) before the migration that taught it to number runs too, so
   *  the run sits in its test with a NULL number. Finalize must not keep that
   *  NULL for ever just because the run is "already in its resolved test". */
  it('numbers a run it finds already in its test with no number — an older worker attached it', async () => {
    const test = await testRow('checkout-smoke');
    const run = await runRow('running', test.id, null);

    expect(await inFinalize((c) => numberRunForTest(c, run.id, test.id))).toBe(1);
    expect(await numberOf(run.id)).toEqual({ testId: test.id, runNumber: 1 });
    expect(await counterOf(test.id)).toBe(2);
  });

  it('clears the number when the resolver found no test', async () => {
    const test = await testRow('checkout-smoke');
    const run = await runRow('running');
    await attachLiveRunToTest(pool, run.id, test.id);

    expect(await inFinalize((c) => numberRunForTest(c, run.id, null))).toBeNull();
    expect(await numberOf(run.id)).toEqual({ testId: null, runNumber: null });
  });

  /** The terminal UPDATE's own guard: a run already finished must not be
   *  re-numbered by a redelivered job. */
  it('leaves a run that is already terminal exactly as it was', async () => {
    const a = await testRow('checkout-smoke', 2);
    const b = await testRow('checkout-soak');
    const done = await runRow('complete', a.id, 1);

    await inFinalize((c) => numberRunForTest(c, done.id, b.id));

    expect(await numberOf(done.id)).toEqual({ testId: a.id, runNumber: 1 });
    expect(await counterOf(b.id)).toBe(1);
  });

  /** ═══ THE RACE A COUNTER EXISTS FOR ═══
   *  Eight runs of one test finalizing at once, each in its own transaction.
   *  A max-plus-one read would hand several of them the same number (and the
   *  unique index would then refuse all but one). */
  it('gives runs finalizing concurrently distinct numbers', async () => {
    const test = await testRow('checkout-smoke');
    const runs = await Promise.all(Array.from({ length: 8 }, () => runRow('parsing')));

    const numbers = await Promise.all(
      runs.map((run) => inFinalize((c) => numberRunForTest(c, run.id, test.id))),
    );

    expect([...numbers].sort((x, y) => x! - y!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await counterOf(test.id)).toBe(9);
  });
});

/** A thrown error as the SQLSTATE a reader needs to see. pg puts it on `code`;
 *  a Prisma batch transaction puts none there and carries the database's own
 *  (`code: "40P01"`) inside its message, so that is read too. */
function codeOf(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown };
  const message = typeof e.message === 'string' ? e.message.trim() : '';
  const code =
    typeof e.code === 'string' ? e.code : (/code: "([0-9A-Z]{5})"/.exec(message)?.[1] ?? 'no code');
  const line = message.split('\n').pop() ?? '';
  return line === '' ? code : `${code}: ${line}`;
}

const pidOf = async (client: import('pg').PoolClient): Promise<number> =>
  (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;

/** Polls `sql` (one boolean column, `ok`) until it answers true. Waiting on
 *  `pg_stat_activity` is the only honest way to know a statement has QUEUED
 *  rather than merely been sent — a fixed sleep is a guess a loaded machine
 *  loses. */
async function until(what: string, sql: string, params: unknown[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const { rows } = await pool.query<{ ok: boolean }>(sql, params);
    if (rows[0]?.ok === true) return;
    if (Date.now() > deadline) throw new Error(`expected ${what} within 5 s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Some backend is waiting on a lock `holder` holds. Scoped to a pid rather
 *  than counting every Lock waiter in the database, so a statement queued
 *  behind somebody else — another file's leftover, an unrelated backend —
 *  cannot satisfy the wait and let the case run its next step early. */
const BLOCKED_BY = `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                                     WHERE $1::int = ANY (pg_blocking_pids(pid))) AS ok`;
const blockedBy = (holder: number) => until(`a backend blocked by pid ${holder}`, BLOCKED_BY, [holder]);

/** `waiter` itself is waiting on a lock, whoever holds it. */
const blocked = (waiter: number) =>
  until(
    `pid ${waiter} blocked on a lock`,
    `SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS ok`,
    [waiter],
  );

/** The pipeline's terminal UPDATE, in the one respect these cases need: it
 *  writes `test_id` to the test the finalize resolved, which is the SAME value
 *  for a run already in it. Whether that UPDATE locks the test row depends
 *  only on whether the row was written earlier in the same transaction —
 *  Postgres re-runs a foreign-key check then, and skips it otherwise — so any
 *  UPDATE of the row carries the property. The pipeline case at the bottom of
 *  this file proves the same thing through the real `PipelineService`. */
const TERMINAL = `UPDATE run SET status = 'complete', test_id = $2
                   WHERE id = $1 AND status NOT IN ('complete', 'failed')`;

describe('deleting a test while its runs finish', () => {
  /** ═══ THE CYCLE `TestRepository.remove`'s FIRST STATEMENT BREAKS ═══
   *
   *  Three transactions, in this exact order:
   *
   *    W  a finalize of another run (R0) into T, uncommitted — holds the TEST row
   *    D  remove(T) — its delete queues behind W on T
   *    A  a finalize of R, committed IN T with no number (an older worker
   *       attached it): its `cur` locks RUN R, its `allocated` queues on T
   *
   *  Then W commits. Without `remove`'s run-first statement, D gets T and
   *  deletes it; the FK's `ON DELETE SET NULL` cascade needs R, held by A,
   *  while A needs T, held by D — Postgres aborts one of them with `40P01`.
   *  WITH it, D locked R (committed in T) before it ever asked for T, so A
   *  queues on R instead, D finishes, and A's statement then finds T deleted.
   *
   *  The real `remove`, the real `numberRunForTest`, and waits on
   *  `pg_stat_activity` rather than sleeps. The interleaving up to W's commit
   *  is forced; what follows is not. D and A both queue for T behind W, and
   *  when W commits they race for T's new row version — so with the first
   *  statement removed this deadlocks only when D wins, measured 5 of 6.
   *  Which side Postgres then aborts varies, and either fails an assertion
   *  below. The case that pins the first statement DETERMINISTICALLY is the
   *  self-healing one further down, a cycle with nothing racing. */
  it('does not deadlock a delete against a finalize that numbers a run already in the test', async () => {
    const test = await testRow('checkout-smoke', 6);
    const r0 = await runRow('parsing');
    const r = await runRow('parsing', test.id, null);
    const repository = new TestRepository(prisma);

    const w = await pool.connect();
    const a = await pool.connect();
    // Read before either client has a statement in flight: a pg client queues
    // its queries, so asking a BLOCKED client for its pid would wait forever.
    const wPid = await pidOf(w);
    const aPid = await pidOf(a);
    let removal: Promise<string> | undefined;
    let finalize: Promise<string> | undefined;
    let outcome = { remove: 'not started', finalize: 'not started' };
    try {
      await w.query('BEGIN');
      expect(await numberRunForTest(w, r0.id, test.id)).toBe(6);

      removal = repository.remove({ orgId, projectId }, test.slug).then(
        (removed) => (removed === null ? 'resolved null' : 'resolved'),
        (err: unknown) => `rejected ${codeOf(err)}`,
      );
      await blockedBy(wPid);

      await a.query('BEGIN');
      finalize = numberRunForTest(a, r.id, test.id)
        .then(() => a.query('COMMIT'))
        .then(
          () => 'committed',
          (err: unknown) => codeOf(err).split(':')[0]!,
        );
      await blocked(aPid);

      await w.query('COMMIT');
      outcome = { remove: await removal, finalize: await finalize };
    } finally {
      // W first: while it is open it holds T, and nothing below can settle.
      await w.query('ROLLBACK').catch(() => undefined);
      await removal;
      await finalize;
      await a.query('ROLLBACK').catch(() => undefined);
      w.release();
      a.release();
    }

    const seen = JSON.stringify(outcome);
    expect(outcome.remove, seen).toBe('resolved');
    expect(outcome.finalize, seen).not.toBe('40P01');
    // Observed: 23503. A queued on R behind D, and by the time it ran, T was
    // deleted — so its UPDATE's `test_id = T` failed the foreign key. That is
    // what a finalize racing its test's deletion has always met, numbering or
    // not: the terminal UPDATE has always written `test_id` itself. It is a
    // refusal, not a hang, and nothing is left half-written. 'committed' is
    // the other safe ending: had A reached T before D, it would have numbered
    // R and D's cascade would then have ungrouped it and cleared the number.
    expect(['committed', '23503'], seen).toContain(outcome.finalize);

    expect(await prisma.test.findUnique({ where: { id: test.id } })).toBeNull();
    expect(await numberOf(r0.id)).toEqual({ testId: null, runNumber: null });
    expect(await numberOf(r.id)).toEqual({ testId: null, runNumber: null });
    expect(
      await prisma.run.count({ where: { projectId, testId: null, runNumber: { not: null } } }),
    ).toBe(0);
  });

  /** ═══ THE FIRST RESIDUAL: A NUMBERED RUN THAT JOINS THE TEST MID-DELETE ═══
   *
   *  A live run R joins T after the delete's first statement has read, and its
   *  finalize takes R before the delete's cascade reaches it:
   *
   *    L  holds another run of T, so the delete's first statement waits on it
   *       having already read — R is not in T yet
   *    -  R's log header joins it to T as Run 6 (attachLiveRunToTest)
   *    A  R's finalize: numberRunForTest keeps Run 6, and holds R
   *
   *  Then L commits: the delete finishes its first statement, takes T, and its
   *  cascade waits on R. A's terminal UPDATE then writes test_id = T. If the
   *  keep arm REWROTE the row, Postgres re-runs the foreign-key check on that
   *  UPDATE — the row was written earlier in the same transaction — which
   *  needs T, held by the delete: 40P01. A keep arm that writes nothing leaves
   *  the UPDATE with no check to run, so A commits and the delete follows. */
  it('does not deadlock a delete against a finalize keeping the number of a run that joined mid-delete', async () => {
    const test = await testRow('checkout-smoke', 6);
    const rx = await runRow('parsing', test.id, 5);
    const r = await runRow('running');
    const repository = new TestRepository(prisma);

    const l = await pool.connect();
    const a = await pool.connect();
    const lPid = await pidOf(l);
    const aPid = await pidOf(a);
    let removal: Promise<string> | undefined;
    let finalize: Promise<string> | undefined;
    let outcome = { remove: 'not started', finalize: 'not started' };
    try {
      await l.query('BEGIN');
      await l.query('SELECT id FROM run WHERE id = $1 FOR UPDATE', [rx.id]);

      removal = repository.remove({ orgId, projectId }, test.slug).then(
        (removed) => (removed === null ? 'resolved null' : 'resolved'),
        (err: unknown) => `rejected ${codeOf(err)}`,
      );
      await blockedBy(lPid);

      expect(await attachLiveRunToTest(bounded, r.id, test.id)).toBe(6);
      await a.query('BEGIN');
      await a.query("SET LOCAL lock_timeout = '5s'");
      expect(await numberRunForTest(a, r.id, test.id)).toBe(6);

      await l.query('COMMIT');
      await blockedBy(aPid);

      finalize = a
        .query(TERMINAL, [r.id, test.id])
        .then(() => a.query('COMMIT'))
        .then(
          () => 'committed',
          (err: unknown) => codeOf(err).split(':')[0]!,
        );
      outcome = { remove: await removal, finalize: await finalize };
    } finally {
      await l.query('ROLLBACK').catch(() => undefined);
      // Until its terminal UPDATE is sent A sits idle holding R, and the
      // delete may be waiting on it: release A first, or this waits for ever.
      if (finalize === undefined) await a.query('ROLLBACK').catch(() => undefined);
      await removal;
      await finalize;
      await a.query('ROLLBACK').catch(() => undefined);
      l.release();
      a.release();
    }

    // Both finish, in that order: the finalize never needs anything the
    // delete holds, so it commits Run 6 — and the delete then ungroups it.
    expect(outcome, JSON.stringify(outcome)).toEqual({ remove: 'resolved', finalize: 'committed' });
    expect(await prisma.test.findUnique({ where: { id: test.id } })).toBeNull();
    expect(await numberOf(r.id)).toEqual({ testId: null, runNumber: null });
    expect(await numberOf(rx.id)).toEqual({ testId: null, runNumber: null });
    expect(
      await prisma.run.count({ where: { projectId, testId: null, runNumber: { not: null } } }),
    ).toBe(0);
  });

  /** ═══ THE SECOND RESIDUAL: A SELF-HEAL THAT HAS WRITTEN ITS ASSERTIONS ═══
   *
   *  R sits in T with no number — an older worker attached it — and its
   *  finalize has inserted a run_assertion row, whose foreign-key check holds
   *  R FOR KEY SHARE. Then the delete starts, and only then does the finalize
   *  reach numberRunForTest, which takes R FOR UPDATE and numbers it from T.
   *
   *  The delete's first statement has to wait behind that KEY SHARE BEFORE it
   *  holds T. A statement that only rewrote R's number, NULL to NULL, changed
   *  no key column, took FOR NO KEY UPDATE — which a KEY SHARE does not block —
   *  and passed; the delete then held T, its cascade waited on the KEY SHARE,
   *  and the finalize's FOR UPDATE waited on the delete: 40P01. A first
   *  statement that UNGROUPS R changes test_id, a key column, so it takes FOR
   *  UPDATE and queues. The finalize is then R's sole locker and upgrades its
   *  own lock without queuing behind the delete (Postgres does not make a
   *  transaction wait on itself), numbers R from a T nobody holds, and
   *  commits. */
  it('does not deadlock a delete against a self-healing finalize that already wrote its assertions', async () => {
    const test = await testRow('checkout-smoke', 6);
    const r = await runRow('parsing', test.id, null);
    const repository = new TestRepository(prisma);

    const a = await pool.connect();
    const aPid = await pidOf(a);
    let removal: Promise<string> | undefined;
    let finalize: Promise<string> | undefined;
    let numbered: number | null = null;
    let outcome = { remove: 'not started', finalize: 'not started' };
    try {
      await a.query('BEGIN');
      await a.query("SET LOCAL lock_timeout = '5s'");
      await a.query(
        `INSERT INTO run_assertion
           (id, run_id, org_id, project_id, rule_id, rule_snapshot, outcome, actual_value, message)
         VALUES ($1, $2, $3, $4, $5, '{}', 'passed', 1, 'p95 within its limit')`,
        [randomUUID(), r.id, orgId, projectId, randomUUID()],
      );

      removal = repository.remove({ orgId, projectId }, test.slug).then(
        (removed) => (removed === null ? 'resolved null' : 'resolved'),
        (err: unknown) => `rejected ${codeOf(err)}`,
      );
      await blockedBy(aPid);

      finalize = numberRunForTest(a, r.id, test.id)
        .then((n) => {
          numbered = n;
          return a.query(TERMINAL, [r.id, test.id]);
        })
        .then(() => a.query('COMMIT'))
        .then(
          () => 'committed',
          (err: unknown) => codeOf(err).split(':')[0]!,
        );
      outcome = { remove: await removal, finalize: await finalize };
    } finally {
      // As above: an A that never reached numberRunForTest still holds the
      // KEY SHARE the delete may be waiting behind.
      if (finalize === undefined) await a.query('ROLLBACK').catch(() => undefined);
      await removal;
      await finalize;
      await a.query('ROLLBACK').catch(() => undefined);
      a.release();
    }

    expect(outcome, JSON.stringify(outcome)).toEqual({ remove: 'resolved', finalize: 'committed' });
    // The finalize numbered R from T before the delete ran; the delete then
    // ungrouped it and cleared the number — UNGROUPED => UNNUMBERED.
    expect(numbered).toBe(6);
    expect(await prisma.test.findUnique({ where: { id: test.id } })).toBeNull();
    expect(await numberOf(r.id)).toEqual({ testId: null, runNumber: null });
  });
});

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);
const blobs = new BlobStore(config.blob);
let bundle: Buffer;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runno-'));
  mkdirSync(join(dir, 'run-1'), { recursive: true });
  copyFileSync(FIXTURE_LOG, join(dir, 'run-1', 'simulation.log'));
  execFileSync('tar', ['-czf', join(dir, 'bundle.tgz'), '-C', dir, 'run-1']);
  bundle = readFileSync(join(dir, 'bundle.tgz'));
  await blobs.ensureBucket();
});

/** A pending upload of the reference bundle, the shape POST /v1/runs leaves. */
async function pendingUpload(): Promise<string> {
  const key = `runs/${projectId}/${randomUUID()}.tgz`;
  await blobs.putStream(key, Readable.from([bundle]), 100_000_000);
  const run = await prisma.run.create({
    data: {
      orgId, projectId, status: 'pending', tool: 'gatling',
      bundleKey: key,
      bundleSha256: createHash('sha256').update(bundle).digest('hex'),
      bundleBytes: BigInt(bundle.length),
      startedAt: new Date('2026-08-07T10:00:00Z'),
      startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {},
    },
  });
  return run.id;
}

describe('the pipeline, end to end', () => {
  /** THE WIRING, not the statement: two real uploads of one simulation,
   *  processed by the real PipelineService, land in one auto-created test as
   *  Run 1 and Run 2. Removing the call from the pipeline fails this alone. */
  it('numbers two uploads of one simulation 1 then 2', async () => {
    const pipeline = new PipelineService(config, prisma, pool, blobs);
    const first = await pendingUpload();
    await pipeline.process(first);
    const second = await pendingUpload();
    await pipeline.process(second);

    const a = await numberOf(first);
    const b = await numberOf(second);
    expect(a.testId).not.toBeNull();
    expect(b.testId).toBe(a.testId);
    expect([a.runNumber, b.runNumber]).toEqual([1, 2]);
  });

  /** ═══ KEEPING A NUMBER NEVER NEEDS THE TEST ROW — THE REAL FINALIZE ═══
   *
   *  A run its live header already numbered in T, finalized by the real
   *  `PipelineService` while another transaction holds T's row FOR UPDATE, as
   *  a delete holds it. Keeping a number writes nothing, so the terminal
   *  UPDATE — test_id unchanged, the row not yet written by this transaction —
   *  runs no foreign-key check and never asks for T. A keep arm that REWROTE
   *  the row made that UPDATE re-check the key and queue behind the holder:
   *  the wait the first residual turns into a deadlock.
   *
   *  Raced rather than awaited: the finalize either finishes, or some backend
   *  is seen waiting on the holder — never a timeout standing in for either. */
  it('finalizes a run already numbered in its test without waiting on the test row', async () => {
    const pipeline = new PipelineService(config, prisma, pool, blobs);
    const first = await pendingUpload();
    await pipeline.process(first);
    const testId = (await numberOf(first)).testId!;
    const second = await pendingUpload();
    expect(await attachLiveRunToTest(pool, second, testId)).toBe(2);

    const holder = await pool.connect();
    const holderPid = await pidOf(holder);
    let processed: Promise<string> | undefined;
    let race = 'not started';
    let result = 'not started';
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM test WHERE id = $1 FOR UPDATE', [testId]);

      let settled = false;
      processed = pipeline.process(second).then(
        () => 'finished',
        (err: unknown) => `rejected ${codeOf(err)}`,
      );
      void processed.finally(() => {
        settled = true;
      });

      const deadline = Date.now() + 60_000;
      for (;;) {
        if (settled) {
          race = 'finished first';
          break;
        }
        const { rows } = await pool.query<{ ok: boolean }>(BLOCKED_BY, [holderPid]);
        if (rows[0]?.ok === true) {
          race = 'waited on the test row';
          break;
        }
        if (Date.now() > deadline) throw new Error('the finalize neither finished nor waited');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      result = (await processed) ?? result;
      holder.release();
    }

    expect(race).toBe('finished first');
    expect(result).toBe('finished');
    expect(await numberOf(second)).toEqual({ testId, runNumber: 2 });
    expect(await counterOf(testId)).toBe(3);
  });
});
