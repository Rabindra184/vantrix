import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  createPrisma,
  PackageRepository,
  RunnerRepository,
  type CreateRunnerJobInput,
} from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);
const packages = new PackageRepository(prisma);

/**
 * Two orgs, each with one project, plus a second project in the FIRST org — the
 * fixture the "a runner never claims across its tenancy boundary" tests share.
 * `claimNext` is the single database statement a deployed runner calls to pick
 * up work; before the on-prem runner review it took no scope and claimed the
 * globally-oldest queued job, so a runner deployed for one org would claim and
 * EXECUTE another org's uploaded Gatling code (a cross-tenant RCE). These tests
 * pin the scope predicate that closed it.
 */
async function seed() {
  const orgA = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const orgB = await prisma.org.create({ data: { slug: 'globex', name: 'Globex' } });
  const projectA1 = await prisma.project.create({
    data: { orgId: orgA.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const projectA2 = await prisma.project.create({
    data: { orgId: orgA.id, slug: 'search', name: 'Search', settings: {} },
  });
  const projectB1 = await prisma.project.create({
    data: { orgId: orgB.id, slug: 'billing', name: 'Billing', settings: {} },
  });
  return {
    orgA: orgA.id,
    orgB: orgB.id,
    projectA1: projectA1.id,
    projectA2: projectA2.id,
    projectB1: projectB1.id,
  };
}

/**
 * A package with one version, through the repository that owns versions. A job
 * is queued against an EXISTING version now — `createQueued` never creates one —
 * so every job in this file starts here.
 */
async function packageWithVersion(
  orgId: string,
  projectId: string,
  over: { name?: string; bytes?: number } = {},
): Promise<{ packageId: string; artifactId: string }> {
  const created = await packages.create({
    id: randomUUID(),
    orgId,
    projectId,
    name: over.name ?? `checkout ${randomUUID().slice(0, 8)}`,
    kind: 'gatling_jar',
  });
  const artifactId = await addVersion(orgId, projectId, created.id, over.bytes);
  return { packageId: created.id, artifactId };
}

/** One more version of a package, made current. A fresh SHA-256 every time, so
 *  `addVersion` stores a new row rather than re-using an existing one. */
async function addVersion(orgId: string, projectId: string, packageId: string, bytes = 4096): Promise<string> {
  const added = await packages.addVersion(orgId, projectId, packageId, {
    artifactId: randomUUID(),
    filename: 'checkout.jar',
    gatlingVersion: '3.11.5',
    sha256: createHash('sha256').update(randomUUID()).digest('hex'),
    bytes,
    simulations: ['com.example.CheckoutSimulation'],
    storagePath: `runner-artifacts/${randomUUID()}.jar`,
  });
  if (!added) throw new Error(`package ${packageId} is not in this tenant`);
  return added.version.artifactId;
}

function jobInput(
  orgId: string,
  projectId: string,
  artifactId: string,
  job: Partial<CreateRunnerJobInput['job']> = {},
): CreateRunnerJobInput {
  return {
    orgId,
    projectId,
    artifactId,
    job: {
      id: randomUUID(),
      requestedBy: 'tester',
      name: 'checkout load',
      simulationClass: 'com.example.CheckoutSimulation',
      environment: 'staging',
      branch: null,
      commitSha: null,
      testSlug: null,
      javaOptions: null,
      systemProperties: {},
      ...job,
    },
  };
}

/** A queued job on an existing version; throws when `createQueued` refuses. */
async function queueOn(
  repo: RunnerRepository,
  orgId: string,
  projectId: string,
  artifactId: string,
  job: Partial<CreateRunnerJobInput['job']> = {},
): Promise<string> {
  const created = await repo.createQueued(jobInput(orgId, projectId, artifactId, job));
  if (!created) throw new Error(`createQueued refused version ${artifactId}`);
  return created.job.id;
}

/** A queued runner job on a package of its own, ready for `claimNext` to pick up. */
async function queueJob(
  repo: RunnerRepository,
  orgId: string,
  projectId: string,
  testSlug: string | null = null,
): Promise<string> {
  const { artifactId } = await packageWithVersion(orgId, projectId);
  return queueOn(repo, orgId, projectId, artifactId, { testSlug });
}

const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

async function eventsOf(jobId: string) {
  return prisma.runnerJobEvent.findMany({ where: { jobId }, orderBy: { seq: 'asc' } });
}

async function runIn(orgId: string, projectId: string): Promise<string> {
  const run = await prisma.run.create({
    data: {
      orgId, projectId, status: 'running', tool: 'gatling',
      bundleKey: `live/${randomUUID()}`, bundleSha256: 'a'.repeat(64), bundleBytes: BigInt(0),
      startedAt: new Date('2026-10-02T09:00:00.000Z'), startedOn: new Date('2026-10-02'),
      engineOptions: {},
    },
  });
  return run.id;
}

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('RunnerRepository.claimNext tenancy scoping', () => {
  it('never claims a job belonging to another org (the cross-tenant RCE fix)', async () => {
    const { orgA, orgB, projectA1, projectB1 } = await seed();
    const repo = new RunnerRepository(prisma);
    // The ONLY queued job in the whole database belongs to orgB. A scope-less
    // claim (the pre-fix behaviour) would hand it to orgA's runner.
    await queueJob(repo, orgB, projectB1);

    const stolen = await repo.claimNext({ orgId: orgA, projectId: projectA1 });
    expect(stolen).toBeNull();

    // And it is still there, untouched, for its rightful owner to claim.
    const rightful = await repo.claimNext({ orgId: orgB, projectId: projectB1 });
    expect(rightful).not.toBeNull();
    expect(rightful?.job.orgId).toBe(orgB);
  });

  it('claims its own org job and flips it out of the queue so no one double-runs it', async () => {
    const { orgB, projectB1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const jobId = await queueJob(repo, orgB, projectB1);

    const first = await repo.claimNext({ orgId: orgB, projectId: projectB1 });
    expect(first?.job.id).toBe(jobId);
    expect(first?.job.status).toBe('starting');

    // A second claim finds nothing: the job is no longer 'queued'.
    const second = await repo.claimNext({ orgId: orgB, projectId: projectB1 });
    expect(second).toBeNull();
  });

  it('an org-wide claim (no project) picks up a job in any of that org project', async () => {
    const { orgA, orgB, projectA2, projectB1 } = await seed();
    const repo = new RunnerRepository(prisma);
    await queueJob(repo, orgA, projectA2);
    await queueJob(repo, orgB, projectB1);

    const claimed = await repo.claimNext({ orgId: orgA });
    expect(claimed?.job.orgId).toBe(orgA);
    expect(claimed?.job.projectId).toBe(projectA2);

    // Still scoped: the org-wide claim never reaches into orgB.
    const again = await repo.claimNext({ orgId: orgA });
    expect(again).toBeNull();
  });

  it('a project-scoped claim never claims a sibling project job in the same org', async () => {
    const { orgA, projectA1, projectA2 } = await seed();
    const repo = new RunnerRepository(prisma);
    // The only queued job is in projectA2; a runner scoped to projectA1 must skip it.
    await queueJob(repo, orgA, projectA2);

    const wrongProject = await repo.claimNext({ orgId: orgA, projectId: projectA1 });
    expect(wrongProject).toBeNull();

    const rightProject = await repo.claimNext({ orgId: orgA, projectId: projectA2 });
    expect(rightProject?.job.projectId).toBe(projectA2);
  });

  it('claims the oldest queued job first within scope', async () => {
    const { orgB, projectB1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const firstQueued = await queueJob(repo, orgB, projectB1);
    // createQueued stamps created_at from now(); a small gap keeps the order deterministic.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await queueJob(repo, orgB, projectB1);

    const claimed = await repo.claimNext({ orgId: orgB, projectId: projectB1 });
    expect(claimed?.job.id).toBe(firstQueued);
  });
});

/**
 * ═══ THE DECLARED TEST, ACROSS THE HANDOFF ═══
 *
 * `metadata.test` reached the bundle upload, the live open and the Gradle
 * plugin before it reached this path — so the one submit route with a UI in
 * front of it was the one that could not name a test.
 *
 * What this pins is the HANDOFF, which is where a field of this kind gets
 * silently dropped: it is written by the API when the job is queued and read
 * back by the on-prem runner, a separate process, some time later. Everything
 * in between is SQL this repository writes by hand — an INSERT column list and
 * four separate SELECT projections — and a field missing from any one of them
 * fails soft, as a run that simply groups by simulation class, which is
 * exactly what it would have done anyway.
 */
/**
 * ═══ A RETRY IS THE SAME JOB, SO IT CARRIES THE SAME ASKS ═══
 *
 * `retry` is an INSERT..SELECT, and `test_slug` was in neither its column
 * list nor its SELECT while every other per-job field was. So a retried job
 * silently lost its declared test and its run filed under the auto-created
 * test named after the simulation class instead — the exact grouping a
 * declared test exists to replace.
 *
 * FOUND BY RETRYING A REAL JOB ON A REAL RUNNER, and nothing in this
 * repository could have caught it: no test called this method at all.
 *
 * ═══ ASSERTED AS THE WHOLE SET, NOT AS ONE FIELD ═══
 *
 * A case pinning `testSlug` alone would leave the identical hole open for
 * the next column anybody adds — which is precisely how this one survived.
 * So the claim is that the retry equals its source on EVERY field the
 * operator chose, and it fails whichever of them goes missing.
 */
describe('RunnerRepository.retry', () => {
  it('carries every field the operator chose onto the retried job', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const sourceId = await queueJob(repo, orgA, projectA1, 'checkout-soak');

    // Only a failed or cancelled job is retryable, so put it there first.
    await pool.query(`UPDATE runner_job SET status = 'failed' WHERE id = $1`, [sourceId]);

    const retried = await repo.retry({
      id: randomUUID(),
      orgId: orgA,
      projectId: projectA1,
      sourceJobId: sourceId,
      requestedBy: 'tester',
    });
    if (retried.kind !== 'retried') throw new Error(`expected a retry, got ${retried.kind}`);

    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT artifact_id, name, simulation_class, environment, branch, commit_sha, test_slug,
              java_options, system_properties
         FROM runner_job WHERE id = ANY($1::uuid[]) ORDER BY created_at`,
      [[sourceId, retried.row.job.id]],
    );
    expect(rows).toHaveLength(2);
    // The RETRY equals the SOURCE on all of them. Compared as objects so a
    // newly-added column joins this assertion by being selected above,
    // rather than needing anyone to remember a new `expect`.
    expect(rows[1]).toEqual(rows[0]);
  });

  /** The status and the requester are deliberately NOT carried: a retry is
   *  queued afresh, by whoever asked for it. Without this, "equals its
   *  source" could be satisfied by copying the row wholesale. */
  it('queues the retry afresh rather than cloning the failure', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const sourceId = await queueJob(repo, orgA, projectA1, 'checkout-soak');
    await pool.query(`UPDATE runner_job SET status = 'failed' WHERE id = $1`, [sourceId]);

    const retried = await repo.retry({
      id: randomUUID(),
      orgId: orgA,
      projectId: projectA1,
      sourceJobId: sourceId,
      requestedBy: 'someone-else',
    });

    if (retried.kind !== 'retried') throw new Error(`expected a retry, got ${retried.kind}`);
    expect(retried.row.job.status).toBe('queued');
    expect(retried.row.job.requestedBy).toBe('someone-else');
    expect(retried.row.job.runId).toBeNull();
  });

  it('refuses a retry whose package was deleted', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { packageId, artifactId } = await packageWithVersion(orgA, projectA1);
    const sourceId = await queueOn(repo, orgA, projectA1, artifactId);
    await pool.query(`UPDATE runner_job SET status = 'failed' WHERE id = $1`, [sourceId]);
    expect(await packages.delete(orgA, projectA1, packageId)).toMatchObject({ kind: 'deleted' });

    const retryId = randomUUID();
    const result = await repo.retry({
      id: retryId, orgId: orgA, projectId: projectA1, sourceJobId: sourceId, requestedBy: 'tester',
    });

    expect(result).toEqual({ kind: 'package_deleted' });
    expect(await prisma.runnerJob.findUnique({ where: { id: retryId } })).toBeNull();
    expect(await eventsOf(retryId)).toEqual([]);
  });

  it('refuses a retry of a job that did not fail, and of a job it cannot see', async () => {
    const { orgA, orgB, projectA1, projectB1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const completeId = await queueJob(repo, orgA, projectA1);
    await pool.query(`UPDATE runner_job SET status = 'complete' WHERE id = $1`, [completeId]);
    const theirs = await queueJob(repo, orgB, projectB1);
    await pool.query(`UPDATE runner_job SET status = 'failed' WHERE id = $1`, [theirs]);

    for (const sourceJobId of [completeId, theirs, randomUUID()]) {
      const result = await repo.retry({
        id: randomUUID(), orgId: orgA, projectId: projectA1, sourceJobId, requestedBy: 'tester',
      });
      expect(result, `retrying ${sourceJobId}`).toEqual({ kind: 'not_retryable' });
    }
  });

  /**
   * ═══ BYTE FOR BYTE: A RETRY RUNS THE VERSION ITS SOURCE RAN ═══
   *
   * A newer upload makes another version current. A retry is the same job run
   * again, so it runs the source's version — never whatever the package holds
   * now — under the source's name and class.
   */
  it('retries the source job’s own version, name and class after a newer version became current', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { packageId, artifactId: v1 } = await packageWithVersion(orgA, projectA1);
    const sourceId = await queueOn(repo, orgA, projectA1, v1, { name: 'nightly', simulationClass: 'a.One' });
    await pool.query(`UPDATE runner_job SET status = 'failed' WHERE id = $1`, [sourceId]);
    const v2 = await addVersion(orgA, projectA1, packageId);
    // The fixture really did move the package on, or this proves nothing.
    expect((await packages.find(orgA, projectA1, packageId))?.current?.artifactId).toBe(v2);

    const result = await repo.retry({
      id: randomUUID(), orgId: orgA, projectId: projectA1, sourceJobId: sourceId, requestedBy: 'tester',
    });

    if (result.kind !== 'retried') throw new Error(`expected a retry, got ${result.kind}`);
    expect(result.row.artifact.id).toBe(v1);
    expect(result.row.job.artifactId).toBe(v1);
    expect(result.row.job.name).toBe('nightly');
    expect(result.row.job.simulationClass).toBe('a.One');
  });
});

describe('a runner job that names its test', () => {
  it('round-trips the slug the requester declared', async () => {
    const { orgB, projectB1 } = await seed();
    const repo = new RunnerRepository(prisma);
    await queueJob(repo, orgB, projectB1, 'checkout-soak');

    const claimed = await repo.claimNext({ orgId: orgB, projectId: projectB1 });
    expect(claimed?.job.testSlug).toBe('checkout-soak');
  });

  it('reports null for a job that named none, which is the ordinary case', async () => {
    const { orgB, projectB1 } = await seed();
    const repo = new RunnerRepository(prisma);
    await queueJob(repo, orgB, projectB1);

    const claimed = await repo.claimNext({ orgId: orgB, projectId: projectB1 });
    expect(claimed?.job.testSlug).toBeNull();
  });
});

/**
 * ═══ THE JOB SAYS WHAT TO RUN; THE PACKAGE SAYS WHAT IT RUNS FROM ═══
 *
 * One version now serves many jobs, so the run name and the simulation class
 * live on the job, and the queue events name the PACKAGE, not the run.
 */
describe('a job carries its own name and class', () => {
  it('names the package, not the run, in the Using package line', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { artifactId } = await packageWithVersion(orgA, projectA1, { name: 'Checkout jar', bytes: 1_887_437 });

    const created = await repo.createQueued(jobInput(orgA, projectA1, artifactId, { name: 'nightly' }));

    // The job really carries the run name, so its absence below is a claim.
    expect(created?.job.name).toBe('nightly');
    const events = await eventsOf(created!.job.id);
    const queued = events.filter((e) => e.source === 'perfportal').map((e) => e.message);
    expect(queued[2]).toBe("Using package: 'Checkout jar' (1.8 MiB)");
    for (const event of events) expect(event.message ?? '').not.toContain('nightly');
  });

  it('runs the class and name the JOB asked for, two jobs on one version', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { artifactId } = await packageWithVersion(orgA, projectA1);
    await queueOn(repo, orgA, projectA1, artifactId, { name: 'first', simulationClass: 'a.One' });
    // createQueued stamps created_at from now(); a small gap keeps the order deterministic.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await queueOn(repo, orgA, projectA1, artifactId, { name: 'second', simulationClass: 'a.Two' });

    const first = await repo.claimNext({ orgId: orgA, projectId: projectA1 });
    const second = await repo.claimNext({ orgId: orgA, projectId: projectA1 });

    expect([first?.job.simulationClass, second?.job.simulationClass]).toEqual(['a.One', 'a.Two']);
    expect([first?.job.name, second?.job.name]).toEqual(['first', 'second']);
    expect([first?.artifact.id, second?.artifact.id]).toEqual([artifactId, artifactId]);
  });

  /** Three projections are written by hand — listRecent, claimNext's RETURNING
   *  and find (which createQueued answers with) — and a column missing from one
   *  of them reads as undefined, not as an error. */
  it('reports the version’s package on every read', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { packageId, artifactId } = await packageWithVersion(orgA, projectA1, { name: 'Checkout jar' });
    const created = await repo.createQueued(jobInput(orgA, projectA1, artifactId));
    const [listed] = await repo.listRecent(orgA, projectA1);
    const claimed = await repo.claimNext({ orgId: orgA, projectId: projectA1 });

    for (const [read, row] of [['createQueued', created], ['listRecent', listed], ['claimNext', claimed]] as const) {
      expect(row?.artifact, read).toMatchObject({
        id: artifactId,
        packageId,
        packageName: 'Checkout jar',
        simulations: ['com.example.CheckoutSimulation'],
      });
      expect(row?.job, read).toMatchObject({ name: 'checkout load', simulationClass: 'com.example.CheckoutSimulation' });
    }
  });
});

describe('createQueued on a version it may not use', () => {
  it('refuses to queue on a version whose package was deleted', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { packageId, artifactId } = await packageWithVersion(orgA, projectA1);
    expect(await packages.delete(orgA, projectA1, packageId)).toMatchObject({ kind: 'deleted' });
    // The version ROW survives its package, so the refusal below is about the
    // package and not a row that is simply missing.
    expect((await prisma.runnerArtifact.findUnique({ where: { id: artifactId } }))?.packageId).toBeNull();

    const jobId = randomUUID();
    expect(await repo.createQueued(jobInput(orgA, projectA1, artifactId, { id: jobId }))).toBeNull();
    expect(await prisma.runnerJob.findUnique({ where: { id: jobId } })).toBeNull();
    expect(await eventsOf(jobId)).toEqual([]);
  });

  it('refuses to queue on another tenant’s version', async () => {
    const { orgA, orgB, projectA1, projectB1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { artifactId } = await packageWithVersion(orgB, projectB1);

    const jobId = randomUUID();
    expect(await repo.createQueued(jobInput(orgA, projectA1, artifactId, { id: jobId }))).toBeNull();
    expect(await prisma.runnerJob.findUnique({ where: { id: jobId } })).toBeNull();
  });
});

/**
 * ═══ A START RACING A PACKAGE DELETE ═══
 *
 * PackageRepository.delete locks the package row FOR UPDATE, then counts
 * active jobs. A start (a queue or a retry) holds that row FOR SHARE while it
 * inserts its job, so the two cannot interleave: whichever locks first wins.
 * These are the start's half — a delete that already holds the lock makes the
 * start wait, and the start then finds no package and queues nothing, rather
 * than queuing a job on a version whose file the delete handed back to be
 * removed. The delete is played by a connection holding the same lock the
 * repository takes, so the start can be parked behind it deterministically.
 */
describe('a start racing a package delete', () => {
  async function waitUntil(what: string, probe: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!(await probe())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function startBehindADelete<T>(packageId: string, start: () => Promise<T>): Promise<T> {
    const deleter = await pool.connect();
    let pending: Promise<T> | null = null;
    try {
      const { rows } = await deleter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const deleterPid = rows[0]!.pid;
      await deleter.query('BEGIN');
      await deleter.query('SELECT id FROM package WHERE id = $1 FOR UPDATE', [packageId]);

      const started = start();
      pending = started;
      let settled = false;
      started.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      // Polled from a third connection, in autocommit: a snapshot taken inside
      // a transaction would freeze.
      await waitUntil('the start to queue behind the delete', async () => {
        if (settled) throw new Error('the start finished without waiting for the delete: it holds no lock on the package');
        const waiting = await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))',
          [deleterPid],
        );
        return waiting.rows[0]!.n > 0;
      });

      await deleter.query('DELETE FROM package WHERE id = $1', [packageId]);
      await deleter.query('COMMIT');
      return await started;
    } finally {
      await deleter.query('ROLLBACK').catch(() => undefined);
      deleter.release();
      // Never leave the start running into the next test's reset.
      if (pending) await Promise.allSettled([pending]);
    }
  }

  it('a queue that meets a delete in flight waits, then queues nothing', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { packageId, artifactId } = await packageWithVersion(orgA, projectA1);
    const jobId = randomUUID();

    const created = await startBehindADelete(packageId, () =>
      repo.createQueued(jobInput(orgA, projectA1, artifactId, { id: jobId })));

    expect(created).toBeNull();
    expect(await prisma.runnerJob.findUnique({ where: { id: jobId } })).toBeNull();
    expect(await eventsOf(jobId)).toEqual([]);
  });

  it('a retry that meets a delete in flight waits, then answers that the package was deleted', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { packageId, artifactId } = await packageWithVersion(orgA, projectA1);
    const sourceId = await queueOn(repo, orgA, projectA1, artifactId);
    await pool.query(`UPDATE runner_job SET status = 'failed' WHERE id = $1`, [sourceId]);
    const retryId = randomUUID();

    const result = await startBehindADelete(packageId, () =>
      repo.retry({ id: retryId, orgId: orgA, projectId: projectA1, sourceJobId: sourceId, requestedBy: 'tester' }));

    expect(result).toEqual({ kind: 'package_deleted' });
    expect(await prisma.runnerJob.findUnique({ where: { id: retryId } })).toBeNull();
    expect(await eventsOf(retryId)).toEqual([]);
  });
});

describe('markRunOpened', () => {
  it('stamps the run with its package when the runner opens it', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { packageId, artifactId } = await packageWithVersion(orgA, projectA1);
    const jobId = await queueOn(repo, orgA, projectA1, artifactId);
    await repo.claimNext({ orgId: orgA, projectId: projectA1 });
    const runId = await runIn(orgA, projectA1);

    expect(await repo.markRunOpened(jobId, runId)).toBe(true);

    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).packageId).toBe(packageId);
    expect((await prisma.runnerJob.findUniqueOrThrow({ where: { id: jobId } })).runId).toBe(runId);
  });

  it('stamps nothing for a job that is no longer starting', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { artifactId } = await packageWithVersion(orgA, projectA1);
    const jobId = await queueOn(repo, orgA, projectA1, artifactId);
    await pool.query(`UPDATE runner_job SET status = 'cancelled' WHERE id = $1`, [jobId]);
    const runId = await runIn(orgA, projectA1);

    expect(await repo.markRunOpened(jobId, runId)).toBe(false);

    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).packageId).toBeNull();
  });
});

/**
 * ═══ RETENTION, IN TWO PASSES ═══
 *
 * Pass 1 removes terminal jobs past the window, handing back their logs. Pass 2
 * removes versions nothing needs any more — no package's current version, and
 * no job left pointing at it. A package's current version is never swept,
 * however old: it is what the next run starts from.
 */
describe('retention', () => {
  /** A job ages by when it last moved, a version by when it was uploaded —
   *  the two columns the two passes measure. */
  async function age(table: 'runner_job' | 'runner_artifact', ids: string[], interval: string) {
    const column = table === 'runner_job' ? 'updated_at' : 'created_at';
    await pool.query(
      `UPDATE ${table} SET ${column} = now() - $2::interval WHERE id = ANY($1::uuid[])`,
      [ids, interval],
    );
  }

  async function storagePathOf(artifactId: string): Promise<string> {
    return (await prisma.runnerArtifact.findUniqueOrThrow({ where: { id: artifactId } })).storagePath;
  }

  it('sweeps old terminal jobs with their logs, keeping their versions', async () => {
    const { orgA, orgB, projectA1, projectB1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { artifactId } = await packageWithVersion(orgA, projectA1);
    const old = await queueOn(repo, orgA, projectA1, artifactId);
    const recent = await queueOn(repo, orgA, projectA1, artifactId);
    const stillRunning = await queueOn(repo, orgA, projectA1, artifactId);
    const theirs = await queueJob(repo, orgB, projectB1);
    await pool.query(
      `UPDATE runner_job SET status = 'complete', log_path = '/logs/a.log' WHERE id = ANY($1::uuid[])`,
      [[old, recent, theirs]],
    );
    await pool.query(`UPDATE runner_job SET status = 'running' WHERE id = $1`, [stillRunning]);
    await age('runner_job', [old, stillRunning, theirs], '40 days');

    const swept = await repo.deleteTerminalJobsOlderThan({ orgId: orgA, projectId: projectA1 }, daysAgo(30));

    expect(swept).toEqual([{ jobId: old, logPath: '/logs/a.log' }]);
    expect(await prisma.runnerJob.findUnique({ where: { id: old } })).toBeNull();
    expect(await eventsOf(old)).toEqual([]);
    for (const kept of [recent, stillRunning, theirs]) {
      expect(await prisma.runnerJob.findUnique({ where: { id: kept } }), kept).not.toBeNull();
    }
    expect(await prisma.runnerArtifact.findUnique({ where: { id: artifactId } })).not.toBeNull();
  });

  it('never sweeps a package’s current version, and sweeps a superseded one no job needs', async () => {
    const { orgA, orgB, projectA1, projectB1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { packageId, artifactId: v1 } = await packageWithVersion(orgA, projectA1);
    const young = await addVersion(orgA, projectA1, packageId);
    const v2 = await addVersion(orgA, projectA1, packageId);
    const theirs = await packageWithVersion(orgB, projectB1);
    const theirsOld = theirs.artifactId;
    await addVersion(orgB, projectB1, theirs.packageId);
    await age('runner_artifact', [v1, v2, theirsOld], '40 days');
    const v1Path = await storagePathOf(v1);

    const swept = await repo.deleteUnneededVersionsOlderThan({ orgId: orgA, projectId: projectA1 }, daysAgo(30));

    expect(swept).toEqual([{ artifactId: v1, storagePath: v1Path }]);
    expect(await prisma.runnerArtifact.findUnique({ where: { id: v1 } })).toBeNull();
    for (const kept of [young, v2, theirsOld]) {
      expect(await prisma.runnerArtifact.findUnique({ where: { id: kept } }), kept).not.toBeNull();
    }
  });

  it('keeps a superseded version a recent job still points at', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { packageId, artifactId: v1 } = await packageWithVersion(orgA, projectA1);
    const jobId = await queueOn(repo, orgA, projectA1, v1);
    await pool.query(`UPDATE runner_job SET status = 'complete' WHERE id = $1`, [jobId]);
    await age('runner_job', [jobId], '1 day');
    await addVersion(orgA, projectA1, packageId);
    // Only v1 is old: the current version is the previous case's rule, and
    // leaving it young keeps this case about the job reference alone.
    await age('runner_artifact', [v1], '40 days');
    const scope = { orgId: orgA, projectId: projectA1 };

    expect(await repo.deleteTerminalJobsOlderThan(scope, daysAgo(30))).toEqual([]);
    expect(await repo.deleteUnneededVersionsOlderThan(scope, daysAgo(30))).toEqual([]);

    expect(await prisma.runnerArtifact.findUnique({ where: { id: v1 } })).not.toBeNull();
  });

  it('sweeps old terminal jobs across every project of the org when the runner is org-wide', async () => {
    const { orgA, orgB, projectA1, projectA2, projectB1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const a1 = await queueJob(repo, orgA, projectA1);
    const a2 = await queueJob(repo, orgA, projectA2);
    const b1 = await queueJob(repo, orgB, projectB1);
    await pool.query(`UPDATE runner_job SET status = 'complete' WHERE id = ANY($1::uuid[])`, [[a1, a2, b1]]);
    await age('runner_job', [a1, a2, b1], '40 days');

    const swept = await repo.deleteTerminalJobsOlderThan({ orgId: orgA }, daysAgo(30));

    expect(swept.map((row) => row.jobId).sort()).toEqual([a1, a2].sort());
    expect(await prisma.runnerJob.findUnique({ where: { id: b1 } })).not.toBeNull();
  });

  it('sweeps unneeded versions across every project of the org when the runner is org-wide', async () => {
    const { orgA, orgB, projectA1, projectA2, projectB1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const superseded = async (orgId: string, projectId: string): Promise<string> => {
      const { packageId, artifactId } = await packageWithVersion(orgId, projectId);
      await addVersion(orgId, projectId, packageId);
      await age('runner_artifact', [artifactId], '40 days');
      return artifactId;
    };
    const a1 = await superseded(orgA, projectA1);
    const a2 = await superseded(orgA, projectA2);
    const b1 = await superseded(orgB, projectB1);

    const swept = await repo.deleteUnneededVersionsOlderThan({ orgId: orgA }, daysAgo(30));

    expect(swept.map((row) => row.artifactId).sort()).toEqual([a1, a2].sort());
    expect(await prisma.runnerArtifact.findUnique({ where: { id: b1 } })).not.toBeNull();
  });

  /**
   * ═══ THE SWEEP, PARKED BETWEEN ITS TWO STATEMENTS ═══
   *
   * Pass 2 chooses and locks its versions in one statement and deletes the ones
   * still unneeded in a second. What can be reached from outside is the gap
   * between them, so these park the sweep there — holding its locks — and try
   * to make the locked version needed: an upload of the same bytes making it
   * current, a queue putting a job on it. Both must WAIT for the sweep and then
   * fail on their own foreign key; the sweep must finish, and the package keep
   * its current version. The same gap is where a lock-free commit, made in
   * replica mode, rebuilds the state the real race leaves, so statement 2's
   * re-check can be pinned (see commitWithoutForeignKeyLocks below).
   */
  function pausedBeforeSecondStatement(
    inTheGap: (sweepPid: number) => Promise<void>,
  ): { repo: RunnerRepository; reached: () => boolean } {
    let reached = false;
    const client = new Proxy(prisma, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        const fn = value as (...args: unknown[]) => unknown;
        if (prop !== '$transaction') return fn.bind(target);
        return (callback: (tx: unknown) => Promise<unknown>, options?: unknown) =>
          target.$transaction(async (tx) => {
            let queries = 0;
            const paused = new Proxy(tx, {
              get(txTarget, txProp) {
                const txValue: unknown = Reflect.get(txTarget, txProp, txTarget);
                if (typeof txValue !== 'function') return txValue;
                const txFn = txValue as (...args: unknown[]) => unknown;
                if (txProp !== '$queryRaw') return txFn.bind(txTarget);
                return async (...args: unknown[]) => {
                  queries += 1;
                  if (queries === 2) {
                    reached = true;
                    const [me] = await txTarget.$queryRawUnsafe<{ pid: number }[]>(
                      'SELECT pg_backend_pid()::int AS pid',
                    );
                    await inTheGap(me!.pid);
                  }
                  return txFn.apply(txTarget, args);
                };
              },
            });
            return callback(paused);
          }, options as Parameters<typeof target.$transaction>[1]);
      },
    });
    return { repo: new RunnerRepository(client), reached: () => reached };
  }

  /** Waits until `pending` is blocked by the sweep's backend. It must stay
   *  well under the 5 s Prisma gives the parked sweep's transaction, so a slow
   *  arrangement fails here, naming what it waited for. */
  async function blockedBySweep(sweepPid: number, pending: Promise<unknown>, what: string): Promise<void> {
    let settled = false;
    pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    const deadline = Date.now() + 3_000;
    for (;;) {
      if (settled) throw new Error(`${what} finished while the sweep held the version: nothing locks it`);
      const waiting = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))',
        [sweepPid],
      );
      if (waiting.rows[0]!.n > 0) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} to queue behind the sweep`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Commits one statement with the foreign-key triggers off for that
   * transaction only (session_replication_role = replica), so it takes NO lock
   * on the version it names.
   *
   * WHY REPLICA MODE: the race statement 2's re-check exists for is a commit
   * landing INSIDE statement 1 — after its snapshot, before its row locks — and
   * no harness can park a statement there. A real writer arriving in the gap
   * between the statements needs a KEY SHARE lock on the version instead, so it
   * waits on the sweep's FOR UPDATE (the two cases above). Replica mode builds
   * the identical post-window state — a version statement 1 chose and locked
   * that has since become current, or come to be referenced by a job — without
   * waiting. It needs a superuser (perfportal is one, locally and in CI's
   * service containers); a role that is not fails here loudly with "permission
   * denied to set parameter", deliberately: a skipped pin is no pin.
   */
  async function commitWithoutForeignKeyLocks(sql: string, params: unknown[]): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(sql, params);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** True when another transaction holds the version's row lock — here, that
   *  statement 1 really chose and locked it, so a case built on that is not
   *  vacuous. Autocommit: a lock this probe takes is released at once. */
  async function lockedElsewhere(artifactId: string): Promise<boolean> {
    const probe = await pool.query('SELECT id FROM runner_artifact WHERE id = $1 FOR UPDATE SKIP LOCKED', [artifactId]);
    return probe.rowCount === 0;
  }

  it('re-checks the current version in statement 2: a version made current after the lock is kept', async () => {
    const { orgA, projectA1 } = await seed();
    const { packageId, artifactId: v1 } = await packageWithVersion(orgA, projectA1);
    await addVersion(orgA, projectA1, packageId);
    await age('runner_artifact', [v1], '40 days');

    let chosen = false;
    const { repo, reached } = pausedBeforeSecondStatement(async () => {
      chosen = await lockedElsewhere(v1);
      await commitWithoutForeignKeyLocks('UPDATE package SET current_artifact_id = $1 WHERE id = $2', [v1, packageId]);
    });

    const swept = await repo.deleteUnneededVersionsOlderThan({ orgId: orgA, projectId: projectA1 }, daysAgo(30));

    expect(reached()).toBe(true);
    expect(chosen).toBe(true);
    expect(swept).toEqual([]);
    expect((await packages.find(orgA, projectA1, packageId))?.current?.artifactId).toBe(v1);
    expect(await prisma.runnerArtifact.findUnique({ where: { id: v1 } })).not.toBeNull();
  });

  it('re-checks job references in statement 2: a version a job came to need after the lock is kept, and the sweep does not fail', async () => {
    const { orgA, projectA1 } = await seed();
    const { packageId, artifactId: v1 } = await packageWithVersion(orgA, projectA1);
    await addVersion(orgA, projectA1, packageId);
    await age('runner_artifact', [v1], '40 days');

    let chosen = false;
    const { repo, reached } = pausedBeforeSecondStatement(async () => {
      chosen = await lockedElsewhere(v1);
      await commitWithoutForeignKeyLocks(
        `INSERT INTO runner_job (org_id, project_id, artifact_id, status, requested_by, name, simulation_class)
         VALUES ($1, $2, $3, 'complete', 'tester', 'nightly', 'com.example.CheckoutSimulation')`,
        [orgA, projectA1, v1],
      );
    });

    // Awaited directly: without the re-check the delete trips runner_job's
    // ON DELETE RESTRICT and this rejects with 23503.
    const swept = await repo.deleteUnneededVersionsOlderThan({ orgId: orgA, projectId: projectA1 }, daysAgo(30));

    expect(reached()).toBe(true);
    expect(chosen).toBe(true);
    expect(swept).toEqual([]);
    expect(await prisma.runnerArtifact.findUnique({ where: { id: v1 } })).not.toBeNull();
  });

  /**
   * ═══ STATEMENT 1'S OWN PREDICATES, AT LIMIT 1 ═══
   *
   * Statement 2's re-check would keep a current or referenced version that
   * statement 1 chose, so at the default limit dropping statement 1's
   * predicates changes nothing visible. It is a liveness bug all the same:
   * ORDER BY created_at ASC LIMIT n would lock the same n oldest needed
   * versions on every tick, statement 2 would keep them all, and retention
   * would stall for good. At limit 1 the oldest such version is the whole
   * batch, so the stall shows.
   */
  it('chooses only versions that are not current, so an old current version cannot stall the sweep at limit 1', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const p1 = await packageWithVersion(orgA, projectA1);
    const p2 = await packageWithVersion(orgA, projectA1);
    await addVersion(orgA, projectA1, p2.packageId);
    await age('runner_artifact', [p1.artifactId], '50 days');
    await age('runner_artifact', [p2.artifactId], '40 days');
    const oldPath = await storagePathOf(p2.artifactId);

    const swept = await repo.deleteUnneededVersionsOlderThan({ orgId: orgA, projectId: projectA1 }, daysAgo(30), 1);

    expect(swept).toEqual([{ artifactId: p2.artifactId, storagePath: oldPath }]);
  });

  it('chooses only versions no job needs, so an old referenced version cannot stall the sweep at limit 1', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { packageId, artifactId: referenced } = await packageWithVersion(orgA, projectA1);
    await queueOn(repo, orgA, projectA1, referenced);
    const eligible = await addVersion(orgA, projectA1, packageId);
    await addVersion(orgA, projectA1, packageId);
    await age('runner_artifact', [referenced], '50 days');
    await age('runner_artifact', [eligible], '40 days');
    const eligiblePath = await storagePathOf(eligible);

    const swept = await repo.deleteUnneededVersionsOlderThan({ orgId: orgA, projectId: projectA1 }, daysAgo(30), 1);

    expect(swept).toEqual([{ artifactId: eligible, storagePath: eligiblePath }]);
  });

  it('cannot make a version current while the sweep holds it: the upload waits, then fails, and the package keeps its current version', async () => {
    const { orgA, projectA1 } = await seed();
    const { packageId, artifactId: v1 } = await packageWithVersion(orgA, projectA1);
    const v1Row = await prisma.runnerArtifact.findUniqueOrThrow({ where: { id: v1 } });
    const v2 = await addVersion(orgA, projectA1, packageId);
    await age('runner_artifact', [v1], '40 days');

    let upload: Promise<unknown> = Promise.resolve();
    const { repo, reached } = pausedBeforeSecondStatement(async (sweepPid) => {
      // The same bytes as v1: addVersion REUSES that row and makes it current.
      upload = packages.addVersion(orgA, projectA1, packageId, {
        artifactId: randomUUID(), filename: 'checkout.jar', gatlingVersion: '3.11.5',
        sha256: v1Row.sha256, bytes: Number(v1Row.bytes), simulations: null,
        storagePath: `runner-artifacts/${randomUUID()}.jar`,
      });
      await blockedBySweep(sweepPid, upload, 'the upload');
    });

    try {
      const swept = await repo.deleteUnneededVersionsOlderThan({ orgId: orgA, projectId: projectA1 }, daysAgo(30));

      expect(reached()).toBe(true);
      expect(swept.map((row) => row.artifactId)).toEqual([v1]);
      await expect(upload).rejects.toThrow(/23503|foreign key/);
      expect((await packages.find(orgA, projectA1, packageId))?.current?.artifactId).toBe(v2);
    } finally {
      await Promise.allSettled([upload]);
    }
  });

  it('cannot point a job at a version while the sweep holds it: the queue waits, then fails, and the sweep finishes', async () => {
    const { orgA, projectA1 } = await seed();
    const { packageId, artifactId: v1 } = await packageWithVersion(orgA, projectA1);
    await addVersion(orgA, projectA1, packageId);
    await age('runner_artifact', [v1], '40 days');
    const jobId = randomUUID();

    let queued: Promise<unknown> = Promise.resolve();
    const { repo, reached } = pausedBeforeSecondStatement(async (sweepPid) => {
      queued = new RunnerRepository(prisma).createQueued(jobInput(orgA, projectA1, v1, { id: jobId }));
      await blockedBySweep(sweepPid, queued, 'the queue');
    });

    try {
      const swept = await repo.deleteUnneededVersionsOlderThan({ orgId: orgA, projectId: projectA1 }, daysAgo(30));

      expect(reached()).toBe(true);
      expect(swept.map((row) => row.artifactId)).toEqual([v1]);
      await expect(queued).rejects.toThrow(/23503|foreign key/);
      expect(await prisma.runnerJob.findUnique({ where: { id: jobId } })).toBeNull();
      expect(await eventsOf(jobId)).toEqual([]);
    } finally {
      await Promise.allSettled([queued]);
    }
  });

  it('sweeps a version whose package was deleted once its jobs are gone', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const { packageId, artifactId } = await packageWithVersion(orgA, projectA1);
    expect(await packages.delete(orgA, projectA1, packageId)).toMatchObject({ kind: 'deleted' });
    await age('runner_artifact', [artifactId], '40 days');
    const path = await storagePathOf(artifactId);

    const swept = await repo.deleteUnneededVersionsOlderThan({ orgId: orgA, projectId: projectA1 }, daysAgo(30));

    expect(swept).toEqual([{ artifactId, storagePath: path }]);
    expect(await prisma.runnerArtifact.findUnique({ where: { id: artifactId } })).toBeNull();
  });
});

/**
 * ═══ A JOB THAT WAS QUEUED BUT CANNOT BE READ BACK ═══
 *
 * Impossible short of a delete between the insert and the read, and the one
 * answer that must never come back for it is "refused" — null from
 * createQueued, not_retryable from retry — while a queued job exists. Both
 * throw, naming the job. `find` is overridden to stand in for the read missing.
 */
describe('a queued job the repository cannot read back', () => {
  class Unreadable extends RunnerRepository {
    override async find(): Promise<null> {
      return null;
    }
  }

  it('createQueued throws, naming the job, rather than answering that the version was refused', async () => {
    const { orgA, projectA1 } = await seed();
    const { artifactId } = await packageWithVersion(orgA, projectA1);
    const jobId = randomUUID();

    await expect(new Unreadable(prisma).createQueued(jobInput(orgA, projectA1, artifactId, { id: jobId })))
      .rejects.toThrow(jobId);
    // The job WAS queued, which is why null would have been a lie.
    expect(await prisma.runnerJob.findUnique({ where: { id: jobId } })).not.toBeNull();
  });

  it('retry throws too, naming the retried job', async () => {
    const { orgA, projectA1 } = await seed();
    const repo = new RunnerRepository(prisma);
    const sourceId = await queueJob(repo, orgA, projectA1);
    await pool.query(`UPDATE runner_job SET status = 'failed' WHERE id = $1`, [sourceId]);
    const retryId = randomUUID();

    await expect(new Unreadable(prisma).retry({
      id: retryId, orgId: orgA, projectId: projectA1, sourceJobId: sourceId, requestedBy: 'tester',
    })).rejects.toThrow(retryId);
    expect(await prisma.runnerJob.findUnique({ where: { id: retryId } })).not.toBeNull();
  });
});
