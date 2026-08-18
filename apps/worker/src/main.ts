import 'reflect-metadata';
import { createPool, createPrisma } from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { loadWorkerConfig } from './config.js';
import { startConsumer } from './consumer.js';
import { PipelineService } from './pipeline/pipeline.service.js';
import { Sweeper } from './sweeper.js';

const config = loadWorkerConfig();
const prisma = createPrisma(config.databaseUrl);

/**
 * This ONE pool is shared by `PipelineService`, `Sweeper`, and (once wired
 * in alongside them here — not yet as of this file) `LiveFoldOwner` — design
 * part-2a §1.3, amended after an earlier draft claimed a worker "cannot
 * exhaust its pool trying to own everything" without ever checking that
 * against the pool's actual size. It was false: `createPool`'s own default
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

const pipeline = new PipelineService(config, prisma, pool, blobs);
const worker = startConsumer(config, pipeline);
const sweeper = new Sweeper(config, pool);

const timer = setInterval(() => {
  void sweeper.sweep().catch((err) => console.error('sweep failed', err));
}, config.sweepIntervalMs);

async function shutdown(): Promise<void> {
  clearInterval(timer);
  await worker.close();
  await sweeper.close();
  await pool.end();
  await prisma.$disconnect();
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
