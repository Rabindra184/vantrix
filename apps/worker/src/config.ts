export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  blob: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  /**
   * BullMQ's job concurrency for the ingest queue (`consumer.ts`).
   *
   * Also a POOL-SIZING INPUT since fix round 1: `main.ts` sizes the shared
   * `pg.Pool` as `maxOwnedRuns` plus `concurrency * PIPELINE_CLIENTS_PER_JOB`
   * (`PipelineService.process` can hold two clients per in-flight job) plus
   * fixed headroom for the fold owner's own discovery client and the
   * sweeper. A non-numeric override reaching `Number(...)` un-guarded would
   * make that `max` computation `NaN`, and pg-pool's own fallback chain
   * (`this.options.max || this.options.poolSize || 10`) SILENTLY substitutes
   * 10 for a `NaN`/falsy `max` — reintroducing Critical 1's exact shape (a
   * pool of 10 against `maxOwnedRuns`'s default of 25) through this field
   * instead of `maxOwnedRuns` or `liveTickMs`. Guarded by `numberOr` for
   * exactly that reason, same as those two.
   */
  concurrency: number;
  sweepIntervalMs: number;
  staleAfterMs: number;
  /**
   * A separate, longer window than staleAfterMs: markParsing moves a run to
   * 'parsing' before any real work, so a worker that dies there (OOM,
   * SIGKILL, node eviction) leaves the run stuck at 'parsing' forever once
   * BullMQ's attempts are exhausted — staleAfterMs alone never catches this,
   * because it only ages 'pending' rows. Longer than staleAfterMs because a
   * run that has genuinely started parsing (as opposed to merely queued) is
   * allowed to take a while for a large bundle; this must not fire while
   * legitimate work is still in flight.
   */
  parsingStaleAfterMs: number;
  /**
   * How long a live run may go without accepting a chunk before the sweeper
   * finalizes it as `incomplete` (design §5, FR-LIVE-5, AC-LIVE-3).
   *
   * `running` is the one state with no other exit. `POST /v1/runs/:id/close`
   * is the happy path, and an agent that is SIGKILLed, evicted, or simply
   * loses the network never sends it — the run then answers 202 +
   * Retry-After forever, and without this branch the only exit is an
   * operator UPDATE. It frees the RUN, not the storage: the sweep writes the
   * row and leaves the `live/{runId}/*` chunk objects for a bucket lifecycle
   * rule (see `Sweeper`'s own docstring).
   *
   * Measured from `stream_updated_at`, NOT `created_at`: a live run's open
   * time says nothing about whether its producer is still alive, and the
   * soak tests this feature exists for stream for hours. See that column's
   * docstring in schema.prisma.
   *
   * 10 minutes. This is a threshold on SILENCE, not on run length, so it has
   * to clear the longest gap a HEALTHY agent can leave between two accepted
   * chunks — a scenario ramping slowly, a think-time-heavy step, or an agent
   * backing off through a network wobble — while still finalizing an
   * abandoned run inside a working day. Shorter than parsingStaleAfterMs
   * would be wrong in the other direction: this decision is TERMINAL
   * (markIncomplete, not a re-enqueue), so firing it early destroys a run
   * that was going to finish, whereas an early `parsing` sweep merely
   * duplicates work.
   */
  runningStaleAfterMs: number;
  /**
   * Default decompressed-bytes budget for openTarGzBundle, used when a
   * project has not set its own `maxDecompressedBundleBytes`. See
   * packages/storage/src/bundle.ts: the compressed upload cap does not bound
   * decompressed size, so this is enforced independently.
   */
  maxDecompressedBundleBytes: number;
  /**
   * How often `LiveFoldOwner` ticks: claims newly-running runs, folds every
   * owned one, releases any that left `running` (design §3.1, FR-LIVE-3).
   *
   * Floored at 1000 ms with `Math.max`, not rejected outright — FR-LIVE-3
   * states 1000 ms as the floor, and silently clamping a misconfiguration
   * (rather than refusing to boot over it) is friendlier for an operator.
   */
  liveTickMs: number;
  /**
   * Caps how many runs one `LiveFoldOwner` holds at once (design §1.3).
   *
   * Real, not a preference: each owned run holds a dedicated `pg.PoolClient`
   * for its advisory lock's whole lifetime (see `LiveFoldOwner`), so this
   * bounds pooled-connection usage directly. NFR-SC-4 targets 50 concurrent
   * live runs across the deployment; two workers at the default of 25 meet
   * that.
   *
   * THE POOL MUST BE SIZED FROM THIS VALUE, NOT THE OTHER WAY AROUND — design
   * §1.3, amended after an earlier draft asserted the opposite ("one worker
   * cannot exhaust its pool trying to own everything") without ever checking
   * it against the pool's actual size, which defaults to 10
   * (`packages/persistence/src/client.ts`) against this field's default of
   * 25. `main.ts` sizes the shared `pg.Pool` as `maxOwnedRuns` plus headroom
   * for the pipeline's own concurrency and the sweeper — see its own
   * `POOL_HEADROOM`-adjacent comment. Raising this default without also
   * reviewing that sizing reintroduces the exact silent deadlock the
   * amendment exists to prevent: no error, no timeout, no log, just a
   * worker that stops.
   */
  maxOwnedRuns: number;
}

/**
 * `Number(x)` on a non-numeric string is `NaN`, and `NaN` defeats both of
 * this config's own guards silently: `Math.max(1000, NaN)` is `NaN` (so
 * `setInterval(fn, NaN)` becomes an effectively-zero-delay timer, the
 * opposite of the floor it is supposed to enforce), and `someCount >= NaN`
 * is always `false` (so a cap compared against it is never reached — see
 * `LiveFoldOwner#doTick`'s `this.#owned.size >= this.#config.maxOwnedRuns`).
 * Falling back to `fallback` on a non-finite parse (covers `NaN` and
 * `Infinity` alike) keeps a misconfigured value from silently disabling the
 * exact protection it was meant to configure.
 */
function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing required environment variable DATABASE_URL');
  return {
    databaseUrl,
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6380',
    blob: {
      endpoint: env.S3_ENDPOINT ?? 'http://localhost:9000',
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? 'perfportal',
      accessKeyId: env.S3_ACCESS_KEY ?? 'perfportal',
      secretAccessKey: env.S3_SECRET_KEY ?? 'perfportal123',
    },
    // numberOr, not a bare Number(...) -- see the field's own doc comment:
    // this is now a pool-sizing input, and an invalid override must not
    // reach main.ts's `max` computation as NaN.
    concurrency: numberOr(env.WORKER_CONCURRENCY, 2),
    sweepIntervalMs: Number(env.SWEEP_INTERVAL_MS ?? 30_000),
    staleAfterMs: Number(env.STALE_AFTER_MS ?? 60_000),
    parsingStaleAfterMs: Number(env.PARSING_STALE_AFTER_MS ?? 15 * 60_000),
    runningStaleAfterMs: Number(env.RUNNING_STALE_AFTER_MS ?? 10 * 60_000),
    maxDecompressedBundleBytes: Number(
      env.MAX_DECOMPRESSED_BUNDLE_BYTES ?? 2 * 1024 * 1024 * 1024,
    ),
    // Math.max, not a validation error -- see the field's own doc comment.
    // numberOr, not a bare Number(...) -- see ITS doc comment: an invalid
    // LIVE_TICK_MS must not turn the floor below into NaN.
    liveTickMs: Math.max(1000, numberOr(env.LIVE_TICK_MS, 5000)),
    maxOwnedRuns: numberOr(env.MAX_OWNED_RUNS, 25),
  };
}
