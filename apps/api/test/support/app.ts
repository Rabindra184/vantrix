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
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { AppModule } from '../../src/app.module.js';
import { ProblemFilter } from '../../src/common/problem.filter.js';
import { hashToken, mintToken } from '../../src/auth/tokens.js';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaClient;
  pool: pg.Pool;
  orgId: string;
  projectId: string;
  ingestToken: string;
  readToken: string;
  close(): Promise<void>;
}

const TABLES = [
  'run_assertion', 'run_error', 'run_series_bucket', 'run_stat',
  'run', 'sla_rule', 'api_token', 'project', 'org',
];

export async function createTestApp(
  settings: Record<string, unknown> = {},
): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ProblemFilter());
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

  return {
    app,
    prisma,
    pool,
    orgId: org.id,
    projectId: project.id,
    ingestToken: ing.token,
    readToken: rd.token,
    async close() {
      await app.close();
    },
  };
}

function splitSecret(token: string): string {
  const parts = token.split('_');
  return parts[2] ?? '';
}
