import { randomUUID } from 'node:crypto';
import {
  CreatePublicLinkResponseSchema,
  PUBLIC_LINK_SECRET_PATTERN,
  PublicLinkListResponseSchema,
  TOKEN_SCOPES,
} from '@perfportal/contracts';
import { hashPublicLinkSecret, hashToken, mintToken } from '@perfportal/core';
import { OrgSettingsRepository } from '@perfportal/persistence';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { signInAsAdmin, signInAsProjectMember } from './support/session.js';

/**
 * ═══ A RUN'S PUBLIC LINKS: CREATE, LIST, REVOKE ═══
 * (docs/superpowers/specs/2026-11-06-public-links-and-custom-report-design.md, section 4.1)
 *
 * Session-only and `run:share` (a Member and up). Driven by a real session
 * from `signInAsProjectMember` over seeded run rows, with the org's switch
 * written through the same repository the controller reads it from.
 *
 * THE SECRET IS ASSERTED AGAINST THE PATTERN HERE, ON THE API'S OWN ANSWER.
 * `@perfportal/core` mints it and `@perfportal/contracts` declares its shape,
 * and neither package can import the other — so this is the one place a real
 * minted secret meets `PUBLIC_LINK_SECRET_PATTERN`.
 */
let ctx: TestContext;
let member: { cookie: string; userId: string };
const MEMBER_EMAIL = 'sharer@example.test';
const DAY_MS = 86_400_000;

beforeEach(async () => {
  ctx = await createTestApp();
  member = await signInAsProjectMember(ctx, MEMBER_EMAIL, [{ projectId: ctx.projectId, role: 'member' }]);
});

afterEach(async () => {
  await ctx?.close();
});

type RunStatus = 'pending' | 'parsing' | 'running' | 'complete' | 'incomplete' | 'failed';

