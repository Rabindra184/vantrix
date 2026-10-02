import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  createPrisma,
  PackageNameTakenError,
  PackageRepository,
  type NewPackageVersion,
} from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);
const packages = new PackageRepository(prisma);

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

let orgA = '';
let orgB = '';
let checkout = '';
let search = '';
let billing = '';
beforeEach(async () => {
  await resetDatabase(pool);
  const a = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const b = await prisma.org.create({ data: { slug: 'globex', name: 'Globex' } });
  orgA = a.id;
  orgB = b.id;
  checkout = (await prisma.project.create({ data: { orgId: orgA, slug: 'checkout', name: 'Checkout', settings: {} } })).id;
  search = (await prisma.project.create({ data: { orgId: orgA, slug: 'search', name: 'Search', settings: {} } })).id;
  billing = (await prisma.project.create({ data: { orgId: orgB, slug: 'billing', name: 'Billing', settings: {} } })).id;
});

const version = (over: Partial<NewPackageVersion> = {}): NewPackageVersion => ({
  artifactId: randomUUID(),
  filename: 'demo.jar',
  gatlingVersion: '3.15.1',
  sha256: 'a'.repeat(64),
  bytes: 1_887_437,
  simulations: ['example.BasicSimulation'],
  storagePath: `x/${randomUUID()}.jar`,
  ...over,
});

const make = (projectId: string, name: string, orgId = orgA) =>
  packages.create({ id: randomUUID(), orgId, projectId, name, kind: 'gatling_jar' });

/**
 * A job on a version, in a status, optionally with a run. Stamping the run's
 * `package_id` here stands in for what the runner's `markRunOpened` does when a
 * job opens its run: usage is counted on that column, not on the job.
 */
async function job(projectId: string, artifactId: string, status: string, runTestId?: string | null) {
  let runId: string | null = null;
  if (runTestId !== undefined) {
    const run = await prisma.run.create({
      data: {
        orgId: orgA,
        projectId,
        testId: runTestId,
        status: 'complete',
        verdict: 'passed',
        tool: 'gatling',
        bundleKey: `runs/${projectId}/${randomUUID()}.tgz`,
        bundleSha256: 'a'.repeat(64),
        bundleBytes: 1n,
        startedAt: new Date(),
        startedOn: new Date(),
        engineOptions: {},
      },
    });
    runId = run.id;
    await prisma.run.update({
      where: { id: run.id },
      data: {
        packageId: (await prisma.runnerArtifact.findUniqueOrThrow({ where: { id: artifactId } })).packageId,
      },
    });
  }
  await prisma.runnerJob.create({
    data: {
      orgId: orgA,
      projectId,
      artifactId,
      runId,
      status,
      requestedBy: 'ci',
      name: 'nightly',
      simulationClass: 'example.BasicSimulation',
    },
  });
}

async function testIn(projectId: string, slug: string): Promise<string> {
  return (
    await prisma.test.create({
      data: { orgId: orgA, projectId, slug, name: slug, simulationClass: `example.${slug}` },
    })
  ).id;
}

async function countArtifacts(packageId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM runner_artifact WHERE package_id = $1',
    [packageId],
  );
  return Number(rows[0]!.n);
}

