import { randomUUID } from 'node:crypto';
import { AiAnalysisResponseSchema, OrgSettingsSchema } from '@perfportal/contracts';
import { AI_ANALYSIS_JOB_OPTIONS, AI_ANALYSIS_QUEUE, type AiConfig } from '@perfportal/core';
import { AiAnalysisRepository } from '@perfportal/persistence';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/auth/auth.module.js';
import { loadConfig } from '../src/config.js';
import { createTestApp, type TestContext } from './support/app.js';
import { signInAsAdmin, signInAsProjectMember } from './support/session.js';

/**
 * ═══ GET AND POST /v1/runs/{id}/ai-analysis, AND THE ORG SWITCH ═══
 * (docs/superpowers/specs/2026-11-02-ai-run-analysis-design.md, section 5)
 *
 * The API decides whether a run MAY be analysed — with the one rule the
 * worker re-checks, `aiUnavailableReason` — and queues the job; it never
 * calls a provider. No worker runs in this process, so a queued job stays
 * waiting under the run's id, and that is what these cases read back.
 */
let ctx: TestContext;
let queue: Queue | undefined;

afterEach(async () => {
  await queue?.close();
  queue = undefined;
  await ctx?.close();
});

/** A provider is configured; no key is real, and none is ever called here. */
const KEY = 'sk-ant-never-sent-anywhere';
const AI: AiConfig = { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: KEY };

async function configuredApp(): Promise<TestContext> {
  return createTestApp({}, [], [{ provide: CONFIG, useValue: { ...loadConfig(), ai: AI } }]);
}

const email = (who: string): string => `${who}-${randomUUID().slice(0, 8)}@example.test`;

