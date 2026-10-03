import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { hashToken, mintToken } from '@perfportal/core';
import { createTestApp, type TestContext } from './support/app.js';
import {
  GATLING_MAIN_CLASS,
  gatlingManifest,
  writeJar,
} from '../../../packages/storage/test/support/jar.js';

/**
 * `POST /v1/projects/:slug/runner/runs` — what it refuses before a job is ever
 * queued.
 *
 * ═══ WHY THE ARTIFACT IS INSPECTED AT ALL ═══
 *
 * Everything wrong with a runner upload used to surface the same way: Gatling
 * exits without producing `simulation.log`, minutes later, and the runner
 * reports SIMULATION_LOG_NOT_FOUND — one message covering a typo'd class, a
 * jar that is not a jar, a missing runtime and a dead JVM, with a remediation
 * that names only the first. A jar packaged by Gatling's own tooling states
 * its simulations in the manifest, which is what Gatling Enterprise reads to
 * list them for you, so the whole class of mistake can be answered in the
 * response to the upload instead.
 *
 * ═══ AND WHY SILENCE MUST NOT BE TREATED AS EVIDENCE ═══
 *
 * A hand-rolled shadow jar declares no `Gatling-Simulations` header. An empty
 * list means "nobody wrote it down", never "this jar has none" — validating
 * against an absent list would reject fat jars that run perfectly well, which
 * is the failure mode this file's third case exists to prevent.
 */
const RUNNER_TOKEN_SCOPES = ['runner', 'read'];

let ctx: TestContext;
let artifactDir: string;
let jarDir: string;
let previousArtifactDir: string | undefined;
let runnerToken: string;

beforeEach(async () => {
  artifactDir = await mkdtemp(path.join(tmpdir(), 'runner-artifacts-'));
  jarDir = await mkdtemp(path.join(tmpdir(), 'runner-jars-'));
  // loadConfig() reads this at createTestApp() time, so it has to be set
  // before the app is built -- the same env-var-then-restore discipline the
  // live suite uses for INGEST_WAIT_MS.
  previousArtifactDir = process.env.RUNNER_ARTIFACT_DIR;
  process.env.RUNNER_ARTIFACT_DIR = artifactDir;

  ctx = await createTestApp();
  runnerToken = await mintRunnerToken(ctx);
});

afterEach(async () => {
  await ctx?.close();
  if (previousArtifactDir === undefined) delete process.env.RUNNER_ARTIFACT_DIR;
  else process.env.RUNNER_ARTIFACT_DIR = previousArtifactDir;
  await rm(artifactDir, { recursive: true, force: true });
  await rm(jarDir, { recursive: true, force: true });
});

/**
 * `TestContext` mints ingest/read/telemetry/stream tokens and no `runner` one,
 * and adding a fifth to the shared factory for one suite would slow every
 * other suite's setup by an Argon2 hash. Minted here instead.
 */
async function mintRunnerToken(context: TestContext): Promise<string> {
  const minted = mintToken();
  const prisma = context.app.get(PrismaClient);
  await prisma.apiToken.create({
    data: {
      orgId: context.orgId,
      projectId: context.projectId,
      name: 'runner',
      prefix: minted.prefix,
      tokenHash: await hashToken(minted.token.split('_')[2] ?? ''),
      scopes: RUNNER_TOKEN_SCOPES,
    },
  });
  return minted.token;
}

function upload(jarPath: string, metadata: Record<string, unknown>) {
  return request(ctx.app.getHttpServer())
    .post('/v1/projects/checkout/runner/runs')
    .set('Authorization', `Bearer ${runnerToken}`)
    .field(
      'metadata',
      JSON.stringify({ name: 'load', artifactKind: 'gatling_jar', ...metadata }),
    )
    .attach('artifact', jarPath, path.basename(jarPath));
}

async function thinJar(simulations: string): Promise<string> {
  const file = path.join(jarDir, 'thin.jar');
  await writeJar(file, [
    {
      name: 'META-INF/MANIFEST.MF',
      content: gatlingManifest({ 'Gatling-Version': '3.15.1', 'Gatling-Simulations': simulations }),
    },
    { name: 'example/BasicSimulation.class', content: 'x' },
  ]);
  return file;
}

