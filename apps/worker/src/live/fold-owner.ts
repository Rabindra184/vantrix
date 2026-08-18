import type { Redis } from 'ioredis';
import { StreamingLogDecoder } from '@perfportal/plugin-gatling';
import { LiveEngine, type EngineResult } from '@perfportal/statistics';
import type { LiveChunkStore } from '@perfportal/storage';
import type pg from 'pg';
import type { WorkerConfig } from '../config.js';
import { RUN_INGEST_LOCK_NAMESPACE } from '../pipeline/pipeline.service.js';
import { buildDelta, INITIAL_CURSOR, type DeltaCursor } from './delta.js';

/**
 * Everything one owned run needs to keep folding, held for as long as this
 * process owns the run. See the design doc's §2.1 for the authoritative
 * shape.
 */
interface FoldState {
  decoder: StreamingLogDecoder;
  engine: LiveEngine;
  /** Holds the advisory lock for `runId`. Taken and released on THIS client,
   * never a different one drawn from the pool -- see `#claim` and
   * `#release`. */
  client: pg.PoolClient;
  /**
   * What the NEXT delta's `buildDelta` call needs to know about the LAST
   * one published for this run -- `seq`, and the response-time series'
   * frontier/width (design §3.3). Starts at `INITIAL_CURSOR` on claim,
   * which is what makes a freshly (or re-)claimed run's first delta a
   * replacement rather than an upsert into a series the consumer never saw.
   */
  cursor: DeltaCursor;
  /**
   * The FETCH FRONTIER, not the decode position -- the highest byte this
   * owner has already retrieved from `LiveChunkStore`, and exactly what
   * `readFrom`'s `offset` argument expects.
   *
   * THIS IS NOT `decoder.consumedBytes`. `consumedBytes` is the last WHOLE
   * RECORD boundary, which routinely sits *behind* the last byte fetched --
   * a record straddling a chunk boundary leaves a partial tail the decoder
   * buffers and reports as unconsumed. `readFrom` selects every chunk whose
   * START is at or past its argument, so handing it `consumedBytes` would
   * re-select chunks already delivered; the decoder splices them in again
   * after the tail it correctly retained, and every absolute position from
   * there on is silently wrong for the rest of the run. See design §2.2.1.
   *
   * Advancing by `bytes.length` (rather than tracking per-chunk lengths) is
   * exact because offset negotiation only ever accepts a chunk when
   * `offset === cursor` (Part 1's `LiveService.stream`): a run's chunks tile
   * `[0, stream_offset)` with no gap and no overlap, so the first chunk
   * `readFrom` returns always starts exactly at `fetchedBytes`.
   */
  fetchedBytes: number;
}

/**
 * How many `liveTickMs` intervals `#ticking` may stay true before a fold is
 * treated as worth logging about. Purely diagnostic -- see `#checkWatchdog`'s
 * doc comment for why this never cancels anything -- so a false positive on
 * a legitimately huge backlog fold costs one extra log line, not a wrong
 * decision. 6x gives real headroom above ordinary tick-to-tick variance
 * while still firing well inside an operator's patience for "is this worker
 * alive".
 */
const WATCHDOG_STUCK_MULTIPLIER = 6;

/**
 * Claims each `running` run on the advisory lock `PipelineService` already
 * uses, folds the chunk bytes it has not yet fetched into a `LiveEngine`,
 * and releases the run once its status leaves `running`.
 *
 * REUSES `RUN_INGEST_LOCK_NAMESPACE` rather than minting a second namespace,
 * and that choice buys a property a separate lock would not: a run cannot be
 * folded by two workers, AND it cannot be folded while `PipelineService` is
 * parsing it. That second half matters because `close()` (Task 9) hands a
 * run to the pipeline for its terminal parse while this owner may still be
 * holding it -- without the shared lock, the two would race over the same
 * bytes with no serialization between them.
 *
 * The fold position is NOT persisted. An owner that claims a run always
 * starts folding at byte 0, re-reading and re-decoding everything the run
 * has streamed so far. That is design §3.5's checkpoint property doing its
 * job: the chunk bytes are already durable and already ordered in blob
 * storage, so "where the fold got to" needs no engine-state serialization,
 * no checkpoint format to version, and a worker dying mid-run costs some
 * CPU re-folding on the next claim rather than costing correctness.
 *
 * After folding, each owned run is snapshotted (`{ clone: true }` --
 * see `#publish`'s own doc comment for why that flag is load-bearing),
 * turned into a delta by the pure `buildDelta`, and published to both of
 * design §3.4's destinations. Publishing always runs strictly after that
 * run's fold for the same tick, never interleaved with it, so every delta
 * describes a whole number of decoded records.
 *
 * DISCOVERY IS THE TICK'S OWN POLL PLUS TWO REDIS PINGS, NEVER THE PINGS
 * ALONE (design §1.2). `LiveNotifier` (`apps/api/src/ingest/live-notifier.ts`)
 * publishes `live:opened` when a run is created and `live:advance` after a
 * chunk is durably accepted; `listen()` subscribes this owner to both and
 * `#onOpened`/`#onAdvance` react. Either message can be dropped -- Redis
 * pub/sub has no persistence, and a message published while every worker is
 * down (a deploy, an outage) reaches nobody -- so `#doTick`'s poll of
 * `WHERE status = 'running'` keeps running on its own schedule regardless of
 * whether either ping ever arrives. The pings are strictly an optimisation
 * over that poll: they lower claim and fold latency when they land, and
 * change nothing about correctness when they do not.
 */
