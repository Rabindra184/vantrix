import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PackageSchema, type Package } from '@perfportal/contracts';
import { hashToken, mintToken } from '@perfportal/core';
import { PackageRepository, RunnerRepository } from '@perfportal/persistence';
import { createTestApp, type TestContext } from './support/app.js';
import { signUpAsOrgMember } from './support/session.js';
import { gatlingManifest, writeJar } from '../../../packages/storage/test/support/jar.js';

/**
 * `/v1/projects/:slug/packages` — a project's named, reusable Gatling artifact.
 *
 * ═══ WHAT THESE CASES PIN THAT A READ OF THE CONTROLLER CANNOT ═══
 *
 * Three of them are about FILES, not rows, because the rows are the repository's
 * and its own suite covers them: a refused upload must leave nothing on disk, an
 * upload of bytes the package already holds must store nothing new, and a
 * delete must take every version's file with it. Each is a count of what is
 * under `artifactDir/<org>/<project>`, which is the only place a leak shows.
 */
const PACKAGES = '/v1/projects/checkout/packages';

let ctx: TestContext;
let artifactDir: string;
let jarDir: string;
let previousArtifactDir: string | undefined;
let runnerToken: string;
let cookie: string;

beforeEach(async () => {
  artifactDir = await mkdtemp(path.join(tmpdir(), 'package-artifacts-'));
  jarDir = await mkdtemp(path.join(tmpdir(), 'package-jars-'));
  // loadConfig() reads this at createTestApp() time, so it has to be set before
  // the app is built — the env-var-then-restore discipline runner.integration
  // uses, for the same reason.
  previousArtifactDir = process.env.RUNNER_ARTIFACT_DIR;
  process.env.RUNNER_ARTIFACT_DIR = artifactDir;

  ctx = await createTestApp();
  runnerToken = await mintBearer(['runner', 'read']);
  // A REAL MEMBER of ctx's own org: a session with no membership 403s the way a
  // bearer does on a session-only route, which would make "a session may
  // delete" pass for the wrong reason (tokens.integration.test.ts records it).
  cookie = await signUpAsOrgMember(ctx, 'package-author@example.test');
});

afterEach(async () => {
  await ctx?.close();
  if (previousArtifactDir === undefined) delete process.env.RUNNER_ARTIFACT_DIR;
  else process.env.RUNNER_ARTIFACT_DIR = previousArtifactDir;
  await rm(artifactDir, { recursive: true, force: true });
  await rm(jarDir, { recursive: true, force: true });
});

/** `TestContext` mints no `runner` token (see runner.integration.test.ts). */
async function mintBearer(scopes: string[], projectId: string = ctx.projectId): Promise<string> {
  const minted = mintToken();
  await ctx.app.get(PrismaClient).apiToken.create({
    data: {
      orgId: ctx.orgId,
      projectId,
      name: `package-${scopes.join('-')}`,
      prefix: minted.prefix,
      tokenHash: await hashToken(minted.token.split('_')[2] ?? ''),
      scopes,
    },
  });
  return minted.token;
}

const asBearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const asSession = () => ({ Cookie: cookie });
type Auth = Record<string, string>;

/** Every status assertion here carries the body: a bare "expected 500 to be 201"
 *  says nothing about which guard or handler answered. */
const body = (res: { body: unknown }) => JSON.stringify(res.body);

async function thinJar(simulations: string | null, file = 'thin.jar'): Promise<string> {
  const fields: Record<string, string> = { 'Gatling-Version': '3.15.1' };
  if (simulations !== null) fields['Gatling-Simulations'] = simulations;
  const jar = path.join(jarDir, file);
  await writeJar(jar, [
    { name: 'META-INF/MANIFEST.MF', content: gatlingManifest(fields) },
    { name: 'example/BasicSimulation.class', content: 'x' },
  ]);
  return jar;
}

