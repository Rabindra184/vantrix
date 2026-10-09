// Must be the first import: decorator metadata (design:paramtypes) is
// recorded by Reflect.metadata as each decorated class module is evaluated,
// which happens as soon as AppModule below pulls them in. Without this
// polyfilled first, Reflect.metadata does not exist yet, decoration becomes
// a silent no-op, and Nest reports a clean boot while injecting undefined —
// the same failure mode the F-2 finding describes, triggered by the test
// harness's import order rather than a compiler flag. main.ts does the same
// for the production entry point.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { INestApplication, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { mountBetterAuth } from '../../src/auth/mount-better-auth.js';
import { AppModule } from '../../src/app.module.js';
import { ProblemFilter } from '../../src/common/problem.filter.js';
import { mountOpenApi } from '../../src/openapi.js';
import { mountSecurityHeaders } from '../../src/security-headers.js';
import { mountSpa } from '../../src/spa.js';
import { hashToken, mintToken } from '@perfportal/core';
import { SCHEMA_TABLES } from '@perfportal/persistence';
import { listenNestOnLoopback } from './loopback.js';

const FIXTURE_WEB_DIST = resolve(import.meta.dirname, '../fixtures/web-dist');

export interface TestContext {
  app: INestApplication;
  prisma: PrismaClient;
  pool: pg.Pool;
  orgId: string;
  projectId: string;
  ingestToken: string;
  readToken: string;
  telemetryToken: string;
  streamToken: string;
  close(): Promise<void>;
}

/**
 * DERIVED FROM `SCHEMA_TABLES`, NEVER HAND-MAINTAINED.
 *
 * This was a literal list, and it had already drifted: `run_error_bucket`
 * (migration 20260815180000) was added to `SCHEMA_TABLES` and never here, so
 * `packages/persistence`'s suite cleared it and this one did not. That table
 * declares no foreign key to `run` — partitioned tables here don't — so
 * `TRUNCATE "run" … CASCADE` never reached it either, and its rows
 * accumulated across every createTestApp() call for a whole integration run.
 *
 * Latent rather than fatal, which is exactly why it survived: each call makes
 * a fresh org and project with random ids, and every error-series query is
 * scoped by (run_started_on, run_id, org_id, project_id), so stale rows never
 * matched a new test's run. It becomes real cross-test contamination the
 * moment a test reuses an org or queries that table without full run scoping.
 *
 * ORDER IS IRRELEVANT, so there is nothing lost by taking `SCHEMA_TABLES`'
 * ordering rather than the children-before-parents ordering this list used to
 * spell out. One `TRUNCATE a, b, c CASCADE` empties every named table in a
 * single operation; it is not a sequence of statements, so no table can be
 * "truncated too early" relative to a table that references it. Verified
 * against this Postgres by truncating a parent and its child with the PARENT
 * NAMED FIRST — both emptied, no error.
 */
const TABLES = SCHEMA_TABLES;