export class LiveFoldOwner {
  readonly #config: WorkerConfig;
  readonly #pool: pg.Pool;
  readonly #chunks: LiveChunkStore;
  readonly #redis: Redis;
  /**
   * A SEPARATE connection from `#redis`, for subscribing -- design §1.2 /
   * §2.3. ioredis puts a connection into subscriber mode on `subscribe()`
   * and then rejects ordinary commands on it (`Redis.js`'s own
   * `sendCommand`, gated on `VALID_IN_SUBSCRIBER_MODE`); `#redis` is the
   * owner's PUBLISHER, used for every `PUBLISH`/`XADD` in `#publish`, so
   * subscribing on it would break every one of those the moment the first
   * `subscribe()` call landed.
   *
   * `redis.duplicate()` (not a second `new Redis(...)` built from
   * `#config.redisUrl` here) reuses whatever options `#redis` was
   * constructed with -- host, port, TLS, auth, anything a caller supplied --
   * without this class needing to know or re-derive any of it, and without
   * `LiveFoldOwner`'s own constructor gaining a parameter for it: the
   * constructor still takes exactly the four arguments it has taken since
   * `main.ts` and the test suite in this directory both started calling it.
   * `close()` quits this connection alongside `#redis`'s own (see that
   * method's doc comment); `listen()` below is what actually subscribes it.
   */
  readonly #sub: Redis;
  readonly #owned = new Map<string, FoldState>();
  /**
   * Run ids with a `#fold` call CURRENTLY in flight -- guards against a
   * hazard `#ticking` does not cover. `#ticking` only prevents two `tick()`
   * calls from overlapping EACH OTHER; it says nothing about a
   * `live:advance` ping's `#onAdvance`, which calls `#fold` from a
   * `message` event handler outside `tick()` entirely and can therefore
   * land WHILE `#doTick`'s own fold loop is mid-`#fold` for that very run
   * (or while a second ping for the same run is).
   *
   * `#fold`'s own doc comment already spells out why two concurrent calls
   * for the SAME `FoldState` corrupt: both read `state.fetchedBytes` before
   * either advances it, both `readFrom` the identical byte range, and both
   * push it into the SAME shared decoder -- design §2.2.1's exact
   * corruption, reached here across the tick/ping boundary instead of
   * across two overlapping ticks.
   *
   * `#foldOnce` is the single gate every caller of `#fold` now goes through
   * (`#doTick`'s own loop included) -- see its own doc comment for what
   * actually happens to a trigger that arrives while a run is already
   * folding: it is DEFERRED, via `#foldAgain`, to a rerun immediately after
   * the in-flight call finishes, not dropped. A run only ever leaves this
   * set once its (possibly rerun) fold has fully settled.
   */
  readonly #folding = new Set<string>();
  /**
   * Run ids that need ANOTHER `#fold` pass once the one currently in flight
   * (tracked by `#folding`) finishes. Set by `#foldOnce` when it finds a
   * run already folding, instead of running `#fold` itself -- see that
   * method's own doc comment for why this is what makes the guard
   * SERIALISE a fold request rather than silently drop it.
   *
   * Coalescing: this is a Set of ids, not a counter, so any number of
   * triggers arriving while one run's fold is in flight -- a `live:advance`
   * ping that raced a tick's own fold, or several pings back to back --
   * collapse into exactly ONE rerun each, not one rerun per trigger.
   */
  readonly #foldAgain = new Set<string>();
  /**
   * Guards `tick()` against overlapping with itself. `main.ts` drives it from
   * a `setInterval` in the same shape it already uses for the sweeper's
   * timer -- fire-and-forget, never awaiting the previous call -- and design
   * §2.1 is explicit that claiming a run which already streamed 200 MB means
   * folding 200 MB before its first delta, which will routinely outlast the
   * 5000 ms default `liveTickMs`. Without this flag, a second `tick()`
   * firing mid-fold would run its OWN claim/fold passes concurrently with
   * the first over the SAME `#owned` map and the SAME `FoldState` objects --
   * two overlapping `#fold` calls for one already-owned run both read
   * `state.fetchedBytes` before either has advanced it, both `readFrom` the
   * identical range, and both push it into the SAME shared decoder. That is
   * design §2.2.1's corruption again, reached by real concurrency this time
   * rather than a wrong cursor or a failure path.
   */
  #ticking = false;
  /**
   * Set once `close()` has been called. Checked in TWO places, for two
   * different reasons:
   *  - `tick()` -- so that once a drain has started, no NEW `#doTick()`
   *    pass can begin.
   *  - `#claim()` -- so that a claim already IN FLIGHT when `close()` ran
   *    unwinds itself (unlock, release the client, do not insert) instead
   *    of inserting a `FoldState` after `close()`'s drain has already run.
   *    See `#claim`'s and `close()`'s own doc comments for the race this
   *    closes and why closing it AT THE INSERT SITE is what lets `close()`
   *    itself stay unbounded-wait-free.
   */
  #closing = false;
  /** When the in-flight tick started, for `#checkWatchdog`; `null` whenever
   * `#ticking` is false. */
  #tickStartedAt: number | null = null;
  /**
   * How many watchdog warnings have already fired for the CURRENT stuck
   * episode -- NOT a boolean, so a tick stuck for a long time gets a fresh
   * warning every `WATCHDOG_STUCK_MULTIPLIER` tick-intervals rather than
   * exactly one ever. See `#checkWatchdog`'s own doc comment. Reset to 0
   * every time a tick actually starts.
   */
  #watchdogWarnCount = 0;

