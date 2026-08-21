import { LiveSlaSchema } from '@perfportal/contracts';
import { LIVE_CHANNELS } from '@perfportal/core';
import type { Redis } from 'ioredis';
import { RuleRepository, type ProjectScope } from '@perfportal/persistence';
import { StreamingLogDecoder } from '@perfportal/plugin-gatling';
import { evaluateRules, liveEvidenceFloor, toEvaluableStats, type EvaluableRule } from '@perfportal/sla';
import { LiveEngine, type EngineOptions, type EngineResult } from '@perfportal/statistics';
import type { LiveChunkStore } from '@perfportal/storage';
import type pg from 'pg';
import type { WorkerConfig } from '../config.js';
import { RUN_INGEST_LOCK_NAMESPACE } from '../pipeline/pipeline.service.js';
import { buildDelta, buildSnapshot, INITIAL_CURSOR, type DeltaCursor, type SlaInput } from './delta.js';

/**
 * Everything a claim has to read off the run's OWN row, resolved once per
 * claim: the tenant `#claimRules` scopes its rule query by, and the engine
 * options this run was opened under.
 *
 * `engineOptions` is not a passenger here. `LiveEngine` reads `warmupMs` out
 * of it, and `warmupMs` decides which events are aggregated AT ALL
 * (`engine.ts`'s `isWarmup` guard, applied to every rollup a rule can name)
 * -- so an owner that constructed `new LiveEngine()` with no options folded
 * events the batch parse of the SAME bytes discards. `PipelineService`
 * passes `run.engineOptions` (pipeline.service.ts), frozen at open from
 * project settings (`LiveService.open`); this reads the same column, so the
 * live banner and the final verdict stay two readings of ONE instrument.
 * Measured before it was threaded, on six requests with `warmupMs: 5000`:
 * live reported `count 6, max 4000`, batch reported `count 3, max 50`.
 */
interface RunClaimContext extends ProjectScope {
  engineOptions: EngineOptions;
}

/**
 * One `run` row as BOTH readers of it select it -- `#doTick`'s discovery
 * poll and `#lookupRunContext`'s per-claim fallback. Shared so the two can
 * never drift into disagreeing about what a claim context is made of.
 */
function runContextOf(row: {
  org_id: string;
  project_id: string;
  engine_options: unknown;
}): RunClaimContext {
  return {
    orgId: row.org_id,
    projectId: row.project_id,
    // `engine_options` is a NOT NULL `Json` column (schema.prisma), so this
    // is an object in practice -- but degrading a SQL or JSON null to the
    // engine's own defaults is the only sane reading anyway, and it is what
    // `runEngineAsync(..., run.engineOptions as EngineOptions)` on the batch
    // side effectively does with the same value.
    engineOptions: (row.engine_options ?? {}) as EngineOptions,
  };
}

/**
 * What a claim recovers from a run that was already being streamed --
 * everything a new owner cannot re-derive from the bytes alone. Both fields
 * come out of ONE read of the replay stream's tip (`#resumeState`).
 */
interface ResumeState {
  cursor: DeltaCursor;
  /** `FoldState.breachingSince`, as the last published delta reported it. */
  breachingSince: Map<string, number>;
}

/** A run nobody has published for: `INITIAL_CURSOR` and no breach history.
 * A function and not a shared constant, because the map is owner state the
 * `FoldState` goes on to mutate. */
