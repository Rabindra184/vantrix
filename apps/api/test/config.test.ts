import { describe, expect, it } from 'vitest';
import { loadConfig, MIN_AUTH_SECRET_LENGTH } from '../src/config.js';

/**
 * The production auth-secret gate. Its whole reason for existing is that the
 * failure it replaces is INVISIBLE at startup: Better Auth throws on its
 * built-in default secret from an async context that nothing awaits until the
 * first `/auth` request, so a secretless production container starts clean,
 * answers its health check, serves the SPA, and then refuses every sign-in.
 *
 * The env objects below are hand-built rather than mutations of
 * `process.env`: integration files share one worker process
 * (`fileParallelism: false`), so a leaked `NODE_ENV=production` would become
 * somebody else's mystery failure — the same hazard the `TZ` case in
 * `trends.integration.test.ts` documents.
 */
const base = { DATABASE_URL: 'postgresql://u:p@localhost:5433/db' };
const goodSecret = 'x'.repeat(MIN_AUTH_SECRET_LENGTH);

describe('loadConfig', () => {
  it('does not require an auth secret outside production', () => {
    expect(() => loadConfig({ ...base })).not.toThrow();
    expect(() => loadConfig({ ...base, NODE_ENV: 'development' })).not.toThrow();
    // vitest's own default, and the one the integration harness runs under.
    expect(() => loadConfig({ ...base, NODE_ENV: 'test' })).not.toThrow();
  });

  it('refuses to start in production with no auth secret, naming the variable', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      /BETTER_AUTH_SECRET is required/,
    );
  });

  it('names the command that generates one, because "set a secret" is not actionable', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/openssl rand -base64 32/);
  });

  it('refuses a secret too short to be worth signing a cookie with', () => {
    const short = 'x'.repeat(MIN_AUTH_SECRET_LENGTH - 1);
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', BETTER_AUTH_SECRET: short }),
    ).toThrow(/at least 32 characters; this one is 31/);
  });

  it('accepts a secret at the floor, and Better Auth\'s own AUTH_SECRET alias', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', BETTER_AUTH_SECRET: goodSecret }),
    ).not.toThrow();
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', AUTH_SECRET: goodSecret }),
    ).not.toThrow();
  });

  it('still defaults the public origin to the port it is listening on', () => {
    expect(loadConfig({ ...base }).betterAuthUrl).toBe('http://localhost:3000');
    expect(loadConfig({ ...base, PORT: '8080' }).betterAuthUrl).toBe('http://localhost:8080');
    expect(loadConfig({ ...base, BETTER_AUTH_URL: 'https://perf.example.com' }).betterAuthUrl).toBe(
      'https://perf.example.com',
    );
  });
});

/**
 * The API reads RAW_LOG_RETENTION_DAYS only to STATE it (Administration ›
 * Data integrity), but it must state the setting the worker acts on — so it
 * is parsed by the worker's own rule, shared through `@perfportal/core`, and
 * these cases mirror `apps/worker/test/config.test.ts`'s.
 */
describe('loadConfig rawLogRetentionDays', () => {
  it('defaults to 90 days when unset or blank (compose passes unset as empty)', () => {
    expect(loadConfig({ ...base }).rawLogRetentionDays).toBe(90);
    expect(loadConfig({ ...base, RAW_LOG_RETENTION_DAYS: '' }).rawLogRetentionDays).toBe(90);
    expect(loadConfig({ ...base, RAW_LOG_RETENTION_DAYS: '  ' }).rawLogRetentionDays).toBe(90);
  });

  it('reads 0 as "for ever" and passes a positive count through', () => {
    expect(loadConfig({ ...base, RAW_LOG_RETENTION_DAYS: '0' }).rawLogRetentionDays).toBe(0);
    expect(loadConfig({ ...base, RAW_LOG_RETENTION_DAYS: '30' }).rawLogRetentionDays).toBe(30);
  });

  it.each(['-1', '7.5', 'forever', '1e3x'])('refuses RAW_LOG_RETENTION_DAYS=%s at startup, naming the variable', (v) => {
    expect(() => loadConfig({ ...base, RAW_LOG_RETENTION_DAYS: v })).toThrow(/RAW_LOG_RETENTION_DAYS/);
  });
});

/**
 * `MAX_AGENT_LOG_BYTES`, the cap on `PUT /v1/runs/{id}/agent`: the runner's
 * own rule for its `RUNNER_MAX_AGENT_LOG_BYTES`, so a Gradle-plugin run's file
 * and a runner run's are held to the same 256 MiB by default. Blank is unset
 * (compose passes an unset variable as ""), and a cap not larger than the
 * plugin's 1024-byte headroom would tell the agent a max of nothing.
 */
describe('loadConfig maxAgentLogBytes', () => {
  it.each(['', 'abc', '1024'])('reads MAX_AGENT_LOG_BYTES=%j as the 256 MiB default', (v) => {
    expect(loadConfig({ ...base, MAX_AGENT_LOG_BYTES: v }).maxAgentLogBytes).toBe(268435456);
  });

  it('honours a cap above the headroom, and defaults when unset', () => {
    expect(loadConfig({ ...base, MAX_AGENT_LOG_BYTES: '1025' }).maxAgentLogBytes).toBe(1025);
    expect(loadConfig({ ...base }).maxAgentLogBytes).toBe(268435456);
  });
});
