import 'reflect-metadata';
import { Redis } from 'ioredis';
import { createPool, createPrisma } from '@perfportal/persistence';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import { loadWorkerConfig } from './config.js';
import { startConsumer } from './consumer.js';
import { LiveFoldOwner } from './live/fold-owner.js';
import { PipelineService } from './pipeline/pipeline.service.js';
import { Sweeper } from './sweeper.js';

const config = loadWorkerConfig();
const prisma = createPrisma(config.databaseUrl);

/**
 * This ONE pool is shared by `PipelineService`, `Sweeper`, and
 * `LiveFoldOwner` — design part-2a §1.3, amended after an earlier draft
 * claimed a worker "cannot exhaust its pool trying to own everything"
 * without ever checking that against the pool's actual size. It was false:
 * `createPool`'s own default
 * (`max: 10`) against `maxOwnedRuns`'s default (25), with no
 * `connectionTimeoutMillis` set either, does not degrade — it deadlocks the
 * whole worker the instant a tenth run is owned (every client held by a
 * `FoldState`, the eleventh `connect()` queuing forever), with no error, no
 * timeout, and no log.
 *
 * So the pool is sized FROM `maxOwnedRuns`, not left at the default. EVERY
 * TERM BELOW IS DERIVED FROM A CLIENT SOME COMPONENT ACTUALLY HOLDS
 * CONCURRENTLY, not guessed — the next component added to this pool must
 * add its own term the same way, or this sizing silently under-counts
 * again exactly as the original bug did:
 *  - `maxOwnedRuns` itself — each owned run holds one dedicated client for
 *    its advisory lock's whole lifetime (`FoldState.client`).
 *  - `FOLD_OWNER_DISCOVERY_CLIENTS` — `LiveFoldOwner#doTick`'s own
 *    `pool.query('SELECT id FROM run WHERE status = ...')` checks out a
 *    client for that one query, CONCURRENTLY with every `FoldState` client
 *    the SAME owner already holds from previous ticks (a tick folds owned
 *    runs after its discovery query, but does not release their clients
 *    first) — a fold round trip is not accounted for by `maxOwnedRuns`
 *    alone, so it needs its own term.
 *  - `concurrency * PIPELINE_CLIENTS_PER_JOB` — `PipelineService.process`
 *    holds up to two clients per in-flight job at once: the lock-holding
 *    client for the whole call, plus a second, brief one `#ingest` opens
 *    for its final commit transaction. Worst case across BullMQ's
 *    configured job concurrency.
 *  - `SWEEPER_CLIENTS` — `Sweeper.sweep` holds exactly one client for its
 *    whole duration (one transaction, BEGIN to COMMIT).
 *
 * `connectionTimeoutMillis` is set alongside it so any FUTURE mis-sizing —
 * or genuine connection pressure — fails loud (a rejected `connect()`)
 * instead of repeating the same silent stall this sizing exists to prevent.
 */
const FOLD_OWNER_DISCOVERY_CLIENTS = 1;
const PIPELINE_CLIENTS_PER_JOB = 2;
const SWEEPER_CLIENTS = 1;
const pool = createPool(config.databaseUrl, {
  max:
    config.maxOwnedRuns +
    FOLD_OWNER_DISCOVERY_CLIENTS +
    config.concurrency * PIPELINE_CLIENTS_PER_JOB +
    SWEEPER_CLIENTS,
  connectionTimeoutMillis: 10_000,
});
const blobs = new BlobStore(config.blob);
await blobs.ensureBucket();
const chunks = new LiveChunkStore(blobs);

const pipeline = new PipelineService(config, prisma, pool, blobs);
const worker = startConsumer(config, pipeline);
const sweeper = new Sweeper(config, pool);
// This owner's Redis connection is its own -- not the one BullMQ's
// `startConsumer`/`Sweeper` open via `{ connection: { url } }` -- because
// `LiveFoldOwner.close()` calls `.quit()` on it directly (see that method's
// own doc comment), and quitting a connection those libraries still hold
// open would break their own shutdown. LiveFoldOwner derives its own second,
// subscriber-mode connection from this one internally (`redis.duplicate()`
// in its constructor -- see `#sub`'s own doc comment); nothing here needs to
// construct or pass in a second connection for that.
const foldOwner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
// Subscribes the owner to `live:opened`/`live:advance` (design §1.2, §2.3)
// before either timer starts below. Awaited, not fire-and-forget, so a
// failure here (a bad REDIS_URL, the broker unreachable at boot) surfaces as
// a boot-time rejection rather than a silently-never-subscribed owner --
// consistent with `blobs.ensureBucket()` above, the other awaited startup
// step this file already has. Not awaiting it would still be SAFE, only
// less prompt: `listen()`'s own doc comment covers why the tick's poll
// backstops every case this subscription speeds up.
await foldOwner.listen();

const sweepTimer = setInterval(() => {
  void sweeper.sweep().catch((err) => console.error('sweep failed', err));
}, config.sweepIntervalMs);
// Same fire-and-forget shape as the sweeper's own timer above -- `tick()`
// guards itself against overlapping with a still-running previous call
// (`LiveFoldOwner`'s own `#ticking`), so this never awaits the previous
// firing before starting the next one.
const liveTickTimer = setInterval(() => {
  void foldOwner.tick().catch((err) => console.error('live fold tick failed', err));
}, config.liveTickMs);

async function shutdown(): Promise<void> {
  clearInterval(sweepTimer);
  clearInterval(liveTickTimer);
  await worker.close();
  await sweeper.close();
  // Before pool.end(): each owned run holds a dedicated pooled client for
  // its advisory lock's whole lifetime, and close() releases every one of
  // them (plus this owner's own Redis connection) -- see its own doc
  // comment for why draining safely needs the tick guard, not just the
  // owned-run map.
  await foldOwner.close();
  await pool.end();
  await prisma.$disconnect();
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
