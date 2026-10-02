import { createHash, randomUUID } from 'node:crypto';
import { Agent, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PackageSchema, type Package } from '@perfportal/contracts';
import { hashToken, mintToken } from '@perfportal/core';
import { PackageRepository, ProjectRepository, RunnerRepository } from '@perfportal/persistence';
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
let previousArtifactCap: string | undefined;
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
  previousArtifactCap = process.env.MAX_RUNNER_ARTIFACT_BYTES;

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
  if (previousArtifactCap === undefined) delete process.env.MAX_RUNNER_ARTIFACT_BYTES;
  else process.env.MAX_RUNNER_ARTIFACT_BYTES = previousArtifactCap;
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

/**
 * A fresh app whose upload cap is `cap` bytes. `loadConfig()` reads
 * MAX_RUNNER_ARTIFACT_BYTES when the app is built (as it does RUNNER_ARTIFACT_DIR),
 * so the cap cannot be changed under a running app; the other cases keep the
 * default and only the ones that need a few-bytes cap pay for a second app.
 * The variable is restored in afterEach.
 */
async function restartWithCap(cap: number): Promise<void> {
  await ctx.close();
  process.env.MAX_RUNNER_ARTIFACT_BYTES = String(cap);
  ctx = await createTestApp();
  runnerToken = await mintBearer(['runner', 'read']);
  cookie = await signUpAsOrgMember(ctx, 'package-author-capped@example.test');
}

/**
 * A PUT whose body is CHUNKED (no Content-Length) and written slowly, over a
 * socket this helper opens itself, so the request is still incomplete when the
 * server first judges its size. That is the only state in which destroying the
 * request destroys the socket, and so the only one in which a 413 can be lost
 * as a reset.
 *
 * Resolves only when BOTH halves have happened: the response arrived AND the
 * client managed to finish sending its whole body, so a 413 that came at the
 * price of an abandoned upload fails here too. It REJECTS if the connection
 * dies before a response, which is the reset itself.
 */
function chunkedPut(
  pathAndQuery: string,
  auth: Auth,
  chunks: readonly Buffer[],
  gapMs: number,
): Promise<{ status: number; body: { code?: string } }> {
  return new Promise((resolve, reject) => {
    const server = ctx.app.getHttpServer() as Server;
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      // keep-alive, so the server does not simply hang up once it has answered.
      const agent = new Agent({ keepAlive: true });
      let result: { status: number; body: { code?: string } } | null = null;
      let finished = false;
      let settled = false;
      const done = (error?: Error): void => {
        if (settled) return;
        if (error === undefined && (result === null || !finished)) return;
        settled = true;
        clearTimeout(deadline);
        agent.destroy();
        server.close();
        if (error !== undefined) reject(error);
        else resolve(result!);
      };
      // The request DEADLINE: a hang fails here, not in the file's own timeout.
      const deadline = setTimeout(
        () =>
          done(
            new Error(
              result === null
                ? 'no response within 5s'
                : 'the 413 arrived but the client could not finish sending: the server stopped reading the request',
            ),
          ),
        5_000,
      );
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'PUT',
          path: pathAndQuery,
          agent,
          headers: { ...auth, 'Content-Type': 'application/octet-stream' },
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (part: Buffer) => parts.push(part));
          res.on('end', () => {
            result = {
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') as { code?: string },
            };
            done();
          });
        },
      );
      req.on('finish', () => {
        finished = true;
        done();
      });
      req.on('error', (err) => done(err));
      void (async () => {
        for (const chunk of chunks) {
          if (req.destroyed) return;
          req.write(chunk);
          await new Promise((next) => setTimeout(next, gapMs));
        }
        if (!req.destroyed) req.end();
      })();
    });
  });
}

/**
 * A request whose CLIENT goes away while the handler is still parked on an await
 * it makes BEFORE it reads the body. `park` receives the one call the handler
 * is parked on and is released only once the server has seen the socket close,
 * so the request is already aborted when the handler resumes — which is when a
 * reader that only listens for an abort from then on would wait for ever.
 *
 * Nothing here sleeps: the handler announces that it is parked, the client
 * destroys its socket, the server-side request reports `close`, and only then
 * is the handler released. `settled` resolves with what the handler ANSWERED —
 * the server-side response's status, and the body it handed to `end` — once
 * that response is `writableEnded` (the handler answered, or tried to, on a
 * socket nobody is reading); never resolving is the hang. The answer is read on
 * the SERVER because the client is gone and can read nothing.
 */
