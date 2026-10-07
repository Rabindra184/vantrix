import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createPrisma, ProjectMemberRepository } from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

let projectId = '';
let otherProjectId = '';

beforeEach(async () => {
  await resetDatabase(pool);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  projectId = (await prisma.project.create({ data: { orgId: org.id, slug: 'checkout', name: 'Checkout' } })).id;
  otherProjectId = (await prisma.project.create({ data: { orgId: org.id, slug: 'search', name: 'Search' } })).id;
  await prisma.user.create({ data: { id: 'u1', name: 'U1', email: 'u1@example.test' } });
  await prisma.user.create({ data: { id: 'u2', name: 'U2', email: 'u2@example.test' } });
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('ProjectMemberRepository', () => {
  it('reads back the role a membership was added with, keyed by project', async () => {
    const repo = new ProjectMemberRepository(prisma);
    await repo.add({ projectId, userId: 'u1', role: 'member', addedBy: null });
    expect(await repo.rolesForUser('u1')).toEqual(new Map([[projectId, 'member']]));
  });

  it("returns the requested user's memberships and no one else's", async () => {
    const repo = new ProjectMemberRepository(prisma);
    await repo.add({ projectId, userId: 'u1', role: 'viewer', addedBy: null });
    await repo.add({ projectId: otherProjectId, userId: 'u1', role: 'manager', addedBy: 'u2' });
    await repo.add({ projectId, userId: 'u2', role: 'manager', addedBy: null });

    expect(await repo.rolesForUser('u1')).toEqual(
      new Map([
        [projectId, 'viewer'],
        [otherProjectId, 'manager'],
      ]),
    );
    expect(await repo.rolesForUser('nobody')).toEqual(new Map());
  });

  it('refuses a second membership for the same person in the same project', async () => {
    const repo = new ProjectMemberRepository(prisma);
    await repo.add({ projectId, userId: 'u1', role: 'member', addedBy: null });
    // P2002, the primary key: refused for being a duplicate, not for any
    // other reason a bare `toThrow()` would also accept.
    await expect(repo.add({ projectId, userId: 'u1', role: 'viewer', addedBy: null })).rejects.toMatchObject({
      code: 'P2002',
    });
    // The refused write changed nothing: the first role stands.
    expect(await repo.rolesForUser('u1')).toEqual(new Map([[projectId, 'member']]));
  });

  it('removes a membership, and only that one', async () => {
    const repo = new ProjectMemberRepository(prisma);
    await repo.add({ projectId, userId: 'u1', role: 'member', addedBy: null });
    await repo.add({ projectId: otherProjectId, userId: 'u1', role: 'viewer', addedBy: null });
    await repo.remove(projectId, 'u1');
    expect(await repo.rolesForUser('u1')).toEqual(new Map([[otherProjectId, 'viewer']]));
  });

  it("goes with the project when the project is deleted", async () => {
    const repo = new ProjectMemberRepository(prisma);
    await repo.add({ projectId, userId: 'u1', role: 'member', addedBy: null });
    await prisma.project.delete({ where: { id: projectId } });
    expect(await repo.rolesForUser('u1')).toEqual(new Map());
  });

  it('goes with the user when the user is deleted, and forgets who added it when they go', async () => {
    const repo = new ProjectMemberRepository(prisma);
    await repo.add({ projectId, userId: 'u1', role: 'member', addedBy: 'u2' });
    await prisma.user.delete({ where: { id: 'u2' } });
    // The membership survives the person who granted it; only the pointer goes.
    const after = await pool.query<{ added_by: string | null }>(
      `SELECT added_by FROM project_member WHERE project_id = $1 AND user_id = 'u1'`,
      [projectId],
    );
    expect(after.rows).toEqual([{ added_by: null }]);

    await prisma.user.delete({ where: { id: 'u1' } });
    const { rows } = await pool.query(`SELECT 1 FROM project_member`);
    expect(rows).toHaveLength(0);
  });

  it('is refused by the database for a role outside the three', async () => {
    // Raw SQL, because the repository's own type would not let the value
    // reach the database: the CHECK is what stands behind every other writer.
    await expect(
      pool.query(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, 'u1', 'admin')`, [projectId]),
    ).rejects.toThrow(/project_member_role_check/);
  });
});
