import 'reflect-metadata';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  createPool,
  createPrisma,
  RecomputeRepository,
  RuleRepository,
  VerificationRepository,
} from '@perfportal/persistence';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import { loadWorkerConfig } from './config.js';
import { startConsumer } from './consumer.js';
import { LiveFoldOwner } from './live/fold-owner.js';
import { PipelineService } from './pipeline/pipeline.service.js';
import { createRecomputeScan, RECOMPUTE_QUEUE, startRecomputeConsumer } from './recompute/recompute-queue.js';
import { RecomputeService } from './recompute/recompute.service.js';
import { runShutdown } from './shutdown.js';
import { Sweeper } from './sweeper.js';
import { createGatlingMethodRunner, gatlingMethodUnavailable } from './verify/gatling-method-runner.js';
import { createVerifyScan, enqueueVerification, startVerifyConsumer, VERIFY_QUEUE } from './verify/verify-queue.js';
import { VerifyService } from './verify/verify.service.js';

const config = loadWorkerConfig();

/**
 * Prisma's pool is a SECOND pool, and until this line nothing sized it.
 *
 * The `pg.Pool` below is derived term by term from clients its consumers
 * actually hold, and the README quotes the resulting number as this
 * process's connection budget. That number was wrong: `createPrisma` opens
 * its own, entirely separate pool against the same database, and Prisma's
 * default is `num_physical_cpus * 2 + 1` -- roughly 9 to 17 depending on
 * the machine. So a replica that budgeted 31 was really taking 40 to 48,
 * two replicas 80 to 96, against `postgres:16-alpine`'s stock
 * `max_connections = 100` shared with every API replica. The overshoot was
 * not merely unaccounted for, it varied with the host's CPU count.
 *
 * Derived the same way as the pool below, so the total is a number someone
 * chose:
 *  - `concurrency * PIPELINE_PRISMA_CLIENTS_PER_JOB` -- Prisma is reached
 *    from `PipelineService` in this process (`RunRepository`,
 *    `ProjectRepository`, `RuleRepository`), and only ever one query at a
 *    time per job: nothing in `packages/persistence` opens an interactive
 *    `$transaction`, so a job never holds two Prisma connections at once.
 *  - `maxOwnedRuns * FOLD_OWNER_CLAIM_PRISMA_CLIENTS` -- live-sla-signals
 *    Task 3 added `LiveFoldOwner`'s own Prisma reach: `#claimRules` reads a
 *    run's SLA rules through `RuleRepository`, ONCE, on EVERY claim that
 *    wins its advisory lock -- not only on the `live:opened` ping's
 *    tenant-lookup fallback path. `#claiming`'s own cap bounds how many
 *    claims can be in flight AT ONCE to `maxOwnedRuns`
 *    (`#atCap()`'s `#owned.size + #claiming.size >= maxOwnedRuns`), and that
 *    is exactly the burst `#claiming` itself exists to survive (a fan-out of
 *    `live:opened` pings, NFR-SC-4's documented load) -- so up to
 *    `maxOwnedRuns` of these Prisma queries can legitimately be in flight at
 *    the same instant. `Sweeper` still does not touch Prisma at all; as of
 *    Task 3, `LiveFoldOwner` does.
 *  - `PRISMA_HEADROOM` -- one spare, so a `P2024` pool timeout cannot be
 *    reached by a single unaccounted-for query (a future repository call
 *    outside a job, a shutdown-time read) rather than by real pressure.
 *
 * An operator who puts `connection_limit` in `DATABASE_URL` overrides this;
 * see `createPrisma`.
 */