describe('POST /v1/projects/:slug/runner/runs artifact checks', () => {
  it('queues a job when the jar declares the simulation asked for', async () => {
    const jar = await thinJar('example.AssertionCorpus,example.BasicSimulation');

    const res = await upload(jar, { simulationClass: 'example.BasicSimulation' });

    expect(res.status).toBe(201);
    expect(res.body.job.status).toBe('queued');
  });

  it('refuses a simulation the jar does not declare, and names the ones it does', async () => {
    const jar = await thinJar('example.AssertionCorpus,example.BasicSimulation');

    const res = await upload(jar, { simulationClass: 'example.BasicSimulationn' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SIMULATION_CLASS_NOT_IN_ARTIFACT');
    // The remediation is the whole value of the check: a 400 that does not say
    // what to type instead is barely better than the job failing.
    expect(res.body.remediation).toContain('example.AssertionCorpus');
    expect(res.body.remediation).toContain('example.BasicSimulation');
    // Nothing queued, and no artifact left behind for the retention sweeper.
    const prisma = ctx.app.get(PrismaClient);
    expect(await prisma.runnerJob.count()).toBe(0);
    expect(await prisma.runnerArtifact.count()).toBe(0);
  });

  it('does not second-guess a jar that declares no simulations at all', async () => {
    // A shadow jar: carries the framework, carries no Gatling manifest
    // headers. There is nothing to validate against, so the upload must pass.
    const jar = path.join(jarDir, 'fat.jar');
    await writeJar(jar, [
      { name: GATLING_MAIN_CLASS, content: 'x' },
      { name: 'example/BasicSimulation.class', content: 'x' },
    ]);

    const res = await upload(jar, { simulationClass: 'example.AnythingAtAll' });

    expect(res.status).toBe(201);
  });

  it('refuses a file that is not a jar, rather than queueing a job that cannot run', async () => {
    const file = path.join(jarDir, 'renamed.jar');
    await writeFile(file, 'a text file somebody renamed to .jar');

    const res = await upload(file, { simulationClass: 'example.BasicSimulation' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RUNNER_ARTIFACT_NOT_A_JAR');
  });

  it('leaves a runnable bundle unexamined — these checks are jar-shaped', async () => {
    // A .tgz is not a zip and has no manifest; running the jar reader over one
    // would reject every bundle upload.
    const bundle = path.join(jarDir, 'bundle.tgz');
    await writeFile(bundle, 'not really a tarball either');

    const res = await request(ctx.app.getHttpServer())
      .post('/v1/projects/checkout/runner/runs')
      .set('Authorization', `Bearer ${runnerToken}`)
      .field(
        'metadata',
        JSON.stringify({
          name: 'load',
          artifactKind: 'gatling_bundle',
          simulationClass: 'example.BasicSimulation',
        }),
      )
      .attach('artifact', bundle, 'bundle.tgz');

    expect(res.status).toBe(201);
  });
});

/**
 * ═══ CANCEL AND RETRY ANSWER WHAT THE DOCUMENT SAYS THEY ANSWER ═══
 *
 * Both answered 201 — Nest's default for a `@Post` — while the published
 * document declared 200 for each, so a generated client branching on the
 * declared status treated every success as an error. They differ now on
 * purpose: a cancel changes a job that already exists (200), a retry creates
 * a new one (201).
 *
 * The case reads the DOCUMENT rather than restating either number twice: the
 * claim is that the server and its contract agree, and that is asserted first,
 * before which number it is. It also proves the 201 is honest — the retried
 * job is a new id, queued, and the very next list read carries it.
 */
describe('cancel and retry on a runner job', () => {
  it('answer the success status the document declares: 200 for a cancel, 201 for the job a retry creates', async () => {
    const server = ctx.app.getHttpServer();
    const auth = { Authorization: `Bearer ${runnerToken}` };
    const doc = (await request(server).get('/v1/openapi.json')).body as {
      paths: Record<string, { post: { responses: Record<string, unknown> } }>;
    };
    const declaredSuccess = (action: 'cancel' | 'retry'): string[] =>
      Object.keys(doc.paths[`/v1/projects/{slug}/runner/runs/{jobId}/${action}`]!.post.responses).filter((c) =>
        c.startsWith('2'),
      );

    const queued = await upload(await thinJar('example.BasicSimulation'), {
      simulationClass: 'example.BasicSimulation',
    });
    expect(queued.status).toBe(201);
    const jobId: string = queued.body.job.id;

    const cancelled = await request(server).post(`/v1/projects/checkout/runner/runs/${jobId}/cancel`).set(auth);
    expect(cancelled.body.job?.status, JSON.stringify(cancelled.body)).toBe('cancelled');
    expect(declaredSuccess('cancel')).toEqual([String(cancelled.status)]);
    expect(cancelled.status).toBe(200);

    const retried = await request(server).post(`/v1/projects/checkout/runner/runs/${jobId}/retry`).set(auth);
    expect(retried.body.job?.status, JSON.stringify(retried.body)).toBe('queued');
    expect(retried.body.job.id).not.toBe(jobId);
    expect(declaredSuccess('retry')).toEqual([String(retried.status)]);
    expect(retried.status).toBe(201);

    // What makes 201 the honest answer: the job it announces exists now.
    const listed = await request(server).get('/v1/projects/checkout/runner/runs').set(auth);
    expect(listed.status).toBe(200);
    expect((listed.body.items as { job: { id: string } }[]).map((i) => i.job.id)).toContain(retried.body.job.id);
  });
});
