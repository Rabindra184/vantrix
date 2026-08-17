export interface AppConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  blob: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  defaultWaitMs: number;
  maxBundleBytes: number;
  /**
   * The cap on a SINGLE `POST /v1/runs/:id/stream` body, distinct from
   * maxBundleBytes above and much smaller.
   *
   * These bound different things. maxBundleBytes bounds a whole run — one
   * upload, or a live run's cumulative accepted bytes, which
   * LiveService.stream checks against the run's own cursor. A chunk is by
   * construction a fraction of one, and the API buffers it in memory before
   * anything about it can be judged (including whether it will be refused as
   * a gap), so sharing maxBundleBytes' 512 MB let one in-flight request pin
   * 512 MB of heap and N requests pin N × that. The upload path deliberately
   * streams a multi-hundred-megabyte body to blob storage rather than
   * holding it (see readMultipart), and this is the same rule.
   *
   * 8 MiB by default: two orders of magnitude above the 64 KiB the protocol
   * is chunked at, so no plausible agent — including one that batches hard
   * after a reconnect — ever meets it, while a burst of concurrent streams
   * stays bounded at a few MB apiece rather than half a gigabyte.
   */
  maxStreamChunkBytes: number;
  betterAuthUrl: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required environment variable ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: required(env, 'DATABASE_URL'),
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6380',
    blob: {
      endpoint: env.S3_ENDPOINT ?? 'http://localhost:9000',
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? 'perfportal',
      accessKeyId: env.S3_ACCESS_KEY ?? 'perfportal',
      secretAccessKey: env.S3_SECRET_KEY ?? 'perfportal123',
    },
    defaultWaitMs: Number(env.INGEST_WAIT_MS ?? 25_000),
    maxBundleBytes: Number(env.MAX_BUNDLE_BYTES ?? 512 * 1024 * 1024),
    maxStreamChunkBytes: Number(env.MAX_STREAM_CHUNK_BYTES ?? 8 * 1024 * 1024),
    // Optional with a default, never required(): a new mandatory environment
    // variable would break M0's "a stranger deploys a running instance and
    // authenticates". Better Auth derives trustedOrigins (its CSRF origin
    // check) from this — see better-auth.instance.ts. Set it to the public
    // origin in any real deployment.
    betterAuthUrl: env.BETTER_AUTH_URL ?? `http://localhost:${Number(env.PORT ?? 3000)}`,
  };
}
