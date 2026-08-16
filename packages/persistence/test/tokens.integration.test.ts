import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createPrisma, TokenRepository } from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);
const tokens = new TokenRepository(prisma);

/** A fresh org + project this test's tokens belong to. */
async function seedOrg() {
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  return { org, project };
}

/**
 * A SECOND org, distinct from the one under test, for the cross-tenant cases.
 * Follows apps/api/test/error-series.integration.test.ts:177 — the tenancy
 * bug this guards against is scoping by project alone and forgetting org, so
 * the fixture must vary org, not just project.
 */
async function seedOtherOrg() {
  const otherOrg = await prisma.org.create({ data: { slug: 'other', name: 'Other' } });
  const otherProject = await prisma.project.create({
    data: { orgId: otherOrg.id, slug: 'p', name: 'P', settings: {} },
  });
  return { orgId: otherOrg.id, projectId: otherProject.id };
}

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('TokenRepository writes', () => {
  it('creates a token and returns it without the hash', async () => {
    const { org, project } = await seedOrg();
    const created = await tokens.create({
      orgId: org.id, projectId: project.id,
      name: 'gen-1 agent', prefix: 'pp_abc123', tokenHash: 'HASH', scopes: ['telemetry'],
    });
    expect(created.prefix).toBe('pp_abc123');
    expect(created.name).toBe('gen-1 agent');
    expect(created.scopes).toEqual(['telemetry']);
    expect(created.revokedAt).toBeNull();
    // The hash must never leave this layer.
    expect(Object.keys(created)).not.toContain('tokenHash');
  });

  it('lists only this project\'s tokens', async () => {
    const { org, project } = await seedOrg();
    const other = await seedOtherOrg();
    await tokens.create({ orgId: org.id, projectId: project.id, name: 'mine', prefix: 'pp_mine', tokenHash: 'H', scopes: ['read'] });
    await tokens.create({ orgId: other.orgId, projectId: other.projectId, name: 'theirs', prefix: 'pp_theirs', tokenHash: 'H', scopes: ['read'] });

    const listed = await tokens.listForProject(org.id, project.id);
    expect(listed.map((t) => t.prefix)).toEqual(['pp_mine']);
    expect(listed.some((t) => 'tokenHash' in t)).toBe(false);
  });

  it('revokes by prefix and is idempotent', async () => {
    const { org, project } = await seedOrg();
    await tokens.create({ orgId: org.id, projectId: project.id, name: 'x', prefix: 'pp_rev', tokenHash: 'H', scopes: ['read'] });

    const first = await tokens.revokeByPrefix(org.id, project.id, 'pp_rev');
    // Assert non-null FIRST, then compare non-optionally. `expect(x?.y).not
    // .toBeNull()` is vacuous when `x` itself is null: optional chaining
    // makes `x?.y` evaluate to `undefined`, and `undefined` is `.not.toBeNull()`
    // too — so that assertion passed even against a `revokeByPrefix` that
    // never wrote anything and always returned `null`.
    expect(first).not.toBeNull();
    expect(first!.revokedAt).toBeInstanceOf(Date);

    // A retried revoke returns the same answer rather than 404-ing, so a
    // caller retrying after a timeout is not told the token vanished.
    const second = await tokens.revokeByPrefix(org.id, project.id, 'pp_rev');
    expect(second).not.toBeNull();
    expect(second!.revokedAt!.getTime()).toBe(first!.revokedAt!.getTime());
  });

  it('will not revoke another project\'s token', async () => {
    const { org, project } = await seedOrg();
    const other = await seedOtherOrg();
    await tokens.create({ orgId: other.orgId, projectId: other.projectId, name: 'theirs', prefix: 'pp_theirs2', tokenHash: 'H', scopes: ['read'] });
    expect(await tokens.revokeByPrefix(org.id, project.id, 'pp_theirs2')).toBeNull();
  });

  it('returns null for an unknown prefix', async () => {
    const { org, project } = await seedOrg();
    expect(await tokens.revokeByPrefix(org.id, project.id, 'pp_nope')).toBeNull();
  });
});
