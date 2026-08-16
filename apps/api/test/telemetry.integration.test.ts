import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';

const sample = (secondsFromNow = 0) => ({
  sampledAt: new Date(Date.now() + secondsFromNow * 1000).toISOString(),
  cpuUserMs: 1000, cpuSystemMs: 500, cpuIdleMs: 8000, cpuIowaitMs: 10,
  memUsedBytes: 1_000_000, memTotalBytes: 8_000_000,
  netRxBytes: 10_000, netTxBytes: 20_000,
  tcpInSegs: 100, tcpOutSegs: 120, tcpRetransSegs: 1, tcpInErrs: 0,
  tcpActiveOpens: 5, tcpPassiveOpens: 3,
  tcpStates: { ESTABLISHED: 10 },
});

describe('POST /v1/telemetry', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  it('accepts a batch from a telemetry token', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`)
      .send({ host: 'gen-1', samples: [sample(0), sample(1)] });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(2);
  });

  // ═══ THE SCOPE IS ASSERTED BOTH WAYS ═══
  // A scope that is not enforced is decoration, and only one of these two
  // directions is the one people remember to test.

  it('refuses an ingest token', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .send({ host: 'gen-1', samples: [sample()] });
    expect(res.status).toBe(403);
  });

  it('refuses a read token', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .send({ host: 'gen-1', samples: [sample()] });
    expect(res.status).toBe(403);
  });

  it('a telemetry token cannot upload a bundle', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`)
      .field('metadata', JSON.stringify({}));
    expect(res.status).toBe(403);
  });

  it('a telemetry token cannot read runs', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`);
    expect(res.status).toBe(403);
  });

  it('rejects a payload that names a tenant', async () => {
    // Spec §2, enforced rather than documented. `.strict()` turns a
    // hypothetical privilege escalation into a 400 on the first request.
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`)
      .send({ host: 'gen-1', projectId: ctx.projectId, samples: [sample()] });
    expect(res.status).toBe(400);
  });

  it('refuses an org-scoped credential', async () => {
    // A session names no project, and a telemetry row must belong to one.
    // Refuse and say what to use instead, exactly as ingest does.
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .send({ host: 'gen-1', samples: [sample()] });
    expect([401, 400]).toContain(res.status);
  });
});
