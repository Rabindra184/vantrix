import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PackageListResponseSchema, RunnerStartResponseSchema, type PackageListResponse } from '@perfportal/contracts';
import { hashToken, mintToken } from '@perfportal/core';
import { PackageRepository, RunnerRepository } from '@perfportal/persistence';
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

  it('still refuses a start with no artifact file, though package creation accepts one', async () => {
    // readRunnerMultipart's `fileRequired` is the one switch between the two:
    // a package may be created empty, a run may not be started without
    // something to run, so this route must keep passing `true`.
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/projects/checkout/runner/runs')
      .set('Authorization', `Bearer ${runnerToken}`)
      .field(
        'metadata',
        JSON.stringify({ name: 'load', artifactKind: 'gatling_jar', simulationClass: 'example.BasicSimulation' }),
      );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BUNDLE_EMPTY');
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
 * The same route, starting from a PACKAGE (docs/superpowers/specs/2026-10-02-packages-design.md).
 *
 * ═══ TWO BODIES, ONE ROUTE ═══
 *
 * A JSON body starts a run from a package's CURRENT version and uploads
 * nothing; a multipart body keeps uploading, and now files every upload as a
 * version of a package — the one its metadata names, or the one its filename
 * stem names, created when it does not exist. A retry runs the version the
 * failed job ran, never whatever its package holds now.
 *
 * ═══ WHAT THESE CASES PIN THAT A READ OF THE CONTROLLER CANNOT ═══
 *
 * Where the job lands (which package, which version) and what is left on disk.
 * The repositories' own suites cover the rows; these cover the route's choices
 * between them, which is where a start would quietly run the wrong jar.
 */
const RUNS = '/v1/projects/checkout/runner/runs';

/** Every status assertion carries the body: a bare "expected 500 to be 201"
 *  names neither the guard nor the handler that answered. */
const body = (res: { body: unknown }) => JSON.stringify(res.body);

function startFromPackage(payload: Record<string, unknown>) {
  return request(ctx.app.getHttpServer())
    .post(RUNS)
    .set('Authorization', `Bearer ${runnerToken}`)
    .send(payload);
}

function retry(jobId: string) {
  return request(ctx.app.getHttpServer())
    .post(`${RUNS}/${jobId}/retry`)
    .set('Authorization', `Bearer ${runnerToken}`);
}

async function listPackages(): Promise<PackageListResponse> {
  const res = await request(ctx.app.getHttpServer())
    .get('/v1/projects/checkout/packages')
    .set('Authorization', `Bearer ${runnerToken}`);
  expect(res.status, body(res)).toBe(200);
  return PackageListResponseSchema.parse(res.body);
}

/** What is on disk for the project — `.part` temp files included, so a leak of
 *  either kind shows. */
async function filesOnDisk(): Promise<string[]> {
  return (await readdir(path.join(artifactDir, ctx.orgId, ctx.projectId)).catch(() => [])).sort();
}

/**
 * A package made through the repository with one version whose FILE is never
 * written: a JSON start reads the version's row and nothing else, so a missing
 * file here is what proves the start uploaded and read nothing.
 */
async function packageWithVersion(
  name: string,
  simulations: string[] | null,
): Promise<{ packageId: string; artifactId: string }> {
  const packages = ctx.app.get(PackageRepository);
  const pkg = await packages.create({ id: randomUUID(), orgId: ctx.orgId, projectId: ctx.projectId, name, kind: 'gatling_jar' });
  const added = await packages.addVersion(ctx.orgId, ctx.projectId, pkg.id, {
    artifactId: randomUUID(),
    filename: `${name}.jar`,
    gatlingVersion: '3.15.1',
    sha256: createHash('sha256').update(randomUUID()).digest('hex'),
    bytes: 1_024,
    simulations,
    storagePath: path.join(ctx.orgId, ctx.projectId, `${randomUUID()}.jar`),
  });
  if (!added) throw new Error(`addVersion refused package "${name}"`);
  return { packageId: pkg.id, artifactId: added.version.artifactId };
}

/** A thin jar at `jarDir/<dir>/<file>`, so two DIFFERENT jars can share a filename. */
async function jarNamed(dir: string, file: string, simulations: string): Promise<string> {
  await mkdir(path.join(jarDir, dir), { recursive: true });
  const jar = path.join(jarDir, dir, file);
  await writeJar(jar, [
    {
      name: 'META-INF/MANIFEST.MF',
      content: gatlingManifest({ 'Gatling-Version': '3.15.1', 'Gatling-Simulations': simulations }),
    },
    { name: 'example/BasicSimulation.class', content: 'x' },
  ]);
  return jar;
}

async function failJob(jobId: string): Promise<void> {
  await ctx.app.get(RunnerRepository).markFailed(jobId, {
    code: 'SIMULATION_LOG_NOT_FOUND',
    message: 'Gatling finished without producing a simulation.log file.',
    remediation: 'Retry the job.',
  });
}

describe('POST /v1/projects/:slug/runner/runs from a package', () => {
  it("starts a run from a package's current version, with no upload", async () => {
    const { packageId, artifactId } = await packageWithVersion('Checkout', ['example.BasicSimulation']);

    const res = await startFromPackage({
      packageId,
      simulationClass: 'example.BasicSimulation',
      name: 'nightly',
      // The optional run metadata rides along: a field the JSON path dropped
      // would file the run somewhere else with nothing failing (the
      // declaredTestSlug lesson, CLAUDE.md).
      environment: 'staging',
      test: 'checkout-nightly',
      systemProperties: { users: '10' },
    });

    expect(res.status, body(res)).toBe(201);
    const started = RunnerStartResponseSchema.parse(res.body);
    expect(started.job).toMatchObject({
      status: 'queued',
      artifactId,
      packageId,
      packageName: 'Checkout',
      name: 'nightly',
      simulationClass: 'example.BasicSimulation',
      environment: 'staging',
      testSlug: 'checkout-nightly',
      systemProperties: { users: '10' },
    });
    expect(started.artifact.id).toBe(artifactId);
    // The artifact's name and class are the JOB's: one version serves many jobs.
    expect(started.artifact).toMatchObject({ name: 'nightly', simulationClass: 'example.BasicSimulation' });
    // Nothing was uploaded, so nothing was written.
    expect(await filesOnDisk()).toEqual([]);
  });

  it('refuses a class the current version does not declare, and accepts any class when the list is unknown', async () => {
    const declared = await packageWithVersion('Checkout', ['example.BasicSimulation']);

    const refused = await startFromPackage({
      packageId: declared.packageId,
      simulationClass: 'example.Nope',
      name: 'nightly',
    });

    expect(refused.status, body(refused)).toBe(400);
    expect(refused.body.code).toBe('SIMULATION_CLASS_NOT_IN_ARTIFACT');
    expect(refused.body.remediation).toContain('example.BasicSimulation');
    expect(await ctx.prisma.runnerJob.count()).toBe(0);

    // Null is UNKNOWN (nobody wrote the manifest header), never "declares none":
    // a shadow jar must still run any class it holds.
    const unknown = await packageWithVersion('Shadow', null);
    const accepted = await startFromPackage({
      packageId: unknown.packageId,
      simulationClass: 'example.Nope',
      name: 'nightly',
    });

    expect(accepted.status, body(accepted)).toBe(201);
    expect(accepted.body.job.simulationClass).toBe('example.Nope');
  });

  it('answers 409 PACKAGE_HAS_NO_FILE for a package with no current version, and 404 for one that is not there', async () => {
    const packages = ctx.app.get(PackageRepository);
    const empty = await packages.create({
      id: randomUUID(),
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      name: 'Empty',
      kind: 'gatling_jar',
    });

    const noFile = await startFromPackage({ packageId: empty.id, simulationClass: 'example.BasicSimulation', name: 'nightly' });
    expect(noFile.status, body(noFile)).toBe(409);
    expect(noFile.body.code).toBe('PACKAGE_HAS_NO_FILE');
    expect(noFile.body.detail).toBe('Package "Empty" has no file to run yet.');
    expect(noFile.body.remediation).toBe(
      'Upload one with PUT /v1/projects/{slug}/packages/{packageId}/content, then start the run.',
    );

    const missingId = randomUUID();
    const missing = await startFromPackage({ packageId: missingId, simulationClass: 'example.BasicSimulation', name: 'nightly' });
    expect(missing.status, body(missing)).toBe(404);
    expect(missing.body.detail).toBe(`No package ${missingId} in this project.`);

    // A DELETED package's id is the same 404: its version rows stay as the
    // record of what earlier jobs ran, but nothing may start from them.
    const gone = await packageWithVersion('Gone', ['example.BasicSimulation']);
    expect((await packages.delete(ctx.orgId, ctx.projectId, gone.packageId)).kind).toBe('deleted');
    const deleted = await startFromPackage({ packageId: gone.packageId, simulationClass: 'example.BasicSimulation', name: 'nightly' });
    expect(deleted.status, body(deleted)).toBe(404);
    expect(deleted.body.detail).toBe(`No package ${gone.packageId} in this project.`);

    expect(await ctx.prisma.runnerJob.count()).toBe(0);
  });

  it('files an upload-and-start in the package its metadata names, ignoring case and space', async () => {
    const checkout = await ctx.app.get(PackageRepository).create({
      id: randomUUID(),
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      name: 'Checkout',
      kind: 'gatling_jar',
    });
    const jar = await thinJar('example.BasicSimulation');

    const res = await upload(jar, { simulationClass: 'example.BasicSimulation', package: ' checkout ' });

    expect(res.status, body(res)).toBe(201);
    expect(res.body.job).toMatchObject({ packageId: checkout.id, packageName: 'Checkout' });
    const listed = await listPackages();
    expect(listed.items.map((p) => p.name)).toEqual(['Checkout']);
    expect(listed.items[0]?.current?.artifactId).toBe(res.body.artifact.id);
  });

  it('files an upload with no package named under its filename stem, as one package across builds', async () => {
    const first = await jarNamed('build-1', 'nightly-tests.jar', 'example.BasicSimulation');
    const second = await jarNamed('build-2', 'nightly-tests.jar', 'example.BasicSimulation,example.Other');

    const a = await upload(first, { simulationClass: 'example.BasicSimulation' });
    const b = await upload(second, { simulationClass: 'example.BasicSimulation' });

    expect(a.status, body(a)).toBe(201);
    expect(b.status, body(b)).toBe(201);
    expect(a.body.job.packageName).toBe('nightly-tests');
    expect(b.body.job.packageId).toBe(a.body.job.packageId);
    expect(b.body.artifact.id).not.toBe(a.body.artifact.id);
    let listed = await listPackages();
    expect(listed.items.map((p) => p.name)).toEqual(['nightly-tests']);
    expect(listed.items[0]?.current?.artifactId).toBe(b.body.artifact.id);
    expect(await filesOnDisk()).toEqual([`${a.body.artifact.id}.jar`, `${b.body.artifact.id}.jar`].sort());

    // The FIRST jar's bytes again: its version is made current and the job runs
    // it, and the file this upload wrote is the duplicate, so it goes.
    const c = await upload(first, { simulationClass: 'example.BasicSimulation' });

    expect(c.status, body(c)).toBe(201);
    expect(c.body.artifact.id).toBe(a.body.artifact.id);
    expect(c.body.job.artifactId).toBe(a.body.artifact.id);
    listed = await listPackages();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.current?.artifactId).toBe(a.body.artifact.id);
    expect(await filesOnDisk()).toEqual([`${a.body.artifact.id}.jar`, `${b.body.artifact.id}.jar`].sort());
  });

  it('leaves no package behind when it refuses the file itself', async () => {
    // Everything that can refuse the FILE runs before a package is found or
    // made: a refused upload whose package did not exist must not leave an
    // empty one named after it, which the next good upload would then land in
    // with no say.
    const notAJar = path.join(jarDir, 'broken.jar');
    await writeFile(notAJar, 'a text file somebody renamed to .jar');
    const wrongClass = await jarNamed('wrong', 'checkout-load.jar', 'example.BasicSimulation');

    const unreadable = await upload(notAJar, { simulationClass: 'example.BasicSimulation' });
    const undeclared = await upload(wrongClass, { simulationClass: 'example.Nope' });

    expect(unreadable.status, body(unreadable)).toBe(400);
    expect(unreadable.body.code).toBe('RUNNER_ARTIFACT_NOT_A_JAR');
    expect(undeclared.status, body(undeclared)).toBe(400);
    expect(undeclared.body.code).toBe('SIMULATION_CLASS_NOT_IN_ARTIFACT');
    expect((await listPackages()).items).toEqual([]);
    expect(await filesOnDisk()).toEqual([]);
  });

  it('refuses an upload whose kind differs from the package it names', async () => {
    await ctx.app.get(PackageRepository).create({
      id: randomUUID(),
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      name: 'Checkout',
      kind: 'gatling_bundle',
    });
    const jar = await thinJar('example.BasicSimulation');

    const res = await upload(jar, { simulationClass: 'example.BasicSimulation', package: 'Checkout' });

    expect(res.status, body(res)).toBe(400);
    expect(res.body.code).toBe('PACKAGE_KIND_MISMATCH');
    expect(res.body.detail).toBe('Package "Checkout" holds gatling_bundle; this upload is a gatling_jar.');
    expect(res.body.remediation).toContain('"package"');
    expect(await filesOnDisk()).toEqual([]);
    expect(await ctx.prisma.runnerJob.count()).toBe(0);
    expect(await ctx.prisma.runnerArtifact.count()).toBe(0);
  });

  it('a retry runs the version the failed job ran, even after a new upload', async () => {
    const { packageId, artifactId: v1 } = await packageWithVersion('Checkout', ['example.BasicSimulation']);
    const started = await startFromPackage({ packageId, simulationClass: 'example.BasicSimulation', name: 'nightly' });
    expect(started.status, body(started)).toBe(201);
    await failJob(started.body.job.id);

    const v2 = await request(ctx.app.getHttpServer())
      .put(`/v1/projects/checkout/packages/${packageId}/content?filename=v2.jar`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send(await readFile(await thinJar('example.BasicSimulation')));
    expect(v2.status, body(v2)).toBe(200);
    // The package's current version really did move, or the case proves nothing.
    expect(v2.body.current.artifactId).not.toBe(v1);

    const retried = await retry(started.body.job.id);

    // 201, where the OpenAPI document declares 200 for retryRunnerRun: the
    // handler carries no @HttpCode, so Nest answers its POST 201. That
    // disagreement predates packages and is recorded, not changed, here.
    expect(retried.status, body(retried)).toBe(201);
    expect(retried.body.artifact.id).toBe(v1);
    expect(retried.body.job).toMatchObject({
      status: 'queued',
      artifactId: v1,
      packageId,
      name: 'nightly',
      simulationClass: 'example.BasicSimulation',
    });
    expect(retried.body.job.id).not.toBe(started.body.job.id);
  });

  it('refuses a retry whose package was deleted', async () => {
    const { packageId } = await packageWithVersion('Checkout', ['example.BasicSimulation']);
    const started = await startFromPackage({ packageId, simulationClass: 'example.BasicSimulation', name: 'nightly' });
    expect(started.status, body(started)).toBe(201);
    await failJob(started.body.job.id);
    expect((await ctx.app.get(PackageRepository).delete(ctx.orgId, ctx.projectId, packageId)).kind).toBe('deleted');

    const res = await retry(started.body.job.id);

    expect(res.status, body(res)).toBe(409);
    expect(res.body.code).toBe('PACKAGE_DELETED');
    expect(res.body.detail).toBe('The package this job ran was deleted, so it cannot run again.');
    expect(res.body.remediation).toBe('Start a new run from a package with POST /v1/projects/{slug}/runner/runs.');
  });

  it('refuses a JSON body that also tries to upload', async () => {
    const { packageId } = await packageWithVersion('Checkout', ['example.BasicSimulation']);

    const res = await startFromPackage({
      packageId,
      simulationClass: 'example.BasicSimulation',
      name: 'nightly',
      artifactKind: 'gatling_jar',
    });

    expect(res.status, body(res)).toBe(400);
    expect(res.body.code).toBe('INVALID_RUNNER_METADATA');
    expect(res.body.detail).toContain('artifactKind');
    expect(await ctx.prisma.runnerJob.count()).toBe(0);
  });
});
