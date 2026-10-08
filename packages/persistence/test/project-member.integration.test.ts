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

  it('removes a membership, and only that one, and says when there was none', async () => {
    const repo = new ProjectMemberRepository(prisma);
    await repo.add({ projectId, userId: 'u1', role: 'member', addedBy: null });
    await repo.add({ projectId: otherProjectId, userId: 'u1', role: 'viewer', addedBy: null });
    expect(await repo.remove(projectId, 'u1')).toBe(true);
    expect(await repo.rolesForUser('u1')).toEqual(new Map([[otherProjectId, 'viewer']]));
    // Gone now, and never there for u2: nothing to remove, and nothing else moved.
    expect(await repo.remove(projectId, 'u1')).toBe(false);
    expect(await repo.remove(projectId, 'u2')).toBe(false);
    expect(await repo.rolesForUser('u1')).toEqual(new Map([[otherProjectId, 'viewer']]));
  });

  it('finds one person’s membership of one project, as the list shows it, and null where there is none', async () => {
    const repo = new ProjectMemberRepository(prisma);
    await repo.add({ projectId, userId: 'u1', role: 'manager', addedBy: 'u2' });
    await repo.add({ projectId: otherProjectId, userId: 'u2', role: 'viewer', addedBy: null });

    const found = await repo.find(projectId, 'u1');
    expect(found).toEqual((await repo.listForProject(projectId))[0]);
    expect(found).toMatchObject({ userId: 'u1', name: 'U1', email: 'u1@example.test', role: 'manager' });
    // u2 holds a role, but in the other project; nobody holds none at all.
    expect(await repo.find(projectId, 'u2')).toBeNull();
    expect(await repo.find(projectId, 'nobody')).toBeNull();
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

  it("lists a project's members by name, with who they are and when they were added", async () => {
    const repo = new ProjectMemberRepository(prisma);
    await prisma.user.update({ where: { id: 'u1' }, data: { name: 'Zed' } });
    await prisma.user.update({ where: { id: 'u2' }, data: { name: 'Abe' } });
    await repo.add({ projectId, userId: 'u1', role: 'viewer', addedBy: null });
    await repo.add({ projectId, userId: 'u2', role: 'manager', addedBy: 'u1' });
    await repo.add({ projectId: otherProjectId, userId: 'u1', role: 'member', addedBy: null });

    const listed = await repo.listForProject(projectId);
    expect(listed.map((m) => ({ userId: m.userId, name: m.name, email: m.email, role: m.role }))).toEqual([
      { userId: 'u2', name: 'Abe', email: 'u2@example.test', role: 'manager' },
      { userId: 'u1', name: 'Zed', email: 'u1@example.test', role: 'viewer' },
    ]);
    // `created_at` is a timestamptz, so this is the row's own instant.
    const { rows } = await pool.query<{ created_at: Date }>(
      `SELECT created_at FROM project_member WHERE project_id = $1 AND user_id = 'u2'`,
      [projectId],
    );
    expect(listed[0]!.addedAt.toISOString()).toBe(rows[0]!.created_at.toISOString());
    expect(await repo.listForProject(otherProjectId)).toHaveLength(1);
  });

  it('changes the role of a membership that exists, and says when there is none', async () => {
    const repo = new ProjectMemberRepository(prisma);
    await repo.add({ projectId, userId: 'u1', role: 'viewer', addedBy: null });
    await repo.add({ projectId: otherProjectId, userId: 'u1', role: 'viewer', addedBy: null });

    expect(await repo.setRole(projectId, 'u1', 'manager')).toBe(true);
    expect(await repo.setRole(projectId, 'u2', 'manager')).toBe(false);
    // Only that membership moved, and no row was made for the person without one.
    expect(await repo.rolesForUser('u1')).toEqual(
      new Map([
        [projectId, 'manager'],
        [otherProjectId, 'viewer'],
      ]),
    );
    expect(await repo.rolesForUser('u2')).toEqual(new Map());
  });

  it('counts members per project, with 0 for a project that has none', async () => {
    const repo = new ProjectMemberRepository(prisma);
    await repo.add({ projectId, userId: 'u1', role: 'viewer', addedBy: null });
    await repo.add({ projectId, userId: 'u2', role: 'member', addedBy: null });

    const counts = await repo.memberCounts([projectId, otherProjectId]);
    expect(counts).toEqual(
      new Map([
        [projectId, 2],
        [otherProjectId, 0],
      ]),
    );
    expect(await repo.memberCounts([])).toEqual(new Map());
  });

  it('writes only the four fields of a membership, whatever else its input carries', async () => {
    const repo = new ProjectMemberRepository(prisma);
    // A caller handing over a wider object — a request body, say — must not
    // have its extra fields passed through to Prisma, which refuses an
    // unknown argument outright.
    const wider = { projectId, userId: 'u1', role: 'member' as const, addedBy: null, projectSlug: 'checkout' };
    await repo.add(wider);
    expect(await repo.rolesForUser('u1')).toEqual(new Map([[projectId, 'member']]));
  });

  it('is refused by the database for a role outside the three', async () => {
    // Raw SQL, because the repository's own type would not let the value
    // reach the database: the CHECK is what stands behind every other writer.
    await expect(
      pool.query(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, 'u1', 'admin')`, [projectId]),
    ).rejects.toThrow(/project_member_role_check/);
  });
});