function create(auth: Auth, metadata: Record<string, unknown>, file?: string, slug = 'checkout') {
  const req = request(ctx.app.getHttpServer())
    .post(`/v1/projects/${slug}/packages`)
    .set(auth)
    .field('metadata', JSON.stringify(metadata));
  return file === undefined ? req : req.attach('artifact', file, path.basename(file));
}

async function createPackage(
  auth: Auth,
  kind: 'gatling_jar' | 'gatling_bundle' = 'gatling_jar',
  name = 'Checkout',
): Promise<Package> {
  const res = await create(auth, { name, kind });
  expect(res.status, body(res)).toBe(201);
  return PackageSchema.parse(res.body);
}

function put(auth: Auth, id: string, content: Buffer, filename?: string, slug = 'checkout') {
  const query = filename === undefined ? '' : `?filename=${encodeURIComponent(filename)}`;
  return request(ctx.app.getHttpServer())
    .put(`/v1/projects/${slug}/packages/${id}/content${query}`)
    .set(auth)
    .set('Content-Type', 'application/octet-stream')
    .send(content);
}

const rename = (auth: Auth, id: string, name: string, slug = 'checkout') =>
  request(ctx.app.getHttpServer()).patch(`/v1/projects/${slug}/packages/${id}`).set(auth).send({ name });

const remove = (auth: Auth, id: string, slug = 'checkout') =>
  request(ctx.app.getHttpServer()).delete(`/v1/projects/${slug}/packages/${id}`).set(auth);

/** What is on disk for the project — `.part` temp files included, so a leak of
 *  either kind shows. */
async function filesOnDisk(): Promise<string[]> {
  return (await readdir(path.join(artifactDir, ctx.orgId, ctx.projectId)).catch(() => [])).sort();
}

