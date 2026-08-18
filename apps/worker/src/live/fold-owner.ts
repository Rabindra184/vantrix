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
 */
export class LiveFoldOwner {
  readonly #config: WorkerConfig;
  readonly #pool: pg.Pool;
  readonly #chunks: LiveChunkStore;
  readonly #redis: Redis;
  readonly #owned = new Map<string, FoldState>();
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
   * Set once `close()` has been called. Checked alongside `#ticking` in
   * `tick()` so that once a drain has started, no later call can start a
   * NEW pass that would insert a fresh `FoldState` after (or during) that
   * drain -- see `close()`'s own doc comment for the race this closes.
   */
  #closing = false;
  /**
   * The promise behind the currently (or most recently) in-flight
   * `#doTick()` call, so `close()` can await the SAME pass `#ticking` is
   * guarding rather than only the state that pass has produced so far. See
   * `close()`'s doc comment.
   */
  #tickPromise: Promise<void> | null = null;
  /** When the in-flight tick started, for `#checkWatchdog`; `null` whenever
   * `#ticking` is false. */
  #tickStartedAt: number | null = null;
  /** Whether the watchdog has already logged for the CURRENT stuck episode,
   * so a hung tick produces one warning, not one per subsequent `tick()`
   * call that finds it still stuck. Reset to `false` every time a tick
   * actually starts. */
  #watchdogWarned = false;

  constructor(config: WorkerConfig, pool: pg.Pool, chunks: LiveChunkStore, redis: Redis) {
    this.#config = config;
    this.#pool = pool;
    this.#chunks = chunks;
    this.#redis = redis;
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
    this.#watchdogWarned = false;
    const settled = this.#doTick();
    this.#tickPromise = settled;
    try {
      await settled;
    } finally {
      this.#ticking = false;
      this.#tickStartedAt = null;
    }
  }

  /**
   * Diagnostic only -- logs once when `#ticking` has stayed true for over
   * `WATCHDOG_STUCK_MULTIPLIER` tick intervals, and never cancels or races
   * anything.
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
   * This does NOT make `close()` return promptly if the current tick really
   * is stuck forever -- `close()` awaits the same in-flight pass (see its
   * own doc comment), so a genuine hang here is a genuine shutdown hang too.
   * That is accepted rather than papered over: this file cannot fix
   * `readFrom`'s missing timeout (out of this task's scope -- see the
   * paragraph above), and a `close()` that abandoned a possibly-still-owned
   * client to avoid waiting would reintroduce the exact leak this method's
   * own interlock exists to close. The watchdog at least means an operator
   * SEES the stall build up (repeatedly, every `liveTickMs`, well before any
   * shutdown is even attempted) instead of a shutdown that hangs with no
   * prior explanation.
   */
  #checkWatchdog(): void {
    if (this.#tickStartedAt === null || this.#watchdogWarned) return;
    const stuckForMs = Date.now() - this.#tickStartedAt;
    const thresholdMs = this.#config.liveTickMs * WATCHDOG_STUCK_MULTIPLIER;
    if (stuckForMs < thresholdMs) return;
    this.#watchdogWarned = true;
    console.error(
      `LiveFoldOwner: tick() has not completed in over ${stuckForMs}ms ` +
        `(over ${WATCHDOG_STUCK_MULTIPLIER}x liveTickMs) -- likely a stalled ` +
        `readFrom against blob storage (BlobStore's S3Client sets no ` +
        `requestTimeout). No further deltas will be published for ANY owned ` +
        'run until this tick resolves.',
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
      await this.#guarded('fold', runId, () => this.#fold(runId, state));
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
   * The cursor is advanced BEFORE either Redis call, not after. A publish
   * that fails partway (a dropped connection between the `PUBLISH` and the
   * `XADD`, say) still must not re-emit the SAME `seq` next tick with
   * DIFFERENT contents -- `seq` is how a consumer detects a gap at all
   * (`LiveDeltaSchema`'s own doc comment), and a repeated value would hide
   * exactly the drop it exists to reveal. A tick that fails to publish is
   * simply a gap the next successful one is visible across, which is the
   * behaviour the wire contract is already designed to tolerate.
   */
  async #publish(runId: string, state: FoldState): Promise<void> {
    const snapshot = state.engine.snapshot({ clone: true });
    const { delta, next } = buildDelta(runId, snapshot, state.cursor);
    state.cursor = next;
    const body = JSON.stringify(delta);
    await this.#redis.publish(`live:${runId}`, body);
    await this.#redis.xadd(`live:${runId}:deltas`, 'MAXLEN', '~', '200', '*', 'delta', body);
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
   * INTERLOCKS WITH `#ticking` BEFORE TOUCHING `#owned`, and that ordering
   * is load-bearing, not defensive dressing. `#owned` is mutated by
   * `#claim` mid-tick, so a naive `close()` that read `#owned` without
   * regard for an in-flight `tick()` could take its snapshot BETWEEN a
   * `#claim` starting and it inserting the `FoldState` it just won the
   * advisory lock for -- that run's client would then never appear in the
   * snapshot below, never get released, and `main.ts`'s `pool.end()` would
   * wait on it forever with nothing to explain why. Setting `#closing`
   * FIRST (checked in `tick()` alongside `#ticking`) guarantees no NEW pass
   * can start once this method has begun, so there is at most one
   * already-in-flight pass left to wait for; awaiting `#tickPromise` -- the
   * SAME promise `#ticking` is guarding, not a fresh call of our own --
   * then guarantees that pass has fully settled `#owned` (every `#claim` it
   * started has either inserted its `FoldState` or failed and logged,
   * `#guarded`'s already-per-run isolation covers that) before the snapshot
   * below is taken. `#tickPromise` being `null` (no tick has ever run, or
   * one already finished and cleared it) makes the wait a no-op.
   *
   * A tick that is STUCK, not merely slow, makes this method stuck too --
   * see `#checkWatchdog`'s own doc comment for why that trade is accepted
   * rather than solved by racing a timeout here as well. That failure mode
   * lives entirely in `LiveChunkStore.readFrom` never settling (blob
   * storage's client sets no request timeout), which this file cannot fix
   * without touching `packages/storage/src/blobs.ts` -- outside this
   * task's scope. The watchdog at least means the stall was already visible
   * in the logs, repeatedly, before any shutdown was even attempted.
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
    this.#closing = true;
    if (this.#tickPromise) {
      await this.#tickPromise.catch((err: unknown) => {
        // `#doTick`'s own per-run work is already isolated by `#guarded`;
        // what can still reach here is the UN-guarded discovery query at
        // the very top of `#doTick`. That failure is orthogonal to closing
        // down and must not abort the drain below -- the whole reason the
        // release step itself uses Promise.allSettled rather than a bare
        // await chain.
        console.error('LiveFoldOwner: in-flight tick failed while close() was waiting for it', err);
      });
    }

    const results = await Promise.allSettled(
      [...this.#owned.keys()].map((runId) => this.#release(runId)),
    );

    await this.#redis.quit().catch((err: unknown) => {
      console.error('LiveFoldOwner: failed to quit redis connection during close()', err);
    });

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

    this.#owned.set(runId, {
      decoder: new StreamingLogDecoder(),
      engine: new LiveEngine(),
      client,
      fetchedBytes: 0,
      cursor: INITIAL_CURSOR,
    });
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
