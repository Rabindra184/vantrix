import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPool, createPrisma } from '@perfportal/persistence';
import { parseSimulationLog, StreamingLogDecoder } from '@perfportal/plugin-gatling';
import { runEngine, type EngineResult } from '@perfportal/statistics';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
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
});