/** A finished run with one exact run_stat row unless told otherwise. */
async function seedRun(
  opts: { status?: 'complete' | 'running'; statsMethod?: 'estimated' | 'exact-v1'; stats?: boolean } = {},
): Promise<string> {
  const status = opts.status ?? 'complete';
  const run = await ctx.prisma.run.create({
    data: {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      status,
      verdict: status === 'complete' ? 'not_evaluated' : null,
      tool: 'gatling',
      simulation: 'example.ParitySimulation',
      bundleKey: `runs/${ctx.projectId}/${randomUUID()}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n,
      startedAt: new Date('2026-11-02T09:00:00Z'),
      startedOn: new Date('2026-11-02T00:00:00Z'),
      engineOptions: {},
      statsMethod: opts.statsMethod ?? 'exact-v1',
      ingestedAt: status === 'complete' ? new Date(Date.now() - 60_000) : null,
    },
  });
  if (opts.stats !== false) {
    await ctx.pool.query(
      `INSERT INTO run_stat
         (id, run_id, org_id, project_id, scope, name, family,
          count, ok_count, ko_count, error_rate,
          min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles, histogram_kind)
       VALUES (gen_random_uuid(), $1, $2, $3, 'run', '', 'response_time',
               3, 2, 1, 0.3333333333333333, 10, 30, 20, 8.16, 1.5, '{"p95": 30}'::jsonb, 'sparse-ms-v2')`,
      [run.id, ctx.orgId, ctx.projectId],
    );
  }
  return run.id;
}

async function enableOrg(enabled = true): Promise<void> {
  await ctx.pool.query('UPDATE org SET ai_enabled = $2 WHERE id = $1', [ctx.orgId, enabled]);
}

/** An analysis the worker would have stored. */
const CONTENT = {
  health: { headline: 'The run made 3 requests.', bullets: ['One of the 3 requests failed.'] },
  insights: { headline: 'Response times held.', errors: [], assertions: [], injectionProfile: [], responseTimes: [] },
  recommendations: { headline: 'Look at the failed request.', bullets: ['Read its error message.'] },
};

async function storeReady(runId: string): Promise<void> {
  await new AiAnalysisRepository(ctx.pool).record(runId, {
    content: CONTENT,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    factsVersion: 1,
    generatedAt: new Date(),
  });
}

function aiQueue(): Queue {
  queue ??= new Queue(AI_ANALYSIS_QUEUE, { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  return queue;
}

const get = (runId: string, auth: { cookie?: string; bearer?: string }) => {
  const req = request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}/ai-analysis`);
  return auth.bearer !== undefined ? req.set('Authorization', `Bearer ${auth.bearer}`) : req.set('Cookie', auth.cookie!);
};

const post = (runId: string, cookie: string) =>
  request(ctx.app.getHttpServer()).post(`/v1/runs/${runId}/ai-analysis`).set('Cookie', cookie);

async function requestedAt(runId: string): Promise<Date | undefined> {
  const { rows } = await ctx.pool.query<{ requested_at: Date }>(
    'SELECT requested_at FROM run_ai_analysis WHERE run_id = $1',
    [runId],
  );
  return rows[0]?.requested_at;
}

const member = () => signInAsProjectMember(ctx, email('member'), [{ projectId: ctx.projectId, role: 'member' }]);

describe('GET /v1/runs/{id}/ai-analysis — why a run cannot be analysed', () => {
  it('answers not_configured without a provider', async () => {
    ctx = await createTestApp();
    await enableOrg();
    const runId = await seedRun();
    const { cookie } = await member();

    const res = await get(runId, { bearer: ctx.readToken }).expect(200);
    expect(AiAnalysisResponseSchema.parse(res.body)).toEqual({ available: false, reason: 'not_configured' });

    const refused = await post(runId, cookie);
    expect([refused.status, refused.body.code]).toEqual([409, 'AI_ANALYSIS_UNAVAILABLE']);
    expect(refused.body.detail).toContain('not_configured');
    expect(refused.body.remediation).toBeTruthy();
    expect(await requestedAt(runId)).toBeUndefined();
  });

  it('answers org_disabled until an admin turns it on', async () => {
    ctx = await configuredApp();
    const runId = await seedRun();
    const admin = await signInAsAdmin(ctx, email('admin'));

    const off = await get(runId, { cookie: admin.cookie }).expect(200);
    expect(off.body).toEqual({ available: false, reason: 'org_disabled' });
    const refused = await post(runId, admin.cookie);
    expect([refused.status, refused.body.code]).toEqual([409, 'AI_ANALYSIS_UNAVAILABLE']);
    expect(refused.body.detail).toContain('org_disabled');

    await request(ctx.app.getHttpServer())
      .put('/v1/admin/settings')
      .set('Cookie', admin.cookie)
      .send({ aiEnabled: true })
      .expect(200);

    const on = await get(runId, { cookie: admin.cookie }).expect(200);
    expect(AiAnalysisResponseSchema.parse(on.body)).toEqual({
      available: true,
      state: 'none',
      content: null,
      failureReason: null,
      generatedAt: null,
      model: null,
      stale: false,
      requestedAt: null,
    });
  });

  it('answers not_terminal for a running run', async () => {
    ctx = await configuredApp();
    await enableOrg();
    const runId = await seedRun({ status: 'running', stats: false });
    const res = await get(runId, { bearer: ctx.readToken }).expect(200);
    expect(res.body).toEqual({ available: false, reason: 'not_terminal' });
  });

  it('answers no_statistics for a finished run with nothing measured', async () => {
    ctx = await configuredApp();
    await enableOrg();
    const runId = await seedRun({ stats: false });
    const res = await get(runId, { bearer: ctx.readToken }).expect(200);
    expect(res.body).toEqual({ available: false, reason: 'no_statistics' });
  });

  it('answers estimated for a run labelled estimated', async () => {
    ctx = await configuredApp();
    await enableOrg();
    const runId = await seedRun({ statsMethod: 'estimated' });
    const res = await get(runId, { bearer: ctx.readToken }).expect(200);
    expect(res.body).toEqual({ available: false, reason: 'estimated' });
  });

  it('answers verification_mismatch', async () => {
    ctx = await configuredApp();
    await enableOrg();
    const runId = await seedRun();
    await ctx.pool.query(
      `INSERT INTO run_verification (run_id, status, checked_at, mismatches) VALUES ($1, 'mismatch', now(), '[]'::jsonb)`,
      [runId],
    );
    const res = await get(runId, { bearer: ctx.readToken }).expect(200);
    expect(res.body).toEqual({ available: false, reason: 'verification_mismatch' });
  });

  it('hides a stored analysis once the org switch is off', async () => {
    ctx = await configuredApp();
    await enableOrg();
    const runId = await seedRun();
    await storeReady(runId);

    const shown = await get(runId, { bearer: ctx.readToken }).expect(200);
    expect(AiAnalysisResponseSchema.parse(shown.body)).toMatchObject({ available: true, state: 'ready', content: CONTENT });

    await enableOrg(false);
    const hidden = await get(runId, { bearer: ctx.readToken }).expect(200);
    expect(hidden.body).toEqual({ available: false, reason: 'org_disabled' });
  });

  it("answers another org's run with 404", async () => {
    ctx = await configuredApp();
    await enableOrg();
    const other = await ctx.prisma.org.create({ data: { slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other' } });
    const project = await ctx.prisma.project.create({ data: { orgId: other.id, slug: 'elsewhere', name: 'Elsewhere' } });
    const run = await ctx.prisma.run.create({
      data: {
        orgId: other.id, projectId: project.id, status: 'complete', tool: 'gatling',
        bundleKey: `runs/${project.id}/${randomUUID()}.tgz`, bundleSha256: 'a'.repeat(64), bundleBytes: 1n,
        startedAt: new Date(), startedOn: new Date('2026-11-02T00:00:00Z'), engineOptions: {},
      },
    });
    const res = await get(run.id, { bearer: ctx.readToken });
    expect(res.status).toBe(404);
    expect(res.body.remediation).toBeTruthy();
  });
});

describe('the OpenAPI document', () => {
  /**
   * The document is derived from the contract, so this proves the field reached
   * it: a generated client reading `requestedAt` must find it declared and
   * nullable. Optional in the contract (an older API omits it), and always
   * sent by this server — the response cases below pin that.
   */
  it('declares requestedAt on the available response, nullable', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/v1/openapi.json').expect(200);
    const schema = res.body.components.schemas.AiAnalysisResponse as {
      anyOf?: Array<{ properties: Record<string, unknown>; required?: string[] }>;
      oneOf?: Array<{ properties: Record<string, unknown>; required?: string[] }>;
    };
    const branches = schema.oneOf ?? schema.anyOf ?? [];
    const available = branches.find((b) => 'state' in b.properties);
    expect(available, JSON.stringify(schema).slice(0, 400)).toBeDefined();
    expect(available!.properties).toHaveProperty('requestedAt');
    expect(JSON.stringify(available!.properties.requestedAt)).toContain('null');
  });
});

describe('POST /v1/runs/{id}/ai-analysis', () => {
  it('POST queues once and answers the pending row twice', async () => {
    ctx = await configuredApp();
    await enableOrg();
    const runId = await seedRun();
    const { cookie, userId } = await member();

    const first = await post(runId, cookie);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(AiAnalysisResponseSchema.parse(first.body)).toMatchObject({ available: true, state: 'pending', content: null });
    const job = await aiQueue().getJob(runId);
    expect(job?.data).toEqual({ runId });
    expect(job?.opts.attempts).toBe(AI_ANALYSIS_JOB_OPTIONS.attempts);
    expect(job?.opts.removeOnFail).toBe(true);
    const { rows } = await ctx.pool.query<{ requested_by: string }>(
      'SELECT requested_by FROM run_ai_analysis WHERE run_id = $1',
      [runId],
    );
    expect(rows[0]?.requested_by).toBe(userId);
    const stamped = await requestedAt(runId);
    // The response carries the row's own request time, which is what lets the
    // card tell a pending row nothing is working on from one a job may be.
    expect(first.body.requestedAt).toBe(stamped!.toISOString());

    const second = await post(runId, cookie);
    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
    // Not marked again, and the job is the one the first POST queued.
    expect(await requestedAt(runId)).toEqual(stamped);
    expect((await aiQueue().getJob(runId))?.timestamp).toBe(job?.timestamp);

    const read = await get(runId, { bearer: ctx.readToken }).expect(200);
    expect(read.body).toEqual(first.body);
  });

  it('re-enqueues a pending row older than thirty-five minutes, and not one a job may still be working on', async () => {
    ctx = await configuredApp();
    await enableOrg();
    const runId = await seedRun();
    const { cookie } = await member();
    await post(runId, cookie).expect(202);
    // The job is gone — BullMQ failed it for stalling and removed it.
    await (await aiQueue().getJob(runId))?.remove();

    // Thirty minutes is inside the longest a job can run (three attempts of
    // two 300 s calls, and the backoff): the row is still trusted.
    await ctx.pool.query(
      `UPDATE run_ai_analysis SET requested_at = now() - interval '30 minutes' WHERE run_id = $1`,
      [runId],
    );
    const trusted = await requestedAt(runId);
    expect((await post(runId, cookie)).status).toBe(202);
    expect(await requestedAt(runId)).toEqual(trusted);
    expect(await aiQueue().getJob(runId)).toBeUndefined();

    // Past the window, nothing can still be working on it.
    await ctx.pool.query(
      `UPDATE run_ai_analysis SET requested_at = now() - interval '36 minutes' WHERE run_id = $1`,
      [runId],
    );
    const old = await requestedAt(runId);

    const res = await post(runId, cookie);
    expect(res.status).toBe(202);
    expect(res.body.state).toBe('pending');
    expect((await requestedAt(runId))!.getTime()).toBeGreaterThan(old!.getTime());
    expect(res.body.requestedAt).toBe((await requestedAt(runId))!.toISOString());
    expect((await aiQueue().getJob(runId))?.data).toEqual({ runId });
  });

  it('POST on a ready analysis answers it without queueing', async () => {
    ctx = await configuredApp();
    await enableOrg();
    const runId = await seedRun();
    await storeReady(runId);
    const { cookie } = await member();

    const res = await post(runId, cookie);
    expect(res.status).toBe(200);
    expect(AiAnalysisResponseSchema.parse(res.body)).toMatchObject({
      available: true,
      state: 'ready',
      content: CONTENT,
      model: 'claude-opus-5-5',
      failureReason: null,
      stale: false,
    });
    expect(await aiQueue().getJob(runId)).toBeUndefined();
  });

  it('queues again after a failed analysis, and reports why the last one failed', async () => {
    ctx = await configuredApp();
    await enableOrg();
    const runId = await seedRun();
    await new AiAnalysisRepository(ctx.pool).markFailed(runId, 'numbers_not_in_facts: 42');
    const { cookie } = await member();

    const read = await get(runId, { bearer: ctx.readToken }).expect(200);
    expect(read.body).toMatchObject({ state: 'failed', failureReason: 'numbers_not_in_facts: 42', content: null });

    const res = await post(runId, cookie);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: 'pending', failureReason: null });
    expect(await aiQueue().getJob(runId)).toBeDefined();
  });

  it('marks an analysis stale after a recompute and lets a member generate again', async () => {
    ctx = await configuredApp();
    await enableOrg();
    const runId = await seedRun();
    await storeReady(runId);
    await ctx.pool.query(`UPDATE run SET recomputed_at = now() + interval '1 second' WHERE id = $1`, [runId]);
    const { cookie } = await member();

    const read = await get(runId, { bearer: ctx.readToken }).expect(200);
    expect(read.body).toMatchObject({ state: 'ready', stale: true });

    const res = await post(runId, cookie);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: 'pending', content: null, stale: false });
    expect((await aiQueue().getJob(runId))?.data).toEqual({ runId });
  });

  it("refuses a viewer's POST with ROLE_REQUIRED and a bearer's with FORBIDDEN", async () => {
    ctx = await configuredApp();
    await enableOrg();
    const runId = await seedRun();
    const viewer = await signInAsProjectMember(ctx, email('viewer'), [{ projectId: ctx.projectId, role: 'viewer' }]);

    const asViewer = await post(runId, viewer.cookie);
    expect([asViewer.status, asViewer.body.code]).toEqual([403, 'ROLE_REQUIRED']);
    // A viewer may still READ the analysis.
    await get(runId, { cookie: viewer.cookie }).expect(200);

    const asBearer = await request(ctx.app.getHttpServer())
      .post(`/v1/runs/${runId}/ai-analysis`)
      .set('Authorization', `Bearer ${ctx.ingestToken}`);
    expect([asBearer.status, asBearer.body.code]).toEqual([403, 'FORBIDDEN']);

    expect(await requestedAt(runId)).toBeUndefined();
    expect(await aiQueue().getJob(runId)).toBeUndefined();
  });
});

