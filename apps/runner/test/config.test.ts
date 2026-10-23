import { describe, expect, it } from 'vitest';
import { loadRunnerConfig } from '../src/config.js';

/**
 * The two knobs the Gatling agent adds to the runner's configuration.
 *
 * The jar path is `RUNNER_AGENT_JAR`, which `infra/Dockerfile` sets to the jar
 * it ships; empty means the runner has no agent and runs every job without it,
 * exactly as it did before the agent existed. The cap is what the agent is told
 * it may write, and what the runner refuses to store above.
 */
const BASE = {
  DATABASE_URL: 'postgresql://x',
  RUNNER_ORG_ID: '22222222-2222-4222-8222-222222222222',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
} as const;

describe('loadRunnerConfig, the Gatling agent', () => {
  it('has no agent jar unless one is configured, and a 256 MiB cap by default', () => {
    const config = loadRunnerConfig({ ...BASE });
    expect(config.agentJar).toBeNull();
    expect(config.maxAgentLogBytes).toBe(268_435_456);
  });

  it('reads the agent jar path and treats an empty value as none', () => {
    expect(loadRunnerConfig({ ...BASE, RUNNER_AGENT_JAR: '/opt/perfportal/gatling-agent.jar' }).agentJar)
      .toBe('/opt/perfportal/gatling-agent.jar');
    // Compose passes an unset variable as an empty string, and `Number('')`
    // style surprises are this repo's recorded trap: blank is unset.
    expect(loadRunnerConfig({ ...BASE, RUNNER_AGENT_JAR: '' }).agentJar).toBeNull();
    expect(loadRunnerConfig({ ...BASE, RUNNER_AGENT_JAR: '   ' }).agentJar).toBeNull();
  });

  it('reads the agent file cap, falling back to the default when it is blank or not a number', () => {
    expect(loadRunnerConfig({ ...BASE, RUNNER_MAX_AGENT_LOG_BYTES: '67108864' }).maxAgentLogBytes).toBe(67_108_864);
    expect(loadRunnerConfig({ ...BASE, RUNNER_MAX_AGENT_LOG_BYTES: '' }).maxAgentLogBytes).toBe(268_435_456);
    expect(loadRunnerConfig({ ...BASE, RUNNER_MAX_AGENT_LOG_BYTES: 'lots' }).maxAgentLogBytes).toBe(268_435_456);
  });
});
