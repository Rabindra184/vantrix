import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { createTestApp, type TestContext } from './support/app.js';
import { mintToken } from '../src/auth/tokens.js';

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

describe('boot integrity', () => {
  it('injects every dependency — a clean startup log is not evidence', async () => {
    ctx = await createTestApp();
    const guard = ctx.app.get(AuthGuard);

    // Assert by API shape, never instanceof: Prisma 6 returns a Proxy, so
    // `new PrismaClient() instanceof PrismaClient` is false even with no Nest.
    const injected = guard as unknown as { tokens?: { findByPrefix?: unknown } };
    expect(typeof injected.tokens?.findByPrefix).toBe('function');
  });
});

describe('AuthGuard', () => {
  it('rejects a request with no token', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/v1/runs/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.remediation).toBeTruthy();
  });

  it('rejects an unknown token', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${mintToken().token}`);
    expect(res.status).toBe(401);
  });

  it('rejects a revoked token', async () => {
    ctx = await createTestApp();
    await ctx.prisma.apiToken.updateMany({ data: { revokedAt: new Date() } });
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(res.status).toBe(401);
    expect(res.body.detail).toContain('revoked');
  });

  it('never returns a stack trace', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/v1/runs/not-a-uuid');
    expect(JSON.stringify(res.body)).not.toContain('at Object.');
  });
});

describe('health', () => {
  it('reports readiness only when the database answers', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