async function seedRun(status: RunStatus = 'complete', orgId = ctx.orgId, projectId = ctx.projectId): Promise<string> {
  const run = await ctx.prisma.run.create({
    data: {
      orgId,
      projectId,
      status,
      verdict: status === 'complete' ? 'not_evaluated' : null,
      tool: 'gatling',
      bundleKey: `runs/${projectId}/${randomUUID()}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n,
      startedAt: new Date('2026-11-06T09:00:00Z'),
      startedOn: new Date('2026-11-06T00:00:00Z'),
      engineOptions: {},
    },
  });
  return run.id;
}

const setSwitch = (enabled: boolean, orgId = ctx.orgId) =>
  new OrgSettingsRepository(ctx.pool).setPublicLinksEnabled(orgId, enabled);

/** An instant `ms` from now, as the browser's preset would send it. */
const ahead = (ms: number): string => new Date(Date.now() + ms).toISOString();

/** A deadline on every request: a route that waits for something nobody sends hangs rather than failing. */
const DEADLINE = { deadline: 15_000, response: 15_000 } as const;

const create = (runId: string, body: unknown, cookie = member.cookie) =>
  request(ctx.app.getHttpServer())
    .post(`/v1/runs/${runId}/public-links`)
    .set('Cookie', cookie)
    .timeout(DEADLINE)
    .send(body as object);

const list = (runId: string, cookie = member.cookie) =>
  request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}/public-links`).set('Cookie', cookie).timeout(DEADLINE);

const revoke = (runId: string, linkId: string, cookie = member.cookie) =>
  request(ctx.app.getHttpServer())
    .delete(`/v1/runs/${runId}/public-links/${linkId}`)
    .set('Cookie', cookie)
    .timeout(DEADLINE);

async function linkRows(runId: string) {
  const { rows } = await ctx.pool.query<{
    id: string;
    token_hash: string;
    created_by: string | null;
    revoked_at: Date | null;
    revoked_by: string | null;
    row: string;
  }>(
    `SELECT id, token_hash, created_by, revoked_at, revoked_by, row_to_json(l)::text AS row
       FROM run_public_link l WHERE run_id = $1::uuid ORDER BY created_at`,
    [runId],
  );
  return rows;
}

/** Creates a link with the switch on and answers its id (and the one secret). */
async function created(runId: string, cookie = member.cookie): Promise<{ id: string; secret: string }> {
  const res = await create(runId, { expiresAt: ahead(30 * DAY_MS) }, cookie);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.link.id as string, secret: res.body.secret as string };
}

describe('POST /v1/runs/{id}/public-links', () => {
  it('creates an active link and answers the one copy of its secret, in the documented shape', async () => {
    await setSwitch(true);
    const runId = await seedRun('complete');
    const expiresAt = ahead(30 * DAY_MS);

    const res = await create(runId, { expiresAt });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = CreatePublicLinkResponseSchema.parse(res.body);
    // The seam neither package can test alone: a secret core really minted,
    // read back through the API, against the pattern contracts declares.
    expect(body.secret).toMatch(PUBLIC_LINK_SECRET_PATTERN);
    expect(body.link.state).toBe('active');
    expect(body.link.expiresAt).toBe(expiresAt);
    expect(body.link.createdBy).toEqual({ name: MEMBER_EMAIL });
    expect([body.link.revokedAt, body.link.revokedBy, body.link.lastUsedAt]).toEqual([null, null, null]);
  });

  it('stores only the secret’s SHA-256, and no column holds the secret itself', async () => {
    await setSwitch(true);
    const runId = await seedRun('complete');

    const { id, secret } = await created(runId);

    const rows = await linkRows(runId);
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(rows[0]!.token_hash).toBe(hashPublicLinkSecret(secret));
    expect(rows[0]!.created_by).toBe(member.userId);
    // Every column, as text: neither the whole secret nor its random part.
    expect(rows[0]!.row).not.toContain(secret);
    expect(rows[0]!.row).not.toContain(secret.slice('ppl_'.length));
  });

  it('refuses while the org’s switch is off, 403 PUBLIC_LINKS_DISABLED naming where to turn it on, and stores nothing', async () => {
    const runId = await seedRun('complete');

    const res = await create(runId, { expiresAt: ahead(30 * DAY_MS) });

    expect([res.status, res.body.code]).toEqual([403, 'PUBLIC_LINKS_DISABLED']);
    expect(res.body.remediation).toContain('Administration › Settings');
    expect(await linkRows(runId)).toEqual([]);
  });

  it.each(['pending', 'parsing', 'running', 'failed'] as const)(
    'refuses a %s run, 409 RUN_NOT_SHAREABLE, and stores nothing',
    async (status) => {
      await setSwitch(true);
      const runId = await seedRun(status);

      const res = await create(runId, { expiresAt: ahead(30 * DAY_MS) });

      expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([409, 'RUN_NOT_SHAREABLE']);
      expect(res.body.remediation).toBeTruthy();
      expect(await linkRows(runId)).toEqual([]);
    },
  );

  it('shares an incomplete run: the stream stopped early, and what arrived is a finished run', async () => {
    await setSwitch(true);
    const runId = await seedRun('incomplete');

    const res = await create(runId, { expiresAt: ahead(30 * DAY_MS) });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.link.state).toBe('active');
  });

  it.each([
    ['an expiry 30 seconds ahead', () => ({ expiresAt: ahead(30_000) })],
    ['an expiry 733 days ahead', () => ({ expiresAt: ahead(733 * DAY_MS) })],
    ['a body with an extra key', () => ({ expiresAt: ahead(30 * DAY_MS), name: 'for the vendor' })],
    ['no expiry at all', () => ({})],
    ['an expiry that is not an ISO instant', () => ({ expiresAt: 'next week' })],
  ])('refuses %s, 400 INVALID_PUBLIC_LINK, and stores nothing', async (_why, body) => {
    await setSwitch(true);
    const runId = await seedRun('complete');

    const res = await create(runId, body());

    expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([400, 'INVALID_PUBLIC_LINK']);
    expect(res.body.remediation).toBeTruthy();
    expect(await linkRows(runId)).toEqual([]);
  });

  it('accepts an expiry 731 days ahead, inside the two-year window', async () => {
    await setSwitch(true);
    const runId = await seedRun('complete');
    const res = await create(runId, { expiresAt: ahead(731 * DAY_MS) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  /**
   * An admin passes `AccessGuard` without its run lookup, so this is the
   * CONTROLLER's own lookup answering — the one that keeps another org's run
   * from reaching the repository's insert, which would throw rather than 404.
   */
  it('answers an admin with 404 for another org’s run, and stores nothing', async () => {
    const other = await ctx.prisma.org.create({ data: { slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other' } });
    const project = await ctx.prisma.project.create({
      data: { orgId: other.id, slug: 'elsewhere', name: 'Elsewhere', settings: {} },
    });
    await setSwitch(true);
    await setSwitch(true, other.id);
    const runId = await seedRun('complete', other.id, project.id);
    const { cookie } = await signInAsAdmin(ctx, 'admin@example.test');

    const res = await create(runId, { expiresAt: ahead(30 * DAY_MS) }, cookie);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.remediation).toBeTruthy();
    expect(await linkRows(runId)).toEqual([]);
  });

  it('refuses a malformed run id 400 INVALID_ID', async () => {
    await setSwitch(true);
    const res = await create('not-a-uuid', { expiresAt: ahead(30 * DAY_MS) });
    expect([res.status, res.body.code]).toEqual([400, 'INVALID_ID']);
  });
});

describe('GET /v1/runs/{id}/public-links', () => {
  it('answers the switch as `enabled`, with an empty list for a run never shared', async () => {
    const runId = await seedRun('complete');

    const off = await list(runId);
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(PublicLinkListResponseSchema.parse(off.body)).toEqual({ enabled: false, items: [] });

    await setSwitch(true);
    const on = await list(runId);
    expect(on.body).toEqual({ enabled: true, items: [] });
  });

  it('lists the run’s links newest first, each with its state and its people, and never a secret', async () => {
    await setSwitch(true);
    const runId = await seedRun('complete');
    const oldest = await created(runId);
    const middle = await created(runId);
    const newest = await created(runId);
    // Distinct creation instants, so the order asserted is the order of
    // creation and not a tie broken by id.
    for (const [link, hoursAgo] of [[oldest, 3], [middle, 2], [newest, 1]] as const) {
      await ctx.pool.query(`UPDATE run_public_link SET created_at = now() - make_interval(hours => $2) WHERE id = $1`, [
        link.id,
        hoursAgo,
      ]);
    }
    await ctx.pool.query(`UPDATE run_public_link SET expires_at = now() - interval '1 day' WHERE id = $1`, [oldest.id]);
    expect((await revoke(runId, middle.id)).status).toBe(204);

    const res = await list(runId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = PublicLinkListResponseSchema.parse(res.body);
    expect(body.enabled).toBe(true);
    expect(body.items.map((l) => [l.id, l.state])).toEqual([
      [newest.id, 'active'],
      [middle.id, 'revoked'],
      [oldest.id, 'expired'],
    ]);
    expect(body.items.map((l) => l.createdBy)).toEqual([
      { name: MEMBER_EMAIL },
      { name: MEMBER_EMAIL },
      { name: MEMBER_EMAIL },
    ]);
    expect(body.items[1]!.revokedBy).toEqual({ name: MEMBER_EMAIL });
    expect(body.items[1]!.revokedAt).not.toBeNull();
    const text = JSON.stringify(res.body);
    for (const { secret } of [oldest, middle, newest]) expect(text).not.toContain(secret);
    expect(text).not.toContain('tokenHash');
  });

  it('keeps listing the links while the switch is off, and says it is off', async () => {
    await setSwitch(true);
    const runId = await seedRun('complete');
    const { id } = await created(runId);
    await setSwitch(false);

    const res = await list(runId);

    expect(res.body.enabled).toBe(false);
    expect(res.body.items.map((l: { id: string }) => l.id)).toEqual([id]);
  });

  it('lists only this run’s links, not another run’s in the same project', async () => {
    await setSwitch(true);
    const runId = await seedRun('complete');
    const otherRunId = await seedRun('complete');
    await created(otherRunId);

    const res = await list(runId);

    expect(res.body.items).toEqual([]);
  });
});

describe('DELETE /v1/runs/{id}/public-links/{linkId}', () => {
  it('revokes, 204, and a second revoke is 204 with the first revocation untouched', async () => {
    await setSwitch(true);
    const runId = await seedRun('complete');
    const { id } = await created(runId);

    const first = await revoke(runId, id);
    expect(first.status, JSON.stringify(first.body)).toBe(204);
    const [afterFirst] = await linkRows(runId);
    expect(afterFirst!.revoked_at).not.toBeNull();
    expect(afterFirst!.revoked_by).toBe(member.userId);

    const second = await revoke(runId, id);
    expect(second.status, JSON.stringify(second.body)).toBe(204);
    const [afterSecond] = await linkRows(runId);
    expect(afterSecond!.revoked_at?.toISOString()).toBe(afterFirst!.revoked_at?.toISOString());
  });

  it('answers 404 for a link of another run in the same project, and leaves that link alone', async () => {
    await setSwitch(true);
    const runId = await seedRun('complete');
    const otherRunId = await seedRun('complete');
    const { id } = await created(otherRunId);

    const res = await revoke(runId, id);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.remediation).toBeTruthy();
    expect((await linkRows(otherRunId))[0]!.revoked_at).toBeNull();
  });

  it('answers 404 for a link id no run holds', async () => {
    const runId = await seedRun('complete');
    const res = await revoke(runId, randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it('lets another Member of the project revoke a link they did not create', async () => {
    await setSwitch(true);
    const runId = await seedRun('complete');
    const { id } = await created(runId);
    const colleague = await signInAsProjectMember(ctx, 'colleague@example.test', [
      { projectId: ctx.projectId, role: 'member' },
    ]);

    const res = await revoke(runId, id, colleague.cookie);

    expect(res.status, JSON.stringify(res.body)).toBe(204);
    const [row] = await linkRows(runId);
    expect(row!.revoked_by).toBe(colleague.userId);
    expect(row!.created_by).toBe(member.userId);
  });

  it('revokes while the switch is off: stopping a link is never refused', async () => {
    await setSwitch(true);
    const runId = await seedRun('complete');
    const { id } = await created(runId);
    await setSwitch(false);

    expect((await revoke(runId, id)).status).toBe(204);
    expect((await linkRows(runId))[0]!.revoked_at).not.toBeNull();
  });

  it('refuses a malformed link id 400 INVALID_ID', async () => {
    const runId = await seedRun('complete');
    const res = await revoke(runId, 'not-a-uuid');
    expect([res.status, res.body.code]).toEqual([400, 'INVALID_ID']);
  });
});

describe('a bearer token', () => {
  /**
   * EVERY scope, so a refusal cannot be a scope the token happens to lack:
   * `SessionOnlyGuard` is the only thing that can answer it. A link is a
   * person's decision to show a run to someone outside, and a CI credential
   * names nobody to record as having made it.
   */
  it('is refused 403 FORBIDDEN on all three routes, whatever its scopes', async () => {
    await setSwitch(true);
    const runId = await seedRun('complete');
    const { id } = await created(runId);
    const minted = mintToken();
    await ctx.prisma.apiToken.create({
      data: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        name: 'everything',
        prefix: minted.prefix,
        tokenHash: await hashToken(minted.token.split('_')[2] ?? ''),
        scopes: [...TOKEN_SCOPES],
      },
    });
    const auth = { Authorization: `Bearer ${minted.token}` };
    const server = ctx.app.getHttpServer();

    const answers = await Promise.all([
      request(server).post(`/v1/runs/${runId}/public-links`).set(auth).timeout(DEADLINE).send({ expiresAt: ahead(DAY_MS) }),
      request(server).get(`/v1/runs/${runId}/public-links`).set(auth).timeout(DEADLINE),
      request(server).delete(`/v1/runs/${runId}/public-links/${id}`).set(auth).timeout(DEADLINE),
    ]);

    expect(answers.map((r) => [r.status, r.body.code])).toEqual([
      [403, 'FORBIDDEN'],
      [403, 'FORBIDDEN'],
      [403, 'FORBIDDEN'],
    ]);
    const rows = await linkRows(runId);
    expect(rows.map((r) => r.revoked_at)).toEqual([null]);
  });
});
