import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOKEN_SCOPES } from '@perfportal/contracts';
import type { TokenScope } from '../src/auth/scopes.decorator.js';
import { createTestApp, type TestContext } from './support/app.js';
import { signUpAsOrgMember } from './support/session.js';

let ctx: TestContext;
let cookie: string;

beforeEach(async () => {
  ctx = await createTestApp();
  // Every test in this file mints against ctx's own org — a real member,
  // not signUpAndLogin's org-less user (see support/session.ts's docstring
  // for why that distinction matters: a no-membership session 403s the same
  // way SessionOnlyGuard refuses a bearer token, so the wrong helper here
  // would make "accepts a session" pass for the wrong reason).
  cookie = await signUpAsOrgMember(ctx, 'minter@example.test');
});

afterEach(async () => {
  await ctx?.close();
});

const telemetrySample = (secondsFromNow = 0) => ({
  sampledAt: new Date(Date.now() + secondsFromNow * 1000).toISOString(),
  cpuUserMs: 1000, cpuSystemMs: 500, cpuIdleMs: 8000, cpuIowaitMs: 10,
  memUsedBytes: 1_000_000, memTotalBytes: 8_000_000,
  netRxBytes: 10_000, netTxBytes: 20_000,
  tcpInSegs: 100, tcpOutSegs: 120, tcpRetransSegs: 1, tcpInErrs: 0,
  tcpActiveOpens: 5, tcpPassiveOpens: 3,
  tcpStates: { ESTABLISHED: 10 },
});

function post(path: string, token: string, body: object) {
  return request(ctx.app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body);
}

function postAsSession(path: string, body: object) {
  return request(ctx.app.getHttpServer()).post(path).set('Cookie', cookie).send(body);
}

function getAsSession(path: string) {
  return request(ctx.app.getHttpServer()).get(path).set('Cookie', cookie);
}

