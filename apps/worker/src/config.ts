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
   * Retry-After forever and its `live/{runId}/*` objects are never
   * reclaimed. Without this branch the only exit is an operator UPDATE.
   *
   * Measured from `stream_updated_at`, NOT `created_at`: a live run's open
   * time says nothing about whether its producer is still alive, and the
   * soak tests this feature exists for stream for hours. See that column's
   * docstring in schema.prisma.
   *
   * 10 minutes. This is a threshold on SILENCE, not on run length, so it has
   * to clear the longest gap a HEALTHY agent can leave between two accepted
   * chunks — a scenario ramping slowly, a think-time-heavy step, or an agent
   * backing off through a network wobble — while still reclaiming an
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
    concurrency: Number(env.WORKER_CONCURRENCY ?? 2),
    sweepIntervalMs: Number(env.SWEEP_INTERVAL_MS ?? 30_000),
    staleAfterMs: Number(env.STALE_AFTER_MS ?? 60_000),
    parsingStaleAfterMs: Number(env.PARSING_STALE_AFTER_MS ?? 15 * 60_000),
    runningStaleAfterMs: Number(env.RUNNING_STALE_AFTER_MS ?? 10 * 60_000),
    maxDecompressedBundleBytes: Number(
      env.MAX_DECOMPRESSED_BUNDLE_BYTES ?? 2 * 1024 * 1024 * 1024,
    ),
  };
}
