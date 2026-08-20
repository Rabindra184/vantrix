export interface RunnerConfig {
  databaseUrl: string;
  redisUrl: string;
  artifactDir: string;
  workDir: string;
  logDir: string;
  pollIntervalMs: number;
  logPollIntervalMs: number;
  maxLogBytes: number;
  javaBin: string;
  blob: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required environment variable ${key}`);
  return value;
}

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6380',
    artifactDir: env.RUNNER_ARTIFACT_DIR ?? '.perfportal/runner-artifacts',
    workDir: env.RUNNER_WORK_DIR ?? '.perfportal/runner-work',
    logDir: env.RUNNER_LOG_DIR ?? '.perfportal/runner-logs',
    pollIntervalMs: Math.max(1000, numberOr(env.RUNNER_POLL_INTERVAL_MS, 3000)),
    logPollIntervalMs: Math.max(250, numberOr(env.RUNNER_LOG_POLL_INTERVAL_MS, 1000)),
    maxLogBytes: Math.max(1024 * 1024, numberOr(env.MAX_BUNDLE_BYTES, 512 * 1024 * 1024)),
    javaBin: env.JAVA_BIN ?? 'java',
    blob: {
      endpoint: env.S3_ENDPOINT ?? 'http://localhost:9000',
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? 'perfportal',
      accessKeyId: required(env, 'S3_ACCESS_KEY'),
      secretAccessKey: required(env, 'S3_SECRET_KEY'),
    },
  };
}
