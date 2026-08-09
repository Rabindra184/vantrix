import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  createPrisma,
  ProjectRepository,
  RunRepository,
  TokenRepository,
} from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

async function seed() {
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const p1 = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const p2 = await prisma.project.create({
    data: { orgId: org.id, slug: 'search', name: 'Search', settings: {} },
  });
  return { orgId: org.id, a: p1.id, b: p2.id };
}

function runInput(orgId: string, projectId: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    orgId,
    projectId,
    tool: 'gatling',
    bundleKey: 'bundles/x.tgz',
    bundleSha256: 'a'.repeat(64),
    bundleBytes: 1234,
    startedAt: new Date('2026-08-07T10:00:00Z'),
    engineOptions: { warmupMs: 0, percentiles: [50, 95] },
    ...over,
  };
}

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('RunRepository tenancy', () => {
  it('will not return a run belonging to another project', async () => {
    const { orgId, a, b } = await seed();
    const run = await new RunRepository(prisma).create(runInput(orgId, a));

    const repo = new RunRepository(prisma);
    expect(await repo.findById({ orgId, projectId: a }, run.id)).not.toBeNull();
    expect(await repo.findById({ orgId, projectId: b }, run.id)).toBeNull();
  });

  it('derives startedOn from startedAt so the partition key is never wrong', async () => {
    const { orgId, a } = await seed();
    const run = await new RunRepository(prisma).create(
      runInput(orgId, a, { startedAt: new Date('2026-03-14T23:59:59Z') }),
    );
    expect(run.startedOn.toISOString().slice(0, 10)).toBe('2026-03-14');
  });
});

describe('RunRepository tenancy — optional projectId (session vs token scope)', () => {
  async function seedTwoProjectsPlusOtherOrg() {
    const { orgId, a: projectA, b: projectB } = await seed();
    const repo = new RunRepository(prisma);
    const runInA = (await repo.create(runInput(orgId, projectA))).id;
    const runInB = (await repo.create(runInput(orgId, projectB))).id;
    const otherOrg = await prisma.org.create({ data: { slug: 'other', name: 'Other Org' } });
    return { orgId, projectA, projectB, runInA, runInB, otherOrgId: otherOrg.id };
  }

  it('scoped to a project, finds only that project\'s run', async () => {
    const { orgId, projectA, runInA, runInB } = await seedTwoProjectsPlusOtherOrg();
    const repo = new RunRepository(prisma);
    expect(await repo.findById({ orgId, projectId: projectA }, runInA)).not.toBeNull();
    expect(await repo.findById({ orgId, projectId: projectA }, runInB)).toBeNull();
  });

  // A session is org-scoped: it may read any run in its org.
  it('scoped to an org only, finds runs in every project of that org', async () => {
    const { orgId, runInA, runInB } = await seedTwoProjectsPlusOtherOrg();
    const repo = new RunRepository(prisma);
    expect(await repo.findById({ orgId }, runInA)).not.toBeNull();
    expect(await repo.findById({ orgId }, runInB)).not.toBeNull();
  });

  // The assertion whose failure is a security bug.
  it('never crosses an org boundary, with or without a project', async () => {
    const { projectA, runInA, otherOrgId } = await seedTwoProjectsPlusOtherOrg();
    const repo = new RunRepository(prisma);
    expect(await repo.findById({ orgId: otherOrgId }, runInA)).toBeNull();
    expect(await repo.findById({ orgId: otherOrgId, projectId: projectA }, runInA)).toBeNull();
  });
});

describe('RunRepository idempotency', () => {
  it('returns the original run for a repeated key instead of creating a second', async () => {
    const { orgId, a } = await seed();
    const repo = new RunRepository(prisma);
    const first = await repo.create(runInput(orgId, a, { idempotencyKey: 'build-42' }));

    const found = await repo.findByIdempotencyKey({ orgId, projectId: a }, 'build-42');
    expect(found?.id).toBe(first.id);
  });

  it('scopes idempotency to the project — the same key in another project is a new run', async () => {
    const { orgId, a, b } = await seed();
    const repo = new RunRepository(prisma);
    await repo.create(runInput(orgId, a, { idempotencyKey: 'build-42' }));
    const other = await repo.create(runInput(orgId, b, { idempotencyKey: 'build-42' }));
    expect(other.id).toBeTruthy();
    expect(await repo.findByIdempotencyKey({ orgId, projectId: b }, 'build-42')).not.toBeNull();
  });
});

describe('ProjectRepository', () => {
  it('resolves a project by org and project slug', async () => {
    await seed();
    const found = await new ProjectRepository(prisma).findBySlug('acme', 'checkout');
    expect(found?.slug).toBe('checkout');
  });

  it('returns null for a project in an org that does not own it', async () => {
    await seed();
    expect(await new ProjectRepository(prisma).findBySlug('nope', 'checkout')).toBeNull();
  });
});

describe('TokenRepository', () => {
  it('finds an active token by prefix and reports a revoked one as revoked', async () => {
    const { orgId, a } = await seed();
    await prisma.apiToken.create({
      data: {
        orgId,
        projectId: a,
        name: 'ci',
        prefix: 'pp_live_abc',
        tokenHash: 'hash',
        scopes: ['ingest'],
      },
    });
    const repo = new TokenRepository(prisma);
    const t = await repo.findByPrefix('pp_live_abc');
    expect(t?.scopes).toEqual(['ingest']);
    expect(t?.revokedAt).toBeNull();
    expect(await repo.findByPrefix('pp_live_missing')).toBeNull();
  });
});
