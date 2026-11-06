import { randomUUID } from 'node:crypto';
import { hashPublicLinkSecret, mintPublicLinkSecret } from '@perfportal/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createPrisma, OrgSettingsRepository, PublicLinkRepository } from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

const STARTED_AT = new Date('2026-08-07T10:00:00Z');
const STARTED_ON = new Date('2026-08-07T00:00:00Z');
/** Every link here expires in a fixed future: no case depends on the clock's distance to it. */
const EXPIRES_AT = new Date('2027-08-07T10:00:00.123Z');

let orgId = '';
let projectId = '';
let runId = '';
/** A second run in the SAME project: what a link of another run looks like. */
let siblingRunId = '';
let otherOrgId = '';
let otherProjectId = '';
let otherRunId = '';
let creatorId = '';
let revokerId = '';

/** A realistic token hash: the secret's SHA-256, exactly what the API will store. */
function freshHash(): string {
  return hashPublicLinkSecret(mintPublicLinkSecret());
}

async function seedRun(org: string, project: string): Promise<string> {
  const run = await prisma.run.create({
    data: {
      orgId: org,
      projectId: project,
      status: 'complete',
      tool: 'gatling',
      simulation: 'example.ParitySimulation',
      bundleKey: `runs/${randomUUID()}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: BigInt(1),
      startedAt: STARTED_AT,
      startedOn: STARTED_ON,
      engineOptions: {},
    },
  });
  return run.id;
}

async function seedUser(name: string): Promise<string> {
  const user = await prisma.user.create({
    data: { id: randomUUID(), name, email: `${randomUUID()}@example.test` },
  });
  return user.id;
}

beforeEach(async () => {
  await resetDatabase(pool);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout' },
  });
  const otherOrg = await prisma.org.create({ data: { slug: 'globex', name: 'Globex' } });
  const otherProject = await prisma.project.create({
    data: { orgId: otherOrg.id, slug: 'checkout', name: 'Checkout' },
  });
  orgId = org.id;
  projectId = project.id;
  otherOrgId = otherOrg.id;
  otherProjectId = otherProject.id;
  runId = await seedRun(orgId, projectId);
  siblingRunId = await seedRun(orgId, projectId);
  otherRunId = await seedRun(otherOrgId, otherProjectId);
  creatorId = await seedUser('Asha');
  revokerId = await seedUser('Bram');
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('PublicLinkRepository', () => {
  it('stores every column it is given and answers the link as the list shows it; a hash is unique', async () => {
    const repo = new PublicLinkRepository(pool);
    const tokenHash = freshHash();
    const created = await repo.create({ orgId, projectId, runId, tokenHash, createdBy: creatorId, expiresAt: EXPIRES_AT });

    expect(created).toEqual({
      id: expect.any(String),
      runId,
      createdAt: expect.any(Date),
      createdByName: 'Asha',
      expiresAt: EXPIRES_AT,
      revokedAt: null,
      revokedByName: null,
      lastUsedAt: null,
    });
    // What create answers is what the list answers for the same row.
    expect(await repo.listForRun({ orgId, projectId }, runId)).toEqual([created]);

    // Every column, read straight off the row rather than through the repository.
    const { rows } = await pool.query(
      `SELECT org_id, project_id, run_id, token_hash, created_by, created_at, expires_at,
              revoked_at, revoked_by, last_used_at
         FROM run_public_link WHERE id = $1`,
      [created.id],
    );
    expect(rows).toEqual([
      {
        org_id: orgId,
        project_id: projectId,
        run_id: runId,
        token_hash: tokenHash,
        created_by: creatorId,
        created_at: created.createdAt,
        expires_at: EXPIRES_AT,
        revoked_at: null,
        revoked_by: null,
        last_used_at: null,
      },
    ]);
    // The hash is the credential, so the record carries none of it.
    expect(JSON.stringify(created)).not.toContain(tokenHash);

    // A second link with the same hash is refused by the unique index itself.
    await expect(
      repo.create({ orgId, projectId, runId: siblingRunId, tokenHash, createdBy: null, expiresAt: EXPIRES_AT }),
    ).rejects.toMatchObject({ code: '23505' });
    const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM run_public_link');
    expect(count.rows[0]?.n).toBe(1);
  });

  it('refuses a token hash that is not lowercase hex SHA-256, so a plaintext secret can never be stored', async () => {
    const repo = new PublicLinkRepository(pool);
    for (const tokenHash of [mintPublicLinkSecret(), freshHash().toUpperCase(), freshHash().slice(1)]) {
      await expect(
        repo.create({ orgId, projectId, runId, tokenHash, createdBy: null, expiresAt: EXPIRES_AT }),
      ).rejects.toMatchObject({ code: '23514' });
    }
    const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM run_public_link');
    expect(count.rows[0]?.n).toBe(0);
  });

  it("refuses a run that is not in the org and project it is said to be in, and stores nothing", async () => {
    const repo = new PublicLinkRepository(pool);
    // Another org's run, under this org's scope: the denormalised tenant would be false.
    await expect(
      repo.create({ orgId, projectId, runId: otherRunId, tokenHash: freshHash(), createdBy: null, expiresAt: EXPIRES_AT }),
    ).rejects.toThrow(/not in this project/);
    const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM run_public_link');
    expect(count.rows[0]?.n).toBe(0);
  });

  it("lists a run's links newest first, scoped to its org and project, naming creator and revoker until they are deleted", async () => {
    const repo = new PublicLinkRepository(pool);
    const older = await repo.create({ orgId, projectId, runId, tokenHash: freshHash(), createdBy: creatorId, expiresAt: EXPIRES_AT });
    const newer = await repo.create({ orgId, projectId, runId, tokenHash: freshHash(), createdBy: null, expiresAt: EXPIRES_AT });
    // A link of the sibling run, and one of another org's run: neither is this run's.
    await repo.create({ orgId, projectId, runId: siblingRunId, tokenHash: freshHash(), createdBy: null, expiresAt: EXPIRES_AT });
    await repo.create({
      orgId: otherOrgId, projectId: otherProjectId, runId: otherRunId,
      tokenHash: freshHash(), createdBy: null, expiresAt: EXPIRES_AT,
    });
    // An hour apart, so the order is a fact about created_at and not a tie two
    // inserts in one millisecond could produce.
    await pool.query(`UPDATE run_public_link SET created_at = now() - interval '1 hour' WHERE id = $1`, [older.id]);
    await pool.query(`UPDATE run_public_link SET created_at = now() WHERE id = $1`, [newer.id]);
    expect(await repo.revoke({ orgId, projectId }, runId, older.id, revokerId)).toBe('revoked');

    const listed = await repo.listForRun({ orgId, projectId }, runId);
    expect(listed.map((l) => l.id)).toEqual([newer.id, older.id]);
    expect(listed[1]).toMatchObject({ createdByName: 'Asha', revokedByName: 'Bram', revokedAt: expect.any(Date) });
    expect(listed[0]).toMatchObject({ createdByName: null, revokedByName: null, revokedAt: null });

    // Another org's scope sees nothing of this run, nor does this org's scope with another project.
    expect(await repo.listForRun({ orgId: otherOrgId, projectId: otherProjectId }, runId)).toEqual([]);
    expect(await repo.listForRun({ orgId, projectId: otherProjectId }, runId)).toEqual([]);
    expect(await repo.listForRun({ orgId: otherOrgId, projectId }, runId)).toEqual([]);

    // Deleting the people keeps the links and forgets only who made and revoked them.
    await prisma.user.delete({ where: { id: creatorId } });
    await prisma.user.delete({ where: { id: revokerId } });
    const after = await repo.listForRun({ orgId, projectId }, runId);
    expect(after.map((l) => l.id)).toEqual([newer.id, older.id]);
    expect(after[1]).toMatchObject({ createdByName: null, revokedByName: null, revokedAt: listed[1]?.revokedAt });
    const pointers = await pool.query(
      'SELECT created_by, revoked_by FROM run_public_link WHERE id = $1',
      [older.id],
    );
    expect(pointers.rows).toEqual([{ created_by: null, revoked_by: null }]);
  });

  it("revokes once, answers 'already' without moving the time, and 'not_found' for another run's link", async () => {
    const repo = new PublicLinkRepository(pool);
    const link = await repo.create({ orgId, projectId, runId, tokenHash: freshHash(), createdBy: creatorId, expiresAt: EXPIRES_AT });
    const sibling = await repo.create({
      orgId, projectId, runId: siblingRunId, tokenHash: freshHash(), createdBy: null, expiresAt: EXPIRES_AT,
    });

    expect(await repo.revoke({ orgId, projectId }, runId, link.id, revokerId)).toBe('revoked');
    // Put the revocation in the past, so a second revoke that moved it would be visible.
    await pool.query(`UPDATE run_public_link SET revoked_at = revoked_at - interval '1 hour' WHERE id = $1`, [link.id]);
    const [first] = await repo.listForRun({ orgId, projectId }, runId);

    expect(await repo.revoke({ orgId, projectId }, runId, link.id, creatorId)).toBe('already');
    const [second] = await repo.listForRun({ orgId, projectId }, runId);
    expect(second?.revokedAt).toEqual(first?.revokedAt);
    // The first revoker stands; the second call wrote nothing.
    expect(second?.revokedByName).toBe('Bram');

    // A link of another run in the same project is not this run's to revoke, and stays live.
    expect(await repo.revoke({ orgId, projectId }, runId, sibling.id, revokerId)).toBe('not_found');
    const [siblingAfter] = await repo.listForRun({ orgId, projectId }, siblingRunId);
    expect(siblingAfter?.revokedAt).toBeNull();
    // Nor is a link outside the scope, nor an id that is not a uuid at all.
    expect(await repo.revoke({ orgId: otherOrgId, projectId: otherProjectId }, runId, link.id, revokerId)).toBe('not_found');
    expect(await repo.revoke({ orgId, projectId }, runId, 'not-a-uuid', revokerId)).toBe('not_found');
    expect(await repo.revoke({ orgId, projectId }, runId, randomUUID(), revokerId)).toBe('not_found');
  });

  it("finds a link by its hash with the org's switch, and nothing for an unknown hash", async () => {
    const repo = new PublicLinkRepository(pool);
    const tokenHash = freshHash();
    const link = await repo.create({ orgId, projectId, runId, tokenHash, createdBy: creatorId, expiresAt: EXPIRES_AT });

    expect(await repo.findForCredential(tokenHash)).toEqual({
      linkId: link.id,
      orgId,
      projectId,
      runId,
      expiresAt: EXPIRES_AT,
      revokedAt: null,
      lastUsedAt: null,
      publicLinksEnabled: false,
    });

    await new OrgSettingsRepository(pool).setPublicLinksEnabled(orgId, true);
    expect(await repo.findForCredential(tokenHash)).toMatchObject({ linkId: link.id, publicLinksEnabled: true });
    // The other org's switch is its own.
    await new OrgSettingsRepository(pool).setPublicLinksEnabled(otherOrgId, false);
    expect(await repo.findForCredential(tokenHash)).toMatchObject({ publicLinksEnabled: true });

    // A revoked link is still found: the caller decides what revoked means.
    await repo.revoke({ orgId, projectId }, runId, link.id, revokerId);
    expect(await repo.findForCredential(tokenHash)).toMatchObject({ linkId: link.id, revokedAt: expect.any(Date) });

    expect(await repo.findForCredential(freshHash())).toBeNull();
    expect(await repo.findForCredential('')).toBeNull();
  });

  it('touches last_used_at at most once a minute', async () => {
    const repo = new PublicLinkRepository(pool);
    const tokenHash = freshHash();
    const link = await repo.create({ orgId, projectId, runId, tokenHash, createdBy: null, expiresAt: EXPIRES_AT });
    const lastUsed = async (): Promise<Date | null> => (await repo.findForCredential(tokenHash))?.lastUsedAt ?? null;

    await repo.touch(link.id);
    const first = await lastUsed();
    expect(first).toBeInstanceOf(Date);

    // Inside the minute: unchanged.
    await repo.touch(link.id);
    expect(await lastUsed()).toEqual(first);

    // Set it back 61 s, past the guard: the next touch moves it again.
    await pool.query(`UPDATE run_public_link SET last_used_at = last_used_at - interval '61 seconds' WHERE id = $1`, [link.id]);
    const backdated = await lastUsed();
    expect(backdated?.getTime()).toBe((first?.getTime() ?? 0) - 61_000);
    await repo.touch(link.id);
    const moved = await lastUsed();
    expect(moved?.getTime()).toBeGreaterThan(backdated?.getTime() ?? Infinity);

    // At 59 s back it is still inside the minute, and stays put.
    await pool.query(`UPDATE run_public_link SET last_used_at = now() - interval '59 seconds' WHERE id = $1`, [link.id]);
    const recent = await lastUsed();
    await repo.touch(link.id);
    expect(await lastUsed()).toEqual(recent);
  });

  it('goes with its run when the run is deleted', async () => {
    const repo = new PublicLinkRepository(pool);
    const tokenHash = freshHash();
    await repo.create({ orgId, projectId, runId, tokenHash, createdBy: null, expiresAt: EXPIRES_AT });
    await repo.create({ orgId, projectId, runId: siblingRunId, tokenHash: freshHash(), createdBy: null, expiresAt: EXPIRES_AT });

    await prisma.run.delete({ where: { id: runId } });
    expect(await repo.findForCredential(tokenHash)).toBeNull();
    const { rows } = await pool.query<{ run_id: string }>('SELECT run_id FROM run_public_link');
    // The sibling run's link is untouched.
    expect(rows).toEqual([{ run_id: siblingRunId }]);
  });

  it('goes with its project when the project is deleted', async () => {
    const repo = new PublicLinkRepository(pool);
    await repo.create({ orgId, projectId, runId, tokenHash: freshHash(), createdBy: null, expiresAt: EXPIRES_AT });
    await repo.create({
      orgId: otherOrgId, projectId: otherProjectId, runId: otherRunId,
      tokenHash: freshHash(), createdBy: null, expiresAt: EXPIRES_AT,
    });

    await prisma.project.delete({ where: { id: projectId } });
    const { rows } = await pool.query<{ project_id: string }>('SELECT project_id FROM run_public_link');
    expect(rows).toEqual([{ project_id: otherProjectId }]);
  });
});

describe('OrgSettingsRepository: public links', () => {
  it('reads false for a new org and round-trips the switch, one org at a time', async () => {
    const settings = new OrgSettingsRepository(pool);
    expect(await settings.publicLinksEnabled(orgId)).toBe(false);
    expect(await settings.publicLinksEnabled(otherOrgId)).toBe(false);

    await settings.setPublicLinksEnabled(orgId, true);
    expect(await settings.publicLinksEnabled(orgId)).toBe(true);
    expect(await settings.publicLinksEnabled(otherOrgId)).toBe(false);
    // Independent of the AI switch beside it.
    expect(await settings.aiEnabled(orgId)).toBe(false);

    await settings.setPublicLinksEnabled(orgId, false);
    expect(await settings.publicLinksEnabled(orgId)).toBe(false);
    // An org that does not exist reads as off.
    expect(await settings.publicLinksEnabled(randomUUID())).toBe(false);
  });
});
