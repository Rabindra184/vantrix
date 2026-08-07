import { randomUUID } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { hashToken, mintToken } from '@perfportal/core';
import { TokenRepository } from '@perfportal/persistence';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { Scopes } from '../src/auth/scopes.decorator.js';
import { ProblemFilter } from '../src/common/problem.filter.js';
import { createTestApp, type TestContext } from './support/app.js';

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

  it('serves /healthz and /readyz without a token now that AuthGuard is global', async () => {
    ctx = await createTestApp();
    const health = await request(ctx.app.getHttpServer()).get('/healthz');
    const ready = await request(ctx.app.getHttpServer()).get('/readyz');
    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
  });
});

describe('AuthGuard short-circuits on req.tenant set by AuthMiddleware', () => {
  // Every scope test below (in "global AuthGuard — scope enforcement cannot
  // be forgotten") builds its app with `imports: [AuthModule]`, so
  // AuthMiddleware — which only ever gets mounted onto the 'v1/*path'
  // prefix by AppModule's own configure() — is never in front of AuthGuard
  // there. AuthGuard.canActivate does `req.tenant ?? (await
  // authenticateRequest(...))`; every test that only ever builds from
  // AuthModule exercises exclusively the right-hand side of that `??`, so if
  // the short-circuit were ever deleted, every one of those tests would
  // still pass — they'd just each perform an extra, silently-redundant
  // Argon2id verification. That is a real doubling of the hot path with zero
  // test coverage protecting it. This test is built from AppModule instead,
  // so the middleware is genuinely in front of the guard, and it counts the
  // one database lookup Argon2id verification depends on.
  it('performs exactly one TokenRepository.findByPrefix lookup per authenticated /v1 request', async () => {
    const spy = vi.spyOn(TokenRepository.prototype, 'findByPrefix');
    ctx = await createTestApp(); // built from AppModule — see support/app.ts
    spy.mockClear(); // drop anything createTestApp's own fixture setup triggered

    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${ctx.readToken}`);

    // The token is valid and has the required scope; the run itself simply
    // doesn't exist. What matters here is the call count, not this status —
    // 404 confirms authentication succeeded and the request reached the
    // handler, rather than failing before AuthGuard ever ran.
    expect(res.status).toBe(404);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('AuthMiddleware — infrastructure failures during authentication', () => {
  it('reports a 500 with a generic INTERNAL body, not a 401, and does not leak the underlying error', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenRepository)
      .useValue({
        findByPrefix: async () => {
          throw new Error("Can't reach database server at localhost:9999");
        },
      })
      .compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ProblemFilter());
    await app.init();

    try {
      const res = await request(app.getHttpServer())
        .get('/v1/runs/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${mintToken().token}`);

      expect(res.status).toBe(500);
      expect(res.body.code).toBe('INTERNAL');
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('9999');
      expect(raw.toLowerCase()).not.toContain('prisma');
    } finally {
      await app.close();
    }
  });
});

describe('global AuthGuard — scope enforcement cannot be forgotten', () => {
  @Controller('v1/__test-scoped')
  class ScopedProbeController {
    @Scopes('ingest')
    @Get()
    probe(): { ok: true } {
      return { ok: true };
    }
  }

  async function buildProbeApp() {
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule],
      controllers: [ScopedProbeController],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ProblemFilter());
    await app.init();

    const prisma = app.get(PrismaClient);
    const org = await prisma.org.create({ data: { slug: `org-${randomUUID().slice(0, 8)}`, name: 'Test' } });
    const project = await prisma.project.create({
      data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
    });
    return { app, prisma, org, project };
  }

  async function mintTokenWithScopes(
    prisma: PrismaClient,
    orgId: string,
    projectId: string,
    scopes: string[],
  ): Promise<string> {
    const minted = mintToken();
    const parts = minted.token.split('_');
    const secret = parts[2] ?? '';
    await prisma.apiToken.create({
      data: {
        orgId,
        projectId,
        name: 'probe',
        prefix: minted.prefix,
        tokenHash: await hashToken(secret),
        scopes,
      },
    });
    return minted.token;
  }

  it('rejects a route with @Scopes() but no @UseGuards when the token lacks that scope', async () => {
    const { app, prisma, org, project } = await buildProbeApp();
    try {
      const readOnly = await mintTokenWithScopes(prisma, org.id, project.id, ['read']);
      const res = await request(app.getHttpServer())
        .get('/v1/__test-scoped')
        .set('Authorization', `Bearer ${readOnly}`);
      expect(res.status).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('allows a route with @Scopes() but no @UseGuards when the token has that scope', async () => {
    const { app, prisma, org, project } = await buildProbeApp();
    try {
      const ingestScoped = await mintTokenWithScopes(prisma, org.id, project.id, ['ingest']);
      const res = await request(app.getHttpServer())
        .get('/v1/__test-scoped')
        .set('Authorization', `Bearer ${ingestScoped}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('rejects the same route with no token at all', async () => {
    const { app } = await buildProbeApp();
    try {
      const res = await request(app.getHttpServer()).get('/v1/__test-scoped');
      expect(res.status).toBe(401);
    } finally {
      await app.close();
    }
  });
});
