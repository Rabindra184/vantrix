import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createPrisma, OrgMemberRepository } from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

async function seedOrg() {
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  return { orgId: org.id };
}

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('OrgMemberRepository', () => {
  it('returns null for a user with no membership', async () => {
    const repo = new OrgMemberRepository(prisma);
    expect(await repo.findOrgForUser('nobody')).toBeNull();
  });

  it('returns the org for a member', async () => {
    const { orgId } = await seedOrg();
    await prisma.user.create({ data: { id: 'u1', name: 'U1', email: 'u1@example.test' } });
    const repo = new OrgMemberRepository(prisma);
    await repo.add('u1', orgId);
    // Exactly the org: the membership carries no role of its own any more.
    // Admin is a flag on the account and a project role is a project_member
    // row, so a `role` key here would be a second place to read either from.
    expect(await repo.findOrgForUser('u1')).toStrictEqual({ orgId });
  });

  it('returns the requested user\'s own membership, not just any row in the table', async () => {
    const org1 = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
    const org2 = await prisma.org.create({ data: { slug: 'globex', name: 'Globex' } });
    await prisma.user.create({ data: { id: 'u1', name: 'U1', email: 'u1@example.test' } });
    await prisma.user.create({ data: { id: 'u2', name: 'U2', email: 'u2@example.test' } });
    const repo = new OrgMemberRepository(prisma);
    await repo.add('u1', org1.id);
    await repo.add('u2', org2.id);

    expect(await repo.findOrgForUser('u1')).toStrictEqual({ orgId: org1.id });
    expect(await repo.findOrgForUser('u2')).toStrictEqual({ orgId: org2.id });
  });
});