const PIPELINE_PRISMA_CLIENTS_PER_JOB = 1;
const FOLD_OWNER_CLAIM_PRISMA_CLIENTS = 1;
const PRISMA_HEADROOM = 1;
// The recompute consumer (concurrency 1) reads a run and its project through Prisma, one query at a time.
// Reserved even when RECOMPUTE_ENABLED=false: one idle connection's worth of budget, not worth a branch.
const RECOMPUTE_PRISMA_CLIENTS = 1;
// The verify consumer (concurrency 1) reads a run and its project through Prisma, one query at a time.
// Reserved even when VERIFY_ENABLED=false, for recompute's reason.
const VERIFY_PRISMA_CLIENTS = 1;
const prisma = createPrisma(config.databaseUrl, {
  connectionLimit:
    config.concurrency * PIPELINE_PRISMA_CLIENTS_PER_JOB +
    config.maxOwnedRuns * FOLD_OWNER_CLAIM_PRISMA_CLIENTS +
    RECOMPUTE_PRISMA_CLIENTS +
    VERIFY_PRISMA_CLIENTS +
    PRISMA_HEADROOM,
});

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
// `Sweeper.sweep` holds one client for its recovery transaction, and then, one run at a time, a
// retention pass's lock client beside the pool query that stamps the run: two at once at most.
const SWEEPER_CLIENTS = 2;
// `RecomputeService.recompute` holds the run's lock client and, inside it, its write transaction's: two at once.
const RECOMPUTE_CLIENTS = 2;
// The recompute scheduler's candidate query, which can run beside a recompute.
// Both recompute terms are reserved even when RECOMPUTE_ENABLED=false (a ceiling, not an allocation).
const RECOMPUTE_SCAN_CLIENTS = 1;
// `VerifyService.verify` holds the run's lock client and, inside it, one pool query at a time (the
// stored-figure reads are sequential on purpose): two at once. Plus the verify scheduler's
// candidate query, which can run beside a verification. Reserved even when VERIFY_ENABLED=false.
const VERIFY_CLIENTS = 2;
const VERIFY_SCAN_CLIENTS = 1;
const pool = createPool(config.databaseUrl, {
  max:
    config.maxOwnedRuns +
    FOLD_OWNER_DISCOVERY_CLIENTS +
    config.concurrency * PIPELINE_CLIENTS_PER_JOB +
    SWEEPER_CLIENTS +
    RECOMPUTE_CLIENTS +
    RECOMPUTE_SCAN_CLIENTS +
    VERIFY_CLIENTS +
    VERIFY_SCAN_CLIENTS,
  connectionTimeoutMillis: 10_000,
});
const blobs = new BlobStore(config.blob);
await blobs.ensureBucket();
const chunks = new LiveChunkStore(blobs);

/**
 * Verification of every run against its raw log (`verify/verify-queue.ts`):
 * requested after each successful ingest and each recompute, and found by a
 * scheduled scan for anything those requests missed (a run ingested while
 * this was switched off, a request Redis refused, a verifier version bump).
 * With `VERIFY_ENABLED=false` nothing is requested or scanned; the scan finds
 * the backlog once it is switched back on.
 */
const verifications = new VerificationRepository(pool);
const verifyQueue = config.verifyEnabled ? new Queue(VERIFY_QUEUE, { connection: { url: config.redisUrl } }) : null;
const requestVerification = verifyQueue
  ? async (runId: string): Promise<void> => {
      await enqueueVerification(verifyQueue, verifications, runId);
    }
  : undefined;

const pipeline = new PipelineService(config, prisma, pool, blobs, requestVerification);
const worker = startConsumer(config, pipeline);

let verify: { consumer: ReturnType<typeof startVerifyConsumer>; timer: NodeJS.Timeout } | null = null;
if (verifyQueue) {
  // ONE line at startup, so an operator can tell "Gatling agrees" from "never
  // asked" without reading a verification row: the method runs only where both
  // jars are installed (the image ships them), and says why not otherwise.
  const unavailable = gatlingMethodUnavailable(config);
  console.log(
    unavailable === null
      ? `verify: Gatling's method is available (${String(config.gatlingMethodSeeds)} replays per run)`
      : `verify: Gatling's method is not available, so no differences from Gatling's report are recorded: ${unavailable}`,
  );
  const gatlingMethod = createGatlingMethodRunner(config);
  const consumer = startVerifyConsumer(config, new VerifyService(config, prisma, pool, blobs, gatlingMethod));
  // Fire-and-forget, as the recompute scan below: startup must not wait on it.
  const scan = createVerifyScan(verifyQueue, verifications);
  void scan();
  const timer = setInterval(() => void scan(), config.verifyScanIntervalMs);
  timer.unref();
  verify = { consumer, timer };
}

