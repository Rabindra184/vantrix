import { StreamingLogDecoder } from '@perfportal/plugin-gatling';
import { LiveEngine, type EngineResult } from '@perfportal/statistics';
import type { LiveChunkStore } from '@perfportal/storage';
import type pg from 'pg';
import type { WorkerConfig } from '../config.js';
import { RUN_INGEST_LOCK_NAMESPACE } from '../pipeline/pipeline.service.js';

/**
 * Everything one owned run needs to keep folding, held for as long as this
 * process owns the run. See the design doc's §2.1 for the authoritative
 * shape; `lastSeq` / `lastPublishedOffsetMs` / `lastBucketWidthMs` are not
 * here yet because this task does not publish — Task 5 adds the delta
 * cursor alongside Redis.
 */
interface FoldState {
  decoder: StreamingLogDecoder;
  engine: LiveEngine;
  /** Holds the advisory lock for `runId`. Taken and released on THIS client,
   * never a different one drawn from the pool -- see `#claim` and
   * `#release`. */
  client: pg.PoolClient;
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
 * No publishing here -- Task 5 wires deltas onto Redis. `tick()` only
 * claims, folds, and releases; `snapshotOf` is a test seam standing in for
 * the publish path until then.
 */
export class LiveFoldOwner {
  readonly #config: WorkerConfig;
  readonly #pool: pg.Pool;
  readonly #chunks: LiveChunkStore;
  readonly #owned = new Map<string, FoldState>();
  /**
   * Guards `tick()` against overlapping with itself. Task 5 drives it from a
   * `setInterval` in the same shape `main.ts` already uses for the sweeper's
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

  constructor(config: WorkerConfig, pool: pg.Pool, chunks: LiveChunkStore) {
    this.#config = config;
    this.#pool = pool;
    this.#chunks = chunks;
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
   */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#doTick();
    } finally {
      this.#ticking = false;
    }
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
   * it. Test seam standing in for Task 5's publish path. */
  snapshotOf(runId: string): EngineResult | null {
    const state = this.#owned.get(runId);
    // clone: true -- the returned rollups must not alias accumulators the
    // next tick's fold mutates; see engine.ts's own doc comment on `clone`.
    return state ? state.engine.snapshot({ clone: true }) : null;
  }

  /** Releases every owned run. Without this, a test (or a shutdown) that
   * constructs more than one owner leaks a pooled connection per owned run
   * and eventually exhausts the pool. */
  async close(): Promise<void> {
    for (const runId of [...this.#owned.keys()]) {
      await this.#release(runId);
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