function blankResume(): ResumeState {
  return { cursor: INITIAL_CURSOR, breachingSince: new Map() };
}

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
  /**
   * The project's rules AS THEY READ WHEN THIS RUN WAS CLAIMED. Deliberately
   * not re-read per tick: a run's SLA should be the SLA it started under, and
   * a rule edited mid-run would otherwise make a breach appear with no change
   * in the data.
   */
  rules: EvaluableRule[];
  /**
   * True when `rules` is `[]` because the load FAILED at claim (the tenant
   * lookup found no row, or `RuleRepository.listEnabled` itself threw) --
   * distinct from a project that legitimately has no enabled rules, which
   * also leaves `rules` as `[]` but with this `false`. Without this, "the
   * DB was unreachable when this run was claimed" and "nobody has
   * configured an SLA yet" render identically: a breach banner reading
   * "nothing breaching" either way. The claim still succeeds either way --
   * see `#claimRules`'s own doc comment for why failing open is right here.
   */
  rulesLoadFailed: boolean;
  /**
   * ruleId -> the elapsed offset at which it began breaching.
   *
   * SEEDED FROM THE REPLAY TIP ON CLAIM, not started empty -- see
   * `#resumeState`. A re-claim (rolling deploy, crash, lock handover)
   * re-folds this run from byte 0, so on its first tick `snapshot.durationMs`
   * is the FULL elapsed offset; a rule that has been breaching since minute
   * three would be re-stamped at the moment the new owner took over. That is
   * the one number in the banner an abort decision turns on, and it fails in
   * the direction that suppresses action: a 4-hour soak breaching at 3
   * minutes, redeployed at 2h40m, would read "breaching since 2h 40m 0s".
   *
   * Entries for rules that are NOT breaching on the first tick after the
   * claim are pruned by `#publish`'s own recovery loop before anything is
   * published, so a tip carrying a rule since disabled, deleted, or recovered
   * costs one map entry for part of one tick.
   */
  breachingSince: Map<string, number>;
  /**
   * Ticks since `live:{runId}:snapshot` was last written. Compared against
   * {@link SNAPSHOT_EVERY_N_TICKS} in `#publish`.
   *
   * Initialised to `SNAPSHOT_EVERY_N_TICKS` itself on claim, not 0 -- so the
   * very first tick a run is owned already writes a snapshot, rather than
   * leaving a freshly-claimed (or re-claimed after a worker restart) run
   * unseedable for a full interval, which at the default is five minutes a
   * late joiner would otherwise have nothing to seed from.
   */
  ticksSinceSnapshot: number;
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
 * How many bytes of published deltas one run's replay stream
 * (`live:{runId}:deltas`) may hold, before Redis's own per-entry overhead.
 *
 * ═══ WHY A BYTE BUDGET AND NOT AN ENTRY COUNT ═══
 * The stream used to be capped at a flat `MAXLEN ~ 200`, which bounds the
 * number of deltas while bounding NOTHING about their size -- and a delta's
 * size is set by the run's shape, not by anything this owner controls.
 * `users` is sent WHOLE every tick, by design (§3.2), and `UserSeries`
 * coalesces each SCENARIO independently against its own
 * `maxBucketsUsers` -- 1200 by default, PER SCENARIO. A 20-scenario soak
 * therefore carries up to 24,000 user buckets in every delta, each of them
 * a `{scenario, startOffsetMs, active}` object: on the order of a megabyte
 * of JSON per message. Two hundred of those is hundreds of megabytes for
 * ONE run's replay buffer, times up to `maxOwnedRuns` runs per worker, in a
 * Redis that `infra/docker-compose.yml` gives no `maxmemory` and no
 * eviction policy.
 *
 * ═══ WHY NOT THE OTHER TWO OPTIONS ═══
 * Omitting `users` from the replay copy was rejected: it is the ONE series
 * a late subscriber can bootstrap correctly (see `delta.ts` -- `users` is
 * whole, `responseTime` is a window), so dropping it from replay removes
 * the only part of a replayed delta that stands on its own. It would also
 * mean the stream and the pub/sub channel carry DIFFERENT bodies for the
 * same `seq`, which is a trap for Part 2b rather than a saving.
 * Truncating the `users` envelope per tick was rejected for contradicting
 * §3.2's "sent whole" outright -- a partial `users` array is
 * indistinguishable on the wire from a run that genuinely has fewer
 * scenarios.
 *
 * Capping by bytes keeps every retained delta INTACT and shrinks the
 * WINDOW instead. A run whose deltas are small keeps the full
 * {@link REPLAY_MAX_ENTRIES}; a run whose deltas are enormous keeps fewer,
 * which is the honest trade -- and the property that actually needed
 * bounding was always "how much Redis does one run cost", never "how many
 * messages".
 *
 * ═══ THE VALUE ═══
 * 4 MiB. At NFR-SC-4's 50 concurrent live runs that is ~200 MB across the
 * whole deployment, which is a reasonable working set for a Redis already
 * carrying BullMQ. It also keeps the full 200-entry window for any delta up
 * to ~21 KB, which covers ordinary runs comfortably -- the budget only
 * starts biting on exactly the pathological shapes it exists for.
 *
 * ═══ WHAT REMAINS EXPOSED, stated rather than papered over ═══
 *  - Redis's own per-entry overhead (the entry id, the `delta` field name,
 *    listpack bookkeeping) is not counted. It is tens of bytes against a
 *    body measured in kilobytes.
 *  - TASK 9 B3: this budget is not actually a hard per-run ceiling, and the
 *    case that breaks it is not exotic. A RE-BUCKETING delta
 *    (`responseTime.replaces: true` -- see delta.ts's "THE COALESCE RULE")
 *    carries its series from offset 0 rather than from a cursor, so it
 *    routinely dwarfs the ordinary upsert deltas immediately before and
 *    after it in the stream -- it "exceeds its neighbours". Because
 *    {@link replayEntryCap} is recomputed on EVERY publish from that
 *    publish's OWN body, the cap right after the re-bucketing tick is small
 *    (correctly, for that oversized tick), but the very next tick's small,
 *    ordinary delta recomputes a much LARGER cap -- one wide enough to also
 *    keep the still-recent oversized survivor, for as long as it stays
 *    within {@link REPLAY_MAX_ENTRIES} of the tip. So the true bound on one
 *    run's retained bytes is not this budget alone; it is this budget (as
 *    sized by whichever tick's body last computed the cap in effect) PLUS
 *    however large that one still-surviving oversized entry is. A stream
 *    with nothing in it is not a replay buffer, and one oversized entry
 *    surviving alongside a budget-sized window is a bounded overshoot where
 *    the previous behaviour's was not bounded at all -- but "bounded" here
 *    means "budget plus one oversized entry", not "budget".
 *  - This bounds one WORKER's owned runs. Two workers at
 *    `maxOwnedRuns` each is twice the figure above, and the compose file
 *    still sets no `maxmemory` -- deliberately, since the only eviction
 *    policies that would fit share the instance with BullMQ's job data and
 *    would start dropping jobs instead.
 */
export const REPLAY_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * The most deltas one run's replay stream holds regardless of how small
 * they are -- FR-LIVE-8's replay depth, and the cap this stream had before
 * {@link REPLAY_BUDGET_BYTES} joined it. The two are a MINIMUM of each
 * other, not alternatives: entries bound the window in TIME (200 ticks,
 * ~17 minutes at the 5 s default) and bytes bound it in SPACE.
 */
export const REPLAY_MAX_ENTRIES = 200;

/**
 * How many ticks between whole-state snapshots to `live:{runId}:snapshot`.
 *
 * ═══ THIS AND THE REPLAY CAP ARE ONE DECISION ═══
 * A connecting client seeds from the snapshot and then replays the stream
 * FORWARD from the snapshot's seq. If the stream's oldest surviving entry is
 * newer than that seq, the join drops every bucket in between -- silently,
 * because a consumer cannot tell a bucket that was never sent from one that
 * saw no traffic.
 *
 * `REPLAY_MAX_ENTRIES` is 200 (~17 minutes at the 5 s default), but
 * `REPLAY_BUDGET_BYTES` can lower the retained count below that at any moment
 * for a run with large deltas. So this interval is chosen well inside the
 * BYTE-derived floor rather than against the entry cap: 60 ticks is 5 minutes
 * at the default, leaving the stream more than three times the room it needs
 * even when the budget is biting hard.
 *
 * The gateway still treats "oldest entry newer than the snapshot's seq" as
 * recoverable -- re-read the snapshot, which by then has advanced -- because
 * this margin is an argument, not an invariant, and the failure it guards is
 * invisible.
 */
export const SNAPSHOT_EVERY_N_TICKS = 60;

/**
 * How long a snapshot key outlives its last write.
 *
 * `infra/docker-compose.yml` sets no `maxmemory` and no eviction policy
 * deliberately (this Redis also carries BullMQ job data, and every fitting
 * policy would start dropping jobs), so THIS TTL is the only thing that
 * reclaims the snapshot of a run whose producer died without close().
 *
 * One hour: twelve times the write interval above, and six times
 * `runningStaleAfterMs` (10 min default), so the sweeper finalizes an
 * abandoned run long before its snapshot expires. A run whose ticks stall past
 * this loses only the seed, which the gateway degrades over rather than
 * failing on.
 */
export const SNAPSHOT_TTL_SECONDS = 3600;

/**
 * How long the REPLAY STREAM outlives its last write, for exactly the reason
 * above -- and its absence was a leak with no ceiling.
 *
 * `live:{runId}:deltas` had no TTL and is deleted by nothing: not `#release`,
 * not `#onClosed`, not the gateway. So every run that ever streamed left up
 * to {@link REPLAY_BUDGET_BYTES} in Redis PERMANENTLY. The design's memory
 * arithmetic is sized against CONCURRENT runs; the real figure grew with the
 * deployment's LIFETIME run count, in the same instance that carries BullMQ
 * job data, and `infra/docker-compose.yml` deliberately sets no `maxmemory`
 * and no eviction policy (every fitting policy would start dropping jobs).
 *
 * A `DEL` in `#release` was the alternative and is worse on both halves: it
 * misses the case that actually strands the key -- an owner that died without
 * releasing -- and it destroys the resume window at the exact moment a
 * viewer's socket drops, which is the moment the run ends and every viewer's
 * page transitions at once.
 *
 * The same hour as the snapshot's, and deliberately the SAME number rather
 * than a second one to reason about: the two keys are one seed between them
 * ({@link LiveGateway}'s `attemptSeed` reads both), the stream only needs to
 * outlive its run by the resume window, and that window is bounded by
 * `runningStaleAfterMs` (10 min default) -- past which the sweeper has
 * finalized the run and no client is resuming anything. An hour is six times
 * that, and it keeps the pair expiring together instead of leaving a stream
 * whose snapshot has gone, which the gateway can only seed from as `partial`.
 */
export const REPLAY_TTL_SECONDS = SNAPSHOT_TTL_SECONDS;

/**
 * How many entries this delta's replay stream may keep, given what this
 * delta costs.
 *
 * Recomputed per publish, from the CURRENT body ONLY -- not from the largest
 * body the stream currently holds, which is what makes the budget an honest
 * approximation rather than a hard ceiling (TASK 9 B3, see
 * {@link REPLAY_BUDGET_BYTES}'s own "WHAT REMAINS EXPOSED" for the concrete
 * case: a re-bucketing delta's cap is small when IT publishes, but the very
 * next, ordinary-sized delta recomputes a much larger cap that also keeps
 * that oversized entry around). What this recomputation DOES buy is holding
 * the budget as the TYPICAL delta a run produces grows over its life --
 * deltas trend larger as a run runs longer, so a cap fixed at claim time
 * would under-retain early and over-retain late. Total retained bytes track
 * roughly the budget, not whatever the deltas happened to cost when the run
 * started -- "roughly", not "at or under": see the oversized-entry case
 * above for exactly how the true bound differs from the nominal one.
 *
 * `Buffer.byteLength`, not `body.length`: the cap is a bound on what REDIS
 * stores, which is UTF-8, while a JS string's `length` counts UTF-16 code
 * units. They agree for ASCII and diverge for exactly the non-ASCII
 * scenario and request names a real run is free to contain -- undercounting
 * the budget by up to 3x on the runs most likely to be large.
 *
 * Exported for its own unit test. It is the one part of this file that is
 * pure arithmetic, and the one whose failure mode is quiet: a cap that
 * silently came out as 0 would make every XADD delete the entire stream it
 * had just written to.
 */
export function replayEntryCap(body: string): number {
  const bytes = Buffer.byteLength(body, 'utf8');
  return Math.min(REPLAY_MAX_ENTRIES, Math.max(1, Math.floor(REPLAY_BUDGET_BYTES / bytes)));
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
 * After folding, each owned run is snapshotted (`{ clone: true }` --
 * see `#publish`'s own doc comment for why that flag is load-bearing),
 * turned into a delta by the pure `buildDelta`, and published to both of
 * design §3.4's destinations. Publishing always runs strictly after that
 * run's fold for the same tick, never interleaved with it, so every delta
 * describes a whole number of decoded records.
 *
 * DISCOVERY IS THE TICK'S OWN POLL PLUS THREE REDIS PINGS, NEVER THE PINGS
 * ALONE (design §1.2). `LiveNotifier` (`apps/api/src/ingest/live-notifier.ts`)
 * publishes `live:opened` when a run is created, `live:advance` after a
 * chunk is durably accepted, and `live:closed` when `close()` claims a run
 * off `running`; `listen()` subscribes this owner to all three and
 * `#onOpened`/`#onAdvance`/`#onClosed` react. Any message can be dropped --
 * Redis pub/sub has no persistence, and a message published while every
 * worker is down (a deploy, an outage) reaches nobody -- so `#doTick`'s poll
 * of `WHERE status = 'running'` keeps running on its own schedule
 * regardless of whether any ping ever arrives, and its release pass drops
 * any owned run that has left `running` regardless of whether `live:closed`
 * arrived.
 *
 * TWO OF THE THREE ARE OPTIMISATIONS AND ONE IS NOT. `live:opened` and
 * `live:advance` only lower latency; the poll finds both cases on its own.
 * `live:closed` removes a latency that is itself the defect -- see
 * `#onClosed`'s own doc comment for why the close path is incorrect without
 * it, and why that is still compatible with a dropped message being
 * survivable.
 */
export class LiveFoldOwner {
  readonly #config: WorkerConfig;
  readonly #pool: pg.Pool;
  readonly #chunks: LiveChunkStore;
  readonly #redis: Redis;
  /**
   * Reads a claimed run's SLA rules, ONCE, at claim -- see `FoldState.rules`'
   * own doc comment for why never again after. Built by the caller on the
   * Prisma client it already owns (`main.ts`): this class touches Postgres
   * everywhere else through `#pool`'s raw `pg.Pool`, and constructing a
   * second `PrismaClient` here would open a second connection pool that
   * `main.ts`'s careful, term-by-term connection sizing does not know about.
   */
  readonly #rules: RuleRepository;
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
   * Run ids with a `#claim` IN FLIGHT -- reserved against `maxOwnedRuns`
   * even though nothing is in `#owned` for them yet.
   *
   * WITHOUT THIS THE CAP IS NOT A CAP. `#claim` awaits `pool.connect()` and
   * then the lock query -- two round trips -- before it inserts anything,
   * and the ioredis `message` handler fires `void this.#guarded(...)` per
   * message with NO serialization between them. So N `live:opened` pings
   * arriving inside that window all read the same pre-insert `#owned.size`,
   * all pass the cap check, and all insert: the cap is overshot by however
   * many pings land in one connect-plus-lock window, unbounded. Not exotic
   * -- NFR-SC-4 targets 50 concurrent live runs and pub/sub fans every
   * `live:opened` to every replica, so a CI fan-out opening 30 runs at once
   * is the documented load.
   *
   * AND THE OVERSHOOT IS UNRECOVERABLE, which is what makes it worse than
   * "a few runs too many". Design §1.3 sizes the shared pool FROM this cap;
   * `main.ts` leaves exactly one client of headroom for `#doTick`'s own
   * discovery query. Overshoot past that and every pooled client is held by
   * a `FoldState`, so `#doTick`'s FIRST statement -- the `SELECT id FROM
   * run WHERE status = 'running'` -- waits out `connectionTimeoutMillis`
   * and throws. `#doTick` therefore never reaches its release loop, and
   * `#release` is called from nowhere else except `close()`. Nothing ever
   * frees a client again; every later tick fails identically, and
   * `PipelineService` and `Sweeper` starve on the same pool. Recovery needs
   * a process restart.
   *
   * A Set of ids rather than a counter, so the "already claiming this run"
   * case is the same lookup as the "already own this run" one, and so a
   * leaked increment is not expressible.
   */
  readonly #claiming = new Set<string>();
  /**
   * Run ids `#onClosed` has released since the CURRENT tick's poll ran, so
   * that tick's claim loop does not immediately re-claim them from its own
   * now-stale snapshot.
   *
   * A real window, not a theoretical one. `#doTick` polls once, releases
   * runs missing from that snapshot, then claims runs in it that are not
   * owned -- and both loops `await` per run, so a `live:closed` ping can be
   * delivered BETWEEN them. The release pass has already passed over that
   * run (it was still `running` when the poll ran), `#onClosed` then deletes
   * it from `#owned`, and the claim loop finds an id that is in
   * `runningIds` and not owned: it claims it straight back, and holds the
   * lock until the NEXT tick's release pass. That is exactly the
   * `liveTickMs`-plus-a-tick latency `live:closed` exists to remove,
   * reintroduced by the tick that was running when it arrived.
   *
   * Cleared at the TOP of `#doTick`, before the poll query, which is what
   * bounds it. A ping delivered before that clear had its `claimForClose`
   * COMMIT before it too, so the poll immediately after already sees
   * `parsing` and the id never enters `runningIds` at all -- nothing is
   * lost by forgetting it. A ping delivered after the clear is in the set
   * for the rest of that tick, which is precisely the span the stale
   * snapshot covers.
   */
  readonly #recentlyClosed = new Set<string>();
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

  constructor(
    config: WorkerConfig,
    pool: pg.Pool,
    chunks: LiveChunkStore,
    redis: Redis,
    rules: RuleRepository,
  ) {
    this.#config = config;
    this.#pool = pool;
    this.#chunks = chunks;
    this.#redis = redis;
    this.#rules = rules;
    this.#sub = redis.duplicate();
    // Registered here, not inside listen(): ioredis buffers a 'message'
    // listener attached before subscribe() resolves just fine (the
    // EventEmitter is live from construction), so there is no ordering
    // requirement forcing this into listen() -- and keeping it here means
    // the routing table exists as soon as the instance does, regardless of
    // whether or when a caller ever calls listen() at all.
    this.#sub.on('message', (channel: string, message: string) => {
      if (channel === LIVE_CHANNELS.opened) {
        void this.#guarded('claim (ping)', message, () => this.#onOpened(message));
      } else if (channel === LIVE_CHANNELS.advance) {
        void this.#guarded('fold (ping)', message, () => this.#onAdvance(message));
      } else if (channel === LIVE_CHANNELS.closed) {
        void this.#guarded('release (ping)', message, () => this.#onClosed(message));
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
    await this.#sub.subscribe(LIVE_CHANNELS.opened, LIVE_CHANNELS.advance, LIVE_CHANNELS.closed);
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
    // A cheap early-out only. `#claim` re-checks the same thing
    // SYNCHRONOUSLY at its own reservation point, which is the check that
    // actually holds -- see `#claiming`'s doc comment for why a check here,
    // before two awaited round trips, cannot.
    if (this.#atCap()) return;
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
   *
   * CHECKS `#closing` FIRST -- fix round 1, Minor 2 -- the same guard
   * `#onOpened` already applies, for symmetry rather than because a missing
   * check here was ever unsafe: `#fold` touches no pooled client (only
   * `state.decoder`/`state.engine`, and blob storage), and any failure it
   * hits is swallowed by the `#guarded` wrapper the `message` handler
   * already installs. Without this, though, a ping delivered during
   * `close()`'s release drain could read `#owned` before that run's entry
   * is deleted and start a fold that outlives `close()` -- harmless in
   * effect, but needless: `close()` has already committed to shutting
   * every owned run down, so a fold started after that point serves no one.
   */
  async #onAdvance(runId: string): Promise<void> {
    if (this.#closing) return;
    const state = this.#owned.get(runId);
    if (!state) return;
    await this.#foldOnce(runId, state);
  }

  /**
   * Reacts to `live:closed` (design §1.2, as amended): a run's `close()`
   * has claimed it off `running`, so release its advisory lock NOW instead
   * of on the next tick's release pass.
   *
   * THIS CHANNEL IS NOT AN OPTIMISATION, and that is the amendment's own
   * wording. `LiveService.close()` enqueues the terminal parse moments
   * after publishing this, and `PipelineService.process` takes the SAME
   * advisory lock this owner is still holding -- §1.1 reuses the namespace
   * deliberately, precisely so a run cannot be folded and parsed at once.
   * The pipeline's entire budget for waiting that out is BullMQ's three
   * attempts on exponential backoff from 2 s: about 6 s. This owner's
   * release latency without this handler is `liveTickMs` PLUS the duration
   * of whatever tick is in flight, and that duration is unbounded -- one
   * tick folds and publishes up to `maxOwnedRuns` runs sequentially. Raise
   * `LIVE_TICK_MS` at all, or have one slow tick at the defaults, and all
   * three attempts are gone; the run then sits at `parsing` until the
   * sweeper's `parsingStaleAfterMs` (15 minutes) re-enqueues it.
   *
   * A DROPPED MESSAGE IS STILL SURVIVABLE, so "not an optimisation" does
   * not make this a single point of failure. `#doTick`'s release pass drops
   * any owned run whose status has left `running` regardless of whether
   * this ping ever arrived. What this removes is the LATENCY of that pass,
   * and the latency is the whole defect.
   *
   * Records the id in `#recentlyClosed` UNCONDITIONALLY, before the
   * ownership check -- see that field's own doc comment. An in-flight
   * `#doTick` holds a `runningIds` snapshot taken before this run left
   * `running`, and its claim loop would otherwise re-claim the run this
   * handler just released (or claim, for the first time, one this owner
   * never held).
   *
   * Releasing while a `#fold` for the same run is in flight is safe and
   * already accounted for: `#fold` never touches `state.client`, and a
   * `readFrom` racing the `finalize` that `close()` is running right now
   * throws (`LiveChunkGapError`, or a deleted key's `get`) into the
   * `#guarded` wrapper that already surrounds every fold. `close()`'s own
   * doc comment documents that same pairing for shutdown.
   */
  async #onClosed(runId: string): Promise<void> {
    if (this.#closing) return;
    this.#recentlyClosed.add(runId);
    if (!this.#owned.has(runId)) return;
    await this.#release(runId);
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
   * actually cancel `LiveChunkStore.readFrom`. `BlobStore` DOES bound each
   * individual request now (`socketTimeout`/`connectionTimeout`, see
   * `packages/storage/src/blobs.ts`), so an abandoned read rejects on its
   * own eventually -- but "eventually" is the whole problem, because it is
   * the IN-FLIGHT window that corrupts. If a later tick then retried the same
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
        `NOT one hung blob read: BlobStore bounds every request ` +
        `(socketTimeout/connectionTimeout, packages/storage/src/blobs.ts) ` +
        `and the pg pool bounds connect. Suspect the Redis publish path, ` +
        `which has NO command timeout, before suspecting storage -- or a ` +
        `run with enough chunks that many individually-bounded reads add ` +
        `up. No further deltas will be ` +
        'published for ANY owned run until this tick resolves. This ' +
        'warning repeats for as long as the stall lasts.',
    );
  }

  async #doTick(): Promise<void> {
    // Cleared BEFORE the query, never after -- see `#recentlyClosed`'s own
    // doc comment. Anything it held was published (and therefore committed)
    // before this line, so the poll one statement later already sees the
    // new status; anything added from here on is guarding against exactly
    // the snapshot this query is about to take.
    this.#recentlyClosed.clear();
    const { rows } = await this.#pool.query<{
      id: string;
      org_id: string;
      project_id: string;
      engine_options: unknown;
    }>(
      // org_id and project_id ride along because the claim needs them to read
      // the project's SLA rules; engine_options because the claim needs it to
      // build this run's `LiveEngine` the way `PipelineService` builds its own
      // (`RunClaimContext`'s doc comment) -- the same rows and the same index,
      // so this costs nothing over selecting `id` alone, and it saves a round
      // trip.
      "SELECT id, org_id, project_id, engine_options FROM run WHERE status = 'running'",
    );
    const runningIds = new Set(rows.map((r) => r.id));
    // Only the claim loop below reads this -- a run already owned or claimed
    // via a `live:opened` ping never needs its row from here at all (see
    // `#claim`'s own doc comment for how the ping path resolves it instead).
    const contextByRunId = new Map<string, RunClaimContext>(
      rows.map((r) => [r.id, runContextOf(r)]),
    );

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
      // A `live:closed` ping landed for this run after the poll above:
      // `runningIds` is stale for it, and claiming it now would re-take
      // the lock the pipeline is waiting on.
      if (this.#recentlyClosed.has(runId)) continue;
      // `#atCap()`, not a bare `#owned.size` comparison: a `live:opened`
      // ping's own `#claim` can be in flight right now, holding a
      // reservation this loop must respect or double-count against.
      if (this.#atCap()) {
        skippedForCap += 1;
        continue;
      }
      // Isolated per run: `#claim` reaching for a `pg.PoolClient` the pool
      // cannot hand out (a bad connection string, or -- with the pool sized
      // per design §1.3 -- genuine exhaustion under an operator's
      // misconfiguration) must fail that ONE run's claim, not this whole
      // tick and every run already owned along with it.
      await this.#guarded('claim', runId, () => this.#claim(runId, contextByRunId.get(runId)));
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
   * 2b's fan-out, and `XADD live:{runId}:deltas` for the replay buffer
   * FR-LIVE-8 wants -- capped by BOTH an entry count and a byte budget,
   * see `REPLAY_BUDGET_BYTES` for why an entry count alone bounded
   * nothing. Part 2a writes that stream even though nothing
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

    // The SAME pure evaluator PipelineService runs against a finished run,
    // through the SAME `toEvaluableStats` mapping -- a live breach that
    // disagreed with the final verdict for the same run would be the
    // record-decoder/`bucketLatency` lesson a third time.
    //
    // ONE evaluator over one mapping is NOT sufficient for that agreement,
    // and assuming it was is how this shipped broken. The evaluator reads
    // statistics, and the statistics are only the same if the two ENGINES
    // were configured the same -- `warmupMs` alone changes which events are
    // aggregated at all. That is why `#claimReserved` builds this run's
    // engine from `RunClaimContext.engineOptions` and not from the defaults,
    // and why the guard is a comparison of the two CALL SITES
    // (`apps/worker/test/sla-agreement.integration.test.ts`) rather than of
    // the mapping they share.
    // `state.rules` is this run's SLA as it read AT CLAIM (`FoldState.rules`'
    // own doc comment), never re-read here. `liveEvidenceFloor` is the one
    // thing a live evaluation needs that a batch one does not: ungated, the
    // first few seconds of every run would breach almost any rule on a
    // handful of samples.
    const { assertions } = evaluateRules(state.rules, toEvaluableStats(snapshot.stats), {
      minObservations: liveEvidenceFloor,
    });

    const breaching = assertions.filter((a) => a.outcome === 'failed');
    const seen = new Set(breaching.map((a) => a.ruleId));
    // A rule that recovered -- or that fell back BELOW the evidence floor --
    // loses its entry. Freezing the timer through a period where the rule
    // was not judged at all would report "breaching for 4 minutes" about
    // three minutes nobody looked at.
    for (const ruleId of state.breachingSince.keys()) {
      if (!seen.has(ruleId)) state.breachingSince.delete(ruleId);
    }
    for (const a of breaching) {
      if (!state.breachingSince.has(a.ruleId)) {
        state.breachingSince.set(a.ruleId, snapshot.durationMs);
      }
    }

    // Required, not optional (`delta.ts`'s own comment on `SlaInput`) -- an
    // optional fourth argument would let a future call site silently omit
    // the SLA state and publish a delta claiming nothing is breaching, which
    // reads exactly like a healthy run. Shared between the delta below and
    // the snapshot further down, since both describe THIS tick's evaluation.
    //
    // `rulesLoadFailed` rides along because it is the ONLY thing that tells a
    // reader "no rules were checked" apart from "this project has no rules":
    // both leave `assertions` empty, and both render as no banner at all.
    // Until it was on the wire it had no production reader whatsoever.
    const sla: SlaInput = {
      assertions,
      breachingSince: state.breachingSince,
      rulesUnavailable: state.rulesLoadFailed,
    };

    const { delta, next } = buildDelta(runId, snapshot, state.cursor, sla);
    const body = JSON.stringify(delta);
    try {
      await this.#redis.publish(`live:${runId}`, body);
      // EXACT `MAXLEN`, not `MAXLEN ~`. Approximate trimming only evicts
      // whole macro-nodes (`stream-node-max-entries`, 100 by default), so
      // `~ 4` can legitimately retain a hundred entries or more -- which
      // would leave `REPLAY_BUDGET_BYTES` bounding nothing precisely on the
      // large-delta runs it exists for. Exact trimming costs an eviction of
      // one or two entries per call, at one call per owned run per
      // `liveTickMs`; the approximation was never buying anything at this
      // rate.
      await this.#redis.xadd(
        `live:${runId}:deltas`,
        'MAXLEN',
        String(replayEntryCap(body)),
        '*',
        'delta',
        body,
      );
      // INSIDE THIS TRY, alongside the XADD it bounds. The defect being fixed
      // is a stream that exists without a TTL, so a failure to set one is a
      // failed publish: the compensation on that path costs a redundant
      // re-send next tick (`{ ...state.cursor, seq: next.seq }` keeps the
      // width/offset state, so the next delta re-covers this one's window),
      // never a loss. One extra round trip per owned run per tick buys the
      // property that the key is never left immortal by a producer that dies
      // between the XADD and any later hygiene step.
      await this.#redis.expire(`live:${runId}:deltas`, REPLAY_TTL_SECONDS);
      state.cursor = next;
    } catch (err) {
      state.cursor = { ...state.cursor, seq: next.seq };
      throw err;
    }

    // AFTER the cursor advances, and in its own try -- a snapshot is a
    // convenience for future subscribers, and letting its failure reach the
    // caller would run the delta path's compensating logic
    // (`{ ...state.cursor, seq: next.seq }`) for an error that has nothing to
    // do with the delta. That would drop the coalesce replacement flag for a
    // tick whose PUBLISH and XADD both succeeded.
    state.ticksSinceSnapshot += 1;
    if (state.ticksSinceSnapshot >= SNAPSHOT_EVERY_N_TICKS) {
      try {
        // `next.seq`, NOT `state.cursor.seq` -- they read as interchangeable
        // here (the try block above already assigned `state.cursor = next`
        // on every path that reaches this line) but that equality is an
        // ARTIFACT of today's statement order, not a guarantee: `state.cursor`
        // is mutable owner state a future change could legitimately reorder
        // around, while `next.seq` is this call's own `buildDelta` result --
        // `prev.seq + 1`, the seq of the delta this snapshot does NOT yet
        // contain (see delta.ts's "A SNAPSHOT IS STAMPED WITH THE SEQ IT DOES
        // NOT CONTAIN") -- and stays correct regardless of how the
        // surrounding code moves. `apps/api`'s replay filter
        // (`live.gateway.ts`'s `attemptSeed`) depends on exactly this
        // convention and encodes it as a hand-written fixture rather than an
        // import, because apps/api has no dependency on apps/worker -- so
        // nothing on that side would fail if this producer silently drifted.
        // The worker-side guard is `fold-owner.integration.test.ts`'s
        // "stamps the snapshot with the last published delta's seq plus
        // one".
        await this.#redis.set(
          `live:${runId}:snapshot`,
          JSON.stringify(buildSnapshot(runId, snapshot, next.seq, sla)),
          'EX',
          SNAPSHOT_TTL_SECONDS,
        );
        state.ticksSinceSnapshot = 0;
      } catch (err) {
        // Left un-reset, so the next tick retries rather than waiting a full
        // interval after a transient failure.
        console.error(`LiveFoldOwner: snapshot write failed for ${runId}:`, err);
      }
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

  /** The rules currently breaching for an owned run, and the elapsed offset
   * each began breaching at -- or null if this owner does not hold `runId`.
   * Test seam, on the same terms as `snapshotOf`: the next task's wire
   * format carries this same state from `#publish`'s own evaluation, not
   * from here. A copy, not the live `Map`, so a caller cannot mutate
   * `state.breachingSince` out from under the next tick. */
  breachingSinceOf(runId: string): ReadonlyMap<string, number> | null {
    const state = this.#owned.get(runId);
    return state ? new Map(state.breachingSince) : null;
  }

  /**
   * The rules THIS run was claimed with, each one COPIED -- or null if this
   * owner does not hold `runId`. Test seam: proves which project's rules a
   * concurrently-claimed run actually ended up with, rather than assuming
   * attribution held under a burst of claims.
   *
   * NOT the same terms as `snapshotOf`, despite looking like it: `snapshotOf`
   * needs `{ clone: true }` because a rollup's own sketches/histograms are
   * mutated by the NEXT fold; a plain field-spread is enough here because
   * every `EvaluableRule` field is a primitive -- the same shallow copy
   * `evaluateRules` already takes of each rule before using it
   * (`packages/sla/src/evaluate.ts`'s own `{ ...rule }`). But it is NOT
   * optional, either way: `EvaluableRule`'s fields are not `readonly`, so
   * handing back the live objects would let `owner.rulesOf(id)![0].threshold
   * = 0` type-check and silently corrupt this run's SLA for every
   * subsequent tick -- this file's whole design is that live per-run state
   * cannot be reached from outside it.
   */
  rulesOf(runId: string): EvaluableRule[] | null {
    const state = this.#owned.get(runId);
    return state ? state.rules.map((r) => ({ ...r })) : null;
  }

  /** Whether this run's SLA rules failed to load at claim -- see
   * `FoldState.rulesLoadFailed`'s own doc comment for why this is not the
   * same question as "were there any". Null if this owner does not hold
   * `runId`. Test seam, on the same terms as `snapshotOf`. */
  rulesLoadFailedFor(runId: string): boolean | null {
    const state = this.#owned.get(runId);
    return state ? state.rulesLoadFailed : null;
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
   * Whether another run can be taken on -- the ONE definition of "at the
   * cap", used by every caller so none of them can disagree.
   *
   * Counts in-flight claims (`#claiming`) alongside settled ones
   * (`#owned`), because a claim that has not inserted yet still costs a
   * pooled client the moment its `pool.connect()` resolves. Counting only
   * `#owned` is exactly the hole a burst of `live:opened` pings walked
   * through -- see `#claiming`'s own doc comment.
   *
   * A run is briefly in BOTH sets (between `#owned.set` and `#claim`'s
   * `finally`), so this can over-count by one per settling claim. That
   * direction is the safe one and there is no await between those two
   * statements for anything to observe it in.
   */
  #atCap(): boolean {
    return this.#owned.size + this.#claiming.size >= this.#config.maxOwnedRuns;
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
   *
   * `context`, when known, is the run row the widened discovery query in
   * `#doTick` already read for this run -- tenant and engine options both
   * (`RunClaimContext`) -- and passing it through here is what lets that
   * widening actually save the round trip it exists to save. `#onOpened`'s
   * `live:opened` ping has no such row to hand over (the channel carries a
   * bare runId -- `LiveNotifier.opened`), so it leaves this `undefined` and
   * `#claimReserved` looks the row up itself, once it has actually won the
   * lock.
   */
  async #claim(runId: string, context?: RunClaimContext): Promise<void> {
    // ═══ SYNCHRONOUS, BEFORE THE FIRST await ═══
    // Everything down to `#claiming.add` runs in the caller's own turn, so
    // two claims started from two `message` events cannot interleave here:
    // the first adds its reservation before the second reads the size. That
    // atomicity is the entire fix, and it only exists because these
    // statements precede `pool.connect()`. Moving any of them below an
    // await reopens the burst overshoot -- see `#claiming`'s doc comment.
    if (this.#owned.has(runId) || this.#claiming.has(runId)) return;
    if (this.#atCap()) return;
    this.#claiming.add(runId);
    try {
      await this.#claimReserved(runId, context);
    } finally {
      // After the insert, never before: a run is momentarily counted twice
      // rather than momentarily not at all.
      this.#claiming.delete(runId);
    }
  }

  /** `#claim`'s body, past the reservation gate. Split out only so that
   * gate can be `return`-based and the release can be one `finally` -- the
   * lock/insert/unwind logic below is unchanged. */
  async #claimReserved(runId: string, known?: RunClaimContext): Promise<void> {
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

    // BEFORE the `#closing` check below, never between it and the `#owned.set`
    // it guards: that pair has to stay in one synchronous turn, or a `close()`
    // starting during this read would drain `#owned` and this insert would
    // strand its client and its advisory lock behind it. Placing the await
    // here only widens a window that already exists (the connect and the lock
    // query above are both awaits), and the check still runs immediately
    // before the insert.
    const { cursor, breachingSince } = await this.#resumeState(runId);
    // Same reasoning as `#resumeState` above -- this run's row and its SLA
    // rules, read ONCE, right here, and never again for as long as this
    // owner holds the run (`FoldState.rules`' own doc comment).
    const context = await this.#claimContext(runId, client, known);
    const { rules, rulesLoadFailed } = await this.#claimRules(runId, context);

    if (this.#closing) {
      // Won the lock, but close() already started (or finished) draining
      // #owned -- inserting now would never be seen by it. Unwind exactly
      // like #release does: unlock on this same client, then return it to
      // the pool in a finally regardless of whether the unlock succeeded.
      // `release(true)` on failure, exactly as `#release` does -- see its
      // own doc comment. This branch has just WON the advisory lock, so a
      // failed unlock here strands it on a session about to go back into
      // the idle pool, with the same permanent consequences.
      try {
        await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
          RUN_INGEST_LOCK_NAMESPACE,
          runId,
        ]);
      } catch (err) {
        client.release(true);
        throw err;
      }
      client.release();
      return;
    }

    this.#owned.set(runId, {
      decoder: new StreamingLogDecoder(),
      // The run's OWN options, never the engine's defaults -- see
      // `RunClaimContext`. `?? {}` is the degraded branch only: `#claimContext`
      // returns null exactly when it could not read the row at all, which it
      // has already logged, and which also leaves this claim with no rules to
      // evaluate against those statistics anyway.
      engine: new LiveEngine(context?.engineOptions ?? {}),
      client,
      fetchedBytes: 0,
      // NOT `INITIAL_CURSOR`, and NOT an empty breach map -- see
      // `#resumeState`. A re-claim after a crash or a rolling deploy has to
      // continue this RUN's sequence and this RUN's breach history, not start
      // a second one of each inside it.
      cursor,
      rules,
      rulesLoadFailed,
      breachingSince,
      // SNAPSHOT_EVERY_N_TICKS, not 0 -- see FoldState.ticksSinceSnapshot's
      // own doc comment: the first tick after a claim must seed immediately.
      ticksSinceSnapshot: SNAPSHOT_EVERY_N_TICKS,
    });
  }

  /**
   * Resolves this run's claim context -- tenant AND engine options
   * (`RunClaimContext`) -- from the discovery query's own row when the
   * caller already has it, or by asking Postgres directly on the client
   * this claim already holds (the `live:opened` ping path, which only ever
   * carries a bare runId).
   *
   * Mirrors `#resumeState`'s own failure shape: a run this owner has
   * already won the lock for is going to be folded regardless, so a failure
   * here degrades to "no rules and the engine's defaults for this claim"
   * rather than aborting a claim that would otherwise have succeeded --
   * FAILING OPEN is right, because a stalled or unreachable pool must not
   * block a run from being folded at all.
   *
   * BUT FAILING OPEN SILENTLY IS NOT RIGHT, which is what
   * `rulesLoadFailed` is for downstream: `rules === []` alone cannot tell
   * "this project genuinely has no enabled rules" apart from "the load
   * failed", and those read identically on a breach banner ("nothing
   * breaching") for two very different reasons. Both branches below are
   * logged for the same reason -- an operator needs to be able to tell the
   * two apart from outside, not just this method's own caller.
   *
   * The null-row branch is the more anomalous of the two, not the more
   * ordinary one: `pg_try_advisory_lock`'s key is `hashtext(runId)`, an
   * arbitrary string with no foreign-key tie to the `run` table, so a claim
   * CAN win the lock for an id with no backing row (a stray or malformed
   * `live:opened` ping -- runs are never deleted, so a live one dropping
   * out from under a lookup that just ran is not the concern; a lookup for
   * an id that was never a real run in the first place is).
   */
  async #claimContext(
    runId: string,
    client: pg.PoolClient,
    known?: RunClaimContext,
  ): Promise<RunClaimContext | null> {
    if (known) return known;
    let context: RunClaimContext | null;
    try {
      context = await this.#lookupRunContext(client, runId);
    } catch (err) {
      console.error(
        `LiveFoldOwner: could not read the run row for ${runId}, claiming with no SLA rules ` +
          "and the engine's default options:",
        err,
      );
      return null;
    }
    if (!context) {
      console.error(
        `LiveFoldOwner: no run row found for ${runId} while resolving its SLA tenant ` +
          '(a lock with no backing row -- see hashtext(runId) above); claiming with no SLA rules',
      );
      return null;
    }
    return context;
  }

  /**
   * This run's enabled rules, as they read at claim. `scope` is
   * `#claimContext`'s result: a null one means the run row could not be
   * read at all, which that method has already logged -- there is nothing
   * to scope a rule query by, and the claim proceeds with none.
   */
  async #claimRules(
    runId: string,
    scope: ProjectScope | null,
  ): Promise<{ rules: EvaluableRule[]; rulesLoadFailed: boolean }> {
    if (!scope) return { rules: [], rulesLoadFailed: true };
    try {
      const records = await this.#rules.listEnabled(scope);
      const rules = records.map((r) => ({
        id: r.id,
        scope: r.scope,
        targetName: r.targetName,
        family: r.family,
        metric: r.metric,
        comparator: r.comparator,
        threshold: r.threshold,
      }));
      return { rules, rulesLoadFailed: false };
    } catch (err) {
      console.error(`LiveFoldOwner: could not load SLA rules for ${runId}, claiming with none:`, err);
      return { rules: [], rulesLoadFailed: true };
    }
  }

  /** The one query `#claimContext` needs when its caller has no row already
   * in hand -- the `live:opened` ping path (see `#claim`'s own doc comment).
   * Selects exactly the columns `#doTick`'s discovery poll selects, through
   * the same `runContextOf`, so the two paths cannot disagree about what a
   * claim reads. Runs on the client this claim already holds the advisory
   * lock on, so it costs a statement on an already-open connection, not a
   * new one. */
  async #lookupRunContext(client: pg.PoolClient, runId: string): Promise<RunClaimContext | null> {
    const { rows } = await client.query<{ org_id: string; project_id: string; engine_options: unknown }>(
      'SELECT org_id, project_id, engine_options FROM run WHERE id = $1',
      [runId],
    );
    const row = rows[0];
    return row ? runContextOf(row) : null;
  }

  /**
   * What a freshly-claimed run resumes from -- `blankResume()` for a run
   * nobody has published for, and the replay stream's TIP for a run this or
   * another worker was already streaming. ONE read serves both fields,
   * because both are properties of the same last-published delta.
   *
   * ═══ WHY THE TIP, AND NOT `DEL live:{runId}:deltas` ═══
   *
   * `seq` was per-OWNER, not per-RUN: this method used to hand every claim
   * `INITIAL_CURSOR`, so a worker restart mid-run published `seq 0, 1, 2...`
   * into a stream still holding `seq 0...199`. Both of the gateway's filters
   * (`attemptSeed`'s `entry.seq >= snapshot.seq`, and `serve`'s flush filter)
   * assume per-run monotonicity, so a fresh connect replayed up to 200 STALE
   * deltas on top of a correct seed -- old ones first, so a stale partial
   * bucket overwrote the snapshot's complete one -- while a resuming client
   * filtered out the new incarnation's `seq 0`, the one delta carrying
   * `replaces: true`.
   *
   * Deleting the stream on claim fixes the collision and breaks something
   * else: a client resuming with `?lastSeq=200` finds a stream that no longer
   * reaches its cursor in the only way the gateway reads as FINE (`oldest ===
   * undefined` -> "nothing newer to replay"), so it is neither re-seeded nor
   * caught up, and the new incarnation's deltas -- numbered from 0 -- are
   * filtered out as already-held for the rest of the run. It also throws away
   * the replay window at the exact moment it is most needed, which is a
   * worker restart.
   *
   * Continuing the sequence keeps every existing filter correct with no
   * further change. The old entries stay valid history at seqs BELOW the new
   * snapshot's, so `attemptSeed` excludes them; a resuming client's cursor
   * still means what it meant; and the new owner's first delta -- which is
   * `replaces: true` carrying the whole series, because only `seq` is taken
   * from the tip while `lastPublishedOffsetMs`/`lastBucketWidthMs` keep their
   * `INITIAL_CURSOR` sentinels -- lands at exactly the seq the stale snapshot
   * key already points at (`prev.seq + 1`).
   *
   * ═══ AND WHY THE TIP CARRIES THE BREACH HISTORY TOO ═══
   *
   * `breachingSince` is the other thing a new owner cannot re-derive from the
   * bytes. A re-fold from byte 0 reaches the same STATISTICS, so a rule that
   * was breaching still breaches -- but `#publish` stamps a rule it has not
   * seen before at the CURRENT `snapshot.durationMs`, which on the first tick
   * after a re-claim is the full elapsed offset. See
   * `FoldState.breachingSince` for the number that produces and why it fails
   * in the dangerous direction.
   *
   * The tip already carries the answer: `sla.breaching[].sinceOffsetMs` is
   * exactly that map, in the same run-relative frame the new fold will
   * measure in (both are offsets from the run's own start). So it is read
   * back out of the body this method is already fetching -- no second read,
   * no new key, and nothing to keep in sync.
   *
   * `LiveSlaSchema` is what validates it, rather than a hand-written shape
   * check: this is the same wire contract the browser holds the producer to,
   * and a tip that does not satisfy it (an older worker's body with no `sla`
   * at all, a half-written entry) yields an empty map -- today's behaviour,
   * which is a re-stamp rather than a wrong number.
   *
   * A failure to READ the tip degrades to `blankResume()` rather than
   * propagating: this is inside `#claimReserved`, which holds a pooled client
   * and an advisory lock, and a Redis outage that makes this read fail is one
   * that will fail the publish two lines later anyway. It is logged, because
   * silently restarting a run's sequence is the defect this method exists to
   * close.
   */
  async #resumeState(runId: string): Promise<ResumeState> {
    try {
      // The tip only: `XREVRANGE ... COUNT 1`. Stream ids are Redis
      // timestamps and carry no relation to a delta's own `seq`
      // (`live.gateway.ts`'s `readStream` makes the same point), so the seq
      // has to be read out of the body -- but the LAST entry is the highest
      // seq by construction, since `#publish` only ever appends.
      const rows = await this.#redis.xrevrange(`live:${runId}:deltas`, '+', '-', 'COUNT', 1);
      const body = rows[0]?.[1]?.[1];
      if (typeof body !== 'string') return blankResume();
      const tip = JSON.parse(body) as { seq?: unknown; sla?: unknown };
      // A corrupt or half-written entry reads as "no stream" rather than as a
      // delta with a missing seq, the same judgement `seqOf` makes on the
      // gateway side.
      if (typeof tip.seq !== 'number' || !Number.isInteger(tip.seq) || tip.seq < 0) {
        return blankResume();
      }
      const breachingSince = new Map<string, number>();
      const sla = LiveSlaSchema.safeParse(tip.sla);
      if (sla.success) {
        for (const b of sla.data.breaching) breachingSince.set(b.ruleId, b.sinceOffsetMs);
      }
      return { cursor: { ...INITIAL_CURSOR, seq: tip.seq + 1 }, breachingSince };
    } catch (err) {
      console.error(`LiveFoldOwner: could not read the replay tip for ${runId}, restarting seq at 0:`, err);
      return blankResume();
    }
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

  /**
   * Drops the fold state, unlocks on the client that took the lock, and
   * returns that client to the pool.
   *
   * A FAILED UNLOCK DESTROYS THE CONNECTION -- `release(true)` -- rather
   * than returning it to the idle pool. This is one argument, not a
   * defensive flourish:
   *
   * Advisory locks are SESSION-scoped and RE-ENTRANT. If the unlock query
   * fails while the backend is still alive (a statement timeout, a
   * cancelled query, a transient error on a healthy connection), the lock
   * is still held BY THAT SESSION -- and a bare `client.release()` puts
   * that session straight back into the pool as an ordinary idle client.
   * Every consequence of that is silent:
   *
   *  - a later `#claim` that happens to draw the same client runs
   *    `pg_try_advisory_lock` on the session that already holds the lock,
   *    and re-entrancy makes it SUCCEED. The owner concludes it won a lock
   *    it never contested, while the hold count goes to 2 and every
   *    subsequent unlock only ever brings it back to 1.
   *  - no OTHER worker, and no `PipelineService.process`, can ever take
   *    that lock again for the life of the connection. The run's terminal
   *    parse is locked out permanently -- `#handleLockLost` throws
   *    `RunLockedError`, BullMQ exhausts its three attempts, and the run
   *    sits at `parsing` until the sweeper's 15-minute staleness window,
   *    then repeats.
   *
   * Destroying the connection ends the session, and a session's advisory
   * locks die with it -- which is the only way to be sure the lock is gone
   * when the statement meant to drop it did not run. The cost is one
   * reconnect on a path that has already failed.
   *
   * The error still propagates: `close()`'s `Promise.allSettled` collects
   * it into the `AggregateError` it exists to raise, and `#doTick`'s
   * release loop hands it to `#guarded` to log.
   */
  async #release(runId: string): Promise<void> {
    const state = this.#owned.get(runId);
    if (!state) return;
    this.#owned.delete(runId);
    try {
      await state.client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
        RUN_INGEST_LOCK_NAMESPACE,
        runId,
      ]);
    } catch (err) {
      state.client.release(true);
      throw err;
    }
    state.client.release();
  }
}