/**
 * Background recompute of runs still carrying estimated statistics, behind
 * ingest (see `recompute-queue.ts`). The first scan is fire-and-forget, like
 * `foldOwner.listen()` below: startup must not wait on Redis or the database
 * for an optimisation, and `createRecomputeScan` logs its own failures.
 */
let recompute:
  | { queue: Queue; consumer: ReturnType<typeof startRecomputeConsumer>; timer: NodeJS.Timeout }
  | null = null;
if (config.recomputeEnabled) {
  const queue = new Queue(RECOMPUTE_QUEUE, { connection: { url: config.redisUrl } });
  const consumer = startRecomputeConsumer(config, new RecomputeService(config, prisma, pool, blobs), {
    requestVerification,
  });
  const scan = createRecomputeScan(queue, new RecomputeRepository(pool));
  void scan();
  const timer = setInterval(() => void scan(), config.recomputeScanIntervalMs);
  timer.unref();
  recompute = { queue, consumer, timer };
}
/**
 * The sweeper's `live:closed` publisher is created HERE and quit HERE, in a
 * shutdown step of its own -- `Sweeper.close()` closes only the BullMQ queue
 * it constructed itself, because every test hands the sweeper a connection it
 * goes on to quit on its own.
 *
 * ═══ THIS ONE LINE WAS WHY SIGTERM NEVER ENDED THE WORKER ═══
 * It used to be `new Sweeper(..., new Redis(config.redisUrl))`, inline, with
 * no name anything could quit later. `shutdown()` below never calls
 * `process.exit` -- it relies on the event loop draining -- and an open ioredis
 * socket is a ref'd handle, so every teardown step ran and the process then sat
 * idle on that one socket FOR EVER. Measured on an idle worker with a handle
 * dump after SIGTERM: exactly one live resource, a `TCPSocketWrap` to Redis,
 * still there at +69 s, and Redis's own `CLIENT LIST` showing that connection
 * had sent nothing but ioredis's `info` ready check since it was opened. The
 * "30 to 60 seconds" recorded elsewhere was whatever cap the person stopping
 * it chose before sending SIGKILL. `shutdown-exit.integration.test.ts` holds
 * the process to exiting on its own.
 */
const sweeperRedis = new Redis(config.redisUrl);
const sweeper = new Sweeper(config, pool, chunks, blobs, sweeperRedis);
// This owner's Redis connection is its own -- not the one BullMQ's
// `startConsumer`/`Sweeper` open via `{ connection: { url } }` -- because
// `LiveFoldOwner.close()` calls `.quit()` on it directly (see that method's
// own doc comment), and quitting a connection those libraries still hold
// open would break their own shutdown. LiveFoldOwner derives its own second,
// subscriber-mode connection from this one internally (`redis.duplicate()`
// in its constructor -- see `#sub`'s own doc comment); nothing here needs to
// construct or pass in a second connection for that.
// `RuleRepository` on the pipeline's OWN `prisma` client, not a new one --
// LiveFoldOwner reads no other Prisma-backed table, so this is the only
// reason it would otherwise open a second pool, and that pool's connections
// are exactly what the sizing comment above does not count.
const foldOwner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl), new RuleRepository(prisma));
// Subscribes the owner to `live:opened`/`live:advance` (design §1.2, §2.3).
// FIRE-AND-FORGET, not awaited -- fix round 1, Minor 3. An earlier version
// awaited this before either timer below started, on the theory that a
// failure "surfaces as a boot-time rejection". That undersold what actually
// happens: ioredis defaults to `enableOfflineQueue: true`, so `subscribe()`
// against an unreachable broker does not reject promptly at all -- it
// queues and keeps retrying, which would hold this `await` (and therefore
// the sweeper's and the tick's own timers just below, and the SIGTERM/SIGINT
// handlers at the bottom of this file) for as long as the outage lasts.
// Design §1.2's whole stance is that pub/sub is an optimisation OVER the
// poll, never required for it -- gating the poll's own startup on the
// optimisation's availability inverts that at the one place it matters
// most. Same fire-and-forget shape as `sweeper.sweep()`/`foldOwner.tick()`
// below: log a failure, do not let it block anything else.
void foldOwner.listen().catch((err) => console.error('live fold owner failed to subscribe', err));

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

