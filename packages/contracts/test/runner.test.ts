import { describe, expect, it } from 'vitest';
import {
  RunnerJobSchema,
  RunnerStartByPackageRequestSchema,
  RunnerStartMetadataSchema,
} from '../src/runner.js';

const base = {
  name: 'checkout load',
  artifactKind: 'gatling_jar',
  simulationClass: 'com.example.CheckoutSimulation',
};

describe('RunnerStartMetadataSchema', () => {
  it('accepts JVM system property keys that are safe as -D arguments', () => {
    const parsed = RunnerStartMetadataSchema.parse({
      ...base,
      systemProperties: {
        'env.name': 'staging',
        'feature_flag-1': 'true',
      },
    });

    expect(parsed.systemProperties['env.name']).toBe('staging');
  });

  it('rejects JVM system property keys with shell/control characters', () => {
    expect(
      RunnerStartMetadataSchema.safeParse({
        ...base,
        systemProperties: {
          'bad key': 'x',
          'also=bad': 'y',
        },
      }).success,
    ).toBe(false);
  });
});

/**
 * Whether the runner loads the Gatling agent for this job. ON unless the
 * requester says otherwise, on BOTH start routes — the upload's multipart
 * metadata and the JSON start-from-package body — so a caller that predates
 * the field gets the agent rather than a refusal or a silent opt-out.
 */
describe('agentEnabled on a runner start', () => {
  const byPackage = {
    packageId: '00000000-0000-4000-8000-000000000001',
    name: 'checkout load',
    simulationClass: 'com.example.CheckoutSimulation',
  };

  it('defaults to true when absent, on both start schemas', () => {
    expect(RunnerStartMetadataSchema.parse(base).agentEnabled).toBe(true);
    expect(RunnerStartByPackageRequestSchema.parse(byPackage).agentEnabled).toBe(true);
  });

  it('keeps an explicit false, on both start schemas', () => {
    expect(RunnerStartMetadataSchema.parse({ ...base, agentEnabled: false }).agentEnabled).toBe(false);
    expect(RunnerStartByPackageRequestSchema.parse({ ...byPackage, agentEnabled: false }).agentEnabled).toBe(false);
  });

  it('refuses a value that is not a boolean, rather than reading "false" as truthy', () => {
    expect(RunnerStartMetadataSchema.safeParse({ ...base, agentEnabled: 'false' }).success).toBe(false);
    expect(RunnerStartByPackageRequestSchema.safeParse({ ...byPackage, agentEnabled: 'false' }).success).toBe(false);
  });

  it('is carried on the job the API answers with, and absent still parses', () => {
    const job = {
      id: '00000000-0000-4000-8000-000000000002',
      artifactId: '00000000-0000-4000-8000-000000000003',
      runId: null,
      status: 'queued',
      requestedBy: 'tester',
      environment: null,
      branch: null,
      commitSha: null,
      testSlug: null,
      javaOptions: null,
      systemProperties: {},
      error: null,
      createdAt: '2026-10-23T10:00:00.000Z',
      updatedAt: '2026-10-23T10:00:00.000Z',
    };
    expect(RunnerJobSchema.parse({ ...job, agentEnabled: false }).agentEnabled).toBe(false);
    expect(RunnerJobSchema.parse({ ...job, agentEnabled: true }).agentEnabled).toBe(true);
    // A body from an API pod that predates the field must still parse: the
    // browser drops a whole body that fails this schema (the rolling-deploy
    // rule), so a required field here would blank the jobs list mid-deploy.
    expect(RunnerJobSchema.parse(job).agentEnabled).toBeUndefined();
    expect(RunnerJobSchema.safeParse({ ...job, agentEnabled: 'false' }).success).toBe(false);
  });
});
