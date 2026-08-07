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
  };
}