async function abortWhileParked(
  method: 'PUT' | 'POST',
  pathAndQuery: string,
  headers: Record<string, string>,
  park: (parked: () => void, gate: Promise<void>) => void,
): Promise<{ settled: () => Promise<{ status: number; body: { code?: string } }> }> {
  const server = ctx.app.getHttpServer() as Server;
  let serverReq: IncomingMessage | undefined;
  let serverRes: ServerResponse | undefined;
  let answered = '';
  const watch = (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    // Express rewrites req.url as it routes, so the request is told apart by its
    // method: it is the only one of that method in flight.
    if (incoming.method === method) {
      serverReq = incoming;
      serverRes = outgoing;
      // Express's send() hands the whole body to end() in one call; keep a copy
      // of it on the way through.
      const end = outgoing.end.bind(outgoing) as (...args: unknown[]) => ServerResponse;
      outgoing.end = ((...args: unknown[]) => {
        const [chunk] = args;
        if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) answered += chunk.toString();
        return end(...args);
      }) as ServerResponse['end'];
    }
  };
  server.on('request', watch);
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const { port } = server.address() as AddressInfo;

  let handlerParked!: () => void;
  const parked = new Promise<void>((resolve) => (handlerParked = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  park(handlerParked, gate);

  const client = httpRequest({ host: '127.0.0.1', port, method, path: pathAndQuery, agent: false, headers });
  client.on('error', () => undefined); // it is destroyed on purpose
  client.write(Buffer.alloc(16, 1)); // no Content-Length: chunked, so the body is unfinished
  await parked;
  const closedServerSide = new Promise<void>((resolve) => serverReq!.once('close', () => resolve()));
  client.destroy();
  await closedServerSide;
  release();

  return {
    settled: async () => {
      try {
        // The deadline: a handler that never returns fails here, not in the
        // file's own timeout.
        await vi.waitFor(() => expect(serverRes!.writableEnded).toBe(true), { timeout: 5_000, interval: 10 });
      } finally {
        server.off('request', watch);
        server.close();
      }
      return { status: serverRes!.statusCode, body: JSON.parse(answered || '{}') as { code?: string } };
    },
  };
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

  it('settles a create whose client went away before its body was read', async () => {
    const repository = ctx.app.get(ProjectRepository);
    const findBySlugInOrg = repository.findBySlugInOrg.bind(repository);
    const aborted = await abortWhileParked(
      'POST',
      PACKAGES,
      { ...asSession(), 'Content-Type': 'multipart/form-data; boundary=----aborted' },
      (parked, gate) => {
        // The handler's own lookup of the project, made before it reads a byte.
        vi.spyOn(repository, 'findBySlugInOrg').mockImplementationOnce(async (...args) => {
          parked();
          await gate;
          return findBySlugInOrg(...args);
        });
      },
    );

    const answer = await aborted.settled();

    // The handler REFUSED the request, rather than merely returning: the guard's
    // own 400, not a 500 from a reader that tripped over a destroyed stream.
    expect(answer.status, JSON.stringify(answer.body)).toBe(400);
    expect(answer.body.code).toBe('UPLOAD_ABORTED');
    expect(await filesOnDisk()).toEqual([]);
    const listed = await request(ctx.app.getHttpServer()).get(PACKAGES).set(asSession());
    expect((listed.body as { items: Package[] }).items).toEqual([]);
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

  it('answers a JSON create in this route\'s own terms, and creates nothing', async () => {
    // The natural first attempt: {name, kind} as JSON. The runner's reader would
    // answer BUNDLE_NOT_ARCHIVE about "the runner request"; this route says what
    // IT takes.
    const res = await request(ctx.app.getHttpServer())
      .post(PACKAGES)
      .set(asSession())
      .send({ name: 'Checkout', kind: 'gatling_jar' });

    expect(res.status, body(res)).toBe(400);
    expect(res.body.code).toBe('INVALID_PACKAGE_METADATA');
    expect(res.body.detail).toContain('multipart/form-data');
    expect(res.body.remediation).toContain('"metadata"');
    expect(res.body.remediation).toContain('"artifact"');
    const listed = await request(ctx.app.getHttpServer()).get(PACKAGES).set(asSession());
    expect((listed.body as { items: Package[] }).items).toEqual([]);
    expect(await filesOnDisk()).toEqual([]);
  });

  it('says so, and still answers with the original error, when the compensating delete fails too', async () => {
    const jar = await thinJar('example.BasicSimulation');
    const repository = ctx.app.get(PackageRepository);
    vi.spyOn(repository, 'addVersion').mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(repository, 'delete').mockRejectedValueOnce(new Error('delete failed too'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await create(asSession(), { name: 'Checkout', kind: 'gatling_jar' }, jar);

    // The caller still learns what actually went wrong, not the cleanup's failure...
    expect(res.status, body(res)).toBe(500);
    // ...and an operator learns an empty package now exists, and what that costs.
    const message = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(message).toContain('EMPTY package');
    expect(message).toContain('409 PACKAGE_NAME_TAKEN');
    warn.mockRestore();
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

  it('settles a PUT whose client went away before its body was read, leaving no file behind', async () => {
    const pkg = await createPackage(asSession());
    const repository = ctx.app.get(PackageRepository);
    const find = repository.find.bind(repository);
    const aborted = await abortWhileParked(
      'PUT',
      `${PACKAGES}/${pkg.id}/content?filename=a.jar`,
      { ...asSession(), 'Content-Type': 'application/octet-stream' },
      (parked, gate) => {
        // The handler's own lookup of the package, which it makes before it
        // reads a byte of the body.
        vi.spyOn(repository, 'find').mockImplementationOnce(async (...args) => {
          parked();
          await gate;
          return find(...args);
        });
      },
    );

    const answer = await aborted.settled();

    expect(answer.status, JSON.stringify(answer.body)).toBe(400);
    expect(answer.body.code).toBe('UPLOAD_ABORTED');
    // An aborted upload must not leave the empty file the handler opened for it
    // (and so must not have held its descriptor open either).
    expect(await filesOnDisk()).toEqual([]);
  });

  it('refuses a bundle PUT to a jar package, and leaves no file', async () => {
    const pkg = await createPackage(asSession());
    const before = await filesOnDisk();

    const res = await put(asSession(), pkg.id, Buffer.from('PK-not-really-a-zip'), 'load.zip');

    expect(res.status, body(res)).toBe(400);
    expect(res.body.code).toBe('PACKAGE_KIND_MISMATCH');
    expect(await filesOnDisk()).toEqual(before);
  });

  /**
   * The reverse of the case above: a JAR to a BUNDLE package. Refused before a
   * byte of the body is read, so nothing is written — and the package goes on
   * running what it ran. The package is given a version first, because "the
   * current version is unchanged" says nothing about a package that never had
   * one.
   */
  it('refuses a jar PUT to a bundle package, leaving no file and the current version as it was', async () => {
    const pkg = await createPackage(asSession(), 'gatling_bundle', 'Load');
    const first = await put(asSession(), pkg.id, Buffer.from('a runnable bundle, never examined'), 'load.zip');
    expect(first.status, body(first)).toBe(200);
    const current = PackageSchema.parse(first.body).current;
    expect(current?.filename).toBe('load.zip');
    const before = await filesOnDisk();
    expect(before).toHaveLength(1);

    const res = await put(asSession(), pkg.id, await readFile(await thinJar('example.A')), 'x.jar');

    expect(res.status, body(res)).toBe(400);
    expect(res.body.code).toBe('PACKAGE_KIND_MISMATCH');
    expect(await filesOnDisk()).toEqual(before);
    const listed = await request(ctx.app.getHttpServer()).get(PACKAGES).set(asSession());
    expect(listed.status, body(listed)).toBe(200);
    const after = (listed.body as { items: Package[] }).items.find((item) => item.id === pkg.id);
    expect(after?.current).toEqual(current);
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

describe('the upload size cap (MAX_RUNNER_ARTIFACT_BYTES)', () => {
  const CAP = 256;

  it('refuses a create whose file is over the cap (413), leaving no file and no package', async () => {
    await restartWithCap(CAP);

    const res = await request(ctx.app.getHttpServer())
      .post(PACKAGES)
      .set(asSession())
      .field('metadata', JSON.stringify({ name: 'Checkout', kind: 'gatling_jar' }))
      .attach('artifact', Buffer.alloc(CAP * 4, 1), 'big.jar');

    expect(res.status, body(res)).toBe(413);
    expect(res.body.code).toBe('BUNDLE_TOO_LARGE');
    // The multipart reader serves the runner start route too, so its wording
    // must not call a package file a "runner artifact".
    expect(res.body.detail).toContain(`${CAP}-byte`);
    expect(res.body.detail).not.toMatch(/runner/i);
    expect(await filesOnDisk()).toEqual([]);
    const listed = await request(ctx.app.getHttpServer()).get(PACKAGES).set(asSession());
    expect((listed.body as { items: Package[] }).items).toEqual([]);
  });

  it('refuses a PUT whose declared length is over the cap (413), and leaves no file', async () => {
    await restartWithCap(CAP);
    const pkg = await createPackage(asSession());

    // supertest declares the true length, so this is the common browser/curl path.
    const res = await put(asSession(), pkg.id, Buffer.alloc(CAP + 1, 1), 'a.jar');

    expect(res.status, body(res)).toBe(413);
    expect(res.body.code).toBe('BUNDLE_TOO_LARGE');
    expect(res.body.meta).toEqual({ maxBytes: CAP });
    expect(await filesOnDisk()).toEqual([]);
  });

  it('refuses on the declared length alone, without waiting for a body that never comes', async () => {
    await restartWithCap(CAP);
    const pkg = await createPackage(asSession());

    // A Content-Length far over the cap with a few bytes behind it. Judged on
    // the header, the answer is immediate; judged on the body, the server waits
    // for bytes that are never sent, which is what the deadline would report.
    const res = await request(ctx.app.getHttpServer())
      .put(`${PACKAGES}/${pkg.id}/content?filename=a.jar`)
      .set(asSession())
      .set('Content-Type', 'application/octet-stream')
      .set('Content-Length', String(CAP * 1000))
      .send(Buffer.from('tiny'))
      .timeout({ deadline: 5_000, response: 5_000 });

    expect(res.status, body(res)).toBe(413);
    expect(res.body.code).toBe('BUNDLE_TOO_LARGE');
    expect(await filesOnDisk()).toEqual([]);
  });

  it('delivers the 413, rather than a reset, to a chunked body that crosses the cap mid-stream', async () => {
    await restartWithCap(CAP);
    const pkg = await createPackage(asSession());

    // No Content-Length, so nothing can be refused early: the first chunk is
    // already over the cap and the request is still being sent for ~250ms after.
    // Destroying that request destroys its socket, and the client then gets a
    // reset in place of this response.
    const res = await chunkedPut(
      `${PACKAGES}/${pkg.id}/content?filename=a.jar`,
      asSession(),
      // 16 MiB in 1 MiB chunks, so the upload is still going well after the
      // first chunk has tripped the cap.
      Array.from({ length: 16 }, () => Buffer.alloc(1024 * 1024, 1)),
      15,
    );

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('BUNDLE_TOO_LARGE');
    // The partial file was removed before the answer was sent.
    expect(await filesOnDisk()).toEqual([]);
  });

  it('accepts a file of exactly the cap, and refuses one byte more', async () => {
    await restartWithCap(CAP);
    const bundle = await createPackage(asSession(), 'gatling_bundle', 'Bundle');

    const exact = await put(asSession(), bundle.id, Buffer.alloc(CAP, 1), 'b.tgz');
    expect(exact.status, body(exact)).toBe(200);
    expect(PackageSchema.parse(exact.body).current?.bytes).toBe(CAP);

    const over = await put(asSession(), bundle.id, Buffer.alloc(CAP + 1, 2), 'b.tgz');
    expect(over.status, body(over)).toBe(413);
    // The version already in force is untouched, and its file is the only one.
    expect(await filesOnDisk()).toHaveLength(1);
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