  constructor(config: WorkerConfig, pool: pg.Pool, chunks: LiveChunkStore, redis: Redis) {
    this.#config = config;
    this.#pool = pool;
    this.#chunks = chunks;
    this.#redis = redis;
    this.#sub = redis.duplicate();
    // Registered here, not inside listen(): ioredis buffers a 'message'
    // listener attached before subscribe() resolves just fine (the
    // EventEmitter is live from construction), so there is no ordering
    // requirement forcing this into listen() -- and keeping it here means
    // the routing table exists as soon as the instance does, regardless of
    // whether or when a caller ever calls listen() at all.
    this.#sub.on('message', (channel: string, message: string) => {
      if (channel === 'live:opened') {
        void this.#guarded('claim (ping)', message, () => this.#onOpened(message));
      } else if (channel === 'live:advance') {
        void this.#guarded('fold (ping)', message, () => this.#onAdvance(message));
      }
    });
  }

  /**
   * Subscribes the dedicated `#sub` connection to both discovery/advance
   * channels design §1.2 and §2.3 name. Separate from the constructor
   * because subscribing is a real round trip to Redis (ioredis's
   * `subscribe()` returns a `Promise`, and a constructor cannot be async) --
   * `main.ts` awaits this once, right after construction, before the
   * periodic tick timer starts.
   *
   * NOT awaiting this before relying on the owner is still safe, only less
   * prompt: every case `listen()` exists to speed up is also covered by
   * `tick()`'s own poll (design §1.2's whole point) -- a run opened, or a
   * chunk accepted, before this resolves is simply picked up on the next
   * scheduled tick instead of immediately.
   */
  async listen(): Promise<void> {
    await this.#sub.subscribe('live:opened', 'live:advance');
  }

  /**
   * Reacts to `live:opened` (design §1.2): a run was just created, and this
   * is the SAME per-id claim gate `#doTick`'s discovery loop applies to a
   * newly-`running` id, just reached a tick early. `#claim` itself already
   * self-checks `#closing` right before it would insert (see that method's
   * own doc comment), so nothing here needs to duplicate that -- but the
   * cheaper checks (already owned, already at cap) are worth doing BEFORE
   * paying for a `pool.connect()` and a lock query that `#claim` would only
   * discover was pointless once it got there.
   *
   * Deliberately does NOT re-verify the run is still `running` against the
   * database first. `#claim` never has -- it wins or loses the advisory
   * lock and, if it wins, folds from byte 0 regardless of what row state
   * produced the attempt. A `live:opened` ping for a run that somehow
   * closed in the few milliseconds since it was published either finds the
   * lock already released (nothing else could hold it that fast) and claims
   * a run with nothing to fold, harmlessly, or -- if it raced a close --
   * gets released again on the very next tick the same way any other owned,
   * no-longer-running run already is (`#doTick`'s release loop).
   */
  async #onOpened(runId: string): Promise<void> {
    if (this.#closing) return;
    if (this.#owned.has(runId)) return;
    if (this.#owned.size >= this.#config.maxOwnedRuns) return;
    await this.#claim(runId);
  }

  /**
   * Reacts to `live:advance` (design §2.2 / §2.3): fetches and folds
   * whatever new bytes are available for a run this owner already holds.
   *
   * A no-op, not a claim attempt, if this owner does not hold `runId` --
   * "if owned" is the operative word design §2.3 uses for this reaction.
   * The run may be owned by a DIFFERENT worker (fine: that worker's own
   * subscriber gets the same ping), not yet claimed at all (the
   * `live:opened` ping or the next tick's poll will get to it), or no
   * longer running (already released). None of those are this call's
   * problem to solve; folding only ever happens against THIS owner's own
   * `FoldState`.
   *
   * Goes through `#foldOnce`, not `#fold` directly -- see `#foldOnce`'s own
   * doc comment for why a ping and `#doTick`'s own fold loop must never run
   * `#fold` concurrently for the same run.
   *
   * Deliberately does not publish. §3.1's cadence ("one timer on the owner,
   * not one per run") stays exactly as `#doTick`'s own publish loop already
   * implements it -- this only warms the fold itself (§2.2's "on a
   * `live:advance` ping OR on the tick, the owner reads chunk objects...")
   * so that whenever the next scheduled tick DOES publish, it describes
   * data that was folded moments after it arrived rather than data fetched
   * fresh at tick time. Publishing here too would mean every accepted
   * chunk -- not every tick -- drives a `PUBLISH`/`XADD` pair, which is the
   * per-run timer §3.1 explicitly rejects.
   */
  async #onAdvance(runId: string): Promise<void> {
    const state = this.#owned.get(runId);
    if (!state) return;
    await this.#foldOnce(runId, state);
  }

  /**
   * One pass: discover currently-`running` runs, claim any not already
   * owned (bounded by `maxOwnedRuns`), fold every owned run's new bytes, and
   * release any owned run whose status has left `running`.
   *
   * Release is checked from the SAME poll that discovers new runs -- design
   * §4: "Detected on the tick, which is already re-reading status to
   * discover new runs" -- so this issues one query per tick, not two.
   *
   * Ignores (does not queue, does not wait for) a call that arrives while a
   * previous one is still running -- see `#ticking`'s own doc comment for
   * why an overlap must never actually run the pass twice concurrently.
   * The next scheduled tick will simply see the by-then-larger backlog and
   * pick up where the in-flight one left off; nothing here needs to be
   * "made up" for a skipped call, since `fetchedBytes` already IS the
   * record of how far each owned run has gotten.
   *
   * Synchronous set-then-check: `#ticking` is read and written before the
   * first `await` below, so two calls issued back to back with neither
   * awaited (`const a = owner.tick(); const b = owner.tick();`) resolve the
   * guard deterministically -- `a` claims it before yielding, `b` sees it
   * already claimed and returns immediately -- rather than depending on how
   * the two calls happen to interleave.
   *
   * An early return while `#ticking` is already true also checks the
   * watchdog (`#checkWatchdog`) before returning -- see that method's own
   * doc comment. This is deliberately piggybacked on the SAME early-return
   * path a real deployment already exercises every `liveTickMs`
   * (`main.ts`'s `setInterval` keeps calling `tick()` on schedule whether or
   * not the previous call has finished), rather than running its own
   * independent timer: it needs no lifecycle of its own to leak or to clean
   * up in `close()`, and it is exercised by exactly the mechanism that would
   * observe a real stall in production.
   */
  async tick(): Promise<void> {
    if (this.#ticking || this.#closing) {
      if (this.#ticking) this.#checkWatchdog();
      return;
    }
    this.#ticking = true;
    this.#tickStartedAt = Date.now();
    this.#watchdogWarnCount = 0;
    try {
      await this.#doTick();
    } finally {
      this.#ticking = false;
      this.#tickStartedAt = null;
    }
  }

  /**
   * Diagnostic only -- logs when `#ticking` has stayed true for over
   * `WATCHDOG_STUCK_MULTIPLIER` tick intervals, and AGAIN every additional
   * `WATCHDOG_STUCK_MULTIPLIER` intervals for as long as it stays stuck --
   * never cancels or races anything.
   *
   * A cancel-and-move-on design (e.g. `Promise.race`ing `#fold` against a
   * timeout) was considered and rejected: the ABANDONED `#fold` call would
   * keep running in the background regardless -- there is no way to
   * actually cancel `LiveChunkStore.readFrom`, which is exactly what stalls
   * (`BlobStore`'s `S3Client` sets no `requestTimeout`, see
   * `packages/storage/src/blobs.ts`). If a later tick then retried the same
   * run (freed to do so the instant the timeout gave up), TWO `#fold` calls
   * would be mutating the SAME `state.decoder` / `state.engine` at once the
   * moment the abandoned one finally resolved -- design §2.2.1's corruption
   * again, this time smuggled in by the very mechanism meant to guard
   * against overlap. `#ticking` staying true is what PREVENTS that; a
   * watchdog that logs instead of racing keeps that guarantee intact and
   * only restores what was actually missing -- visibility. Silence was the
   * whole problem: no error, no log, no further deltas for any run, and no
   * way to tell from outside whether the process was stuck or merely quiet.
   *
   * REPEATING, not one-shot, is load-bearing for that visibility claim, not
   * decoration: a single log line emitted once, possibly hours before an
   * operator investigates a hung `SIGTERM`, has typically scrolled out of
   * whatever log buffer or retention window exists by the time anyone
   * looks. `#watchdogWarnCount` tracks how many `thresholdMs` multiples
   * have already produced a warning (`Math.floor(stuckForMs /
   * thresholdMs)`), not a boolean, so a permanently-stuck tick keeps
   * re-arming: one warning at `1x threshold`, another at `2x`, and so on --
   * genuinely recurring in the log for as long as the stall lasts, on this
   * class's own early-return path (see `tick()`'s doc comment for why that
   * path needs no timer of its own to drive it).
   *
   * `close()` no longer waits on an in-flight tick at all (see its own doc
   * comment), so this watchdog's silence would no longer make SHUTDOWN
   * hang -- but a stuck tick still blocks every OTHER owned run's fold and
   * publish for as long as it lasts (`#doTick`'s fold loop `await`s each
   * run's `#fold` in sequence), which is exactly the ongoing, DURING-
   * NORMAL-OPERATION visibility gap repeating warnings are for.
   */
  #checkWatchdog(): void {
    if (this.#tickStartedAt === null) return;
    const stuckForMs = Date.now() - this.#tickStartedAt;
    const thresholdMs = this.#config.liveTickMs * WATCHDOG_STUCK_MULTIPLIER;
    const dueWarnings = Math.floor(stuckForMs / thresholdMs);
    if (dueWarnings <= this.#watchdogWarnCount) return;
    this.#watchdogWarnCount = dueWarnings;
    console.error(
      `LiveFoldOwner: tick() has not completed in over ${stuckForMs}ms ` +
        `(over ${dueWarnings * WATCHDOG_STUCK_MULTIPLIER}x liveTickMs) -- ` +
        `likely a stalled readFrom against blob storage (BlobStore's ` +
        `S3Client sets no requestTimeout). No further deltas will be ` +
        'published for ANY owned run until this tick resolves. This ' +
        'warning repeats for as long as the stall lasts.',
    );
  }

  async #doTick(): Promise<void> {
    const { rows } = await this.#pool.query<{ id: string }>(
      "SELECT id FROM run WHERE status = 'running'",
    );
    const runningIds = new Set(rows.map((r) => r.id));

    // Release first: an id that dropped out of 'running' must not be
    // treated as newly discoverable, and freeing its client/lock before the
    // claim pass below keeps the pool accounting honest within this tick.
    // Isolated per run for the same reason the claim and fold passes below
    // are: one run's unlock failing (a dead connection, a network blip)
    // must not strand every OTHER owned run's release for this tick too.
    for (const runId of this.#owned.keys()) {
      if (!runningIds.has(runId)) {
        await this.#guarded('release', runId, () => this.#release(runId));
      }
    }

    // Counts, not an early `break`, so the log line below reports the true
    // number skipped this tick rather than stopping at the first one and
    // leaving every later id silently unaccounted for.
    let skippedForCap = 0;
    for (const runId of runningIds) {
      if (this.#owned.has(runId)) continue;
      if (this.#owned.size >= this.#config.maxOwnedRuns) {
        skippedForCap += 1;
        continue;
      }
      // Isolated per run: `#claim` reaching for a `pg.PoolClient` the pool
      // cannot hand out (a bad connection string, or -- with the pool sized
      // per design §1.3 -- genuine exhaustion under an operator's
      // misconfiguration) must fail that ONE run's claim, not this whole
      // tick and every run already owned along with it.
      await this.#guarded('claim', runId, () => this.#claim(runId));
    }
    if (skippedForCap > 0) {
      // Design §1.3: "At the cap the owner logs and skips." A run silently
      // never folded is exactly the undiagnosable-from-outside failure §1.2
      // warns about for the missed-pub/sub case; this is the same failure
      // reached a different way, and needs the same visibility.
      console.warn(
        `LiveFoldOwner: at maxOwnedRuns (${this.#config.maxOwnedRuns}); ` +
          `skipped ${skippedForCap} newly-discovered running run(s) this tick`,
      );
    }

    for (const [runId, state] of this.#owned) {
      // Isolated per run -- see `#fold`'s own doc comment for the concrete,
      // ordinary way this throws (a run's chunk objects deleted out from
      // under a listed key by a concurrent `close()`), and why one run's
      // failure must not cost every other owned run its fold this tick.
      await this.#guarded('fold', runId, () => this.#foldOnce(runId, state));
    }

    // A separate loop, after every owned run has folded -- never combined
    // into the loop above so that a Redis failure publishing run A's delta
    // cannot be confused (in the log, or in effect) with run A's OWN fold
    // failing, and so that run B still gets its fold this tick even if run
    // A's publish call is what throws. Runs strictly after ALL folding for
    // this tick, per design §3.1 ("snapshot, build a delta, publish") and
    // per `#publish`'s own doc comment on why "after, never between reads"
    // matters for what a delta describes.
    for (const [runId, state] of this.#owned) {
      await this.#guarded('publish', runId, () => this.#publish(runId, state));
    }
  }

  /**
   * Builds this tick's delta from a clone-safe snapshot of the run's fold
   * state, advances that run's cursor, and writes the SAME serialized body
   * to both destinations design §3.4 names: `PUBLISH live:{runId}` for Part
   * 2b's fan-out, and `XADD live:{runId}:deltas MAXLEN ~200` for the replay
   * buffer FR-LIVE-8 wants. Part 2a writes that stream even though nothing
   * reads it until Part 2b -- splitting a stream's writer from its reader
   * across two sub-projects would leave 2b with nothing real to test replay
   * against.
   *
   * `{ clone: true }` is not optional (design §3.1): without it the
   * snapshot's rollups alias the SAME accumulators the next tick's `#fold`
   * mutates, so a delta `JSON.stringify`'d after the two `await`s below
   * would describe a state that kept changing underneath it -- one that
   * existed at no single instant, not merely a stale one.
   *
   * `state.cursor` is advanced to `next` ONLY once both Redis calls have
   * actually succeeded -- fix round 1, Important 1. It used to advance
   * unconditionally, before either call, on the theory that a `seq` gap is
   * all a consumer needs to detect a drop. That is true for `seq`, and
   * ONLY for `seq`: `next.lastBucketWidthMs` and `next.lastPublishedOffsetMs`
   * are not a loss-detection signal, they are the STATE `buildDelta`'s
   * coalesce rule (§3.3, `delta.ts`) reasons from on the NEXT call. Advance
   * them on a publish that never reached anyone and the next tick computes
   * `replaces = responseWidthMs !== prev.lastBucketWidthMs` against a width
   * ALREADY equal to the current one -- `false` -- and emits a plain upsert
   * for a series the consumer never received the REPLACEMENT for. That is
   * §3.3's exact hazard ("nothing thrown and nothing logged... the
   * consumer's picture is just quietly wrong from that tick on, forever"),
   * reached through the failure path instead of a genuine mid-run coalesce.
   * `seq` alone still must not repeat a value with different contents next
   * to it (`LiveDeltaSchema`'s own doc comment), so it advances regardless
   * of outcome -- `{ ...state.cursor, seq: next.seq }` on the catch path
   * reads as "this attempt is accounted for, but nothing it would have told
   * the next call about `replaces`/`since` actually happened."
   */
  async #publish(runId: string, state: FoldState): Promise<void> {
    const snapshot = state.engine.snapshot({ clone: true });
    const { delta, next } = buildDelta(runId, snapshot, state.cursor);
    const body = JSON.stringify(delta);
    try {
      await this.#redis.publish(`live:${runId}`, body);
      await this.#redis.xadd(`live:${runId}:deltas`, 'MAXLEN', '~', '200', '*', 'delta', body);
      state.cursor = next;
    } catch (err) {
      state.cursor = { ...state.cursor, seq: next.seq };
      throw err;
    }
  }

  /**
   * Runs `fn`, logging (not propagating) any failure. `tick()` processes
   * several runs in one pass, sharing nothing but this owner's own state
   * between them -- one run's storage error, decode error, or connection
   * failure is exactly that run's problem, not a reason to abandon claiming
   * or folding every run that comes after it in iteration order this tick.
   * A failed run simply gets retried next tick: an unclaimed id is
   * rediscovered by the next poll, and a claimed-but-failed-to-fold run
   * keeps its `FoldState` (and its `fetchedBytes` cursor) untouched, so
   * nothing about the failure needs to be remembered here.
   */
  async #guarded(label: string, runId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      console.error(`LiveFoldOwner: ${label} failed for run ${runId}`, err);
    }
  }

  /** The fold result for an owned run, or null if this owner does not hold
   * it. Test seam: production code never calls this -- `#publish` takes its
   * own snapshot on the same terms -- it exists so a test can inspect fold
   * state directly rather than parsing a wire delta back apart. */
  snapshotOf(runId: string): EngineResult | null {
    const state = this.#owned.get(runId);
    // clone: true -- the returned rollups must not alias accumulators the
    // next tick's fold mutates; see engine.ts's own doc comment on `clone`.
    return state ? state.engine.snapshot({ clone: true }) : null;
  }

  /**
   * Releases every owned run and quits this owner's own Redis connection.
   * Without this, a test (or a shutdown) that constructs more than one
   * owner leaks a pooled connection per owned run and eventually exhausts
   * the pool.
   *
   * DOES NOT WAIT FOR AN IN-FLIGHT TICK -- fix round 1, Important 2. An
   * earlier version set `#closing` and then awaited the SAME `#doTick()`
   * promise `#ticking` was guarding, on the theory that only a fully-
   * settled tick could guarantee every `#claim` it started had already
   * inserted its `FoldState` before the snapshot below was taken. That
   * guarantee was real, but the price was unbounded: a tick genuinely stuck
   * in `LiveChunkStore.readFrom` (blob storage's client sets no request
   * timeout -- see `#checkWatchdog`'s doc comment) made `close()`, and
   * therefore `main.ts`'s whole `shutdown()`, hang forever -- WORSE than
   * before this class had a `close()`/`#ticking` interlock at all, since a
   * stuck tick used to leave `close()` free to drain and return.
   *
   * The actual leak this method exists to prevent is closed AT ITS SOURCE
   * instead, in `#claim` (see that method's own doc comment): a claim that
   * wins its advisory lock AFTER `#closing` has been set unlocks and
   * releases its own client immediately rather than inserting into
   * `#owned` at all. Setting `#closing` here, synchronously, before this
   * method does anything else, is what makes that self-check meaningful --
   * every `#claim` call still able to reach the insert at `#claim`'s own
   * `this.#owned.set(...)` line has ALREADY read `#closing` as `false` and
   * committed to inserting by the time this line runs (JS has no
   * mid-statement preemption), so the snapshot below either sees that
   * insert already landed or the claim that would have produced it has
   * already unwound itself -- never a claim caught in between. With the
   * leak closed there, this method needs no wait of its own: draining
   * `#owned` immediately is correct regardless of what any in-flight tick
   * is currently doing.
   *
   * What remains, and is accepted rather than solved here: an ALREADY-
   * OWNED run's fold or publish that is mid-flight when `close()` runs is
   * NOT waited for either. Its `FoldState` is synchronously deleted from
   * `#owned` and its client released as part of the drain below (Map
   * deletion mid-iteration is well-defined in JS -- a `for...of` fold loop
   * still in progress on `this.#owned` simply stops finding further
   * entries once they are gone, and the SEPARATE publish loop that runs
   * after it starts fresh against whatever remains, which by then is
   * nothing new). The one in-flight `#fold` call already past its own
   * `readFrom` await, if any, keeps running in the background using its
   * captured `state` reference -- harmless in itself (nothing reads that
   * `state` again once its run is gone from `#owned`, and `#fold` never
   * touches `state.client`) -- but releasing that run's advisory lock while
   * its own `readFrom` may still be reading the SAME chunk keys reopens the
   * exact race `#fold`'s doc comment already documents as ordinary
   * operation for `LiveChunkStore.finalize` (a listed key deleted by a
   * concurrent finalize before its own `get` runs): `readFrom` throws, the
   * error is swallowed and logged by whatever `#guarded` call is still
   * wrapping it, nothing corrupts. Narrower than before (bounded to at
   * most the one run whose fold was already past its `readFrom` await at
   * the exact instant `close()` ran, and only during shutdown), and a
   * pre-existing, already-handled failure class rather than a new one.
   *
   * `Promise.allSettled` for the releases, not a sequential loop that stops
   * at the first rejection -- a loop awaiting `#release` one at a time
   * would abandon every run still left in `#owned` the moment ANY single
   * one's unlock query failed, leaking exactly the pooled connections this
   * method exists to prevent leaking, for every run after the failing one
   * in iteration order. Each run's `#release` is independent (its own
   * client, its own lock), so nothing is lost by running them concurrently.
   *
   * A failure is surfaced, not swallowed: `#release` already returns its
   * client to the pool in a `finally` regardless of whether the unlock
   * query itself succeeded (see its own doc comment), so nothing here is
   * needed to prevent a connection leak from an individual failure -- but
   * an advisory lock that failed to unlock stays held for as long as that
   * connection lives, which is real enough for a caller to want to know
   * about, and "some releases silently failed" is exactly this class's own
   * kind of undiagnosable-from-outside failure otherwise.
   *
   * The Redis connection is quit AFTER the release drain, and regardless of
   * whether any individual release failed -- same `Promise.allSettled`
   * reasoning applied to this owner's own last resource: one failure must
   * not strand the other.
   */
  async close(): Promise<void> {
    // Synchronous, first statement: see this method's own doc comment for
    // why setting this BEFORE anything else is what makes #claim's
    // self-check meaningful, and why that is what lets this method skip
    // waiting for any in-flight tick.
    this.#closing = true;

    const results = await Promise.allSettled(
      [...this.#owned.keys()].map((runId) => this.#release(runId)),
    );

    // Both connections quit independently (same Promise.all reasoning as
    // the release drain above applied to this owner's own two resources):
    // #sub failing to quit must not skip quitting #redis, or the reverse.
    await Promise.all([
      this.#redis.quit().catch((err: unknown) => {
        console.error('LiveFoldOwner: failed to quit redis connection during close()', err);
      }),
      this.#sub.quit().catch((err: unknown) => {
        console.error('LiveFoldOwner: failed to quit redis subscriber connection during close()', err);
      }),
    ]);

    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((f) => f.reason as unknown),
        `LiveFoldOwner.close(): failed to release ${failures.length} of ${results.length} owned run(s)`,
      );
    }
  }

  /**
   * Takes the advisory lock on a dedicated client and, only if won, starts
   * folding this run from byte 0. Mirrors `pipeline.service.ts`'s
   * `process()`: the lock is taken and released on the SAME connection,
   * never handed off, because releasing on a different pooled connection
   * than the one that took it would either fail outright or unlock nothing.
   *
   * SELF-CHECKS `#closing` immediately before inserting -- fix round 1,
   * Important 2. `close()` no longer waits for an in-flight tick before
   * draining `#owned` (see its own doc comment), which means a claim that
   * is still awaiting `pool.connect()` or the lock query when `close()`
   * runs would otherwise win its lock and insert a `FoldState` AFTER
   * `close()`'s drain has already run and returned -- a client neither
   * released by that drain nor ever released by anything else, leaked for
   * good. Checking `#closing` here, at the one and only insertion site,
   * closes that leak at its source: a claim that wins its lock too late to
   * matter unwinds itself (unlock, release the client) exactly like the
   * "another owner already holds it" branch just above, instead of
   * inserting into a map `close()` has already decided is final.
   */
  async #claim(runId: string): Promise<void> {
    const client = await this.#pool.connect();
    let got = false;
    try {
      const { rows } = await client.query<{ got: boolean }>(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS got',
        [RUN_INGEST_LOCK_NAMESPACE, runId],
      );
      got = rows[0]?.got ?? false;
    } catch (err) {
      client.release();
      throw err;
    }
    if (!got) {
      // Another owner (this process or another worker) already holds the
      // lock -- or PipelineService is parsing this run right now. Either
      // way, not ours this tick.
      client.release();
      return;
    }

    if (this.#closing) {
      // Won the lock, but close() already started (or finished) draining
      // #owned -- inserting now would never be seen by it. Unwind exactly
      // like #release does: unlock on this same client, then return it to
      // the pool in a finally regardless of whether the unlock succeeded.
      try {
        await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
          RUN_INGEST_LOCK_NAMESPACE,
          runId,
        ]);
      } finally {
        client.release();
      }
      return;
    }

    this.#owned.set(runId, {
      decoder: new StreamingLogDecoder(),
      engine: new LiveEngine(),
      client,
      fetchedBytes: 0,
      cursor: INITIAL_CURSOR,
    });
  }

  /**
   * The single gate every caller of `#fold` goes through -- `#doTick`'s own
   * fold loop included, not just `#onAdvance`. See `#folding`'s own doc
   * comment for the hazard this closes: a `live:advance` ping can call
   * `#fold` for a run WHILE `#doTick`'s fold loop (or another ping) is
   * already mid-`#fold` for that same run, and two concurrent `#fold` calls
   * against the same `FoldState` corrupt the decode.
   *
   * SERIALISES, does not drop, a trigger that finds a run already folding
   * -- fix round 1, Important 1. An earlier version returned immediately in
   * that case, on the theory that "whichever fold IS in flight will pick up
   * everything available once it reaches its own next `readFrom`". That is
   * FALSE: `#fold` issues exactly ONE `readFrom` call per invocation and
   * returns -- there is no "next `readFrom`" inside an already-in-flight
   * call, and that call's own read was issued BEFORE the dropped trigger's
   * bytes existed, which is precisely why the trigger arrived while it was
   * still in flight. Dropping it meant those bytes waited for `#doTick`'s
   * own next scheduled pass (up to `liveTickMs` later) on exactly the runs
   * where bytes arrive fastest -- silently defeating this whole task's
   * purpose under load, the one case where waking early matters most.
   *
   * So a trigger that finds `#folding.has(runId)` records the request in
   * `#foldAgain` instead of running `#fold` itself, and the call ALREADY in
   * flight -- see the `do`/`while` below -- checks that flag the instant it
   * finishes and, if set, clears it and folds again immediately, before
   * this method (and therefore `#doTick`'s own `#guarded('fold', ...)`
   * await, or `#onAdvance`'s) returns. `#foldAgain` is a Set of ids, not a
   * counter, so any number of triggers arriving during one in-flight fold
   * collapse into exactly one rerun, never one rerun per trigger. Clearing
   * it BEFORE each `#fold` call (not after) is what makes a trigger that
   * arrives DURING the rerun itself schedule a THIRD pass rather than being
   * silently absorbed by a flag already about to be cleared.
   */
  async #foldOnce(runId: string, state: FoldState): Promise<void> {
    if (this.#folding.has(runId)) {
      this.#foldAgain.add(runId);
      return;
    }
    this.#folding.add(runId);
    try {
      do {
        this.#foldAgain.delete(runId);
        await this.#fold(runId, state);
      } while (this.#foldAgain.has(runId));
    } finally {
      this.#folding.delete(runId);
    }
  }

  /**
   * Reads every chunk at or past the fetch frontier, decodes it, folds every
   * emitted event. The frontier advances by the bytes just fetched --
   * NEVER by `decoder.consumedBytes` (see `FoldState.fetchedBytes`'s doc
   * comment for why those two are not interchangeable) -- and it advances
   * IMMEDIATELY AFTER THE READ, before decoding, not after.
   *
   * That ordering is deliberate, not incidental. `readFrom` throwing here is
   * safe to retry: nothing below has mutated yet, so leaving `fetchedBytes`
   * unchanged and trying again next tick is exactly correct (and IS what
   * happens -- the advance below is never reached). But `decoder.push`
   * mutates the decoder's own buffer before it can ever throw a decode
   * error, and `engine.add` can throw partway through a prefix of events
   * already folded. If the frontier stayed unchanged after either of THOSE,
   * the next tick would call `readFrom` with the SAME argument, fetch the
   * SAME bytes the decoder already buffered or partially consumed, and feed
   * them to `push` a second time -- re-delivering already-received bytes is
   * exactly design §2.2.1's corruption, just reached via the failure path
   * instead of a wrong cursor formula, and just as silent. Advancing here
   * trades that compounding corruption for a bounded loss (the bytes that
   * caused THIS throw are not retried), which is what design §2.2 means by
   * "fetchedBytes then advances by the length of the bytes it just
   * received" -- immediately after the read is the only place that sentence
   * can mean.
   *
   * `readFrom` throwing here is not exotic, either. `LiveChunkStore.finalize`
   * (`apps/api/src/ingest/live.service.ts`'s `close()` calls it) lists a
   * run's chunk keys, then DELETES them once the assembled log is written
   * durably; `readFrom` lists keys and fans out parallel `get`s over them,
   * so a key it listed can be deleted by a concurrent `finalize` before its
   * own `get` runs, and that `get` rejects. `tick()` calls this once per
   * owned run per pass, so that must be this one run's failure, not every
   * other owned run's fold for the tick -- see `tick()`'s `#guarded` calls.
   */
  async #fold(runId: string, state: FoldState): Promise<void> {
    const bytes = await this.#chunks.readFrom(runId, state.fetchedBytes);
    if (bytes.length === 0) return;

    state.fetchedBytes += bytes.length;

    const events = state.decoder.push(bytes);
    for (const event of events) state.engine.add(event);
  }

  /** Drops the fold state, unlocks on the client that took the lock, and
   * returns that client to the pool. */
  async #release(runId: string): Promise<void> {
    const state = this.#owned.get(runId);
    if (!state) return;
    this.#owned.delete(runId);
    try {
      await state.client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
        RUN_INGEST_LOCK_NAMESPACE,
        runId,
      ]);
    } finally {
      state.client.release();
    }
  }
}
