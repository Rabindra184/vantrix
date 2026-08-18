import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LiveDeltaSchema, type LiveDelta } from '@perfportal/contracts';
import { createPool, createPrisma } from '@perfportal/persistence';
import { parseSimulationLog, StreamingLogDecoder } from '@perfportal/plugin-gatling';
import { runEngine, type EngineResult } from '@perfportal/statistics';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { LiveFoldOwner } from '../src/live/fold-owner.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

const config = loadWorkerConfig({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? '',
});
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);
const blobs = new BlobStore(config.blob);
const chunks = new LiveChunkStore(blobs);

let log: Buffer;

beforeAll(async () => {
  log = readFileSync(FIXTURE_LOG);
  await blobs.ensureBucket();
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

const TABLES = [
  'run_assertion', 'run_error', 'run_series_bucket', 'run_user_bucket', 'run_stat',
  'run', 'sla_rule', 'api_token', 'project', 'org',
  'org_member', 'session', 'account', 'verification', 'user',
];

async function truncateAll(): Promise<void> {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
}

async function seedOrgProject(): Promise<{ orgId: string; projectId: string }> {
  // Unique slug per call (org.slug is globally @unique) so a test that seeds
  // several runs, or runs after another test in this file, never collides.
  const org = await prisma.org.create({ data: { slug: `acme-${randomUUID()}`, name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  return { orgId: org.id, projectId: project.id };
}

/**
 * Shaped like pipeline.integration.test.ts's seedLiveRun (Task 9's live-run
 * shape: status 'running', bundleKey ending in /simulation.log, a non-zero
 * streamOffset) so this file and that one share one definition of "a live
 * run in the database". Two differences, both because this file's subject
 * is the fold owner rather than the pipeline:
 *
 *  - it does NOT truncate -- several cases below seed more than one running
 *    run in a single test, so truncation has to be the caller's job
 *    (`truncateAll`, called once per `it`);
 *  - it never writes a `bundleKey` object. `LiveFoldOwner` never reads
 *    `bundleKey` -- only `LiveChunkStore`'s chunk objects, which callers
 *    `put` separately -- so there is nothing there for it to be wrong about.
 */
async function seedRunningRun(
  orgId: string,
  projectId: string,
  rawLogLength: number,
): Promise<string> {
  const startedAt = new Date('2026-08-07T10:00:00Z');
  const run = await prisma.run.create({
    data: {
      orgId, projectId, status: 'running', tool: 'gatling',
      bundleKey: `runs/test/${randomUUID()}/simulation.log`,
      bundleSha256: createHash('sha256').update(randomUUID()).digest('hex'),
      bundleBytes: BigInt(rawLogLength), streamOffset: BigInt(rawLogLength),
      startedAt, startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {},
    },
  });
  return run.id;
}

const runStat = (r: EngineResult) => r.stats.find((s) => s.scope === 'run' && s.family === 'response_time');

/**
 * The byte offset the fixture's Gatling header ends at, discovered rather
 * than hard-coded (CLAUDE.md's "expectations are computed from the payload"
 * rule): feed the reference log to a fresh decoder one byte at a time and
 * take the first offset at which `consumedBytes` moves off zero -- that is
 * exactly the instant the header's own meta event is fully parsed and
 * nothing else has been consumed yet (mirrors the boundary-walk technique
 * `packages/plugin-gatling/test/stream.test.ts` already uses for the same
 * kind of "where does record N end" question).
 */
function headerLength(fullLog: Buffer): number {
  const probe = new StreamingLogDecoder();
  for (let i = 0; i < fullLog.length; i++) {
    probe.push(fullLog.subarray(i, i + 1));
    if (probe.consumedBytes > 0) return probe.consumedBytes;
  }
  throw new Error('fixture never emitted a meta event');
}

describe('LiveFoldOwner', () => {
  it('folds a streaming run to the same numbers a batch parse produces', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);
    for (let at = 0; at < log.length; at += 8192) {
      await chunks.put(runId, at, log.subarray(at, Math.min(at + 8192, log.length)));
    }

    // try/finally throughout this file: each owned run holds a pooled
    // client for its lock's whole lifetime (see LiveFoldOwner), so a case
    // that throws before its own owner.close() would otherwise leak that
    // client past the end of the test -- and afterAll's pool.end() then
    // hangs waiting for it, turning one assertion failure into a
    // hookTimeout that hides the real error.
    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      await owner.tick();

      const live = owner.snapshotOf(runId);
      const batch = runEngine(parseSimulationLog(log));

      expect(live).not.toBeNull();
      expect(runStat(live!)!.count).toBe(runStat(batch)!.count);
      expect(runStat(live!)!.okCount).toBe(runStat(batch)!.okCount);
      expect(runStat(live!)!.koCount).toBe(runStat(batch)!.koCount);
    } finally {
      await owner.close();
    }
  });

  it('folds only the new bytes on a second tick', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);
    const half = Math.floor(log.length / 2);
    await chunks.put(runId, 0, log.subarray(0, half));

    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      await owner.tick();
      const partial = runStat(owner.snapshotOf(runId)!)!;
      expect(partial.count).toBeGreaterThan(0);

      await chunks.put(runId, half, log.subarray(half));
      await owner.tick();
      const full = runStat(owner.snapshotOf(runId)!)!;

      const batch = runStat(runEngine(parseSimulationLog(log)))!;
      expect(full.count).toBeGreaterThan(partial.count);
      expect(full.count).toBe(batch.count);
      expect(full.okCount).toBe(batch.okCount);
      expect(full.koCount).toBe(batch.koCount);
    } finally {
      await owner.close();
    }
  });

  it('two owners race for one run and exactly one wins', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);
    await chunks.put(runId, 0, log);

    const a = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    const b = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      await a.tick();
      await b.tick();

      const owned = [a.snapshotOf(runId), b.snapshotOf(runId)].filter((s) => s !== null);
      expect(owned).toHaveLength(1);
      // And the winner actually folded -- the loser must not have raced it
      // to a half-folded state.
      expect(runStat(owned[0]!)!.count).toBeGreaterThan(0);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('releases a run that has left running, and frees its lock', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);
    await chunks.put(runId, 0, log);

    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    const other = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      await owner.tick();
      expect(owner.snapshotOf(runId)).not.toBeNull();

      await pool.query(`UPDATE run SET status = 'parsing' WHERE id = $1`, [runId]);
      await owner.tick();
      expect(owner.snapshotOf(runId)).toBeNull();

      // The lock is genuinely free: a second owner can now claim it.
      await pool.query(`UPDATE run SET status = 'running' WHERE id = $1`, [runId]);
      await other.tick();
      expect(other.snapshotOf(runId)).not.toBeNull();
    } finally {
      await other.close();
      await owner.close();
    }
  });

  it('does not exceed maxOwnedRuns', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const runId = await seedRunningRun(orgId, projectId, log.length);
      await chunks.put(runId, 0, log);
      runIds.push(runId);
    }

    const owner = new LiveFoldOwner({ ...config, maxOwnedRuns: 2 }, pool, chunks, new Redis(config.redisUrl));
    try {
      await owner.tick();

      const ownedCount = runIds.filter((id) => owner.snapshotOf(id) !== null).length;
      expect(ownedCount).toBe(2);
    } finally {
      await owner.close();
    }
  });

  /**
   * THE cursor case. Design §2.2.1: the cursor `readFrom` needs is the FETCH
   * FRONTIER (the highest byte already retrieved), never
   * `decoder.consumedBytes` (the last WHOLE-RECORD boundary, which routinely
   * sits behind it). Passing `consumedBytes` re-selects chunks already
   * delivered; the decoder splices them in again after the tail it correctly
   * retained, and decoding corrupts silently from there on.
   *
   * The whole point of this case is to make that corruption actually
   * reachable, which needs BOTH of the following at once:
   *
   *  - storage chunks smaller than a record (4 bytes -- the median record in
   *    this fixture is ~22 bytes, per a byte-at-a-time boundary walk), so
   *    that the gap between `consumedBytes` and the true frontier spans
   *    several separately-stored chunk KEYS rather than landing inside a
   *    single already-fully-consumed one; a large chunk (e.g. 8192 bytes, as
   *    the first case above uses) would not reliably trigger this, because
   *    the gap almost never reaches back across a whole such chunk's start
   *    offset.
   *  - several ticks with new bytes arriving between them, so a tick's fold
   *    genuinely ends on a partial trailing record (an ordinary streaming
   *    condition) and the NEXT tick's `readFrom` argument is exercised.
   *
   * With the cursor set to `decoder.consumedBytes` this case fails (either a
   * thrown decode error or corrupted counts, from feeding the decoder
   * duplicate bytes); with the fetch frontier it passes.
   */
  it('folds correctly when chunks are smaller than a single record, across several ticks', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);

    const STORAGE_CHUNK = 4;      // smaller than every record in the fixture (min ~10 bytes)
    const TICK_BATCH = 4096;      // bytes newly available between ticks; not record-aligned

    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      let written = 0;
      while (written < log.length) {
        const batchEnd = Math.min(written + TICK_BATCH, log.length);
        for (let at = written; at < batchEnd; at += STORAGE_CHUNK) {
          const end = Math.min(at + STORAGE_CHUNK, batchEnd);
          await chunks.put(runId, at, log.subarray(at, end));
        }
        written = batchEnd;
        await owner.tick();
      }
      // A final tick is a no-op (nothing new since the last batch) but keeps
      // this symmetric with how a real owner would run.
      await owner.tick();

      const live = owner.snapshotOf(runId);
      expect(live).not.toBeNull();
      const batch = runEngine(parseSimulationLog(log));

      expect(runStat(live!)!.count).toBe(runStat(batch)!.count);
      expect(runStat(live!)!.okCount).toBe(runStat(batch)!.okCount);
      expect(runStat(live!)!.koCount).toBe(runStat(batch)!.koCount);
    } finally {
      await owner.close();
    }
  }, 120_000);

  /**
   * Fix round 1, Important 3. `tick()` used to await `#fold` for each owned
   * run with no per-run try/catch, so one run's fold throwing aborted the
   * whole pass -- every OTHER owned run silently got no fold that tick, with
   * nothing to distinguish it from an idle tick. Reachable in the ordinary
   * course of operation, not just synthetically: `LiveChunkStore.finalize`
   * (`close()`'s path) lists a run's chunk keys and then deletes them, so a
   * key `readFrom` listed can be deleted before its own parallel `get` runs.
   *
   * The "bad" run's corruption here is a genuinely thrown decode error (not
   * a `TruncatedError`, which `StreamingLogDecoder` already handles by
   * buffering and returning cleanly) -- a valid header immediately followed
   * by one byte that is not any of `header.ts`'s five real record types, so
   * `readRecord`'s `default` branch throws before returning any events at
   * all. `headerLength` is derived from the fixture, not hard-coded.
   */
  it('one owned run failing to fold does not stop another owned run folding in the same tick', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();

    const goodRunId = await seedRunningRun(orgId, projectId, log.length);
    await chunks.put(goodRunId, 0, log);

    const badRunId = await seedRunningRun(orgId, projectId, log.length);
    const corrupted = Buffer.concat([log.subarray(0, headerLength(log)), Buffer.from([0xfe])]);
    await chunks.put(badRunId, 0, corrupted);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      await expect(owner.tick()).resolves.toBeUndefined();

      // Exactly one failure logged, and it names the bad run -- proves the
      // isolation caught and reported it rather than the tick somehow
      // avoiding the throw altogether.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toContain(`fold failed for run ${badRunId}`);

      const good = owner.snapshotOf(goodRunId);
      expect(good).not.toBeNull();
      const batch = runEngine(parseSimulationLog(log));
      expect(runStat(good!)!.count).toBe(runStat(batch)!.count);
      expect(runStat(good!)!.okCount).toBe(runStat(batch)!.okCount);
      expect(runStat(good!)!.koCount).toBe(runStat(batch)!.koCount);

      // The bad run stays owned (a failed fold is retried, not evicted) but
      // nothing was ever folded into it -- decoder.push threw before
      // returning any events, so engine.add was never called and no
      // run-scope rollup exists yet at all.
      const bad = owner.snapshotOf(badRunId);
      expect(bad).not.toBeNull();
      expect(runStat(bad!)).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
      await owner.close();
    }
  });

  /**
   * Fix round 1, Important 4. `#fold` used to advance `fetchedBytes` AFTER
   * decoding, so a throw from `decoder.push` (which mutates the decoder's
   * buffer before it can ever throw) or `engine.add` left the frontier right
   * where it was. The next tick would then `readFrom` the SAME argument,
   * fetch the SAME corrupt bytes again, and feed them to the decoder a
   * second time -- re-delivery, design §2.2.1's exact corruption, reached
   * via the failure path instead of a wrong cursor formula.
   *
   * This is observed through a `console.error` spy rather than through
   * `snapshotOf`: once a decode throws, the run's engine can never reach a
   * comparable-to-batch state again (the decoder's own read position is left
   * wherever the throwing record left it -- not this task's concern to fix,
   * `plugin-gatling` is untouched here). What IS this task's concern, and
   * what the spy makes observable, is whether the SAME error recurs on a
   * later tick with nothing new to fold: recurrence is the fingerprint of
   * re-delivery, and its absence is the fingerprint of the frontier having
   * moved.
   */
  it('advances the frontier even when a fold throws, so a later tick does not keep re-delivering the same bytes', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);

    const corrupted = Buffer.concat([log.subarray(0, headerLength(log)), Buffer.from([0xfe])]);
    await chunks.put(runId, 0, corrupted);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      await owner.tick();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toContain(`fold failed for run ${runId}`);

      // Nothing new was put since. If the frontier had not moved, this tick
      // re-fetches the identical corrupted bytes and throws the identical
      // error again -- a SECOND console.error call. With the frontier
      // advanced, readFrom(runId, fetchedBytes) now returns empty and
      // #fold's own `if (bytes.length === 0) return;` makes this a clean
      // no-op: the call count must stay at exactly one.
      await owner.tick();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
      await owner.close();
    }
  });

  /**
   * Fix round 1, Important 2. Task 5 drives `tick()` from a fire-and-forget
   * `setInterval` that never awaits the previous call (the same shape
   * `main.ts` already uses for the sweeper), and design §2.1 says claiming a
   * run that already streamed 200 MB means folding 200 MB before its first
   * delta -- routinely longer than the 5000 ms default `liveTickMs`. Without
   * a guard, an overlapping second `tick()` would run its own claim/fold
   * passes concurrently with the first over the SAME `#owned` map: two
   * `#fold` calls for one already-owned run both read `state.fetchedBytes`
   * before either advances it, both fetch the identical range, and both
   * push it into the SAME shared decoder -- design §2.2.1's corruption
   * again, this time from real concurrency rather than a wrong cursor.
   */
  it('ignores an overlapping tick instead of racing the previous one over the same owned run', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);
    const half = Math.floor(log.length / 2);
    await chunks.put(runId, 0, log.subarray(0, half));

    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      await owner.tick();
      const partial = runStat(owner.snapshotOf(runId)!)!;
      expect(partial.count).toBeGreaterThan(0);

      await chunks.put(runId, half, log.subarray(half));

      // Neither awaited before the other starts: the guard is checked and
      // set synchronously, before tick()'s first `await`, so calling it
      // twice back to back like this deterministically exercises it rather
      // than depending on a lucky interleaving.
      const first = owner.tick();
      const secondStart = Date.now();
      const second = owner.tick();
      await second;
      const secondElapsedMs = Date.now() - secondStart;
      await first;

      // THE discriminating assertion. An ignored call resolves off an
      // already-true flag check, synchronously, before its body ever issues
      // a query -- a microtask, not a network round trip. A call that ran
      // its OWN real pass instead (guard absent) does at minimum one
      // `SELECT` against Postgres plus a `LiveChunkStore.readFrom` (a blob
      // LIST plus GETs), which on this stack is consistently tens of
      // milliseconds (the "does not exceed maxOwnedRuns" case's whole
      // tick(), across three seeded runs, takes ~300ms end to end). 15ms
      // leaves a wide, deliberately non-flaky margin below that floor while
      // still being generous for CI jitter around a genuinely-instant
      // early return.
      //
      // A same-process race between the two calls' OWN independent queries
      // (asserting `second` merely finishes before `first`) was tried first
      // and rejected: with comparable real work on both sides, either can
      // legitimately finish first by chance, which observably made that
      // version pass even with the guard removed. Elapsed time against an
      // absolute floor does not have that failure mode.
      expect(secondElapsedMs).toBeLessThan(15);

      const full = runStat(owner.snapshotOf(runId)!)!;
      const batch = runStat(runEngine(parseSimulationLog(log)))!;
      // Not the discriminating assertion (a losing racer's decoder.push
      // throwing before its own engine.add loop runs can leave the winner's
      // correct fold intact even without the guard -- Important 3's
      // isolation absorbs that particular shape of corruption too), but
      // still worth asserting: the guarded, intended behaviour must also
      // reach the right numbers, not just resolve quickly.
      expect(full.count).toBe(batch.count);
      expect(full.okCount).toBe(batch.okCount);
      expect(full.koCount).toBe(batch.koCount);
    } finally {
      await owner.close();
    }
  });

  /**
   * Fix round 1, Important 6. `close()` used to await `#release` in a
   * sequential loop with no per-run isolation, so one run's unlock query
   * throwing abandoned every run still left in `#owned` at that point in
   * iteration order -- leaking exactly the pooled connections this method's
   * own doc comment says it exists to prevent leaking, for every run after
   * the failing one.
   *
   * The failure is forced WITHOUT touching a real connection.
   * `pg_terminate_backend` was tried first and rejected: pg-pool removes a
   * checked-out client's error listener for exactly as long as it is
   * checked out (`_acquireClient`'s own `client.removeListener('error',
   * idleListener)`, restored only once `.release()` runs), so the SAME
   * termination that correctly rejects the in-flight unlock query also, in
   * that window, fires a raw, unlistened socket-level 'error' -- observed
   * to sometimes crash the whole test worker outright rather than merely
   * fail the one test, which is not an acceptable price for one assertion.
   *
   * Instead, every client this pool hands out for the rest of this test has
   * its `query` method wrapped to intercept exactly ONE call -- the unlock
   * bound to `badRunId` -- and reject it synthetically; every other call,
   * including badRunId's own lock ACQUIRE and everything for `goodRunId`,
   * passes straight through to the real client. Matched on the call's own
   * bound parameter, not on claim order, so this does not depend on which
   * run happens to get claimed first.
   */
  it('settles every release even when one fails, and surfaces the failure', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const goodRunId = await seedRunningRun(orgId, projectId, log.length);
    const badRunId = await seedRunningRun(orgId, projectId, log.length);
    await chunks.put(goodRunId, 0, log);
    await chunks.put(badRunId, 0, log);

    // Installed BEFORE the claim, not just before close(): #release reuses
    // the SAME client object #claim originally obtained from pool.connect
    // (see FoldState.client's own doc comment -- taken and released on
    // THIS client, never a different one), so the wrapper has to be in
    // place at claim time for badRunId's eventual unlock call to be the
    // wrapped instance's, not the real one's.
    //
    // pool.connect is overloaded (a bare Promise-returning form -- what
    // LiveFoldOwner itself calls -- AND a callback form pg-pool's OWN
    // `pool.query()` convenience method calls internally, including for
    // the plain `pool.query(...)` calls this very test file's helpers use).
    // The first attempt at this mock handled only the Promise form and
    // silently hung the whole suite: `pool.query()` awaits its callback
    // being invoked, and a mock that never calls it never resolves.
    // Both forms are handled here for exactly that reason.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwarding pg.Pool#connect's own overloaded signature verbatim
    const realConnect = pool.connect.bind(pool) as (...a: any[]) => any;
    function wrapClient(client: pg.PoolClient): pg.PoolClient {
      const realQuery = client.query.bind(client);
      vi.spyOn(client, 'query').mockImplementation(((...args: unknown[]) => {
        const [text, params] = args;
        const isBadRunUnlock =
          typeof text === 'string' &&
          text.includes('pg_advisory_unlock') &&
          Array.isArray(params) &&
          params[1] === badRunId;
        if (isBadRunUnlock) return Promise.reject(new Error('synthetic unlock failure for test'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwarding pg.PoolClient#query's own overloaded signature verbatim
        return (realQuery as any)(...args);
      }) as typeof client.query);
      return client;
    }
    vi.spyOn(pool, 'connect').mockImplementation(((cb?: (...a: unknown[]) => void) => {
      if (typeof cb === 'function') {
        return realConnect((err: Error | null, client: pg.PoolClient | undefined, release: unknown) => {
          if (client) wrapClient(client);
          cb(err, client, release);
        });
      }
      return (realConnect() as Promise<pg.PoolClient>).then(wrapClient);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching pool.connect's own overloaded signature
    }) as any);

    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      await owner.tick();
      expect(owner.snapshotOf(goodRunId)).not.toBeNull();
      expect(owner.snapshotOf(badRunId)).not.toBeNull();

      await expect(owner.close()).rejects.toThrow(/failed to release 1 of 2/);

      // The good run's release still ran despite the bad one's failure:
      // its lock is genuinely free, provable by a fresh owner claiming it
      // immediately on the very next tick. The bad run is moved off
      // 'running' first, purely so this owner's discovery poll does not
      // also attempt to re-claim it -- badRunId's REAL advisory lock is
      // still genuinely held (the synthetic rejection never actually ran
      // pg_advisory_unlock against Postgres), so its own recovery is not
      // this assertion's concern, only the good run's is.
      await pool.query(`UPDATE run SET status = 'parsing' WHERE id = $1`, [badRunId]);
      const other = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
      try {
        await other.tick();
        expect(other.snapshotOf(goodRunId)).not.toBeNull();
      } finally {
        await other.close();
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  /**
   * Fix round 1, Critical 1. `maxOwnedRuns` (default 25) against
   * `createPool`'s OLD default pool size (`max: 10`, no
   * `connectionTimeoutMillis`) did not degrade -- it deadlocked the whole
   * worker the instant an eleventh run needed a connection: `pool.connect()`
   * queues forever under pg's own default timeout of 0, `tick()` never
   * reaches its fold loop, and everything else sharing that pool (in
   * production, `PipelineService` and `Sweeper`) starves behind it. No
   * error, no timeout, no log -- see design part-2a §1.3 as amended.
   *
   * This owner's own `maxOwnedRuns` (3) is deliberately larger than the
   * dedicated pool's `max` (2): the CAP is not what is under test here (the
   * "does not exceed maxOwnedRuns" case above already covers that), the
   * POOL'S OWN BOUND is. With `connectionTimeoutMillis` set, a claim beyond
   * what the pool can hand out fails fast (caught by Important 3's per-run
   * isolation, logged, not propagated) rather than hanging -- provable by
   * elapsed time staying well under what "hangs until the test runner gives
   * up" would look like, and by exactly `pool.max` runs ending up owned,
   * never more.
   */
  it('a claim beyond what the pool can hand out fails fast rather than hanging tick()', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const runId = await seedRunningRun(orgId, projectId, log.length);
      await chunks.put(runId, 0, log);
      runIds.push(runId);
    }

    const smallPool = createPool(config.databaseUrl, { max: 2, connectionTimeoutMillis: 500 });
    const owner = new LiveFoldOwner({ ...config, maxOwnedRuns: 3 }, smallPool, chunks, new Redis(config.redisUrl));
    try {
      const start = Date.now();
      await owner.tick();
      const elapsedMs = Date.now() - start;

      // Bounded by the pool's own timeout (500ms) times, at most, the
      // number of runs that cannot get a connection (at most one, since
      // only a THIRD claim can ever be starved with pool max 2 and 3 runs)
      // -- nowhere near "hangs until the runner's own timeout fires".
      expect(elapsedMs).toBeLessThan(5000);

      const ownedCount = runIds.filter((id) => owner.snapshotOf(id) !== null).length;
      expect(ownedCount).toBe(2);
    } finally {
      await owner.close();
      await smallPool.end();
    }
  });

  /**
   * Task 5's own case. Design §3.1: "Each tick, for every owned run:
   * snapshot, build a delta, publish." The subscriber is a SEPARATE `Redis`
   * connection from the owner's own -- ioredis puts a connection into
   * subscriber mode on `subscribe()` and it cannot then issue normal
   * commands, so the owner's publisher and the test's subscriber can never
   * be the same client.
   *
   * `seen[0].responseTime.replaces` (not a flat `replacesSeries`, per the
   * two-envelope shape design §3.2 settled on after the brief was written)
   * proves the wire shape actually matches `LiveDeltaSchema` -- if `#publish`
   * emitted the brief's original flat shape, `LiveDeltaSchema.parse` above
   * would already have thrown before this line ever ran.
   */
  it('publishes a delta per tick, with monotonic seq and append-only series', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);

    const sub = new Redis(config.redisUrl);
    const seen: LiveDelta[] = [];
    await sub.subscribe(`live:${runId}`);
    sub.on('message', (_channel, message: string) => {
      seen.push(LiveDeltaSchema.parse(JSON.parse(message)));
    });

    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      const half = Math.floor(log.length / 2);
      await chunks.put(runId, 0, log.subarray(0, half));
      await owner.tick();
      await chunks.put(runId, half, log.subarray(half));
      await owner.tick();

      await vi.waitFor(() => expect(seen.length).toBe(2));
      expect(seen.map((d) => d.seq)).toEqual([0, 1]);
      // The FIRST delta for any run is always a replacement -- INITIAL_CURSOR's
      // lastBucketWidthMs (0) never equals a real bucket width. See
      // delta.ts's own "THE COALESCE RULE" doc comment.
      expect(seen[0]!.responseTime.replaces).toBe(true);
      expect(seen[1]!.summary.count).toBeGreaterThan(seen[0]!.summary.count);
      // Two separate envelopes, each with its own width (design §3.2) --
      // not one shared width/flag pair on the delta as a whole.
      expect(seen[0]!.responseTime.widthMs).toBeGreaterThan(0);
      expect(seen[0]!.users.widthMs).toBeGreaterThan(0);
      expect(Array.isArray(seen[0]!.users.buckets)).toBe(true);
    } finally {
      await sub.quit();
      await owner.close();
    }
  });

  /**
   * Design §3.4: "Published to `live:{runId}` (pub/sub, for Part 2b's
   * fan-out) **and** appended to `live:{runId}:deltas` with `MAXLEN
   * ~200`." Part 2a writes that stream even though nothing reads it until
   * Part 2b -- this is the case that proves the writer actually works,
   * which is what makes that later reader testable against something real.
   */
  it('appends every delta to the capped replay stream', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);

    const redis = new Redis(config.redisUrl);
    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      const half = Math.floor(log.length / 2);
      await chunks.put(runId, 0, log.subarray(0, half));
      await owner.tick();
      await chunks.put(runId, half, log.subarray(half));
      await owner.tick();

      const streamKey = `live:${runId}:deltas`;
      expect(await redis.xlen(streamKey)).toBe(2);

      const entries = await redis.xrange(streamKey, '-', '+');
      // Each XRANGE entry is `[id, [field, value, field, value, ...]]` --
      // `'delta'` is the one field name `#publish`'s XADD call wrote.
      const deltas = entries.map(([, fields]) => {
        const idx = fields.indexOf('delta');
        return LiveDeltaSchema.parse(JSON.parse(fields[idx + 1] as string));
      });
      // The SAME seqs the pub/sub subscriber above would have seen -- one
      // wire contract, two destinations, not two independently-numbered ones.
      expect(deltas.map((d) => d.seq)).toEqual([0, 1]);
      expect(deltas[0]!.responseTime.replaces).toBe(true);
      expect(deltas[1]!.summary.count).toBeGreaterThan(deltas[0]!.summary.count);
    } finally {
      await redis.quit();
      await owner.close();
    }
  });

  /**
   * Fix round 1, Important 1. `#publish` used to advance `state.cursor` to
   * `next` BEFORE either Redis call, on the theory that a `seq` gap alone
   * is what a consumer needs to detect a dropped delta. That is true for
   * `seq` -- it is NOT true for `next.lastBucketWidthMs`, which
   * `buildDelta`'s coalesce rule (design §3.3) reasons from on the NEXT
   * call: if a publish that would have flagged `replaces: true` fails, and
   * the cursor advances anyway, the FOLLOWING tick sees
   * `prev.lastBucketWidthMs` already equal to the current width and wrongly
   * computes `replaces: false` -- a plain upsert for a series the consumer
   * never received the replacement for. Silent from then on, exactly what
   * §3.3 calls "not optional".
   *
   * The very FIRST delta for any run is always a `replaces: true` tick
   * (`INITIAL_CURSOR.lastBucketWidthMs` is 0, and no real width is ever
   * 0 -- see `delta.ts`'s own "the very first delta is a replacement for
   * the same mechanism" comment), which makes it the one coalesce-flagged
   * tick reachable through `LiveFoldOwner`'s real, unmodified engine
   * defaults without forcing an actual mid-run bucket coalesce: the
   * `buildDelta` comparison this test exercises
   * (`responseWidthMs !== prev.lastBucketWidthMs`) is identical whether
   * `prev` is the `INITIAL_CURSOR` sentinel or a genuine prior width, and a
   * true mid-run coalesce needs far more buckets than this fixture's ~63s
   * duration can produce against `LiveEngine`'s default `maxBucketsRun`
   * (1200) -- `#claim` constructs the engine with no override, and adding
   * one is out of this fix's scope.
   */
  it('preserves the coalesce replacement flag across a failed publish, so the next tick still replaces rather than silently upserting', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);
    await chunks.put(runId, 0, log);

    const publisherRedis = new Redis(config.redisUrl);
    // Fails ONLY the very first PUBLISH -- #guarded catches it and logs, so
    // tick() itself still resolves; XADD is never reached for that attempt
    // (#publish's own try/catch never calls it once publish rejects).
    const publishSpy = vi
      .spyOn(publisherRedis, 'publish')
      .mockRejectedValueOnce(new Error('synthetic publish failure'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const owner = new LiveFoldOwner(config, pool, chunks, publisherRedis);
    try {
      await owner.tick();
      expect(
        errorSpy.mock.calls.some(
          (c) => typeof c[0] === 'string' && c[0].includes(`publish failed for run ${runId}`),
        ),
      ).toBe(true);
      publishSpy.mockRestore();

      const sub = new Redis(config.redisUrl);
      const seen: LiveDelta[] = [];
      await sub.subscribe(`live:${runId}`);
      sub.on('message', (_channel, message: string) => {
        seen.push(LiveDeltaSchema.parse(JSON.parse(message)));
      });

      // Nothing new to fold, but the owner still ticks and publishes again
      // -- the run's very first SUCCESSFULLY-delivered delta. Under the
      // bug, `state.cursor.lastBucketWidthMs` was already set to the real
      // width by the failed first attempt, so this tick would wrongly
      // compute `replaces: false`.
      await owner.tick();
      await vi.waitFor(() => expect(seen.length).toBe(1));

      expect(seen[0]!.responseTime.replaces).toBe(true);
      // seq still advanced across the failed attempt (0 was never
      // delivered to anyone) -- proves the fix does not repeat a seq value,
      // only the fields that gate the replacement flag are preserved.
      expect(seen[0]!.seq).toBe(1);

      await sub.quit();
    } finally {
      errorSpy.mockRestore();
      await owner.close();
    }
  });

  /**
   * Fix round 1, Important 2. `close()` used to set `#closing` and then
   * AWAIT the in-flight tick before draining `#owned`, on the theory that
   * only a fully-settled tick could guarantee every `#claim` it started had
   * already inserted its `FoldState`. That guarantee was real, but a tick
   * genuinely stuck in `readFrom` (blob storage's client sets no request
   * timeout) made `close()` -- and therefore `main.ts`'s whole
   * `shutdown()` -- hang forever, WORSE than before this class had any
   * interlock at all.
   *
   * The fix moves the leak-closing check to `#claim` itself: a claim that
   * wins its lock after `#closing` is already true unwinds itself (unlock,
   * release the client) instead of inserting. `close()` no longer needs to
   * wait for anything.
   *
   * Same gating technique as the previous round's version of this case
   * (`pool.connect`'s promise-form call for `#claim` is held open by a
   * manually-released gate; its callback form, which `pool.query`'s own
   * internal use of `connect` goes through, is left completely alone), but
   * the assertions now prove the OPPOSITE property: `close()` resolves
   * WITHOUT the gate ever being released, and only once it is released
   * afterward does the delayed claim discover `#closing` and unwind --
   * proven by a fresh owner immediately re-claiming the same run's lock.
   */
  it('close() does not wait for an in-flight tick, and a claim that resolves afterward does not leak its client', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);
    await chunks.put(runId, 0, log);

    let releaseClaim: (() => void) | undefined;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let claimStarted: (() => void) | undefined;
    const claimStartedPromise = new Promise<void>((resolve) => {
      claimStarted = resolve;
    });

    let promiseFormCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwarding pg.Pool#connect's own overloaded signature verbatim
    const realConnect = pool.connect.bind(pool) as (...a: any[]) => any;
    vi.spyOn(pool, 'connect').mockImplementation(((cb?: (...a: unknown[]) => void) => {
      if (typeof cb === 'function') return realConnect(cb);
      promiseFormCalls += 1;
      if (promiseFormCalls === 1) {
        claimStarted!();
        return claimGate.then(() => realConnect());
      }
      return realConnect();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching pool.connect's own overloaded signature
    }) as any);

    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      const tickPromise = owner.tick();
      await claimStartedPromise; // #claim's own connect() call is now gated, in flight

      const closeStart = Date.now();
      await owner.close(); // must resolve WITHOUT the gate ever being released
      const closeElapsedMs = Date.now() - closeStart;
      // Generous bound, well above what an empty-map drain plus a redis
      // quit needs, and well below "waited for a gate nothing released" --
      // the discriminating evidence that close() did not wait this time.
      expect(closeElapsedMs).toBeLessThan(300);

      // Only now let the delayed claim resolve -- it wins the lock (no one
      // else holds it) but must find #closing already true and unwind.
      releaseClaim!();
      await tickPromise; // the tick itself still completes cleanly

      // The lock is genuinely free: a fresh owner can claim this run
      // immediately, proving the delayed claim's client was released, not
      // leaked, once it discovered #closing.
      const verifier = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
      try {
        await verifier.tick();
        expect(verifier.snapshotOf(runId)).not.toBeNull();
      } finally {
        await verifier.close();
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  /**
   * `#ticking` releases on a throw (every other case in this file already
   * proves that, via `#guarded`) but never on a HANG -- `BlobStore`'s
   * `S3Client` sets no `requestTimeout` (`packages/storage/src/blobs.ts`),
   * so a stalled `readFrom` used to leave `#ticking` true with no error, no
   * log, and no further deltas for ANY owned run, forever.
   * `fold-owner.ts`'s `#checkWatchdog` fixes the SILENCE, deliberately
   * without touching the STUCK-ness itself -- see its own doc comment for
   * why cancelling would risk exactly the concurrent-mutation corruption
   * `#ticking` exists to prevent.
   *
   * Fix round 1, Important 3: the first version of this warning fired
   * exactly ONCE per stuck episode and then fell silent for however long
   * the stall lasted -- while its own doc comments (and this file's
   * original version of this very test) claimed it logged "repeatedly".
   * That was false, and the gap mattered: a single line emitted once,
   * possibly long before an operator investigates, has typically scrolled
   * out of any reasonable log buffer by the time anyone looks. This case
   * now proves the CORRECTED claim -- the warning re-arms and fires again
   * every `WATCHDOG_STUCK_MULTIPLIER` tick-intervals for as long as the
   * stall persists -- rather than merely asserting "exactly one".
   *
   * `readFrom` is mocked to a REAL (bounded) delay rather than a genuine
   * infinite hang, so this test terminates either way; the point under test
   * is whether the watchdog fires REPEATEDLY while it is still pending, not
   * whether the delay is technically finite.
   *
   * The watchdog only checks from `tick()`'s own early-return path (see that
   * method's doc comment for why), so this simulates `main.ts`'s real
   * `setInterval` driver by calling `tick()` repeatedly while the first call
   * is still in flight, exactly as that timer would.
   */
  it('logs a repeating watchdog warning for as long as a fold stays stuck, not just once', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);
    await chunks.put(runId, 0, log);

    // liveTickMs small enough that several watchdog thresholds (6x
    // liveTickMs each, WATCHDOG_STUCK_MULTIPLIER) fit inside STUCK_MS:
    // 6 * 20 = 120ms per threshold, ~4 fit inside 500ms -- comfortable room
    // to observe more than one re-arm without being flaky right at a
    // boundary.
    const STUCK_MS = 500;
    const realReadFrom = chunks.readFrom.bind(chunks);
    const readFromSpy = vi.spyOn(chunks, 'readFrom').mockImplementation((rid: string, offset: number) => {
      if (rid !== runId) return realReadFrom(rid, offset);
      return new Promise((resolve) => {
        setTimeout(() => resolve(realReadFrom(rid, offset)), STUCK_MS);
      });
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const owner = new LiveFoldOwner({ ...config, liveTickMs: 20 }, pool, chunks, new Redis(config.redisUrl));
    try {
      const stuckTick = owner.tick(); // resolves only once STUCK_MS elapses

      const isWatchdogWarning = (call: unknown[]): boolean =>
        typeof call[0] === 'string' && call[0].includes('LiveFoldOwner: tick() has not completed');

      // Simulates main.ts's real setInterval driver: keeps calling tick()
      // (an early return while #ticking is true, checking the watchdog
      // each time) on a cadence finer than the watchdog's own threshold,
      // well past STUCK_MS so the whole stuck episode is observed.
      let polls = 0;
      const deadline = Date.now() + STUCK_MS + 300;
      while (Date.now() < deadline) {
        await owner.tick();
        polls += 1;
        await new Promise((r) => setTimeout(r, 15));
      }
      await stuckTick; // let the originally-stuck tick actually finish

      const watchdogCalls = errorSpy.mock.calls.filter(isWatchdogWarning);
      // Genuinely repeats -- more than the single warning a one-shot flag
      // would have produced. THE discriminating assertion for this fix.
      expect(watchdogCalls.length).toBeGreaterThanOrEqual(2);
      // But throttled to the threshold's own cadence, not fired on every
      // poll -- proves this is "every Nx liveTickMs", not "every
      // early-return call that happens to still find it stuck".
      expect(watchdogCalls.length).toBeLessThan(polls);

      // Each successive message reports a STRICTLY larger elapsed time than
      // the last -- proves these are genuinely separate, later checks, not
      // the same call's arguments inspected more than once.
      const elapsedMsPerCall = watchdogCalls.map((c) => {
        const match = /not completed in over (\d+)ms/.exec(c[0] as string);
        if (!match) throw new Error('watchdog message did not match the expected shape');
        return Number(match[1]);
      });
      for (let i = 1; i < elapsedMsPerCall.length; i++) {
        expect(elapsedMsPerCall[i]).toBeGreaterThan(elapsedMsPerCall[i - 1]!);
      }
    } finally {
      errorSpy.mockRestore();
      readFromSpy.mockRestore();
      await owner.close();
    }
  }, 10_000);

  /**
   * Task 6's own subject: design §1.2's `live:opened` ping should let an
   * owner claim a freshly-created run WITHOUT waiting for `#doTick`'s own
   * discovery poll. `owner.tick()` is deliberately never called anywhere in
   * this case -- calling it would make the assertion pass whether or not
   * the ping itself did anything, since the poll claims the very same run
   * on its own the moment it runs. `vi.waitFor` is what proves the claim
   * happened asynchronously, off the ping's own message handler, rather
   * than off any call this test makes directly.
   */
  it('claims a run immediately on a live:opened ping, without waiting for a tick', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);

    const publisher = new Redis(config.redisUrl);
    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      await owner.listen();
      expect(owner.snapshotOf(runId)).toBeNull();

      await publisher.publish('live:opened', runId);

      await vi.waitFor(() => expect(owner.snapshotOf(runId)).not.toBeNull());
    } finally {
      await publisher.quit();
      await owner.close();
    }
  });

  /**
   * The companion case for `live:advance` (design §2.2 / §2.3): once a run
   * is owned, a ping should fold newly-available bytes without waiting for
   * `tick()`. The run is claimed the ORDINARY way first (one real `tick()`
   * call against the first half of the fixture) so this case isolates the
   * ADVANCE reaction from the OPENED one the case above already covers --
   * only the SECOND half's bytes, and the fold that picks them up, are
   * attributable to the ping.
   */
  it('folds an owned run immediately on a live:advance ping, without waiting for a tick', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);
    const half = Math.floor(log.length / 2);
    await chunks.put(runId, 0, log.subarray(0, half));

    const publisher = new Redis(config.redisUrl);
    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      await owner.listen();
      await owner.tick();
      const partial = runStat(owner.snapshotOf(runId)!)!;
      expect(partial.count).toBeGreaterThan(0);

      await chunks.put(runId, half, log.subarray(half));
      await publisher.publish('live:advance', runId);

      const batch = runStat(runEngine(parseSimulationLog(log)))!;
      await vi.waitFor(() => {
        expect(runStat(owner.snapshotOf(runId)!)!.count).toBe(batch.count);
      });
    } finally {
      await publisher.quit();
      await owner.close();
    }
  });

  /**
   * The negative half of the pair above -- "fold that run IF OWNED" (design
   * §2.3) is a conditional, and this is what proves the condition is
   * actually checked rather than the handler claiming on advance too. If
   * `#onAdvance` claimed instead of no-op'ing for a run it does not hold,
   * this run would show up owned; nothing here ever calls `tick()` or
   * publishes `live:opened`, so there is no other way it could.
   */
  it('a live:advance ping for a run this owner does not own does not claim it', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);
    await chunks.put(runId, 0, log);

    const publisher = new Redis(config.redisUrl);
    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      await owner.listen();
      expect(owner.snapshotOf(runId)).toBeNull();

      await publisher.publish('live:advance', runId);
      // No event to wait FOR (nothing should happen), so this gives message
      // delivery a generous window before asserting its absence, rather
      // than racing the assertion against delivery -- same shape as the
      // API-side negative cases in live.integration.test.ts.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(owner.snapshotOf(runId)).toBeNull();
    } finally {
      await publisher.quit();
      await owner.close();
    }
  });

  /**
   * `#ticking` guards `tick()` against overlapping ITSELF, but a
   * `live:advance` ping calls `#fold` from a `message` event handler
   * entirely outside `tick()` -- so without a SEPARATE guard, a ping
   * arriving while `#doTick`'s own fold loop is mid-`#fold` for that exact
   * run would run a second, concurrent `#fold` against the same
   * `FoldState`. `#fold`'s own doc comment already explains why that
   * corrupts: both calls would read `state.fetchedBytes` before either
   * advances it, both `readFrom` the identical range, and both push it into
   * the SAME shared decoder -- design §2.2.1's corruption, reached across
   * the tick/ping boundary instead of across two overlapping ticks.
   *
   * The tick's own fold is made to STALL inside `readFrom` -- gated on a
   * manually-released promise, not a blind `setTimeout` -- so the ping can
   * be fired at a DETERMINISTIC moment (once the mock proves the tick's
   * fold has actually reached `readFrom`) rather than racing an arbitrary
   * delay against however long claiming and discovering the run happens to
   * take on this run of the test.
   */
  it('a live:advance ping never overlaps a fold already in flight for the same run', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);
    await chunks.put(runId, 0, log);

    let concurrent = 0;
    let maxConcurrent = 0;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let readFromStarted: (() => void) | undefined;
    const readFromStartedPromise = new Promise<void>((resolve) => {
      readFromStarted = resolve;
    });
    const realReadFrom = chunks.readFrom.bind(chunks);
    const readFromSpy = vi.spyOn(chunks, 'readFrom').mockImplementation(async (rid: string, offset: number) => {
      if (rid !== runId) return realReadFrom(rid, offset);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      readFromStarted!(); // the tick's own fold has now reached readFrom -- provably "in flight"
      try {
        await gate;
        return await realReadFrom(rid, offset);
      } finally {
        concurrent -= 1;
      }
    });

    const publisher = new Redis(config.redisUrl);
    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
    try {
      await owner.listen();

      const tickPromise = owner.tick(); // claims runId, then stalls inside the mocked readFrom
      await readFromStartedPromise; // wait for the stall, not a fixed delay

      await publisher.publish('live:advance', runId);
      // Give the ping's message handler + #onAdvance -> #foldOnce a moment
      // to run. If the guard is absent, this is where a SECOND readFrom
      // call for runId would start while the gate is still held, pushing
      // `concurrent` to 2.
      await new Promise((resolve) => setTimeout(resolve, 150));
      // THE discriminating assertion.
      expect(maxConcurrent).toBe(1);

      releaseGate!();
      await tickPromise;

      // Not just "not measurably concurrent" -- genuinely undamaged: the
      // batch numbers still match, which they would NOT if a second
      // concurrent readFrom had spliced duplicate bytes into the decoder.
      const live = owner.snapshotOf(runId);
      const batch = runEngine(parseSimulationLog(log));
      expect(live).not.toBeNull();
      expect(runStat(live!)!.count).toBe(runStat(batch)!.count);
      expect(runStat(live!)!.okCount).toBe(runStat(batch)!.okCount);
      expect(runStat(live!)!.koCount).toBe(runStat(batch)!.koCount);
    } finally {
      readFromSpy.mockRestore();
      await publisher.quit();
      await owner.close();
    }
  });
});
