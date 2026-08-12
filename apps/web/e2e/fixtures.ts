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

// DATABASE_URL points at the SAME Postgres apps/api/test/support/app.ts's
// createTestApp() uses. That helper TRUNCATEs all 15 tables on every single
// call (see app.ts:58) — so running `pnpm test:integration` concurrently
// with `pnpm test:e2e` against this database destroys every org/project/run
// this file just seeded, mid-assertion, for a completely unrelated suite.
// Never run them at the same time against the same DATABASE_URL.
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
 *  this rather than guessing a project slug.
 *
 *  `orderBy: createdAt asc` is load-bearing, not decorative: seedAdmin() and
 *  seedAdminForEmptyOrg() create exactly one project per org (via
 *  createOrgAndProject) at org-creation time, but seedRunWithNaAssertion
 *  below mints a SECOND, dedicated project in the same org, strictly later.
 *  Without a deterministic order, `findFirst` picks whichever project
 *  Postgres feels like returning, and every orgId-taking seed becomes
 *  order-dependent on which one ran first. */
async function projectFor(orgId: string): Promise<string> {
  const project = await prisma.project.findFirst({ where: { orgId }, orderBy: { createdAt: 'asc' } });
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

  // process() throws on a real ingest failure (PipelineService's #ingest
  // rethrows after recording it — see the comment above), so a caller who
  // reaches this point already knows nothing THREW. This is a belt-and-
  // suspenders check on top of that: a seed that returned a run id without
  // confirming the row itself says 'complete' could hand later tasks a
  // 'failed' or still-'pending' run dressed as real data, and every one of
  // the seven seeds ultimately calls through here.
  const finished = await prisma.run.findUnique({ where: { id: body.id } });
  if (finished?.status !== 'complete') {
    throw new Error(
      `ingestAndProcess: run ${body.id} did not reach 'complete' after the pipeline ran ` +
        `(status: ${finished?.status ?? 'MISSING ROW'}).`,
    );
  }
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

/**
 * A real ingested run with one SLA rule that CANNOT be evaluated against
 * it — Task 7. Mirrors apps/api/test/verdict.integration.test.ts:140-158: a
 * rule scoped to a request name the reference bundle never produces
 * evaluates to not_applicable, never a pass, because there is nothing for it
 * to compare against.
 *
 * Order-independent by construction: this mints its OWN dedicated project
 * inside orgId, rather than ingesting into the org's shared 'checkout'
 * project (via projectFor). `sla_rule` is scoped per-project, and
 * PipelineService applies every enabled rule in a project to every run
 * subsequently ingested into it — reusing the shared project would silently
 * attach this not_applicable rule to every later seedRunWithData(orgId) (or
 * seedPendingRun(orgId)) call against the same org, contaminating a run that
 * is supposed to have no rules at all. Callers may seed this before or
 * after any other orgId-taking seed, in either order, safely.
 */
export async function seedRunWithNaAssertion(orgId: string): Promise<string> {
  const project = await prisma.project.create({
    data: { orgId, slug: unique('na-assertion'), name: 'NA Assertion', settings: {} },
  });
  await prisma.slaRule.create({
    data: {
      orgId,
      projectId: project.id,
      scope: 'request',
      targetName: 'GET /nonexistent',
      family: 'response_time',
      metric: 'p95',
      comparator: 'lte',
      threshold: 10,
    },
  });
  const token = await mintIngestToken(orgId, project.id);
  const runId = await ingestAndProcess(token);

  // Post-condition: the whole point of this seed is a not_applicable
  // assertion, not merely a completed run — confirm the row exists rather
  // than trusting the rule shape silently kept producing one.
  const naAssertion = await prisma.runAssertion.findFirst({
    where: { runId, outcome: 'not_applicable' },
  });
  if (!naAssertion) {
    throw new Error(
      `seedRunWithNaAssertion: run ${runId} completed but has no not_applicable assertion — ` +
        'the SLA rule shape may no longer produce one (see verdict.integration.test.ts:140-158).',
    );
  }
  return runId;
}

/**
 * A real ingested run with one SLA rule it DEMONSTRABLY fails — Task 7's
 * 422 case, and the one the run detail page is most likely to regress on.
 *
 * `GET /v1/runs/:id` answers **422** for a complete run whose verdict is
 * 'failed' (RunsService.statusFor), and the body is a normal
 * `RunResponseSchema` run — NOT problem+json. A client that treats every
 * non-2xx as an error tells the reader their most important run is
 * unreadable. This seed is what makes that regression visible.
 *
 * The rule is scoped to the run itself with a 1ms p95 threshold. Run-scope
 * `response_time` statistics DO exist for the reference bundle (see
 * verdict.integration.test.ts's own run-scope p95 rule, which passes at
 * 100_000), so the rule is always applicable — never not_applicable — and
 * the bundle's p95 is orders of magnitude above one millisecond, so the
 * only outcome it can produce is 'failed'.
 *
 * Order-independent by construction, in exactly the way and for exactly the
 * reason seedRunWithNaAssertion above is: its OWN dedicated project inside
 * orgId, never the org's shared 'checkout' project. `sla_rule` is scoped
 * per-project and PipelineService applies every enabled rule in a project to
 * every run subsequently ingested into it, so sharing the project would
 * silently attach this always-failing rule to every later
 * seedRunWithData(orgId) call and turn a run that is supposed to have no
 * rules at all into a verdict-failed one.
 */
export async function seedRunWithFailedAssertion(orgId: string): Promise<string> {
  const project = await prisma.project.create({
    data: { orgId, slug: unique('failed-assertion'), name: 'Failed Assertion', settings: {} },
  });
  await prisma.slaRule.create({
    data: {
      orgId,
      projectId: project.id,
      scope: 'run',
      targetName: null,
      family: 'response_time',
      metric: 'p95',
      comparator: 'lte',
      threshold: 1,
    },
  });
  const token = await mintIngestToken(orgId, project.id);
  const runId = await ingestAndProcess(token);

  // Post-condition in TWO parts, because the two facts can come apart and
  // each is load-bearing for a different half of the test. Without them a
  // rule shape that quietly stopped producing a failure would seed a
  // perfectly ordinary 200 run, and the 422 test would go green having never
  // exercised 422 at all — the exact silent-pass this fixture exists to
  // prevent (same reasoning as seedRunWithNaAssertion's own post-condition).
  const failedAssertion = await prisma.runAssertion.findFirst({
    where: { runId, outcome: 'failed' },
  });
  if (!failedAssertion) {
    throw new Error(
      `seedRunWithFailedAssertion: run ${runId} completed but has no failed assertion — ` +
        'the SLA rule shape may no longer produce one (see verdict.integration.test.ts).',
    );
  }
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (run?.verdict !== 'failed') {
    throw new Error(
      `seedRunWithFailedAssertion: run ${runId} has a failed assertion but verdict ` +
        `'${run?.verdict ?? 'MISSING ROW'}' — GET /v1/runs/${runId} will not answer 422, ` +
        'so this fixture no longer exercises the case it exists for.',
    );
  }
  return runId;
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

/**
 * Run rows with caller-chosen timestamps, created directly via Prisma —
 * never posted through HTTP and never handed to PipelineService, so there is
 * nothing to wait on, exactly like seedPendingRun above.
 *
 * Task 6 needs ORDERING, not parsed metrics: the list is sorted by
 * COALESCE(tool_started_at, started_at) DESC (RunRepository.list), and the
 * only thing an ordering test can assert is that the rendered sequence agrees
 * with that expression. A real ingest per row would buy nothing here while
 * widening the failure surface of an ordering test to the whole pipeline —
 * parser, statistics engine and blob store included — so a red test would no
 * longer name its own cause.
 *
 * `toolStartedAt` is deliberately controllable and deliberately optional: a
 * row omitting it is a run the worker has not parsed yet, which is the case
 * the list's ingest-time fallback exists for. `startedOn` mirrors
 * `startedAt`'s date because it is that column's ingest-date partition key
 * (see schema.prisma) — never the tool's own date.
 *
 * ONE `prisma.run.createMany` for the whole batch, not one insert per row:
 * the pagination test seeds a full page plus one, and paying a round trip per
 * row would make a test about a button click cost twenty-six of them.
 */
export async function seedRunsAt(
  orgId: string,
  rows: ReadonlyArray<{ startedAt: Date; toolStartedAt?: Date | null }>,
): Promise<void> {
  const projectId = await projectFor(orgId);
  await prisma.run.createMany({
    data: rows.map((row) => ({
      orgId,
      projectId,
      status: 'pending',
      tool: 'gatling',
      bundleKey: `e2e-fixture/${randomUUID()}`,
      bundleSha256: '0'.repeat(64),
      bundleBytes: BigInt(1),
      startedAt: row.startedAt,
      startedOn: row.startedAt,
      toolStartedAt: row.toolStartedAt ?? null,
      engineOptions: {},
    })),
  });
}

/** A real, fully-ingested run in a BRAND NEW org the caller has no
 *  membership in — Task 7's cross-org case. */
export async function seedRunInOtherOrg(): Promise<string> {
  const { orgId, projectId } = await createOrgAndProject();
  const token = await mintIngestToken(orgId, projectId);
  return ingestAndProcess(token);
}