function getWithBearer(path: string, token: string) {
  return request(ctx.app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
}

function deleteAsSession(path: string) {
  return request(ctx.app.getHttpServer()).delete(path).set('Cookie', cookie);
}

function deleteWithBearer(path: string, token: string) {
  return request(ctx.app.getHttpServer()).delete(path).set('Authorization', `Bearer ${token}`);
}

function postTelemetry(headers: Record<string, string>) {
  return request(ctx.app.getHttpServer())
    .post('/v1/telemetry')
    .set(headers)
    .send({ host: 'lg-alpha', samples: [telemetrySample()] });
}

describe('POST /v1/projects/:slug/tokens', () => {
  // ═══ THE ESCALATION TEST, BOTH DIRECTIONS ═══
  // This is the feature's security property. It is also the assertion that
  // would silently keep passing if someone replaced the session check with
  // @Scopes('read') — a plausible-looking simplification that reintroduces the
  // escalation exactly.

  it('refuses a bearer read token', async () => {
    const res = await post(`/v1/projects/checkout/tokens`, ctx.readToken, { name: 'x', scopes: ['telemetry'] });
    expect(res.status).toBe(403);
  });

  it('refuses a bearer ingest token', async () => {
    const res = await post(`/v1/projects/checkout/tokens`, ctx.ingestToken, { name: 'x', scopes: ['telemetry'] });
    expect(res.status).toBe(403);
  });

  it('accepts a session', async () => {
    const res = await postAsSession(`/v1/projects/checkout/tokens`, { name: 'gen-1 agent', scopes: ['telemetry'] });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^pp_[0-9a-f]+_[0-9a-f]+$/);
    expect(res.body.prefix).toBe(res.body.token.split('_').slice(0, 2).join('_'));
    expect(res.body.scopes).toEqual(['telemetry']);
  });

  // The round trip that proves the credential WORKS, rather than that a row
  // was written. Without it every other assertion could pass against a token
  // the API will not actually accept.
  it('mints a telemetry token that can actually post telemetry', async () => {
    const minted = await postAsSession(`/v1/projects/checkout/tokens`, { name: 'agent', scopes: ['telemetry'] });
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${minted.body.token}`)
      .send({ host: 'lg-alpha', samples: [telemetrySample()] });
    expect(res.status).toBe(202);
  });

  it('mints a token that cannot do what it was not scoped for', async () => {
    const minted = await postAsSession(`/v1/projects/checkout/tokens`, { name: 'agent', scopes: ['telemetry'] });
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs')
      .set('Authorization', `Bearer ${minted.body.token}`);
    expect(res.status).toBe(403);
  });

  it('rejects an unknown scope, an empty scope list and a blank name', async () => {
    for (const body of [
      { name: 'x', scopes: ['admin'] },
      { name: 'x', scopes: [] },
      { name: '  ', scopes: ['read'] },
    ]) {
      expect((await postAsSession(`/v1/projects/checkout/tokens`, body)).status).toBe(400);
    }
  });

  it("answers 404 for a project outside the caller's org", async () => {
    const other = await ctx.prisma.org.create({ data: { slug: 'other-org-tokens', name: 'Other' } });
    const otherProject = await ctx.prisma.project.create({
      data: { orgId: other.id, slug: 'other-project', name: 'Other Project' },
    });
    const res = await postAsSession(`/v1/projects/${otherProject.slug}/tokens`, { name: 'x', scopes: ['read'] });
    expect(res.status).toBe(404);
  });
});

describe('the contract and the API agree about scopes', () => {
  it("TOKEN_SCOPES matches the API's TokenScope union", () => {
    // The duplication is deliberate (contracts must not import from apps/api,
    // which the browser also loads), so this is what stops it drifting.
    //
    // A `Record<TokenScope, true>` (not a `TokenScope[]` annotation) is what
    // makes this exhaustive: a plain array-typed literal only constrains each
    // ELEMENT to the union, so adding a fourth member to TokenScope leaves
    // `['ingest', 'read', 'telemetry']` perfectly valid and this test green
    // while TOKEN_SCOPES silently falls behind. The mapped type instead
    // requires a property for every member of the union, so an unlisted
    // scope is a compile error here, not a silent gap.
    //
    // That compile error only reaches CI because test/tsconfig.json exists
    // and `pnpm typecheck` runs it. Until it did, apps/api/test was checked
    // by nothing, the annotation below was erased before the test ever ran,
    // and this guarded exactly as much as a comment would have.
    const fromApi: Record<TokenScope, true> = { ingest: true, read: true, telemetry: true, stream: true };
    expect([...TOKEN_SCOPES].sort()).toEqual(Object.keys(fromApi).sort());
  });
});

describe('GET /v1/projects/:slug/tokens', () => {
  it('lists this project\'s tokens and never the secret', async () => {
    const minted = await postAsSession(`/v1/projects/checkout/tokens`, { name: 'listed', scopes: ['read'] });
    const res = await getAsSession(`/v1/projects/checkout/tokens`);

    expect(res.status).toBe(200);
    const row = res.body.tokens.find((t: { prefix: string }) => t.prefix === minted.body.prefix);
    expect(row).toBeDefined();
    expect(row.name).toBe('listed');
    // Derived from what was minted, not written down.
    expect(row.scopes).toEqual(minted.body.scopes);
    expect(row.revokedAt).toBeNull();
    // The secret exists once, at mint. Never again, and never the hash.
    expect(JSON.stringify(res.body)).not.toContain(minted.body.token.split('_')[2]);
    expect(Object.keys(row)).not.toContain('tokenHash');
  });

  it('refuses a bearer credential', async () => {
    expect((await getWithBearer(`/v1/projects/checkout/tokens`, ctx.readToken)).status).toBe(403);
  });
});

describe('DELETE /v1/projects/:slug/tokens/:prefix', () => {
  // THE TEST THAT CLOSES THE LOOP. `revokedAt` has been checked on every
  // authentication since the column was created and never written by
  // anything; this is the first proof it bites end to end.
  it('revokes a token that then stops authenticating', async () => {
    const minted = await postAsSession(`/v1/projects/checkout/tokens`, { name: 'doomed', scopes: ['telemetry'] });
    const auth = { Authorization: `Bearer ${minted.body.token}` };

    const before = await postTelemetry(auth);
    expect(before.status).toBe(202);

    const revoked = await deleteAsSession(`/v1/projects/checkout/tokens/${minted.body.prefix}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).not.toBeNull();

    const after = await postTelemetry(auth);
    expect(after.status).toBe(401);
  });

  it('is idempotent, keeping the original revocation time', async () => {
    const minted = await postAsSession(`/v1/projects/checkout/tokens`, { name: 'twice', scopes: ['read'] });
    const first = await deleteAsSession(`/v1/projects/checkout/tokens/${minted.body.prefix}`);
    const second = await deleteAsSession(`/v1/projects/checkout/tokens/${minted.body.prefix}`);
    expect(second.status).toBe(200);
    expect(second.body.revokedAt).toBe(first.body.revokedAt);
  });

  it('answers 404 for an unknown prefix', async () => {
    expect((await deleteAsSession(`/v1/projects/checkout/tokens/pp_nope`)).status).toBe(404);
  });

  it('refuses a bearer credential', async () => {
    expect((await deleteWithBearer(`/v1/projects/checkout/tokens/pp_x`, ctx.readToken)).status).toBe(403);
  });
});
