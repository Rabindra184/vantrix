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
    await repo.add('u1', orgId, 'admin');
    expect(await repo.findOrgForUser('u1')).toEqual({ orgId, role: 'admin' });
  });

  it('returns the requested user\'s own membership, not just any row in the table', async () => {
    const org1 = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
    const org2 = await prisma.org.create({ data: { slug: 'globex', name: 'Globex' } });
    await prisma.user.create({ data: { id: 'u1', name: 'U1', email: 'u1@example.test' } });
    await prisma.user.create({ data: { id: 'u2', name: 'U2', email: 'u2@example.test' } });
    const repo = new OrgMemberRepository(prisma);
    await repo.add('u1', org1.id, 'admin');
    await repo.add('u2', org2.id, 'member');

    expect(await repo.findOrgForUser('u1')).toEqual({ orgId: org1.id, role: 'admin' });
    expect(await repo.findOrgForUser('u2')).toEqual({ orgId: org2.id, role: 'member' });
  });
});
