export interface RunnerConfig {
  databaseUrl: string;
  redisUrl: string;
  artifactDir: string;
  workDir: string;
  logDir: string;
  pollIntervalMs: number;
  logPollIntervalMs: number;
  maxLogBytes: number;
  staleJobMs: number;
  artifactRetentionDays: number;
  retentionSweepIntervalMs: number;
  javaBin: string;
  /**
   * A Gatling distribution this runner can LEND to a jar that carries none —
   * the directory holding `lib/*.jar`, or a `lib` directory itself.
   *
   * `gatlingEnterprisePackage` builds a thin jar on purpose: Gatling
   * Enterprise supplies the framework at execution time, so the package never
   * carries it. This is that supply. Null means the runner has none, and a
   * thin jar is refused with an actionable error rather than launched into a
   * `ClassNotFoundException`.
   *
   * `infra/Dockerfile` installs one and points `RUNNER_GATLING_HOME` at it, so
   * a containerized runner needs no configuration at all; a host install sets
   * the variable itself.
   */
  gatlingHome: string | null;
  scope: {
    orgId: string;
    projectId: string | null;
  };
  childUid: number | null;
  childGid: number | null;
  allowSameUidExecution: boolean;
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

function optionalNonEmpty(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function optionalNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer but received ${value}`);
  }
  return parsed;
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
    staleJobMs: Math.max(60_000, numberOr(env.RUNNER_STALE_JOB_MS, 30 * 60_000)),
    artifactRetentionDays: Math.max(0, numberOr(env.RUNNER_ARTIFACT_RETENTION_DAYS, 30)),
    retentionSweepIntervalMs: Math.max(60_000, numberOr(env.RUNNER_RETENTION_SWEEP_INTERVAL_MS, 5 * 60_000)),
    javaBin: env.JAVA_BIN ?? 'java',
    gatlingHome: optionalNonEmpty(env, 'RUNNER_GATLING_HOME'),
    scope: {
      orgId: required(env, 'RUNNER_ORG_ID'),
      projectId: optionalNonEmpty(env, 'RUNNER_PROJECT_ID'),
    },
    childUid: optionalNumber(env.RUNNER_CHILD_UID),
    childGid: optionalNumber(env.RUNNER_CHILD_GID),
    // Fail-closed by default: the runner refuses to execute an uploaded
    // simulation as its own uid (which would give attacker code the
    // control-plane process's credentials and network reach). A trusted
    // single-tenant host may opt out with RUNNER_ALLOW_SAME_UID=true.
    allowSameUidExecution: env.RUNNER_ALLOW_SAME_UID === 'true',
    blob: {
      endpoint: env.S3_ENDPOINT ?? 'http://localhost:9000',
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? 'perfportal',
      accessKeyId: required(env, 'S3_ACCESS_KEY'),
      secretAccessKey: required(env, 'S3_SECRET_KEY'),
    },
  };
}
