import { randomUUID } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { TokenRepository } from '@perfportal/persistence';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { Scopes } from '../src/auth/scopes.decorator.js';
import { ProblemFilter } from '../src/common/problem.filter.js';
import { createTestApp, type TestContext } from './support/app.js';
import { hashToken, mintToken } from '../src/auth/tokens.js';

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
