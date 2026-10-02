import { describe, expect, it } from 'vitest';
import {
  CreatePackageRequestSchema,
  PackageSchema,
  RenamePackageRequestSchema,
  RunnerJobSchema,
  RunnerStartByPackageRequestSchema,
  RunnerStartMetadataSchema,
} from '../src/index.js';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('package names', () => {
  it('trims, and refuses an empty or over-long name', () => {
    expect(CreatePackageRequestSchema.parse({ name: '  Checkout  ', kind: 'gatling_jar' }).name).toBe('Checkout');
    expect(CreatePackageRequestSchema.safeParse({ name: '   ', kind: 'gatling_jar' }).success).toBe(false);
    expect(RenamePackageRequestSchema.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
    expect(RenamePackageRequestSchema.safeParse({ name: 'x'.repeat(120) }).success).toBe(true);
  });

  it('refuses a field the request does not define', () => {
    expect(CreatePackageRequestSchema.safeParse({ name: 'a', kind: 'gatling_jar', team: 't' }).success).toBe(false);
    expect(RenamePackageRequestSchema.safeParse({ name: 'a', kind: 'gatling_jar' }).success).toBe(false);
  });

  it('accepts only the two artifact kinds', () => {
    expect(CreatePackageRequestSchema.safeParse({ name: 'a', kind: 'js' }).success).toBe(false);
  });
});

describe('starting a run from a package', () => {
  it('needs a package id, a class and a run name', () => {
    const ok = { packageId: UUID, simulationClass: 'example.BasicSimulation', name: 'nightly' };
    expect(RunnerStartByPackageRequestSchema.safeParse(ok).success).toBe(true);
    expect(RunnerStartByPackageRequestSchema.safeParse({ ...ok, packageId: 'nope' }).success).toBe(false);
    expect(RunnerStartByPackageRequestSchema.safeParse({ ...ok, simulationClass: '' }).success).toBe(false);
  });

  it('takes none of the upload fields, which describe a file it does not send', () => {
    const ok = { packageId: UUID, simulationClass: 'example.BasicSimulation', name: 'nightly' };
    expect(RunnerStartByPackageRequestSchema.safeParse({ ...ok, artifactKind: 'gatling_jar' }).success).toBe(false);
    expect(RunnerStartByPackageRequestSchema.safeParse({ ...ok, gatlingVersion: '3.15.1' }).success).toBe(false);
  });

  it('lets the upload-and-start metadata name its package, trimmed', () => {
    const parsed = RunnerStartMetadataSchema.parse({ name: 'n', simulationClass: 'a.B', package: ' Checkout ' });
    expect(parsed.package).toBe('Checkout');
  });
});

describe('a job from an older pod', () => {
  it('still parses without the package fields', () => {
    const job = {
      id: UUID, artifactId: UUID, runId: null, status: 'queued', requestedBy: 'ci',
      environment: null, branch: null, commitSha: null, testSlug: null, javaOptions: null,
      systemProperties: {}, error: null,
      createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z',
    };
    expect(RunnerJobSchema.safeParse(job).success).toBe(true);
  });
});

describe('a package with no file', () => {
  it('reports current as null rather than an empty version', () => {
    const pkg = {
      id: UUID, name: 'Checkout', kind: 'gatling_jar',
      createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z',
      current: null, usage: { tests: 0, runs: 0, activeJobs: 0 },
    };
    expect(PackageSchema.parse(pkg).current).toBeNull();
  });
});
