// Must be the first import: PipelineService below is a Nest-decorated class
// (@Injectable()), and that decorator calls Reflect.defineMetadata at
// module-evaluation time. Without the polyfill loaded first, that throws
// immediately on import — the same ordering apps/api/src/main.ts and
// apps/api/test/support/app.ts both already depend on.
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashToken, mintToken } from '@perfportal/core';
import { createAuth, createPool, createPrisma, OrgMemberRepository } from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
// Reached into apps/worker's BUILT output, not its TypeScript source: the
// production webServer command (playwright.config.ts) already builds
// apps/worker as part of `pnpm build`, and importing the compiled JS avoids
// asking Playwright's own TS loader to correctly re-transpile a
// Nest-decorated class it was never designed to handle. This mirrors what
// apps/api/test/support/pipeline.ts does for the SAME class from the
// integration suite, just against dist instead of src, because that suite
// runs under Vitest's TS transform and this one doesn't.
import { PipelineService } from '../../worker/dist/pipeline/pipeline.service.js';
import { loadWorkerConfig } from '../../worker/dist/config.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required to seed the e2e fixtures, e.g.\n' +
      '  export DATABASE_URL=\'postgresql://perfportal:perfportal@localhost:5433/perfportal\'',
  );
}

// playwright.config.ts's use.baseURL, duplicated here rather than imported:
// fixtures.ts talks to the server over plain HTTP (fetch), never through a
// Playwright `page`, so it has no access to the test-level `baseURL` fixture.
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

const prisma = createPrisma(DATABASE_URL);
const pool = createPool(DATABASE_URL);
const auth = createAuth({ databaseUrl: DATABASE_URL, baseUrl: BASE_URL });
const orgMembers = new OrgMemberRepository(prisma);
const workerConfig = loadWorkerConfig();
const blobs = new BlobStore(workerConfig.blob);

/** Every seeded account uses this password. Well above Better Auth's 8-char
 *  floor (see packages/persistence/scripts/bootstrap.ts's own comment on the
 *  same 8-128 bound) — never asserted on, so its exact shape doesn't matter. */
const PASSWORD = 'correct-horse-battery-staple';

/** A short, globally-unique-enough slug/local-part. Playwright spreads test
 *  files across separate worker PROCESSES, so a plain in-module counter
 *  would restart at 0 in each one and collide; randomUUID does not. */
