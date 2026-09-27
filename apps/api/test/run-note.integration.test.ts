import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrgMemberRepository } from '@perfportal/persistence';
import { createTestApp, type TestContext } from './support/app.js';
import { signUp } from './support/session.js';

/**
 * ═══ PUT /v1/runs/{id}/note ═══
 * (docs/superpowers/specs/2026-09-27-run-note-design.md)
 *
 * A person's note on a run. Session-only: a bearer token is a machine and
 * names nobody. Scoped by org: another org's run is 404, never 403. And the
 * note travels on BOTH GET /v1/runs/{id} builders — the full body of a
 * finished run and the hand-written 202 of a running one — because a note
 * written while a run streams must not vanish until it finishes.
 */
let ctx: TestContext;
let cookie: string;
let userId: string;
const EMAIL = 'note-writer@example.test';

beforeEach(async () => {
  ctx = await createTestApp();
  const signed = await signUp(ctx.app, EMAIL);
  cookie = signed.cookie;
  userId = signed.userId;
  await ctx.app.get(OrgMemberRepository).add(userId, ctx.orgId, 'member');
});

afterEach(async () => {
  await ctx?.close();
});

async function seedRun(
  status: 'running' | 'complete',
  orgId = ctx.orgId,
  projectId = ctx.projectId,
): Promise<string> {
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
      startedAt: new Date('2026-09-27T09:00:00Z'),
      startedOn: new Date('2026-09-27T00:00:00Z'),
      engineOptions: {},
    },
  });
  return run.id;
}

const put = (runId: string, body: object) =>
  request(ctx.app.getHttpServer()).put(`/v1/runs/${runId}/note`).set('Cookie', cookie).send(body);

const read = (runId: string) =>
  request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}`).set('Authorization', `Bearer ${ctx.readToken}`);

describe('PUT /v1/runs/{id}/note', () => {
  it('writes the note, stamping who and when, and answers the note as it now stands', async () => {
    const runId = await seedRun('complete');

    const res = await put(runId, { note: 'baseline after the cache change' });

    expect(res.status).toBe(200);
    expect(res.body.note.text).toBe('baseline after the cache change');
    expect(res.body.note.updatedBy).toEqual({ name: EMAIL });
    expect(Number.isNaN(Date.parse(res.body.note.updatedAt))).toBe(false);
    const row = await ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(row.note).toBe('baseline after the cache change');
    expect(row.noteUpdatedBy).toBe(userId);
  });

  it('stores the trimmed text', async () => {
    const runId = await seedRun('complete');
    const res = await put(runId, { note: '  flaky environment, ignore \n' });
    expect(res.status).toBe(200);
    expect(res.body.note.text).toBe('flaky environment, ignore');
  });

  it('removes the note, its time and its author together on null', async () => {
    const runId = await seedRun('complete');
    await put(runId, { note: 'temporary' });

    const res = await put(runId, { note: null });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ note: null });
    const row = await ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect([row.note, row.noteUpdatedAt, row.noteUpdatedBy]).toEqual([null, null, null]);
  });

  it('refuses a bearer token, whatever it can read', async () => {
    const runId = await seedRun('complete');
    const res = await request(ctx.app.getHttpServer())
      .put(`/v1/runs/${runId}/note`)
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .send({ note: 'a machine has no name' });
    expect(res.status).toBe(403);
    expect((await ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } })).note).toBeNull();
  });

  it("answers another org's run with 404, and writes nothing to it", async () => {
    const other = await ctx.prisma.org.create({ data: { slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other' } });
    const project = await ctx.prisma.project.create({
      data: { orgId: other.id, slug: 'elsewhere', name: 'Elsewhere', settings: {} },
    });
    const runId = await seedRun('complete', other.id, project.id);

    const res = await put(runId, { note: 'not yours' });

    expect(res.status).toBe(404);
    expect(res.body.remediation).toBeTruthy();
    expect((await ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } })).note).toBeNull();
  });

  it('refuses a malformed id before reading the body', async () => {
    const res = await put('not-a-uuid', { note: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  it('refuses every body the contract refuses, with INVALID_RUN_NOTE and a way forward', async () => {
    const runId = await seedRun('complete');
    for (const body of [{}, { note: '   ' }, { note: 'x'.repeat(501) }, { note: 'ok', updatedBy: 'me' }]) {
      const res = await put(runId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code, JSON.stringify(body)).toBe('INVALID_RUN_NOTE');
      expect(res.body.remediation, JSON.stringify(body)).toMatch(/500/);
    }
    expect((await ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } })).note).toBeNull();
  });
});

describe('the note on every read of a run', () => {
  it('reaches the full body of a finished run', async () => {
    const runId = await seedRun('complete');
    await put(runId, { note: 'read me later' });

    const res = await read(runId);

    expect(res.status).toBe(200);
    expect(res.body.note.text).toBe('read me later');
    expect(res.body.note.updatedBy).toEqual({ name: EMAIL });
  });

  it("reaches a running run's 202 — the body a reader watches while it streams", async () => {
    const runId = await seedRun('running');
    await put(runId, { note: 'written while it ran' });

    const res = await read(runId);

    expect(res.status).toBe(202);
    expect(res.body.note.text).toBe('written while it ran');
  });

  it('says null, not absent, for a run nobody has annotated', async () => {
    const runId = await seedRun('complete');
    const res = await read(runId);
    expect(res.body.note).toBeNull();
  });

  it('reaches the run list as text alone, and search finds a run by its note', async () => {
    const noted = await seedRun('complete');
    const plain = await seedRun('complete');
    await put(noted, { note: 'regression after the zeppelin upgrade' });

    const list = await request(ctx.app.getHttpServer()).get('/v1/runs').set('Cookie', cookie);
    const byId = new Map((list.body.items as { id: string; note?: unknown }[]).map((r) => [r.id, r]));
    expect(byId.get(noted)?.note).toBe('regression after the zeppelin upgrade');
    expect(byId.get(plain)?.note).toBeNull();

    const found = await request(ctx.app.getHttpServer()).get('/v1/runs?q=zeppelin').set('Cookie', cookie);
    expect((found.body.items as { id: string }[]).map((r) => r.id)).toEqual([noted]);
  });

  it('keeps the words and drops the name once the author is deleted', async () => {
    const runId = await seedRun('complete');
    await put(runId, { note: 'outlives its author' });

    await ctx.prisma.user.delete({ where: { id: userId } });

    const res = await read(runId);
    expect(res.body.note.text).toBe('outlives its author');
    expect(res.body.note.updatedBy).toBeNull();
  });
});
