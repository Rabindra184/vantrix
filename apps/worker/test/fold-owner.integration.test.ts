import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPool, createPrisma } from '@perfportal/persistence';
import { parseSimulationLog, StreamingLogDecoder } from '@perfportal/plugin-gatling';
import { runEngine, type EngineResult } from '@perfportal/statistics';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
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
    // hookTimeout that hides the real error. See the report's RED section.
    const owner = new LiveFoldOwner(config, pool, chunks);
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

    const owner = new LiveFoldOwner(config, pool, chunks);
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

    const a = new LiveFoldOwner(config, pool, chunks);
    const b = new LiveFoldOwner(config, pool, chunks);
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

    const owner = new LiveFoldOwner(config, pool, chunks);
    const other = new LiveFoldOwner(config, pool, chunks);
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

    const owner = new LiveFoldOwner({ ...config, maxOwnedRuns: 2 }, pool, chunks);
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
   * duplicate bytes); with the fetch frontier it passes. See the report for
   * the actual before/after run.
   */
  it('folds correctly when chunks are smaller than a single record, across several ticks', async () => {
    await truncateAll();
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedRunningRun(orgId, projectId, log.length);

    const STORAGE_CHUNK = 4;      // smaller than every record in the fixture (min ~10 bytes)
    const TICK_BATCH = 4096;      // bytes newly available between ticks; not record-aligned

    const owner = new LiveFoldOwner(config, pool, chunks);
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
    const owner = new LiveFoldOwner(config, pool, chunks);
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
    const owner = new LiveFoldOwner(config, pool, chunks);
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

    const owner = new LiveFoldOwner(config, pool, chunks);
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

    const owner = new LiveFoldOwner(config, pool, chunks);
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
      const other = new LiveFoldOwner(config, pool, chunks);
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
});
