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

/**
 * Two projects in one org, a run in each, plus a second org entirely — the
 * fixture every "session scope may cross projects but never orgs" test
 * shares below.
 */
async function seedTwoProjectsPlusOtherOrg() {
  const { orgId, a: projectA, b: projectB } = await seed();
  const repo = new RunRepository(prisma);
  const runInA = (await repo.create(runInput(orgId, projectA))).id;
  const runInB = (await repo.create(runInput(orgId, projectB))).id;
  const otherOrg = await prisma.org.create({ data: { slug: 'other', name: 'Other Org' } });
  return { orgId, projectA, projectB, runInA, runInB, otherOrgId: otherOrg.id };
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

describe('RunRepository.list — optional projectId (session vs token scope)', () => {
  it('scoped to a project, lists only that project\'s runs', async () => {
    const { orgId, projectA, runInA, runInB } = await seedTwoProjectsPlusOtherOrg();
    const repo = new RunRepository(prisma);
    const { items } = await repo.list({ orgId, projectId: projectA }, { limit: 10 });
    expect(items.map((r) => r.id)).toEqual([runInA]);
    expect(items.some((r) => r.id === runInB)).toBe(false);
  });

  // A session is org-scoped: listing must surface every project's runs, not
  // silently come back empty because no project_id was supplied.
  it('scoped to an org only, lists runs from every project in that org', async () => {
    const { orgId, runInA, runInB } = await seedTwoProjectsPlusOtherOrg();
    const repo = new RunRepository(prisma);
    const { items } = await repo.list({ orgId }, { limit: 10 });
    expect(items.map((r) => r.id).sort()).toEqual([runInA, runInB].sort());
  });

  it('paginates by cursor under an org-only scope, across both projects', async () => {
    const { orgId, runInA, runInB } = await seedTwoProjectsPlusOtherOrg();
    const repo = new RunRepository(prisma);

    const first = await repo.list({ orgId }, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = await repo.list({ orgId }, { limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);

    const seen = [first.items[0]?.id, second.items[0]?.id].sort();
    expect(seen).toEqual([runInA, runInB].sort());
  });

  it('filters by status, verdict, and searchable run metadata', async () => {
    const { orgId, a, b } = await seed();
    const repo = new RunRepository(prisma);
    const checkout = await repo.create(runInput(orgId, a, { branch: 'main' }));
    const catalog = await repo.create(runInput(orgId, b, { branch: 'release/search' }));

    await prisma.run.update({
      where: { id: checkout.id },
      data: { status: 'complete', verdict: 'failed', simulation: 'CheckoutSimulation' },
    });
    await prisma.run.update({
      where: { id: catalog.id },
      data: { status: 'running', verdict: null, simulation: 'CatalogSimulation' },
    });

    await expect(repo.list({ orgId }, { limit: 10, status: 'complete' })).resolves.toMatchObject({
      items: [{ id: checkout.id }],
    });
    await expect(repo.list({ orgId }, { limit: 10, verdict: 'none' })).resolves.toMatchObject({
      items: [{ id: catalog.id }],
    });
    await expect(repo.list({ orgId }, { limit: 10, q: 'catalog' })).resolves.toMatchObject({
      items: [{ id: catalog.id }],
    });
    await expect(repo.list({ orgId }, { limit: 10, q: 'release/search' })).resolves.toMatchObject({
      items: [{ id: catalog.id }],
    });
  });

  /**
   * THE RUN ID IS MATCHED BY PREFIX, NOT ANYWHERE IN THE STRING.
   *
   * Folded into the same contains-anywhere OR as simulation and branch, a
   * uuid makes every short query match almost everything: `%3%` is in nearly
   * every uuid ever generated, so a reader narrowing to a branch containing
   * `3` got their whole org back. The prefix is the useful half anyway —
   * `RunList` renders `id.slice(0, 8)` as a run's fallback name, so the
   * prefix is exactly the string a reader has on screen to copy.
   *
   * Both directions, and the negative one derived rather than assumed: the
   * single hex character asserted on is READ OFF the id being searched for,
   * so this cannot go stale against a re-seeded fixture.
   */
  it('matches a run id by prefix, and does not match one anywhere in the middle', async () => {
    const { orgId, a, b } = await seed();
    const repo = new RunRepository(prisma);
    const target = await repo.create(runInput(orgId, a, { branch: 'main' }));
    const other = await repo.create(runInput(orgId, b, { branch: 'other' }));

    const prefix = target.id.slice(0, 8);
    await expect(repo.list({ orgId }, { limit: 10, q: prefix })).resolves.toMatchObject({
      items: [{ id: target.id }],
    });

    // A single character out of the target's own id. Under substring
    // matching this returned both runs — a uuid pair almost always shares
    // every hex digit — and under prefix matching it is not an id query at
    // all (too short to be one), so it matches on nothing.
    const oneChar = target.id[14]!;
    const noisy = await repo.list({ orgId }, { limit: 10, q: oneChar });
    expect(noisy.items).toHaveLength(0);

    // The guard that keeps the negative meaningful: both runs really are in
    // this org and reachable with no query at all.
    const all = await repo.list({ orgId }, { limit: 10 });
    expect(all.items.map((r) => r.id).sort()).toEqual([target.id, other.id].sort());
  });

  it('finds a run by its project name as well as by its own columns', async () => {
    const { orgId, a, b } = await seed();
    const repo = new RunRepository(prisma);
    const inA = await repo.create(runInput(orgId, a, { branch: 'main' }));
    await repo.create(runInput(orgId, b, { branch: 'main' }));

    // The project match is resolved by a SEPARATE query and applied as
    // `project_id = ANY(...)` (see `projectIdsMatching`), so this is the case
    // that proves lifting it out of the join did not lose the capability.
    const project = await prisma.project.findUniqueOrThrow({ where: { id: a } });
    const { items } = await repo.list({ orgId }, { limit: 10, q: project.name });
    expect(items.map((r) => r.id)).toContain(inA.id);
  });

  /**
   * THE PLAN, NOT JUST THE ROWS — the same reason the series suite asserts
   * partition pruning.
   *
   * Every correctness case above passes just as well against a sequential
   * scan, so nothing else here can tell a working index from a decorative
   * one. Two real changes have already made these indexes unreachable while
   * every row assertion stayed green: wrapping a column in `COALESCE(col,
   * '')`, and matching the project through the JOIN so the OR spanned two
   * tables (PostgreSQL cannot BitmapOr a branch on a joined table, and one
   * such branch costs every other branch its index too).
   *
   * `enable_seqscan = off` does not fake the result. It removes the planner's
   * preference for a scan on a table too small to have one — the indexes must
   * still be USABLE for the plan to mention them at all, and an expression
   * the index cannot serve still plans as `Seq Scan` with seqscan disabled,
   * which is exactly what the COALESCE version did.
   */
  it('can serve the search from its trigram indexes, not a sequential scan', async () => {
    const { orgId, a } = await seed();
    const repo = new RunRepository(prisma);
    await repo.create(runInput(orgId, a, { branch: 'release/search-plan' }));

    // Same predicate shape `list()` builds, spelled here against the same
    // columns so a change to one is visible as a failure in the other.
    // `SET LOCAL` inside a transaction, never a bare `SET`: Prisma hands out
    // a POOLED connection, so a bare one would leave seqscan disabled on it
    // for whichever unrelated test drew that connection next — a leak of
    // exactly the shape `TZ` already caused in the trends suite. `SET LOCAL`
    // reverts at commit.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN (COSTS OFF)
       SELECT r.id FROM run r
        WHERE r.org_id = $1::uuid
          AND (r.simulation ILIKE $2 ESCAPE '\\'
            OR r.description ILIKE $2 ESCAPE '\\'
            OR r.environment ILIKE $2 ESCAPE '\\'
            OR r.branch ILIKE $2 ESCAPE '\\'
            OR r.commit_sha ILIKE $2 ESCAPE '\\')`,
        orgId,
        '%search-plan%',
      );
    });
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');

    // Guard first: EXPLAIN really did return a plan, so the assertions below
    // are about its contents and not about an empty string.
    expect(text.length).toBeGreaterThan(0);
    for (const index of [
      'run_simulation_trgm',
      'run_description_trgm',
      'run_environment_trgm',
      'run_branch_trgm',
      'run_commit_sha_trgm',
    ]) {
      expect(text, `${index} is not reachable by the search predicate`).toContain(index);
    }
    expect(text).toContain('BitmapOr');
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