/**
 * Ordered, and every step isolated -- see `runShutdown`'s own doc comment
 * for why a plain sequence of awaits made `LiveFoldOwner.close()`'s
 * DESIGNED `AggregateError` fatal to the whole teardown, leaving the pool
 * and Prisma's connections open and printing `ERR_UNHANDLED_REJECTION`
 * instead of the message that error was built to carry.
 */
let shutdownPromise: Promise<void> | null = null;

function shutdown(): Promise<void> {
  // ═══ MEMOIZED, AND `process.once` BELOW ═══
  //
  // Neither alone is enough. `process.once` stops a repeated SIGINT (two
  // Ctrl-Cs, which is what a shell gives you when the first teardown takes a
  // moment) re-entering through the SAME signal; the memo stops SIGTERM
  // arriving after SIGINT — a different handler, so `once` says nothing about
  // it — starting a second teardown over the first.
  //
  // A second teardown is not harmless. It calls `pool.end()` on an already
  // ended pool and `.quit()` on a Redis connection that is already closing,
  // and `runShutdown` faithfully logs both as failed steps: an operator
  // reading that log sees errors from a shutdown that actually went fine, in
  // the one place they are most likely to be looking for a real one.
  //
  // Matches apps/runner/src/main.ts, which has had this shape since it was
  // written; this file was the odd one out.
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = runShutdown([
    { name: 'clear timers', run: () => { clearInterval(sweepTimer); clearInterval(liveTickTimer); } },
    { name: 'worker.close', run: () => worker.close() },
    // Before pool.end(): a recompute in flight holds pool clients until its job returns.
    { name: 'recompute.close', run: async () => {
      if (!recompute) return;
      clearInterval(recompute.timer);
      await recompute.consumer.close();
      await recompute.queue.close();
    } },
    // Before pool.end(), for recompute's reason: a verification in flight holds pool clients.
    { name: 'verify.close', run: async () => {
      if (verify) {
        clearInterval(verify.timer);
        await verify.consumer.close();
      }
      await verifyQueue?.close();
    } },
    { name: 'sweeper.close', run: () => sweeper.close() },
    // After sweeper.close(). A sweep still in flight publishes with `.catch()`, so a connection
    // already quit costs it a dropped `live:closed` ping and nothing else. See `sweeperRedis` above.
    // A quit that fails (Redis unreachable, a publish stuck in the offline queue) still has to let
    // go: `disconnect()` stops the reconnect timers, which would otherwise hold the loop exactly as
    // the unquit socket did. Rethrown so `runShutdown` logs the failure.
    { name: 'sweeperRedis.quit', run: async () => {
      await sweeperRedis.quit().catch((err: unknown) => {
        sweeperRedis.disconnect();
        throw err;
      });
    } },
    // Before pool.end(): each owned run holds a dedicated pooled client for
    // its advisory lock's whole lifetime, and close() releases every one of
    // them (plus this owner's own Redis connection) -- see its own doc
    // comment for why draining safely needs the tick guard, not just the
    // owned-run map.
    { name: 'foldOwner.close', run: () => foldOwner.close() },
    { name: 'pool.end', run: () => pool.end() },
    { name: 'prisma.$disconnect', run: () => prisma.$disconnect() },
  ]);
  return shutdownPromise;
}

// `.catch()` even though `runShutdown` is documented not to reject: a
// signal handler is the one place in this process with nowhere to put a
// rejection, and on Node 22 an unhandled one terminates immediately --
// which is exactly how the AggregateError above used to take the whole
// teardown down. Belt and braces, at the cost of one line.
const onSignal = () => void shutdown().catch((err) => console.error('worker shutdown failed', err));
process.once('SIGTERM', onSignal);
process.once('SIGINT', onSignal);
