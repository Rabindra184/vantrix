import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { RunEventsResponseSchema } from '@perfportal/contracts';
import { PackageRepository, RunnerRepository } from '@perfportal/persistence';
import { createTestApp, type TestContext } from './support/app.js';

/**
 * ═══ GET /v1/runs/{id}/events — WHAT THE LOGS TAB READS ═══
 * (docs/superpowers/specs/2026-09-29-run-logs-design.md)
 *
 * A runner run's events through the real API, and the answer for a run no
 * runner produced. Cross-org refusal is proven by session-auth's derived
 * endpoint list, which this route joins by existing under /v1/runs/:id.
 */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

function readEvents(runId: string) {
  return request(ctx.app.getHttpServer())
    .get(`/v1/runs/${runId}/events`)
    .set('Authorization', `Bearer ${ctx.readToken}`);
}

async function openLive(): Promise<string> {
  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs/live')
    .set('Authorization', `Bearer ${ctx.streamToken}`)
    .send({ tool: 'gatling' });
  expect(res.status).toBe(201);
  return res.body.runId as string;
}

/** A runner job queued through the real repositories on a version of a
 *  package of its own, owning `runId`, with the runner's first two events
 *  recorded after the API's three. Answers the package's name, which carries a
 *  random suffix: a project refuses a second package of one name, so a fixed
 *  one would make a second call fail for a reason unrelated to the test. */
async function runnerJobFor(runId: string): Promise<{ jobId: string; packageName: string }> {
  const packages = new PackageRepository(ctx.prisma);
  const packageName = `checkout load ${randomUUID().slice(0, 8)}`;
  const pkg = await packages.create({
    id: randomUUID(), orgId: ctx.orgId, projectId: ctx.projectId, name: packageName, kind: 'gatling_jar',
  });
  const added = await packages.addVersion(ctx.orgId, ctx.projectId, pkg.id, {
    artifactId: randomUUID(), filename: 'checkout.jar', gatlingVersion: '3.15.1',
    sha256: 'a'.repeat(64), bytes: 1_887_437, simulations: ['example.ParitySimulation'],
    storagePath: `runner-artifacts/${randomUUID()}.jar`,
  });
  if (!added) throw new Error('package version not added');
  const runner = new RunnerRepository(ctx.prisma);
  const created = await runner.createQueued({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    artifactId: added.version.artifactId,
    job: {
      id: randomUUID(), requestedBy: 'events-test', name: 'nightly', simulationClass: 'example.ParitySimulation',
      environment: null, branch: null, commitSha: null, testSlug: null, javaOptions: null, systemProperties: {},
    },
  });
  if (!created) throw new Error('createQueued refused the version');
  await ctx.prisma.runnerJob.update({ where: { id: created.job.id }, data: { runId, status: 'running' } });
  await runner.recordRunnerEvent(created.job.id, { message: "Claimed by the runner on 'node-1'" });
  await runner.recordRunnerEvent(created.job.id, { phase: 'Deploying' });
  return { jobId: created.job.id, packageName };
}

describe('GET /v1/runs/{id}/events', () => {
  it('answers a runner run’s events in the order they happened', async () => {
    ctx = await createTestApp();
    const runId = await openLive();
    const { packageName } = await runnerJobFor(runId);

    const res = await readEvents(runId);
    expect(res.status).toBe(200);
    const body = RunEventsResponseSchema.parse(res.body);
    expect(body.runId).toBe(runId);
    expect(body.recorded).toBe(true);
    expect(body.events.map((e) => e.phase ?? e.message)).toEqual([
      'Start requested.',
      "Starting the simulation: 'example.ParitySimulation'",
      `Using package: '${packageName}' (1.8 MiB)`,
      "Claimed by the runner on 'node-1'",
      'Deploying',
    ]);
    expect(body.events.map((e) => e.source)).toEqual(['perfportal', 'perfportal', 'perfportal', 'runner', 'runner']);
    for (const event of body.events) expect(event.at).toMatch(ISO);
  });

  it('says nothing could be recorded for a run no runner produced', async () => {
    ctx = await createTestApp();
    const runId = await openLive();
    const res = await readEvents(runId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId, recorded: false, events: [] });
  });

  it('refuses a malformed run id with the 400 its siblings answer', async () => {
    ctx = await createTestApp();
    const res = await readEvents('not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  it('answers 404 for a run it cannot see, never 403', async () => {
    ctx = await createTestApp();
    const res = await readEvents(randomUUID());
    expect(res.status).toBe(404);
  });
});