export async function createTestApp(
  settings: Record<string, unknown> = {},
  /** Test-only controllers mounted beside the app's own — for a case that has
   *  to drive a route shape no real route carries yet. Global guards, the auth
   *  middleware and the problem filter apply to them exactly as to the rest. */
  extraControllers: Type[] = [],
  /** Providers replaced by value before the app compiles — for a case that
   *  needs a setting production fixes, such as a longer throttle window than
   *  a loaded machine can be trusted to fit its requests into. */
  overrides: ReadonlyArray<{ provide: unknown; useValue: unknown }> = [],
): Promise<TestContext> {
  let builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  });
  for (const { provide, useValue } of overrides) builder = builder.overrideProvider(provide).useValue(useValue);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();

  // Same order as main.ts, and shared with it for the same reason
  // mountBetterAuth is: a header sent only in production, or only under
  // test, fails invisibly — no test would catch it either way.
  mountSecurityHeaders(app.getHttpAdapter().getInstance(), FIXTURE_WEB_DIST);
  mountBetterAuth(app);
  mountSpa(app.getHttpAdapter().getInstance(), FIXTURE_WEB_DIST);

  app.useGlobalFilters(new ProblemFilter());
  mountOpenApi(app);
  // LISTENING, on 127.0.0.1, before anything else: supertest then reuses this
  // server rather than calling `listen(0)` on the wildcard address per
  // request, which can share a port another process holds on 127.0.0.1 and
  // hand it the request — the `501 {}` CLAUDE.md long blamed on load. See
  // ./loopback.ts. `listen` runs `init()` itself; `app.close()` stops it.
  await listenNestOnLoopback(app);

  const prisma = app.get(PrismaClient);
  const pool = app.get(pg.Pool);

  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);

  const org = await prisma.org.create({ data: { slug: `org-${randomUUID().slice(0, 8)}`, name: 'Test' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: settings as object },
  });

  const ing = mintToken();
  await prisma.apiToken.create({
    data: {
      orgId: org.id, projectId: project.id, name: 'ci',
      prefix: ing.prefix, tokenHash: await hashToken(splitSecret(ing.token)),
      scopes: ['ingest', 'read'],
    },
  });

  const rd = mintToken();
  await prisma.apiToken.create({
    data: {
      orgId: org.id, projectId: project.id, name: 'reader',
      prefix: rd.prefix, tokenHash: await hashToken(splitSecret(rd.token)),
      scopes: ['read'],
    },
  });

  const tel = mintToken();
  await prisma.apiToken.create({
    data: {
      orgId: org.id, projectId: project.id, name: 'agent',
      prefix: tel.prefix, tokenHash: await hashToken(splitSecret(tel.token)),
      scopes: ['telemetry'],
    },
  });

  const strm = mintToken();
  await prisma.apiToken.create({
    data: {
      orgId: org.id, projectId: project.id, name: 'streamer',
      prefix: strm.prefix, tokenHash: await hashToken(splitSecret(strm.token)),
      scopes: ['stream'],
    },
  });

  // close() has always been safe to call twice and several suites rely on
  // that: auth.integration.test.ts closes `ctx` in an afterEach that also
  // runs after tests which never replaced it. app.close() tolerates the
  // repeat; pool.end() does not, and throws "Called end on pool more than
  // once". Idempotence is what lets disposal be added without rewriting
  // every caller's lifecycle.
  //
  // A boolean set before the awaits would be worse than none: it is already
  // true while cleanup runs, so a failure part-way leaves the remaining
  // resources undisposed AND every retry a no-op. Holding the in-flight
  // promise instead means callers share one cleanup and each disposer runs
  // even when an earlier one throws, with the failure surfacing afterwards.
  let closing: Promise<void> | undefined;

  return {
    app,
    prisma,
    pool,
    orgId: org.id,
    projectId: project.id,
    ingestToken: ing.token,
    readToken: rd.token,
    telemetryToken: tel.token,
    streamToken: strm.token,
    async close() {
      // app.close() disposes what Nest owns the lifecycle of — providers
      // implementing OnModuleDestroy, like IngestQueue and TerminalWaiter.
      // It CANNOT dispose these two: both are supplied by a useFactory that
      // returns a raw instance, so Nest holds no lifecycle hook for either,
      // and every createTestApp() call builds a fresh DI container and
      // therefore a fresh pool (max: 10) and a fresh PrismaClient.
      //
      // Closing only the app leaked both. Measured on read.integration.test.ts
      // (28 calls): backend connections climbed 13 -> 33 monotonically across
      // the file and dropped to 1 only when the worker process exited, which
      // was the sole thing reclaiming them. It stayed under max_connections
      // (100) because vitest forks per file, so the count resets at each file
      // boundary — the leak was bounded by luck, not by design.
      closing ??= (async () => {
        try {
          await app.close();
        } finally {
          try {
            await pool.end();
          } finally {
            await prisma.$disconnect();
          }
        }
      })();
      await closing;
    },
  };
}

function splitSecret(token: string): string {
  const parts = token.split('_');
  return parts[2] ?? '';
}
