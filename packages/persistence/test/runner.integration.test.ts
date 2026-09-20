import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  createPrisma,
  RunnerRepository,
  type CreateRunnerJobInput,
} from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

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

/** A queued runner job with a distinct artifact, ready for `claimNext` to pick up. */
async function queueJob(
  repo: RunnerRepository,
  orgId: string,
  projectId: string,
  testSlug: string | null = null,
): Promise<string> {
  const input: CreateRunnerJobInput = {
    artifact: {
      id: randomUUID(),
      orgId,
      projectId,
      name: 'checkout load',
      filename: 'checkout.jar',
      kind: 'gatling_jar',
      simulationClass: 'com.example.CheckoutSimulation',
      gatlingVersion: '3.11.5',
      sha256: 'a'.repeat(64),
      bytes: 4096,
      storagePath: `runner-artifacts/${randomUUID()}.jar`,
    },
    job: {
      id: randomUUID(),
      requestedBy: 'tester',
      environment: 'staging',
      branch: null,
      commitSha: null,
      testSlug,
      javaOptions: null,
      systemProperties: {},
    },
  };
  const created = await repo.createQueued(input);
  return created.job.id;
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
    expect(retried).not.toBeNull();

    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT artifact_id, environment, branch, commit_sha, test_slug,
              java_options, system_properties
         FROM runner_job WHERE id = ANY($1::uuid[]) ORDER BY created_at`,
      [[sourceId, retried!.job.id]],
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

    expect(retried?.job.status).toBe('queued');
    expect(retried?.job.requestedBy).toBe('someone-else');
    expect(retried?.job.runId).toBeNull();
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