function unique(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function createOrgAndProject(): Promise<{ orgId: string; projectId: string }> {
  const org = await prisma.org.create({ data: { slug: unique('org'), name: 'E2E Org' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  return { orgId: org.id, projectId: project.id };
}

/** The project a seedAdmin()/seedAdminForEmptyOrg() org already has — every
 *  seed below that takes an orgId (rather than minting its own) ingests into
 *  this rather than guessing a project slug. */
async function projectFor(orgId: string): Promise<string> {
  const project = await prisma.project.findFirst({ where: { orgId } });
  if (!project) {
    throw new Error(`no project found for org ${orgId} — seed the org via seedAdmin() first`);
  }
  return project.id;
}

async function mintIngestToken(orgId: string, projectId: string): Promise<string> {
  const minted = mintToken();
  const secret = minted.token.split('_')[2] ?? '';
  await prisma.apiToken.create({
    data: {
      orgId,
      projectId,
      name: 'e2e-fixture',
      prefix: minted.prefix,
      tokenHash: await hashToken(secret),
      scopes: ['ingest', 'read'],
    },
  });
  return minted.token;
}

// Built once, lazily, and reused by every seed that ingests real data —
// mirrors apps/api/test/session-auth.integration.test.ts's module-scope
// `bundle`. Building the tarball is cheap; it is the ingest pipeline
// (parsing + the statistics engine) that costs the ~51s the brief warns
// about, so this only saves redundant tar-ing, not that cost — see
// ingestAndProcess below and its callers' own beforeAll-only usage.
const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);
let bundlePromise: Promise<Buffer> | null = null;
function loadBundle(): Promise<Buffer> {
  bundlePromise ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-bundle-'));
    const results = join(dir, 'run-1');
    mkdirSync(results, { recursive: true });
    copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
    const out = join(dir, 'bundle.tgz');
    execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
    return readFileSync(out);
  })();
  return bundlePromise;
}

/**
 * Posts the real reference bundle to the RUNNING server over plain HTTP —
 * not through an in-process Nest app; there is no such thing here, only the
 * process playwright.config.ts's webServer started — then runs the ingest
 * pipeline directly against the same database. Mirrors
 * session-auth.integration.test.ts's ingestFullRun exactly in intent: no
 * worker process is running anywhere in this stack (docker-compose only
 * brings up Postgres/Redis/MinIO), so without this direct call the run
 * would sit at 'pending' forever, waiting for a consumer that doesn't exist.
 */
async function ingestAndProcess(token: string): Promise<string> {
  const bundle = await loadBundle();
  const form = new FormData();
  form.set('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }));
  form.set('bundle', new Blob([new Uint8Array(bundle)]), 'bundle.tgz');

  const res = await fetch(`${BASE_URL}/v1/runs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (res.status !== 202) {
    throw new Error(`POST /v1/runs expected 202, got ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };

  const pipeline = new PipelineService(workerConfig, prisma, pool, blobs);
  await pipeline.process(body.id);
  return body.id;
}

/** A signed-up admin, its own fresh org, and the 'checkout' project every
 *  orgId-taking seed below ingests into. */
export async function seedAdmin(): Promise<{ email: string; password: string; orgId: string }> {
  const email = `${unique('admin')}@example.test`;
  const signUp = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Admin' } });
  const { orgId } = await createOrgAndProject();
  await orgMembers.add(signUp.user.id, orgId, 'admin');
  return { email, password: PASSWORD, orgId };
}

/** A signed-up user with NO org_member row — Task 5's 403-after-login case. */
export async function seedUserWithoutOrg(): Promise<{ email: string; password: string }> {
  const email = `${unique('orphan')}@example.test`;
  await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Orphan' } });
  return { email, password: PASSWORD };
}

/** An admin of an org that never gets a run — Task 6's empty-state case.
 *  A separate org from seedAdmin()'s, not merely a separate user in the
 *  same one: this org's project must stay run-less for the whole test. */
export async function seedAdminForEmptyOrg(): Promise<{ email: string; password: string }> {
  const email = `${unique('empty-admin')}@example.test`;
  const signUp = await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: 'Empty Org Admin' },
  });
  const { orgId } = await createOrgAndProject();
  await orgMembers.add(signUp.user.id, orgId, 'admin');
  return { email, password: PASSWORD };
}

/** A real, fully-ingested run — real stats/series/distribution/scatter data,
 *  not a bare stub row — in orgId's own project. */
export async function seedRunWithData(orgId: string): Promise<string> {
  const projectId = await projectFor(orgId);
  const token = await mintIngestToken(orgId, projectId);
  return ingestAndProcess(token);
}

/** A real ingested run with one SLA rule that CANNOT be evaluated against
 *  it — Task 7. Mirrors apps/api/test/verdict.integration.test.ts:140-158:
 *  a rule scoped to a request name the reference bundle never produces
 *  evaluates to not_applicable, never a pass, because there is nothing for
 *  it to compare against. */
export async function seedRunWithNaAssertion(orgId: string): Promise<string> {
  const projectId = await projectFor(orgId);
  await prisma.slaRule.create({
    data: {
      orgId,
      projectId,
      scope: 'request',
      targetName: 'GET /nonexistent',
      family: 'response_time',
      metric: 'p95',
      comparator: 'lte',
      threshold: 10,
    },
  });
  const token = await mintIngestToken(orgId, projectId);
  return ingestAndProcess(token);
}

/** A run row that stays 'pending' — created directly via Prisma, never
 *  posted through HTTP and never handed to PipelineService.process(), so
 *  there is nothing to wait or sleep on: no worker will ever pick it up. */
export async function seedPendingRun(orgId: string): Promise<string> {
  const projectId = await projectFor(orgId);
  const run = await prisma.run.create({
    data: {
      orgId,
      projectId,
      status: 'pending',
      tool: 'gatling',
      bundleKey: `e2e-fixture/${randomUUID()}`,
      bundleSha256: '0'.repeat(64),
      bundleBytes: BigInt(1),
      startedAt: new Date(),
      startedOn: new Date(),
      engineOptions: {},
    },
  });
  return run.id;
}

/** A real, fully-ingested run in a BRAND NEW org the caller has no
 *  membership in — Task 7's cross-org case. */
export async function seedRunInOtherOrg(): Promise<string> {
  const { orgId, projectId } = await createOrgAndProject();
  const token = await mintIngestToken(orgId, projectId);
  return ingestAndProcess(token);
}
