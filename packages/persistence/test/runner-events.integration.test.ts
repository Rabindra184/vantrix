import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createPrisma } from '../src/index.js';
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

async function seedProject(slug = 'acme'): Promise<{ orgId: string; projectId: string }> {
  const org = await prisma.org.create({ data: { slug, name: slug } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  return { orgId: org.id, projectId: project.id };
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