describe('PackageRepository', () => {
  it('creates a package with no file, and lists it with current null and zero usage', async () => {
    const created = await make(checkout, 'Checkout');
    expect(created.current).toBeNull();

    const listed = await packages.list(orgA, checkout);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(created.id);
    expect(listed[0]!.current).toBeNull();
    expect(listed[0]!.usage).toEqual({ tests: 0, runs: 0, activeJobs: 0 });
  });

  it('refuses a name the project already has, ignoring case and surrounding space', async () => {
    await make(checkout, 'Checkout');
    await expect(make(checkout, 'checkout')).rejects.toBeInstanceOf(PackageNameTakenError);
    // The API trims before calling, so a padded name reaches here already
    // trimmed; the case half of the rule is what this pins. The rule is per
    // project, so the same name elsewhere is fine.
    await expect(make(search, 'checkout')).resolves.toMatchObject({ name: 'checkout' });
  });

  it('surfaces any other unique violation as itself, never as a taken name', async () => {
    const first = await make(checkout, 'Checkout');
    // The same id under a different name collides on the primary key, which
    // shares SQLSTATE 23505 with the name index and must not be mistaken for it.
    const err = await packages
      .create({ id: first.id, orgId: orgA, projectId: checkout, name: 'Distinct', kind: 'gatling_jar' })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(PackageNameTakenError);
  });

  it('finds a package by name ignoring case', async () => {
    const created = await make(checkout, 'Checkout');
    const found = await packages.findByName(orgA, checkout, 'CHECKOUT');
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe('Checkout');
    expect(await packages.findByName(orgA, search, 'CHECKOUT')).toBeNull();
  });

  it('makes an uploaded version current and stamps the last upload', async () => {
    const created = await make(checkout, 'Checkout');
    const v = version();
    const added = await packages.addVersion(orgA, checkout, created.id, v);
    expect(added).not.toBeNull();
    expect(added!.reused).toBe(false);
    expect(added!.package.current?.artifactId).toBe(v.artifactId);
    expect(added!.version.artifactId).toBe(v.artifactId);
    expect(added!.version.simulations).toEqual(['example.BasicSimulation']);
    expect(added!.package.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('reuses a version with identical bytes instead of storing a second one', async () => {
    const created = await make(checkout, 'Checkout');
    const first = version({ sha256: 'b'.repeat(64) });
    const second = version({ sha256: 'c'.repeat(64) });
    const third = version({ sha256: 'b'.repeat(64) });
    await packages.addVersion(orgA, checkout, created.id, first);
    const afterSecond = await packages.addVersion(orgA, checkout, created.id, second);
    expect(afterSecond!.package.current?.artifactId).toBe(second.artifactId);

    const reused = await packages.addVersion(orgA, checkout, created.id, third);
    expect(reused!.reused).toBe(true);
    expect(reused!.version.artifactId).toBe(first.artifactId);
    expect(reused!.package.current?.artifactId).toBe(first.artifactId);
    expect(await countArtifacts(created.id)).toBe(2);
  });

  it('never reaches across tenants', async () => {
    const created = await make(checkout, 'Checkout');
    expect(await packages.find(orgA, search, created.id)).toBeNull();
    expect(await packages.find(orgB, billing, created.id)).toBeNull();
    expect(await packages.rename(orgA, search, created.id, 'Stolen')).toBeNull();
    expect(await packages.addVersion(orgA, search, created.id, version())).toBeNull();
    expect(await packages.delete(orgA, search, created.id)).toEqual({ kind: 'not_found' });

    // The package is untouched by every one of those.
    const still = await packages.find(orgA, checkout, created.id);
    expect(still?.name).toBe('Checkout');
    expect(still?.current).toBeNull();
  });

  it('counts usage over runs, durably, and active jobs over every version', async () => {
    const created = await make(checkout, 'Checkout');
    const v1 = version({ sha256: 'b'.repeat(64) });
    const v2 = version({ sha256: 'c'.repeat(64) });
    await packages.addVersion(orgA, checkout, created.id, v1);
    await packages.addVersion(orgA, checkout, created.id, v2);
    const t1 = await testIn(checkout, 'one');
    const t2 = await testIn(checkout, 'two');

    await job(checkout, v1.artifactId, 'complete', t1);
    await job(checkout, v2.artifactId, 'complete', t2);
    await job(checkout, v1.artifactId, 'queued');

    const before = await packages.find(orgA, checkout, created.id);
    expect(before!.usage).toEqual({ tests: 2, runs: 2, activeJobs: 1 });

    // Retention removes old jobs; the runs and their tests were counted on the
    // run's own package_id, so they survive it.
    await pool.query('DELETE FROM runner_job');
    const after = await packages.find(orgA, checkout, created.id);
    expect(after!.usage).toEqual({ tests: 2, runs: 2, activeJobs: 0 });
  });

  it('refuses to delete while a job of any version is active, naming the count', async () => {
    const created = await make(checkout, 'Checkout');
    const v1 = version({ sha256: 'b'.repeat(64) });
    const v2 = version({ sha256: 'c'.repeat(64) });
    await packages.addVersion(orgA, checkout, created.id, v1);
    await packages.addVersion(orgA, checkout, created.id, v2);
    await job(checkout, v1.artifactId, 'running');
    await job(checkout, v2.artifactId, 'queued');

    expect(await packages.delete(orgA, checkout, created.id)).toEqual({ kind: 'in_use', activeJobs: 2 });
    expect(await packages.find(orgA, checkout, created.id)).not.toBeNull();
  });

  it('waits for a start in flight, then refuses on the job that start queued', async () => {
    const created = await make(checkout, 'Checkout');
    const v = version();
    await packages.addVersion(orgA, checkout, created.id, v);

    // A start holds the package row FOR SHARE while it queues its job. The
    // delete has to wait for it and then count on a snapshot that sees the job;
    // a delete that counted first would see nothing and remove a package a run
    // is about to start from.
    const starter = await pool.connect();
    try {
      const { rows } = await starter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const starterPid = rows[0]!.pid;
      await starter.query('BEGIN');
      await starter.query('SELECT id FROM package WHERE id = $1 FOR SHARE', [created.id]);

      const outcome = packages.delete(orgA, checkout, created.id).then(
        (result) => result,
        (err: unknown) => err,
      );

      // Poll from a connection that is neither the starter's nor the delete's,
      // in autocommit: a snapshot taken inside a transaction would freeze.
      const deadline = Date.now() + 10_000;
      let blocked = 0;
      while (blocked === 0 && Date.now() < deadline) {
        const waiting = await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))',
          [starterPid],
        );
        blocked = waiting.rows[0]!.n;
        if (blocked === 0) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked, 'the delete never queued behind the start').toBeGreaterThan(0);

      await starter.query(
        `INSERT INTO runner_job (org_id, project_id, artifact_id, status, requested_by, name, simulation_class)
         VALUES ($1, $2, $3, 'queued', 'ci', 'nightly', 'example.BasicSimulation')`,
        [orgA, checkout, v.artifactId],
      );
      await starter.query('COMMIT');

      expect(await outcome).toEqual({ kind: 'in_use', activeJobs: 1 });
      expect(await packages.find(orgA, checkout, created.id)).not.toBeNull();
    } finally {
      await starter.query('ROLLBACK').catch(() => undefined);
      starter.release();
    }
  });

  it('deletes when nothing is active, keeps the version rows, and hands back every file', async () => {
    const created = await make(checkout, 'Checkout');
    const v1 = version({ sha256: 'b'.repeat(64) });
    const v2 = version({ sha256: 'c'.repeat(64) });
    await packages.addVersion(orgA, checkout, created.id, v1);
    await packages.addVersion(orgA, checkout, created.id, v2);
    const t1 = await testIn(checkout, 'one');
    await job(checkout, v1.artifactId, 'complete', t1);

    const result = await packages.delete(orgA, checkout, created.id);
    expect(result.kind).toBe('deleted');
    if (result.kind !== 'deleted') throw new Error('unreachable');
    expect([...result.storagePaths].sort()).toEqual([v1.storagePath, v2.storagePath].sort());

    expect(await packages.find(orgA, checkout, created.id)).toBeNull();
    const artifacts = await prisma.runnerArtifact.findMany({
      where: { id: { in: [v1.artifactId, v2.artifactId] } },
    });
    expect(artifacts).toHaveLength(2);
    expect(artifacts.every((a) => a.packageId === null)).toBe(true);
    const runs = await prisma.run.findMany({ where: { projectId: checkout } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.packageId).toBeNull();
  });

  it('renames, and refuses a taken name on rename', async () => {
    const first = await make(checkout, 'Checkout');
    const second = await make(checkout, 'Other');

    const renamed = await packages.rename(orgA, checkout, first.id, 'New name');
    expect(renamed?.name).toBe('New name');

    await expect(packages.rename(orgA, checkout, second.id, 'new NAME')).rejects.toBeInstanceOf(
      PackageNameTakenError,
    );
    // The refused rename changed nothing.
    expect((await packages.find(orgA, checkout, second.id))?.name).toBe('Other');
  });
});
