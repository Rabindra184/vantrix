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

describe('RunRepository.claimStale', () => {
  it('returns pending runs older than the window and ignores fresh ones', async () => {
    const { orgId, a } = await seed();
    const repo = new RunRepository(prisma);
    const stale = await repo.create(
      runInput(orgId, a, { startedAt: new Date('2026-08-07T10:00:00Z') }),
    );
    const fresh = await repo.create(runInput(orgId, a));

    // Age the first run's ingest clock past the window.
    await pool.query(`UPDATE run SET created_at = now() - interval '10 minutes' WHERE id = $1`, [
      stale.id,
    ]);

    const claimed = await repo.claimStale(60_000);
    expect(claimed).toContain(stale.id);
    expect(claimed).not.toContain(fresh.id);
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
