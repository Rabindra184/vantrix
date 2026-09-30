import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  createPrisma,
  RunnerRepository,
  type CreateRunnerJobInput,
} from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

/**
 * ═══ A RUNNER RUN'S LIFECYCLE EVENTS, IN THE DATABASE ═══
 * (docs/superpowers/specs/2026-09-29-run-logs-design.md)
 *
 * What the table refuses, what goes with a job, what the API writes when it
 * queues, retries and cancels a job, what the runner writes, and what the
 * run page reads back.
 */
const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);
const repo = new RunnerRepository(prisma);

async function seedProject(slug = 'acme'): Promise<{ orgId: string; projectId: string }> {
  const org = await prisma.org.create({ data: { slug, name: slug } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  return { orgId: org.id, projectId: project.id };
}

function queueInput(
  orgId: string,
  projectId: string,
  job: Partial<CreateRunnerJobInput['job']> = {},
  artifact: Partial<CreateRunnerJobInput['artifact']> = {},
): CreateRunnerJobInput {
  return {
    artifact: {
      id: randomUUID(),
      orgId,
      projectId,
      name: 'checkout load',
      filename: 'checkout.jar',
      kind: 'gatling_jar',
      simulationClass: 'com.example.CheckoutSimulation',
      gatlingVersion: '3.15.1',
      sha256: 'a'.repeat(64),
      bytes: 4096,
      storagePath: `runner-artifacts/${randomUUID()}.jar`,
      ...artifact,
    },
    job: {
      id: randomUUID(),
      requestedBy: 'tester',
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

/** A queued job, written straight into the tables — so the constraint cases
 *  below do not depend on `createQueued` writing its own events. */
async function bareJob(orgId: string, projectId: string): Promise<string> {
  const artifact = await prisma.runnerArtifact.create({
    data: {
      orgId, projectId, name: 'bare', filename: 'bare.jar', kind: 'gatling_jar',
      simulationClass: 'com.example.Bare', sha256: 'b'.repeat(64), bytes: BigInt(1),
      storagePath: `runner-artifacts/${randomUUID()}.jar`,
    },
  });
  const job = await prisma.runnerJob.create({
    data: { orgId, projectId, artifactId: artifact.id, status: 'queued', requestedBy: 'tester' },
  });
  return job.id;
}

async function insertEvent(
  jobId: string,
  source: string,
  message: string | null,
  phase: string | null,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO runner_job_event (job_id, org_id, project_id, source, message, phase)
    SELECT id, org_id, project_id, ${source}::text, ${message}::text, ${phase}::text
    FROM runner_job
    WHERE id = ${jobId}::uuid
  `;
}

async function eventsOf(jobId: string) {
  return prisma.runnerJobEvent.findMany({ where: { jobId }, orderBy: { seq: 'asc' } });
}

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('runner_job_event — what the table refuses', () => {
  it('refuses an event that is both a message and a phase', async () => {
    const { orgId, projectId } = await seedProject();
    const jobId = await bareJob(orgId, projectId);
    await expect(insertEvent(jobId, 'runner', 'Package prepared', 'Deploying'))
      .rejects.toThrow(/runner_job_event_message_xor_phase_check/);
  });

  it('refuses an event that is neither', async () => {
    const { orgId, projectId } = await seedProject();
    const jobId = await bareJob(orgId, projectId);
    await expect(insertEvent(jobId, 'runner', null, null))
      .rejects.toThrow(/runner_job_event_message_xor_phase_check/);
  });

  it('refuses a source nobody writes', async () => {
    const { orgId, projectId } = await seedProject();
    const jobId = await bareJob(orgId, projectId);
    await expect(insertEvent(jobId, 'gatling-enterprise', 'Start requested.', null))
      .rejects.toThrow(/runner_job_event_source_check/);
  });

  it('refuses a phase Gatling Enterprise does not have', async () => {
    const { orgId, projectId } = await seedProject();
    const jobId = await bareJob(orgId, projectId);
    await expect(insertEvent(jobId, 'runner', null, 'Warmup'))
      .rejects.toThrow(/runner_job_event_phase_check/);
  });

  it('accepts a message and a phase, in the order they were written', async () => {
    const { orgId, projectId } = await seedProject();
    const jobId = await bareJob(orgId, projectId);
    await insertEvent(jobId, 'runner', 'Package prepared', null);
    await insertEvent(jobId, 'runner', null, 'Injecting');
    const events = await eventsOf(jobId);
    expect(events.map((e) => e.message ?? `--- ${e.phase}`)).toEqual(['Package prepared', '--- Injecting']);
  });
});

describe('runner_job_event — it goes with its job', () => {
  it('deletes a job’s events with the job', async () => {
    const { orgId, projectId } = await seedProject();
    const jobId = await bareJob(orgId, projectId);
    await insertEvent(jobId, 'runner', 'Package prepared', null);
    await prisma.runnerJob.delete({ where: { id: jobId } });
    expect(await eventsOf(jobId)).toEqual([]);
  });
});

const QUEUED = (simulationClass: string, name: string, size: string) => [
  'Start requested.',
  `Starting the simulation: '${simulationClass}'`,
  `Using package: '${name}' (${size})`,
];

/** The transaction id that wrote a row. Equal ids mean one transaction. */
async function writersOf(table: 'runner_job' | 'runner_job_event', jobId: string): Promise<string[]> {
  const rows = table === 'runner_job'
    ? await prisma.$queryRaw<{ x: string }[]>`SELECT xmin::text AS x FROM runner_job WHERE id = ${jobId}::uuid`
    : await prisma.$queryRaw<{ x: string }[]>`SELECT DISTINCT xmin::text AS x FROM runner_job_event WHERE job_id = ${jobId}::uuid`;
  return rows.map((row) => row.x);
}

async function runFor(orgId: string, projectId: string): Promise<string> {
  const run = await prisma.run.create({
    data: {
      orgId, projectId, status: 'running', tool: 'gatling',
      bundleKey: `live/${randomUUID()}`, bundleSha256: 'a'.repeat(64), bundleBytes: BigInt(0),
      startedAt: new Date('2026-09-29T11:41:00.000Z'), startedOn: new Date('2026-09-29'),
      engineOptions: {},
    },
  });
  return run.id;
}

describe('the queue events — written with the job, by the same statement', () => {
  it('writes Start requested, the simulation and the package when a job is queued', async () => {
    const { orgId, projectId } = await seedProject();
    const created = await repo.createQueued(queueInput(orgId, projectId, {}, { bytes: 1_887_437 }));
    const events = await eventsOf(created.job.id);
    expect(events.map((e) => e.message)).toEqual(QUEUED('com.example.CheckoutSimulation', 'checkout load', '1.8 MiB'));
    expect(events.every((e) => e.source === 'perfportal' && e.phase === null)).toBe(true);
    expect(await writersOf('runner_job_event', created.job.id)).toEqual(await writersOf('runner_job', created.job.id));
  });

  it('writes a retry’s own three against the NEW job, leaving the source job’s alone', async () => {
    const { orgId, projectId } = await seedProject();
    const source = await repo.createQueued(queueInput(orgId, projectId));
    await prisma.runnerJob.update({ where: { id: source.job.id }, data: { status: 'failed' } });
    const retryId = randomUUID();
    const retried = await repo.retry({ id: retryId, orgId, projectId, sourceJobId: source.job.id, requestedBy: 'tester' });
    expect(retried?.job.id).toBe(retryId);
    expect((await eventsOf(retryId)).map((e) => e.message)).toEqual(QUEUED('com.example.CheckoutSimulation', 'checkout load', '4.0 KiB'));
    expect(await writersOf('runner_job_event', retryId)).toEqual(await writersOf('runner_job', retryId));
    expect(await eventsOf(source.job.id)).toHaveLength(3);
  });

  it('writes nothing for a retry it refuses', async () => {
    const { orgId, projectId } = await seedProject();
    const source = await repo.createQueued(queueInput(orgId, projectId));   // still queued: not retryable
    const retryId = randomUUID();
    expect(await repo.retry({ id: retryId, orgId, projectId, sourceJobId: source.job.id, requestedBy: 'tester' })).toBeNull();
    expect(await prisma.runnerJob.findUnique({ where: { id: retryId } })).toBeNull();
    expect(await eventsOf(retryId)).toEqual([]);
  });

  it('never names a job parameter the page must not show', async () => {
    const { orgId, projectId } = await seedProject();
    const storagePath = `runner-artifacts/${randomUUID()}.jar`;
    const created = await repo.createQueued(queueInput(
      orgId, projectId,
      { javaOptions: '-Xmx7g -Dleak.secret=PARAM-LEAK-7f3a', systemProperties: { 'leak.key': 'PARAM-LEAK-91c2' } },
      { storagePath },
    ));
    const text = (await eventsOf(created.job.id)).map((e) => e.message ?? '').join('\n');
    for (const leak of ['PARAM-LEAK', '-Xmx7g', 'leak.', storagePath, 'runner-artifacts/']) {
      expect(text, `an event carries "${leak}"`).not.toContain(leak);
    }
  });
});

describe('cancel — one event for a job it actually moved', () => {
  it('writes Cancel requested once, and nothing for a cancel that changes nothing', async () => {
    const { orgId, projectId } = await seedProject();
    const created = await repo.createQueued(queueInput(orgId, projectId));
    expect(await repo.cancel(orgId, projectId, created.job.id, { recordRequest: true })).not.toBeNull();
    expect(await repo.cancel(orgId, projectId, created.job.id, { recordRequest: true })).not.toBeNull();   // already cancelled: a no-op
    const cancels = (await eventsOf(created.job.id)).filter((e) => e.message === 'Cancel requested.');
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.source).toBe('perfportal');
  });

  it('writes nothing for a job it cannot cancel', async () => {
    const { orgId, projectId } = await seedProject();
    const created = await repo.createQueued(queueInput(orgId, projectId));
    await prisma.runnerJob.update({ where: { id: created.job.id }, data: { status: 'complete' } });
    expect(await repo.cancel(orgId, projectId, created.job.id, { recordRequest: true })).toBeNull();
    expect((await eventsOf(created.job.id)).map((e) => e.message)).not.toContain('Cancel requested.');
  });

  it('writes nothing when the cancel is not a person’s request', async () => {
    // The runner's own shutdown cancels its active job; that is a node
    // restarting, not somebody pressing Cancel, so the log must not say so.
    const { orgId, projectId } = await seedProject();
    const created = await repo.createQueued(queueInput(orgId, projectId));
    const moved = await repo.cancel(orgId, projectId, created.job.id, { recordRequest: false });
    expect(moved?.job.status).toBe('cancelled');
    expect((await eventsOf(created.job.id)).map((e) => e.message)).toEqual(
      QUEUED('com.example.CheckoutSimulation', 'checkout load', '4.0 KiB'),
    );
  });
});

describe('recordRunnerEvent — the runner’s own writer', () => {
  it('writes a message and a phase, as the runner, in order', async () => {
    const { orgId, projectId } = await seedProject();
    const jobId = await bareJob(orgId, projectId);
    await repo.recordRunnerEvent(jobId, { message: "Claimed by the runner on 'node-1'" });
    await repo.recordRunnerEvent(jobId, { phase: 'Deploying' });
    const events = await eventsOf(jobId);
    expect(events.map((e) => [e.source, e.message, e.phase])).toEqual([
      ['runner', "Claimed by the runner on 'node-1'", null],
      ['runner', null, 'Deploying'],
    ]);
    expect(events.every((e) => e.orgId === orgId && e.projectId === projectId)).toBe(true);
  });

  it('caps a long message', async () => {
    const { orgId, projectId } = await seedProject();
    const jobId = await bareJob(orgId, projectId);
    await repo.recordRunnerEvent(jobId, { message: `Run failed: X: ${'m'.repeat(3000)}` });
    const [event] = await eventsOf(jobId);
    expect(event?.message).toHaveLength(2000);
    expect(event?.message?.endsWith('…')).toBe(true);
  });
});

describe('listEventsForRun — what the run page reads', () => {
  it('answers the run’s job and its events, oldest first', async () => {
    const { orgId, projectId } = await seedProject();
    const created = await repo.createQueued(queueInput(orgId, projectId));
    const runId = await runFor(orgId, projectId);
    await prisma.runnerJob.update({ where: { id: created.job.id }, data: { runId, status: 'running' } });
    await repo.recordRunnerEvent(created.job.id, { message: "Claimed by the runner on 'node-1'" });
    await repo.recordRunnerEvent(created.job.id, { phase: 'Deploying' });

    const found = await repo.listEventsForRun(orgId, projectId, runId);
    expect(found?.jobId).toBe(created.job.id);
    expect(found?.events.map((e) => e.phase ?? e.message)).toEqual([
      ...QUEUED('com.example.CheckoutSimulation', 'checkout load', '4.0 KiB'),
      "Claimed by the runner on 'node-1'",
      'Deploying',
    ]);
    expect(found?.events.every((e) => e.at instanceof Date)).toBe(true);
  });

  it('answers null for a run no runner job produced', async () => {
    const { orgId, projectId } = await seedProject();
    const runId = await runFor(orgId, projectId);
    expect(await repo.listEventsForRun(orgId, projectId, runId)).toBeNull();
  });

  it('answers null for another organisation’s run', async () => {
    const mine = await seedProject('acme');
    const theirs = await seedProject('globex');
    const created = await repo.createQueued(queueInput(theirs.orgId, theirs.projectId));
    const runId = await runFor(theirs.orgId, theirs.projectId);
    await prisma.runnerJob.update({ where: { id: created.job.id }, data: { runId } });
    expect(await repo.listEventsForRun(mine.orgId, mine.projectId, runId)).toBeNull();
  });
});
