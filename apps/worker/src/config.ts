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
    maxDecompressedBundleBytes: Number(
      env.MAX_DECOMPRESSED_BUNDLE_BYTES ?? 2 * 1024 * 1024 * 1024,
    ),
  };
}
