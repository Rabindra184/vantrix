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
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { mountBetterAuth } from '../../src/auth/mount-better-auth.js';
import { AppModule } from '../../src/app.module.js';
import { ProblemFilter } from '../../src/common/problem.filter.js';
import { mountOpenApi } from '../../src/openapi.js';
import { mountSpa } from '../../src/spa.js';
import { hashToken, mintToken } from '@perfportal/core';
import { SCHEMA_TABLES } from '@perfportal/persistence';

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
): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();

  mountBetterAuth(app);
  mountSpa(app.getHttpAdapter().getInstance(), FIXTURE_WEB_DIST);

  app.useGlobalFilters(new ProblemFilter());
  mountOpenApi(app);
  await app.init();

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

  return {
    app,
    prisma,
    pool,
    orgId: org.id,
    projectId: project.id,
    ingestToken: ing.token,
    readToken: rd.token,
    telemetryToken: tel.token,
    async close() {
      await app.close();
    },
  };
}

function splitSecret(token: string): string {
  const parts = token.split('_');
  return parts[2] ?? '';
}
