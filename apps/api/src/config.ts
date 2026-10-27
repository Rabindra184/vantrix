import { parseRawLogRetentionDays } from '@perfportal/core';

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
  runner: {
    artifactDir: string;
    maxArtifactBytes: number;
  };
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
  /**
   * The most `PUT /v1/runs/{id}/agent` stores of a live run's agent file, from
   * `MAX_AGENT_LOG_BYTES` — the runner's own cap for the file it stores
   * itself (`RUNNER_MAX_AGENT_LOG_BYTES`), by the runner's own rule: 256 MiB by
   * default, and a value that is blank, not a positive integer, or not larger
   * than the 1024 bytes of headroom the agent is given under it falls back to
   * the default. The body is streamed to a temporary file, never held, so this
   * bounds disk and object-store bytes rather than heap.
   */
  maxAgentLogBytes: number;
  betterAuthUrl: string;
  /** See `cookiesAreSecure` — off unless `ALLOW_INSECURE_COOKIES=true`. */
  allowInsecureCookies: boolean;
  /**
   * `RAW_LOG_RETENTION_DAYS`, which the WORKER acts on (its sweeper deletes
   * raw logs past it). The API only states it — Administration › Data
   * integrity shows it read-only — so it reads it by the worker's own rule,
   * `parseRawLogRetentionDays`, and refuses to start on a value the worker
   * would refuse too. 0 keeps raw logs for ever.
   */
  rawLogRetentionDays: number;
}

/**
 * The shortest secret this refuses in production. `openssl rand -base64 32`
 * emits 44 characters, so the documented recipe clears it comfortably; the
 * number itself is Better Auth's own advice, which it only WARNS about.
 */
export const MIN_AUTH_SECRET_LENGTH = 32;

/**
 * ═══ THE ONE VARIABLE WHOSE ABSENCE IS SILENT UNTIL SOMEBODY LOGS IN ═══
 *
 * Better Auth falls back to a hard-coded default secret when
 * `BETTER_AUTH_SECRET` is unset, and throws on that default only when
 * `NODE_ENV=production` — which `infra/Dockerfile` sets. But it throws from
 * inside `createAuthContext`, which is ASYNC and not awaited until the first
 * `/auth` request. So a container with no secret builds, starts, passes its
 * health check, serves the SPA, and then fails every sign-in for the life of
 * the deployment. The compose profile shipped exactly that way.
 *
 * Checking it here moves that failure to process start, where an orchestrator
 * can see it and an operator gets a message naming the variable and the
 * command that generates one.
 *
 * Production-only, deliberately: a development machine and the integration
 * harness (vitest sets NODE_ENV=test) must keep working with no new required
 * variable, which is the same reason `betterAuthUrl` below has a default
 * rather than being `required()`.
 *
 * LENGTH IS CHECKED TOO, and that is stricter than Better Auth, which only
 * logs a warning below 32 characters. This value signs every session cookie
 * in the deployment; a warning in a container log is not where that belongs.
 */
function requireAuthSecretInProduction(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;
  const secret = env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'BETTER_AUTH_SECRET is required when NODE_ENV=production: it signs every session cookie, ' +
        'and without it Better Auth refuses to authenticate anyone. ' +
        'Generate one with `openssl rand -base64 32` and set it (PERFPORTAL_AUTH_SECRET in infra/docker-compose.yml).',
    );
  }
  if (secret.length < MIN_AUTH_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET must be at least ${MIN_AUTH_SECRET_LENGTH} characters; this one is ${secret.length}. ` +
        'Generate one with `openssl rand -base64 32`.',
    );
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required environment variable ${key}`);
  return v;
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const parsed = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

const DEFAULT_MAX_AGENT_LOG_BYTES = 268_435_456;

/** The agent writes one closing `capped` line past its own `max`, which the plugin sets this far under the cap. */
const AGENT_CAP_HEADROOM_BYTES = 1024;

/**
 * Blank is unset — compose passes an unset variable as "", and `Number('')` is
 * 0, a cap that would refuse every agent file — and so is anything that is not
 * a whole number larger than the headroom.
 */
function agentLogCap(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_MAX_AGENT_LOG_BYTES;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > AGENT_CAP_HEADROOM_BYTES ? parsed : DEFAULT_MAX_AGENT_LOG_BYTES;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  requireAuthSecretInProduction(env);
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
    runner: {
      artifactDir: env.RUNNER_ARTIFACT_DIR ?? '.perfportal/runner-artifacts',
      maxArtifactBytes: positiveInteger(env, 'MAX_RUNNER_ARTIFACT_BYTES', 512 * 1024 * 1024),
    },
    maxStreamChunkBytes: Number(env.MAX_STREAM_CHUNK_BYTES ?? 8 * 1024 * 1024),
    maxAgentLogBytes: agentLogCap(env.MAX_AGENT_LOG_BYTES),
    // Optional with a default, never required(): a new mandatory environment
    // variable would break M0's "a stranger deploys a running instance and
    // authenticates". Better Auth derives trustedOrigins (its CSRF origin
    // check) from this — see better-auth.instance.ts. Set it to the public
    // origin in any real deployment.
    betterAuthUrl: env.BETTER_AUTH_URL ?? `http://localhost:${Number(env.PORT ?? 3000)}`,
    /* Lets a plain-HTTP deployment reached by hostname or IP hold a session.
     * Off unless explicitly enabled, and it cannot downgrade an HTTPS
     * deployment — `cookiesAreSecure` returns on the scheme before it is
     * consulted. What it costs is described there and in DEPLOYMENT.md.
     *
     * `=== 'true'`, not truthiness: `ALLOW_INSECURE_COOKIES=false` must not
     * switch the thing ON, and every non-empty string is truthy. That is the
     * shape of a setting nobody notices is inverted until sessions are
     * already crossing the network in the clear. */
    allowInsecureCookies: env.ALLOW_INSECURE_COOKIES === 'true',
    rawLogRetentionDays: parseRawLogRetentionDays(env.RAW_LOG_RETENTION_DAYS),
  };
}