describe('/v1/admin/settings', () => {
  it('GET and PUT /v1/admin/settings report and set the switch', async () => {
    ctx = await configuredApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const api = request(ctx.app.getHttpServer());

    const before = await api.get('/v1/admin/settings').set('Cookie', admin.cookie).expect(200);
    expect(OrgSettingsSchema.parse(before.body)).toEqual({
      aiEnabled: false,
      aiProviderConfigured: true,
      aiProvider: 'anthropic',
      aiModel: 'claude-opus-5-5',
      aiBaseUrlHost: null,
    });
    // The deployment's key never leaves it.
    expect(JSON.stringify(before.body)).not.toContain(KEY);

    const set = await api.put('/v1/admin/settings').set('Cookie', admin.cookie).send({ aiEnabled: true }).expect(200);
    expect(set.body).toEqual({ ...before.body, aiEnabled: true });
    const { rows } = await ctx.pool.query<{ ai_enabled: boolean }>('SELECT ai_enabled FROM org WHERE id = $1', [ctx.orgId]);
    expect(rows[0]?.ai_enabled).toBe(true);

    // The provider belongs to the environment: refused, not ignored.
    const refused = await api
      .put('/v1/admin/settings')
      .set('Cookie', admin.cookie)
      .send({ aiEnabled: false, aiModel: 'something-else' });
    expect([refused.status, refused.body.code]).toEqual([400, 'INVALID_ORG_SETTINGS']);
    expect(refused.body.remediation).toBeTruthy();
    expect((await api.get('/v1/admin/settings').set('Cookie', admin.cookie).expect(200)).body.aiEnabled).toBe(true);

    const manager = await signInAsProjectMember(ctx, email('manager'), [{ projectId: ctx.projectId, role: 'manager' }]);
    const notAdmin = await api.put('/v1/admin/settings').set('Cookie', manager.cookie).send({ aiEnabled: false });
    expect([notAdmin.status, notAdmin.body.code]).toEqual([403, 'ADMIN_REQUIRED']);
  });

  it('reports no provider when the deployment configures none', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const res = await request(ctx.app.getHttpServer()).get('/v1/admin/settings').set('Cookie', admin.cookie).expect(200);
    expect(res.body).toEqual({
      aiEnabled: false,
      aiProviderConfigured: false,
      aiProvider: null,
      aiModel: null,
      aiBaseUrlHost: null,
    });
  });

  it('names an openai-compatible endpoint by its host alone, never its userinfo, path or query', async () => {
    const openai: AiConfig = {
      provider: 'openai-compatible',
      model: 'llama-3.3-70b',
      baseUrl: 'https://svc-user:svc-secret@llm.internal.example:8443/openai/v1?tenant=acme',
      apiKey: KEY,
    };
    ctx = await createTestApp({}, [], [{ provide: CONFIG, useValue: { ...loadConfig(), ai: openai } }]);
    const admin = await signInAsAdmin(ctx, email('admin'));
    const res = await request(ctx.app.getHttpServer()).get('/v1/admin/settings').set('Cookie', admin.cookie).expect(200);
    expect(OrgSettingsSchema.parse(res.body)).toEqual({
      aiEnabled: false,
      aiProviderConfigured: true,
      aiProvider: 'openai-compatible',
      aiModel: 'llama-3.3-70b',
      aiBaseUrlHost: 'llm.internal.example:8443',
    });
    // The host alone: nothing else of the base URL reaches an admin's page.
    const body = JSON.stringify(res.body);
    for (const part of ['svc-user', 'svc-secret', '/openai/v1', 'tenant=acme', KEY]) expect(body).not.toContain(part);
  });
});