describe('POST /v1/projects/:slug/packages', () => {
  it('creates a package with no file (201), and lists it', async () => {
    const res = await create(asSession(), { name: 'Checkout', kind: 'gatling_jar' });

    expect(res.status, body(res)).toBe(201);
    const created = PackageSchema.parse(res.body);
    expect(created).toMatchObject({ name: 'Checkout', kind: 'gatling_jar', current: null });
    expect(created.usage).toEqual({ tests: 0, runs: 0, activeJobs: 0 });
    // Nothing was uploaded, so nothing may be left on disk — not even the empty
    // temp file the multipart reader opens before it knows there is no file.
    expect(await filesOnDisk()).toEqual([]);

    const listed = await request(ctx.app.getHttpServer()).get(PACKAGES).set(asSession());
    expect(listed.status, body(listed)).toBe(200);
    expect((listed.body as { items: Package[] }).items.map((p) => p.id)).toEqual([created.id]);
  });

  it("creates a package with a file, reading the manifest's simulations and version", async () => {
    const jar = await thinJar('example.BasicSimulation,example.Other');

    const res = await create(asSession(), { name: 'Checkout', kind: 'gatling_jar' }, jar);

    expect(res.status, body(res)).toBe(201);
    const created = PackageSchema.parse(res.body);
    expect(created.current).toMatchObject({
      filename: 'thin.jar',
      simulations: ['example.BasicSimulation', 'example.Other'],
      gatlingVersion: '3.15.1',
    });
    const stored = await readFile(jar);
    expect(created.current?.bytes).toBe(stored.length);
    expect(created.current?.sha256).toBe(createHash('sha256').update(stored).digest('hex'));
    // Exactly the file the version names, and no `.part` beside it.
    expect(await filesOnDisk()).toEqual([`${created.current?.artifactId}.jar`]);
  });

  it('treats a file part with no name and no bytes as no file, and removes the empty file it opened', async () => {
    // What a browser form posts when its file input was left empty: the part is
    // there, with an empty filename and an empty body. The multipart reader has
    // already opened its temp file by then, so "no file" has to clean up.
    const boundary = '----packages-empty-file-part';
    const payload =
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n` +
      `${JSON.stringify({ name: 'Checkout', kind: 'gatling_jar' })}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="artifact"; filename=""\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n\r\n--${boundary}--\r\n`;

    const res = await request(ctx.app.getHttpServer())
      .post(PACKAGES)
      .set(asSession())
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(payload);

    expect(res.status, body(res)).toBe(201);
    expect(PackageSchema.parse(res.body).current).toBeNull();
    expect(await filesOnDisk()).toEqual([]);
  });

  it('stores null, not [], for a jar whose manifest declares none', async () => {
    const jar = await thinJar(null);

    const res = await create(asSession(), { name: 'Checkout', kind: 'gatling_jar' }, jar);

    expect(res.status, body(res)).toBe(201);
    // An empty list would claim "this jar has no simulations"; the truth is
    // that nobody wrote the header, which is unknown.
    expect(PackageSchema.parse(res.body).current?.simulations).toBeNull();
  });

  it('refuses a metadata part the schema does not accept, and leaves no file', async () => {
    const jar = await thinJar('example.BasicSimulation');

    const res = await create(asSession(), { name: '  ', kind: 'gatling_jar' }, jar);

    expect(res.status, body(res)).toBe(400);
    expect(res.body.code).toBe('INVALID_PACKAGE_METADATA');
    expect(await filesOnDisk()).toEqual([]);
  });

  it('refuses a file part with a name and no bytes, and leaves neither a file nor a package', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post(PACKAGES)
      .set(asSession())
      .field('metadata', JSON.stringify({ name: 'Checkout', kind: 'gatling_jar' }))
      .attach('artifact', Buffer.alloc(0), 'empty.jar');

    expect(res.status, body(res)).toBe(400);
    expect(res.body.code).toBe('BUNDLE_EMPTY');
    expect(await filesOnDisk()).toEqual([]);
    const listed = await request(ctx.app.getHttpServer()).get(PACKAGES).set(asSession());
    expect((listed.body as { items: Package[] }).items).toEqual([]);
  });

  it('leaves neither a package nor a file when storing the first version fails', async () => {
    const jar = await thinJar('example.BasicSimulation');
    // The package row is made BEFORE its first version, so a failure in between
    // must take the row back: left behind, it would turn the caller's retry
    // into "that name is taken" over a package with nothing in it.
    vi.spyOn(ctx.app.get(PackageRepository), 'addVersion').mockRejectedValueOnce(new Error('boom'));

    const res = await create(asSession(), { name: 'Checkout', kind: 'gatling_jar' }, jar);

    expect(res.status, body(res)).toBe(500);
    expect(await filesOnDisk()).toEqual([]);
    const listed = await request(ctx.app.getHttpServer()).get(PACKAGES).set(asSession());
    expect((listed.body as { items: Package[] }).items).toEqual([]);
    // And the retry the caller makes next is not refused.
    expect((await create(asSession(), { name: 'Checkout', kind: 'gatling_jar' }, jar)).status).toBe(201);
  });

  it('refuses a file whose extension does not suit the kind, and leaves neither a file nor a package', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post(PACKAGES)
      .set(asSession())
      .field('metadata', JSON.stringify({ name: 'Checkout', kind: 'gatling_jar' }))
      .attach('artifact', Buffer.from('PK-not-really-a-zip'), 'load.zip');

    expect(res.status, body(res)).toBe(400);
    expect(res.body.code).toBe('PACKAGE_KIND_MISMATCH');
    expect(await filesOnDisk()).toEqual([]);
    const listed = await request(ctx.app.getHttpServer()).get(PACKAGES).set(asSession());
    expect((listed.body as { items: Package[] }).items).toEqual([]);
  });

  it('leaves a runnable bundle unexamined: no version facts, and the archive kept as it came', async () => {
    // A .tgz is not a zip and has no manifest; reading it as a jar would reject
    // every bundle upload. What is unknown stays null.
    const res = await request(ctx.app.getHttpServer())
      .post(PACKAGES)
      .set(asSession())
      .field('metadata', JSON.stringify({ name: 'Bundle', kind: 'gatling_bundle' }))
      .attach('artifact', Buffer.from('not really a tarball either'), 'bundle.tgz');

    expect(res.status, body(res)).toBe(201);
    const created = PackageSchema.parse(res.body);
    expect(created.kind).toBe('gatling_bundle');
    expect(created.current).toMatchObject({ filename: 'bundle.tgz', simulations: null, gatlingVersion: null });
    expect(await filesOnDisk()).toEqual([`${created.current?.artifactId}.tgz`]);
  });

  it('refuses a file that is not a jar, and leaves neither a file nor a package', async () => {
    const notAJar = path.join(jarDir, 'renamed.jar');
    await writeFile(notAJar, 'a text file somebody renamed to .jar');

    const res = await create(asSession(), { name: 'Checkout', kind: 'gatling_jar' }, notAJar);

    expect(res.status, body(res)).toBe(400);
    expect(res.body.code).toBe('RUNNER_ARTIFACT_NOT_A_JAR');
    expect(await filesOnDisk()).toEqual([]);
    const listed = await request(ctx.app.getHttpServer()).get(PACKAGES).set(asSession());
    expect((listed.body as { items: Package[] }).items).toEqual([]);
  });
});

describe('PUT /v1/projects/:slug/packages/:packageId/content', () => {
  it('replaces the current version, and identical bytes store nothing new', async () => {
    const pkg = await createPackage(asSession());
    const jarA = await readFile(await thinJar('example.A', 'a.jar'));
    const jarB = await readFile(await thinJar('example.B', 'b.jar'));

    const first = await put(asSession(), pkg.id, jarA, 'a.jar');
    expect(first.status, body(first)).toBe(200);
    const firstArtifact = PackageSchema.parse(first.body).current?.artifactId;
    expect(PackageSchema.parse(first.body).current?.simulations).toEqual(['example.A']);

    const second = await put(asSession(), pkg.id, jarB, 'b.jar');
    expect(second.status, body(second)).toBe(200);
    const secondArtifact = PackageSchema.parse(second.body).current?.artifactId;
    expect(secondArtifact).not.toBe(firstArtifact);
    expect(PackageSchema.parse(second.body).current?.simulations).toEqual(['example.B']);

    const third = await put(asSession(), pkg.id, jarA, 'a.jar');
    expect(third.status, body(third)).toBe(200);
    // A's FIRST artifact is current again: the version already held is reused,
    // not duplicated...
    expect(PackageSchema.parse(third.body).current?.artifactId).toBe(firstArtifact);
    // ...and the file the third upload wrote was removed. Two versions, two files.
    expect(await filesOnDisk()).toEqual([`${firstArtifact}.jar`, `${secondArtifact}.jar`].sort());
  });

  it('uses the package name when no filename is given', async () => {
    const pkg = await createPackage(asSession(), 'gatling_jar', 'Soak');
    const jar = await readFile(await thinJar('example.A'));

    const res = await put(asSession(), pkg.id, jar);

    expect(res.status, body(res)).toBe(200);
    expect(PackageSchema.parse(res.body).current?.filename).toBe('Soak.jar');
  });

  it('treats a repeated filename parameter as no name, rather than failing', async () => {
    const pkg = await createPackage(asSession(), 'gatling_jar', 'Soak');
    const jar = await readFile(await thinJar('example.A'));

    // Express hands a repeated parameter over as an array, which is not a name.
    const res = await request(ctx.app.getHttpServer())
      .put(`${PACKAGES}/${pkg.id}/content?filename=a.jar&filename=b.jar`)
      .set(asSession())
      .set('Content-Type', 'application/octet-stream')
      .send(jar);

    expect(res.status, body(res)).toBe(200);
    expect(PackageSchema.parse(res.body).current?.filename).toBe('Soak.jar');
  });

  it('refuses a bundle PUT to a jar package, and leaves no file', async () => {
    const pkg = await createPackage(asSession());
    const before = await filesOnDisk();

    const res = await put(asSession(), pkg.id, Buffer.from('PK-not-really-a-zip'), 'load.zip');

    expect(res.status, body(res)).toBe(400);
    expect(res.body.code).toBe('PACKAGE_KIND_MISMATCH');
    expect(await filesOnDisk()).toEqual(before);
  });

  it('refuses a file that is not a jar, and leaves no file', async () => {
    const pkg = await createPackage(asSession());

    const res = await put(asSession(), pkg.id, Buffer.from('a text file somebody renamed to .jar'), 'x.jar');

    expect(res.status, body(res)).toBe(400);
    expect(res.body.code).toBe('RUNNER_ARTIFACT_NOT_A_JAR');
    expect(await filesOnDisk()).toEqual([]);
  });

  it('refuses a body a parser already drained', async () => {
    const pkg = await createPackage(asSession());

    // express.json() drains a body whose Content-Type matches before any
    // handler runs, so a handler that waited for 'end' would hang for ever. The
    // request DEADLINE is part of the assertion: without it a regression is a
    // timeout in the whole file, not a failure here (CLAUDE.md).
    const res = await request(ctx.app.getHttpServer())
      .put(`${PACKAGES}/${pkg.id}/content?filename=a.jar`)
      .set(asSession())
      .set('Content-Type', 'application/json')
      .send({ not: 'a jar' })
      .timeout({ deadline: 5_000, response: 5_000 });

    expect(res.status, body(res)).toBe(400);
    expect(res.body.code).toBe('STREAM_BODY_CONSUMED');
    expect(await filesOnDisk()).toEqual([]);
  });

  it('refuses a request with no body at all, and leaves no file', async () => {
    const pkg = await createPackage(asSession());

    const res = await put(asSession(), pkg.id, Buffer.alloc(0), 'a.jar');

    expect(res.status, body(res)).toBe(400);
    expect(res.body.code).toBe('BUNDLE_EMPTY');
    expect(await filesOnDisk()).toEqual([]);
  });
});

describe('PATCH and DELETE /v1/projects/:slug/packages/:packageId', () => {
  it('renames, and answers 409 PACKAGE_NAME_TAKEN for a name taken ignoring case', async () => {
    const first = await createPackage(asSession(), 'gatling_jar', 'Checkout');
    const second = await createPackage(asSession(), 'gatling_jar', 'Soak');

    const renamed = await rename(asSession(), second.id, 'Soak v2');
    expect(renamed.status, body(renamed)).toBe(200);
    expect(PackageSchema.parse(renamed.body).name).toBe('Soak v2');

    const taken = await rename(asSession(), second.id, 'CHECKOUT');
    expect(taken.status, body(taken)).toBe(409);
    expect(taken.body.code).toBe('PACKAGE_NAME_TAKEN');

    // Creating one by a taken name is the same refusal, with the same code.
    const duplicate = await create(asSession(), { name: 'checkout', kind: 'gatling_jar' });
    expect(duplicate.status, body(duplicate)).toBe(409);
    expect(duplicate.body.code).toBe('PACKAGE_NAME_TAKEN');
    expect(first.name).toBe('Checkout');
  });

  it('refuses a rename body the schema does not accept', async () => {
    const pkg = await createPackage(asSession());

    const res = await rename(asSession(), pkg.id, '   ');

    expect(res.status, body(res)).toBe(400);
    expect(res.body.code).toBe('INVALID_PACKAGE_METADATA');
  });

  it("deletes (204) and removes every version's file; refuses 409 PACKAGE_IN_USE while a job is active", async () => {
    const pkg = await createPackage(asSession());
    const first = PackageSchema.parse(
      (await put(asSession(), pkg.id, await readFile(await thinJar('example.A', 'a.jar')), 'a.jar')).body,
    );
    const second = PackageSchema.parse(
      (await put(asSession(), pkg.id, await readFile(await thinJar('example.B', 'b.jar')), 'b.jar')).body,
    );
    const versions = [first.current!.artifactId, second.current!.artifactId];
    expect(await filesOnDisk()).toHaveLength(2);

    const jobId = randomUUID();
    const queued = await ctx.app.get(RunnerRepository).createQueued({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      artifactId: second.current!.artifactId,
      job: {
        id: jobId,
        requestedBy: 'test',
        name: 'load',
        simulationClass: 'example.B',
        environment: null,
        branch: null,
        commitSha: null,
        testSlug: null,
        javaOptions: null,
        systemProperties: {},
      },
    });
    expect(queued).not.toBeNull();

    const refused = await remove(asSession(), pkg.id);
    expect(refused.status, body(refused)).toBe(409);
    expect(refused.body.code).toBe('PACKAGE_IN_USE');
    expect(refused.body.detail).toContain('1 run of this package is queued or running');
    expect(await filesOnDisk()).toHaveLength(2);

    await ctx.app.get(PrismaClient).runnerJob.update({ where: { id: jobId }, data: { status: 'complete' } });

    const deleted = await remove(asSession(), pkg.id);
    expect(deleted.status, body(deleted)).toBe(204);
    expect(await filesOnDisk()).toEqual([]);
    // The version rows stay — they are the record of what the job ran — with no
    // package to belong to.
    const rows = await ctx.app.get(PrismaClient).runnerArtifact.findMany({ where: { id: { in: versions } } });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.packageId)).toEqual([null, null]);

    const gone = await request(ctx.app.getHttpServer()).get(PACKAGES).set(asSession());
    expect((gone.body as { items: Package[] }).items).toEqual([]);
  });
});

describe('a delete and the files it removes', () => {
  it('never follows a stored path out of the artifact directory', async () => {
    // A stored path is data a past version of this code wrote. A delete that
    // followed one out of the directory — relative or absolute — would remove a
    // file nobody asked it to; refusing is the whole point of the containment
    // check, and it has to leave the package's own files going.
    const outside = path.join(jarDir, 'outside.jar');
    const escaped = path.join(jarDir, 'escaped.jar');
    await writeFile(outside, 'not ours to delete');
    await writeFile(escaped, 'not ours to delete either');
    const pkg = await createPackage(asSession());
    const inside = PackageSchema.parse(
      (await put(asSession(), pkg.id, await readFile(await thinJar('example.A')), 'a.jar')).body,
    );
    const repository = new PackageRepository(ctx.app.get(PrismaClient));
    for (const [artifactId, storagePath] of [
      [randomUUID(), path.relative(artifactDir, escaped)],
      [randomUUID(), outside],
    ] as const) {
      await repository.addVersion(ctx.orgId, ctx.projectId, pkg.id, {
        artifactId,
        filename: 'x.jar',
        gatlingVersion: null,
        sha256: artifactId,
        bytes: 1,
        simulations: null,
        storagePath,
      });
    }
    expect(await filesOnDisk()).toEqual([`${inside.current!.artifactId}.jar`]);

    const deleted = await remove(asSession(), pkg.id);

    expect(deleted.status, body(deleted)).toBe(204);
    expect(await filesOnDisk()).toEqual([]);
    expect(await readFile(outside, 'utf8')).toBe('not ours to delete');
    expect(await readFile(escaped, 'utf8')).toBe('not ours to delete either');
  });
});

describe('who may do what', () => {
  it('refuses a bearer token on delete (403), and accepts one for create, upload and rename', async () => {
    const bearer = asBearer(runnerToken);

    const created = await createPackage(bearer);
    const uploaded = await put(bearer, created.id, await readFile(await thinJar('example.A')), 'a.jar');
    expect(uploaded.status, body(uploaded)).toBe(200);
    const renamed = await rename(bearer, created.id, 'Checkout 2');
    expect(renamed.status, body(renamed)).toBe(200);

    const refused = await remove(bearer, created.id);
    expect(refused.status, body(refused)).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    // The refusal is the GUARD's, so nothing was deleted and nothing removed.
    const listed = await request(ctx.app.getHttpServer()).get(PACKAGES).set(bearer);
    expect((listed.body as { items: Package[] }).items).toHaveLength(1);
    expect(await filesOnDisk()).toHaveLength(1);

    // And a session may delete: the other half of the split.
    const deleted = await remove(asSession(), created.id);
    expect(deleted.status, body(deleted)).toBe(204);
  });

  it('lets a read token list but not create, upload or rename', async () => {
    const reader = asBearer(ctx.readToken);
    const pkg = await createPackage(asSession());

    const listed = await request(ctx.app.getHttpServer()).get(PACKAGES).set(reader);
    expect(listed.status, body(listed)).toBe(200);

    expect((await create(reader, { name: 'Other', kind: 'gatling_jar' })).status).toBe(403);
    expect((await put(reader, pkg.id, Buffer.from('x'), 'a.jar')).status).toBe(403);
    expect((await rename(reader, pkg.id, 'Renamed')).status).toBe(403);
  });

  it("answers 404 for another project's package, and for a bearer token naming another project", async () => {
    const prisma = ctx.app.get(PrismaClient);
    const other = await prisma.project.create({ data: { orgId: ctx.orgId, slug: 'other', name: 'Other' } });
    const foreign = await new PackageRepository(prisma).create({
      id: randomUUID(),
      orgId: ctx.orgId,
      projectId: other.id,
      name: 'Foreign',
      kind: 'gatling_jar',
    });

    // The first project's slug with the second project's package id: a package
    // is looked up INSIDE the project, so it is simply not there.
    const jar = await readFile(await thinJar('example.A'));
    expect((await put(asSession(), foreign.id, jar, 'a.jar')).status).toBe(404);
    expect((await rename(asSession(), foreign.id, 'Taken')).status).toBe(404);
    expect((await remove(asSession(), foreign.id)).status).toBe(404);
    const listed = await request(ctx.app.getHttpServer()).get(PACKAGES).set(asSession());
    expect((listed.body as { items: Package[] }).items).toEqual([]);
    // None of that touched the foreign package, or put a file on disk.
    expect(await new PackageRepository(prisma).find(ctx.orgId, other.id, foreign.id)).not.toBeNull();
    expect(await filesOnDisk()).toEqual([]);

    // AC-SEC-3: a token minted for project A, naming project B's slug, is 404 on
    // every route — never B's data, and never a 403 that confirms B exists.
    const bearer = asBearer(runnerToken);
    const names = await request(ctx.app.getHttpServer()).get('/v1/projects/other/packages').set(bearer);
    expect(names.status, body(names)).toBe(404);
    expect((await create(bearer, { name: 'Sneaky', kind: 'gatling_jar' }, undefined, 'other')).status).toBe(404);
    expect((await put(bearer, foreign.id, jar, 'a.jar', 'other')).status).toBe(404);
    expect((await rename(bearer, foreign.id, 'Taken', 'other')).status).toBe(404);
    expect(await new PackageRepository(prisma).list(ctx.orgId, other.id)).toHaveLength(1);

    // A project-B token, by contrast, reaches B: the 404s above are about the
    // credential's project, not about B being unreachable.
    const bToken = await mintBearer(['runner', 'read'], other.id);
    const own = await request(ctx.app.getHttpServer()).get('/v1/projects/other/packages').set(asBearer(bToken));
    expect(own.status, body(own)).toBe(200);
  });

  it('answers 400 INVALID_ID for a malformed package id on every route that takes one', async () => {
    const bad = 'not-a-uuid';
    for (const res of [
      await put(asSession(), bad, Buffer.from('x'), 'a.jar'),
      await rename(asSession(), bad, 'Renamed'),
      await remove(asSession(), bad),
    ]) {
      expect(res.status, body(res)).toBe(400);
      expect(res.body.code).toBe('INVALID_ID');
    }
  });
});
