import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Controller, Get, Param } from '@nestjs/common';
import { PublicLinkResolveResponseSchema } from '@perfportal/contracts';
import { hashPublicLinkSecret, mintPublicLinkSecret } from '@perfportal/core';
import { OrgSettingsRepository, PublicLinkRepository } from '@perfportal/persistence';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { LinkReadable, PublicLinkOnly } from '../src/auth/access.decorator.js';
import { runNotFound } from '../src/common/validation.js';
import { CLOSE_UNAUTHORIZED } from '../src/live/live.gateway.js';
import { buildOpenApiDocument } from '../src/openapi/document.js';
import { createTestApp, type TestContext } from './support/app.js';
import { signInAsProjectMember } from './support/session.js';

/**
 * ═══ A PUBLIC LINK IS A CREDENTIAL PINNED TO ONE RUN, DENIED BY DEFAULT ═══
 * (docs/superpowers/specs/2026-11-06-public-links-and-custom-report-design.md,
 * sections 4.3, 5.1 and 5.2)
 *
 * `Authorization: PublicLink <secret>` is the third credential `AuthMiddleware`
 * accepts, ahead of a bearer token and a session. These cases drive it through
 * the real app: the four 401s and the order they are tested in, the switch,
 * revocation on the next request, `GET /v1/public-link`, the default-deny
 * `AccessGuard` answers every other route with, and what a link reads of its
 * own run: the note without its author's name (section 5.4), and no response a
 * cache may keep. Which routes a link may read is pinned against every route
 * by the link matrix in `access-routes.integration.test.ts`.
 *
 * Links are written through `PublicLinkRepository` with a secret minted here,
 * not through the create route: what is under test is the READ path, and the
 * repository is what lets a case put a link in any state — revoked, expired
 * at an exact instant — that the create route rightly refuses to make.
 */
/*
 * ═══ TWO TEST-ONLY ROUTES, ONE PER OPENING ═══
 *
 * Every real `@LinkReadable` handler answers from its own lookups, and the one
 * real `@PublicLinkOnly` handler refuses a non-link caller itself too — so on
 * real routes alone, what the guard decides is mixed with what the handler
 * answers, and its refusal of a session on a `@PublicLinkOnly` route is masked
 * by the controller's own. These two answer 200 to whoever the guard lets
 * through, so each opening is seen by itself: a link reads its own run and no
 * other, and a `@PublicLinkOnly` route answers a link and nobody else.
 */
@Controller('/v1/runs/:id/__link-readable-probe')
class LinkReadableProbe {
  @Get()
  @LinkReadable()
  read(@Param('id') id: string): { id: string } {
    return { id };
  }
}

@Controller('/v1/__public-link-only-probe')
class PublicLinkOnlyProbe {
  @Get()
  @PublicLinkOnly()
  read(): { ok: true } {
    return { ok: true };
  }
}

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestApp({}, [LinkReadableProbe, PublicLinkOnlyProbe]);
});

afterEach(async () => {
  vi.useRealTimers();
  await ctx?.close();
});

const DAY_MS = 86_400_000;
/** A deadline on every request: a route that waits for something nobody sends hangs rather than failing. */
const DEADLINE = { deadline: 15_000, response: 15_000 } as const;
const REMEDIATION = 'Ask whoever sent this link for a new one.';

/** The spec's own sentences (global constraints), written out rather than imported. */
const NOT_FOUND = 'This link does not exist.';
const REVOKED = 'This link has been revoked.';
const DISABLED = 'Public links are turned off for this organisation.';
const expiredOn = (expiresAt: Date): string => `This link expired on ${expiresAt.toISOString()}.`;

/** `@PublicLinkOnly`'s refusal of every other credential. */
const ONLY_A_LINK = {
  detail: "Only a public link's credential can read this.",
  remediation:
    "Send Authorization: PublicLink <secret>, with the secret from the link's URL. A signed-in " +
    'session or an API token reads the run itself at GET /v1/runs/{id}.',
} as const;

/** Ruling R3: a link refused on a route that names no run. */
const NOT_READABLE = {
  detail: 'Nothing here can be read with a public link.',
  remediation: 'Open the link you were sent; it reads one run.',
} as const;

const links = () => new PublicLinkRepository(ctx.pool);
const setSwitch = (enabled: boolean) => new OrgSettingsRepository(ctx.pool).setPublicLinksEnabled(ctx.orgId, enabled);

async function seedRun(): Promise<string> {
  const run = await ctx.prisma.run.create({
    data: {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      status: 'complete',
      verdict: 'not_evaluated',
      tool: 'gatling',
      bundleKey: `runs/${ctx.projectId}/${randomUUID()}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n,
      startedAt: new Date('2026-11-06T09:00:00Z'),
      startedOn: new Date('2026-11-06T00:00:00Z'),
      engineOptions: {},
    },
  });
  return run.id;
}

/**
 * A run of `status` carrying a note a member of the project wrote through the
 * real note route, so its author is a person with a name: the account's name,
 * which these helpers set to its email. `running` is read through the
 * hand-written 202, `complete` through `toResponse` — the two identity
 * builders a redaction has to reach.
 */
async function notedRun(
  status: 'complete' | 'running',
): Promise<{ runId: string; cookie: string; email: string; text: string }> {
  const runId = await seedRun();
  if (status === 'running') await ctx.prisma.run.update({ where: { id: runId }, data: { status: 'running' } });
  const email = `author-${randomUUID()}@example.test`;
  const { cookie } = await signInAsProjectMember(ctx, email, [{ projectId: ctx.projectId, role: 'member' }]);
  const text = 'Baseline after the cache change.';
  const written = await request(ctx.app.getHttpServer())
    .put(`/v1/runs/${runId}/note`)
    .set('Cookie', cookie)
    .timeout(DEADLINE)
    .send({ note: text });
  expect([written.status, written.body.note?.updatedBy], JSON.stringify(written.body)).toStrictEqual([
    200,
    { name: email },
  ]);
  return { runId, cookie, email, text };
}

/** A link to `runId`, stored as the create route stores one: the secret's hash and nothing else. */
async function makeLink(
  runId: string,
  expiresAt = new Date(Date.now() + 30 * DAY_MS),
): Promise<{ id: string; secret: string; expiresAt: Date }> {
  const secret = mintPublicLinkSecret();
  const link = await links().create({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    runId,
    tokenHash: hashPublicLinkSecret(secret),
    createdBy: null,
    expiresAt,
  });
  return { id: link.id, secret, expiresAt };
}

/** Moves a link's expiry into the past, the way time would. */
async function expire(linkId: string): Promise<Date> {
  const at = new Date(Date.now() - DAY_MS);
  await ctx.pool.query('UPDATE run_public_link SET expires_at = $2 WHERE id = $1::uuid', [linkId, at]);
  return at;
}

async function revokeThroughRepository(runId: string, linkId: string): Promise<void> {
  const { userId } = await signInAsProjectMember(ctx, `revoker-${randomUUID()}@example.test`, [
    { projectId: ctx.projectId, role: 'member' },
  ]);
  const outcome = await links().revoke({ orgId: ctx.orgId, projectId: ctx.projectId }, runId, linkId, userId);
  expect(outcome).toBe('revoked');
}

const lastUsedAt = async (linkId: string): Promise<Date | null> =>
  (await ctx.pool.query<{ last_used_at: Date | null }>('SELECT last_used_at FROM run_public_link WHERE id = $1::uuid', [linkId]))
    .rows[0]!.last_used_at;

/** GET `url` carrying exactly this Authorization header and nothing else. */
const withHeader = (url: string, authorization: string) =>
  request(ctx.app.getHttpServer()).get(url).set('Authorization', authorization).timeout(DEADLINE);

const resolve = (secret: string) => withHeader('/v1/public-link', `PublicLink ${secret}`);

/** A 401 from the link credential: its own code, the spec's sentence, problem+json. */
function expectRefused(res: request.Response, code: string, detail: string): void {
  expect(
    [res.status, res.body.code, res.body.detail, res.body.remediation],
    JSON.stringify(res.body),
  ).toStrictEqual([401, code, detail, REMEDIATION]);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  // Its detail names the link's state and expiry, so no cache keeps it either.
  expect(res.headers['cache-control']).toBe('private, no-store');
}

/** A problem body with its traceId dropped and the caller-supplied target masked (access-routes' shape). */
function masked(body: Record<string, unknown>, identifier?: string): Record<string, unknown> {
  const { traceId, ...rest } = body;
  expect(typeof traceId).toBe('string');
  const text = JSON.stringify(rest);
  return JSON.parse(identifier === undefined ? text : text.replaceAll(identifier, '<target>')) as Record<string, unknown>;
}

describe('a malformed or unknown PublicLink credential', () => {
  it.each([
    ['no value at all', () => 'PublicLink'],
    ['an API token in its place', () => 'PublicLink pp_abc'],
    // 1,000 characters that START like a secret, so a prefix check alone would let them through.
    ['1,000 characters', () => `PublicLink ppl_${'A'.repeat(996)}`],
    ['a well-formed secret nobody holds', () => `PublicLink ${mintPublicLinkSecret()}`],
  ])('answers %s 401 LINK_NOT_FOUND, never a 500', async (label, header) => {
    await setSwitch(true);
    const lookup = vi.spyOn(PublicLinkRepository.prototype, 'findForCredential');
    try {
      const res = await withHeader('/v1/public-link', header());
      expectRefused(res, 'LINK_NOT_FOUND', NOT_FOUND);
      // A value that cannot be a secret is refused before anything is hashed
      // or read; only the well-formed one reaches the lookup.
      expect(lookup).toHaveBeenCalledTimes(label === 'a well-formed secret nobody holds' ? 1 : 0);
    } finally {
      lookup.mockRestore();
    }
  });

  /**
   * The PublicLink scheme is tested FIRST, ahead of a session cookie: a sharer
   * who opens their own link while signed in sees what a stranger sees, and a
   * broken link is not quietly answered as the session.
   */
  it('takes the PublicLink header over a session cookie sent with it', async () => {
    await setSwitch(true);
    const { cookie, email, runId } = await notedRun('complete');

    const bogus = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}`)
      .set('Cookie', cookie)
      .set('Authorization', `PublicLink ${mintPublicLinkSecret()}`)
      .timeout(DEADLINE);
    expectRefused(bogus, 'LINK_NOT_FOUND', NOT_FOUND);

    const { secret } = await makeLink(runId);
    const real = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}`)
      .set('Cookie', cookie)
      .set('Authorization', `PublicLink ${secret}`)
      .timeout(DEADLINE);
    const cookieAlone = await request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}`).set('Cookie', cookie).timeout(DEADLINE);
    // Both read the run 200, so what tells the two answers apart is what only
    // a link's answer withholds: the note's author.
    expect([cookieAlone.status, cookieAlone.body.note?.updatedBy], JSON.stringify(cookieAlone.body)).toStrictEqual([
      200,
      { name: email },
    ]);
    expect([real.status, real.body.note?.updatedBy], JSON.stringify(real.body)).toStrictEqual([200, null]);
    expect(real.headers['cache-control']).toBe('private, no-store');
  });
});

describe('a link that stopped working says why', () => {
  it('reads LINK_REVOKED for a revoked link', async () => {
    await setSwitch(true);
    const runId = await seedRun();
    const link = await makeLink(runId);
    await revokeThroughRepository(runId, link.id);
    expectRefused(await resolve(link.secret), 'LINK_REVOKED', REVOKED);
  });

  it('reads LINK_EXPIRED with the date it expired, and does not touch last_used_at', async () => {
    await setSwitch(true);
    const runId = await seedRun();
    const link = await makeLink(runId);
    const at = await expire(link.id);
    expectRefused(await resolve(link.secret), 'LINK_EXPIRED', expiredOn(at));
    expect(await lastUsedAt(link.id), 'a refused link was recorded as used').toBeNull();
  });

  it('reads PUBLIC_LINKS_DISABLED while the organisation has public links off', async () => {
    await setSwitch(false);
    const runId = await seedRun();
    const link = await makeLink(runId);
    expectRefused(await resolve(link.secret), 'PUBLIC_LINKS_DISABLED', DISABLED);
  });

  /*
   * ═══ THE ORDER IS REVOKED, THEN DISABLED, THEN EXPIRED ═══
   *
   * Each case puts a link in TWO states at once, so a check tested in the
   * wrong order answers the other code. Three pairs, one per adjacent swap.
   */
  it('reads LINK_REVOKED for a link both revoked and expired', async () => {
    await setSwitch(true);
    const runId = await seedRun();
    const link = await makeLink(runId);
    await revokeThroughRepository(runId, link.id);
    await expire(link.id);
    expectRefused(await resolve(link.secret), 'LINK_REVOKED', REVOKED);
  });

  it('reads PUBLIC_LINKS_DISABLED for a link both disabled and expired', async () => {
    await setSwitch(false);
    const runId = await seedRun();
    const link = await makeLink(runId);
    await expire(link.id);
    expectRefused(await resolve(link.secret), 'PUBLIC_LINKS_DISABLED', DISABLED);
  });

  it('reads LINK_REVOKED for a link both revoked and disabled', async () => {
    await setSwitch(false);
    const runId = await seedRun();
    const link = await makeLink(runId);
    await revokeThroughRepository(runId, link.id);
    expectRefused(await resolve(link.secret), 'LINK_REVOKED', REVOKED);
  });

  /**
   * AN EXPIRY OF EXACTLY NOW IS EXPIRED, as `publicLinkState` reads it, so the
   * run's list and the credential agree in the same millisecond. Only the
   * clock is faked — `Date`, never a timer — and the app runs in this
   * process, so the middleware reads the instant set here. The millisecond
   * before is the pair: a check written `<` instead of `<=` fails one of the
   * two, whichever way it is wrong.
   */
  it('reads an expiry of exactly now as expired, and the millisecond before as active', async () => {
    await setSwitch(true);
    const runId = await seedRun();
    const link = await makeLink(runId, new Date(Date.now() + 10 * 60_000));

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(link.expiresAt.getTime() - 1));
    const before = await resolve(link.secret);
    vi.setSystemTime(link.expiresAt);
    const at = await resolve(link.secret);
    vi.useRealTimers();

    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expectRefused(at, 'LINK_EXPIRED', expiredOn(link.expiresAt));
  });

  it('refuses an expired link while an unexpired one to the same run reads', async () => {
    await setSwitch(true);
    const runId = await seedRun();
    const old = await makeLink(runId);
    const at = await expire(old.id);
    const fresh = await makeLink(runId);

    expectRefused(await resolve(old.secret), 'LINK_EXPIRED', expiredOn(at));
    expect((await resolve(fresh.secret)).status).toBe(200);
  });
});

describe('the switch and a revoke take effect on the next request', () => {
  it('suspends every link while the switch is off and restores it when it is back on', async () => {
    await setSwitch(true);
    const runId = await seedRun();
    const link = await makeLink(runId);

    expect((await resolve(link.secret)).status).toBe(200);
    await setSwitch(false);
    expectRefused(await resolve(link.secret), 'PUBLIC_LINKS_DISABLED', DISABLED);
    await setSwitch(true);
    const back = await resolve(link.secret);
    expect([back.status, back.body.runId], JSON.stringify(back.body)).toStrictEqual([200, runId]);
  });

  it('refuses a link revoked between two requests, with no restart', async () => {
    await setSwitch(true);
    const runId = await seedRun();
    const link = await makeLink(runId);

    expect((await resolve(link.secret)).status).toBe(200);
    await revokeThroughRepository(runId, link.id);
    expectRefused(await resolve(link.secret), 'LINK_REVOKED', REVOKED);
  });
});

describe('GET /v1/public-link', () => {
  it('answers the link’s run and expiry, and no cache may keep it', async () => {
    await setSwitch(true);
    const runId = await seedRun();
    const link = await makeLink(runId);

    const res = await resolve(link.secret);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(PublicLinkResolveResponseSchema.parse(res.body)).toStrictEqual({
      runId,
      expiresAt: link.expiresAt.toISOString(),
    });
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('records last_used_at on the first request', async () => {
    await setSwitch(true);
    const runId = await seedRun();
    const link = await makeLink(runId);
    expect(await lastUsedAt(link.id)).toBeNull();

    expect((await resolve(link.secret)).status).toBe(200);

    const used = await lastUsedAt(link.id);
    expect(used, 'last_used_at was not written').not.toBeNull();
    expect(Math.abs(used!.getTime() - Date.now())).toBeLessThan(60_000);
  });

  /**
   * `@PublicLinkOnly`: every other credential gets the same 404, so the route
   * says nothing to a session or a token beyond what the document already
   * does.
   */
  it('answers a session and a bearer token 404, one body for both', async () => {
    const { cookie } = await signInAsProjectMember(ctx, `reader-${randomUUID()}@example.test`, [
      { projectId: ctx.projectId, role: 'viewer' },
    ]);
    const session = await request(ctx.app.getHttpServer()).get('/v1/public-link').set('Cookie', cookie).timeout(DEADLINE);
    const bearer = await withHeader('/v1/public-link', `Bearer ${ctx.readToken}`);

    for (const res of [session, bearer]) {
      expect([res.status, res.body.code, res.body.detail, res.body.remediation], JSON.stringify(res.body)).toStrictEqual(
        [404, 'NOT_FOUND', ONLY_A_LINK.detail, ONLY_A_LINK.remediation],
      );
    }
    expect(masked(bearer.body)).toStrictEqual(masked(session.body));
  });
});

/*
 * ═══ DEFAULT-DENY: A LINK REACHES NOTHING IT IS NOT GIVEN ═══
 *
 * A link reads its own run's fifteen allowlisted routes and its resolve route,
 * and nothing else — including a route of its OWN run that is not on the
 * allowlist (`/trends`), which is the case that proves the guard decides from
 * the marker and not from the run id alone. Every refusal answers exactly as
 * a run that does not exist. The same rule over every route is the link
 * matrix's, in `access-routes.integration.test.ts`.
 */
describe('a link on every other route', () => {
  async function linked(): Promise<{ runId: string; secret: string }> {
    await setSwitch(true);
    const runId = await seedRun();
    return { runId, secret: (await makeLink(runId)).secret };
  }

  it('answers a read of its own run off the allowlist 404, byte for byte the body a missing run gets', async () => {
    const { runId, secret } = await linked();
    const missingId = randomUUID();
    const { cookie } = await signInAsProjectMember(ctx, `member-${randomUUID()}@example.test`, [
      { projectId: ctx.projectId, role: 'member' },
    ]);

    const own = await withHeader(`/v1/runs/${runId}/trends`, `PublicLink ${secret}`);
    const missingByLink = await withHeader(`/v1/runs/${missingId}/trends`, `PublicLink ${secret}`);
    const missingBySession = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${missingId}/trends`)
      .set('Cookie', cookie)
      .timeout(DEADLINE);

    expect([own.status, own.body.code], JSON.stringify(own.body)).toStrictEqual([404, 'NOT_FOUND']);
    // A guard's refusal of a link tenant is a response to it too.
    expect(own.headers['cache-control']).toBe('private, no-store');
    expect(masked(own.body, runId)).toStrictEqual(masked(missingByLink.body, missingId));
    expect(masked(own.body, runId)).toStrictEqual(masked(missingBySession.body, missingId));
  });

  it('answers a write to its own run 404, and writes nothing', async () => {
    const { runId, secret } = await linked();
    const missingId = randomUUID();

    const write = await request(ctx.app.getHttpServer())
      .put(`/v1/runs/${runId}/note`)
      .set('Authorization', `PublicLink ${secret}`)
      .timeout(DEADLINE)
      .send({ note: 'written through a public link' });
    const missing = await request(ctx.app.getHttpServer())
      .put(`/v1/runs/${missingId}/note`)
      .set('Authorization', `PublicLink ${secret}`)
      .timeout(DEADLINE)
      .send({ note: 'x' });

    expect([write.status, write.body.code], JSON.stringify(write.body)).toStrictEqual([404, 'NOT_FOUND']);
    expect(masked(write.body, runId)).toStrictEqual(masked(missing.body, missingId));
    const row = await ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(row.note).toBeNull();
  });

  /** A route whose `:id` is not a uuid: still the run's 404, never the pipe's 400 that would tell it from a real id. */
  it('answers a malformed run id with the same 404', async () => {
    const { runId, secret } = await linked();
    const malformed = await withHeader('/v1/runs/not-a-uuid', `PublicLink ${secret}`);
    const own = await withHeader(`/v1/runs/${runId}/trends`, `PublicLink ${secret}`);
    expect([malformed.status, malformed.body.code], JSON.stringify(malformed.body)).toStrictEqual([404, 'NOT_FOUND']);
    expect(masked(malformed.body, 'not-a-uuid')).toStrictEqual(masked(own.body, runId));
  });

  /** Ruling R3: a route with no `:id` has no run to name, so every such route answers one fixed sentence. */
  it('answers a route that names no run 404 with one body for all of them', async () => {
    const { secret } = await linked();
    const responses = await Promise.all(
      ['/v1/runs', '/v1/projects', '/v1/admin/settings', `/v1/projects/checkout/tests`].map((url) =>
        withHeader(url, `PublicLink ${secret}`),
      ),
    );
    for (const res of responses) {
      expect([res.status, res.body.code, res.body.detail, res.body.remediation], JSON.stringify(res.body)).toStrictEqual(
        [404, 'NOT_FOUND', NOT_READABLE.detail, NOT_READABLE.remediation],
      );
      expect(masked(res.body)).toStrictEqual(masked(responses[0]!.body));
    }
  });
});

/*
 * ═══ WHAT A LINK READS OF ITS OWN RUN ═══
 * (spec section 5.4)
 *
 * The note's text is part of the run the sharer chose to share, so it stays;
 * a person's name does not leave the install, so `updatedBy` reads null — the
 * value it already has once an author's account is deleted. Through BOTH
 * identity builders: a finished run is answered by `toResponse`, a running one
 * by the hand-written 202, and a redaction applied to one alone would leave
 * the name on the other. A session reading the same run still sees the name,
 * which is what keeps "redacted" from meaning "never stored".
 */
describe('what a link reads of its own run', () => {
  it.each([
    ['complete', 200],
    ['running', 202],
  ] as const)('reads a %s run’s note without its author, which a session still sees', async (status, code) => {
    await setSwitch(true);
    const { runId, cookie, email, text } = await notedRun(status);
    const { secret } = await makeLink(runId);

    const byLink = await withHeader(`/v1/runs/${runId}`, `PublicLink ${secret}`);
    const bySession = await request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}`).set('Cookie', cookie).timeout(DEADLINE);

    expect([bySession.status, bySession.body.note?.text, bySession.body.note?.updatedBy], JSON.stringify(bySession.body)).toStrictEqual([
      code,
      text,
      { name: email },
    ]);
    expect([byLink.status, byLink.body.note], JSON.stringify(byLink.body)).toStrictEqual([
      code,
      { text, updatedAt: bySession.body.note.updatedAt, updatedBy: null },
    ]);
  });

  /**
   * Every response to a link carries `Cache-Control: private, no-store`, so no
   * intermediary keeps a copy of a run read without signing in. The routes
   * are the ones the document offers a link (`publicLinkAuth` beside the
   * other two credentials) — a set `access-routes.integration.test.ts` holds
   * equal to the walked `@LinkReadable` set — each filled with the link's own
   * run, and a response is counted only once the guard has let it through:
   * a refusal's header is the default-deny block's claim, not this one.
   */
  it('marks every allowlisted response through the link private, no-store', async () => {
    await setSwitch(true);
    const runId = await seedRun();
    const { secret } = await makeLink(runId);
    const doc = buildOpenApiDocument();
    const allowlisted = Object.entries(doc.paths)
      .filter(([, item]) => (item.get?.security ?? []).some((req) => 'publicLinkAuth' in req))
      .map(([path]) => path)
      .filter((path) => path.startsWith('/v1/runs/{id}'));
    expect(allowlisted.length, 'the document offers a link too few routes').toBeGreaterThan(10);

    const wrong: string[] = [];
    for (const path of allowlisted) {
      const res = await withHeader(path.replace('{id}', runId), `PublicLink ${secret}`);
      if (res.body?.detail === runNotFound(runId).message) wrong.push(`${path}: refused, ${res.status}`);
      else if (res.headers['cache-control'] !== 'private, no-store') {
        wrong.push(`${path}: Cache-Control ${String(res.headers['cache-control'])}`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });
});

describe('the guard’s two openings', () => {
  it('lets a link read a @LinkReadable route for its own run, and for no other', async () => {
    await setSwitch(true);
    const runId = await seedRun();
    const otherRunId = await seedRun();
    const missingId = randomUUID();
    const { secret } = await makeLink(runId);
    const probe = (id: string) => withHeader(`/v1/runs/${id}/__link-readable-probe`, `PublicLink ${secret}`);

    const own = await probe(runId);
    expect([own.status, own.body], JSON.stringify(own.body)).toStrictEqual([200, { id: runId }]);
    expect(own.headers['cache-control']).toBe('private, no-store');

    // Another run in the SAME project, a run nobody holds, and an id that is
    // not a uuid: one body each, the missing run's.
    const other = await probe(otherRunId);
    const missing = await probe(missingId);
    const malformed = await probe('not-a-uuid');
    expect([other.status, missing.status, malformed.status]).toStrictEqual([404, 404, 404]);
    expect(masked(other.body, otherRunId)).toStrictEqual(masked(missing.body, missingId));
    expect(masked(malformed.body, 'not-a-uuid')).toStrictEqual(masked(missing.body, missingId));
  });

  it('lets a link through a @PublicLinkOnly route and answers a session and a token 404', async () => {
    await setSwitch(true);
    const { secret } = await makeLink(await seedRun());
    const { cookie } = await signInAsProjectMember(ctx, `reader-${randomUUID()}@example.test`, [
      { projectId: ctx.projectId, role: 'manager' },
    ]);

    const link = await withHeader('/v1/__public-link-only-probe', `PublicLink ${secret}`);
    const session = await request(ctx.app.getHttpServer())
      .get('/v1/__public-link-only-probe')
      .set('Cookie', cookie)
      .timeout(DEADLINE);
    const bearer = await withHeader('/v1/__public-link-only-probe', `Bearer ${ctx.readToken}`);

    expect([link.status, link.body]).toStrictEqual([200, { ok: true }]);
    for (const res of [session, bearer]) {
      expect([res.status, res.body.detail], JSON.stringify(res.body)).toStrictEqual([404, ONLY_A_LINK.detail]);
    }
  });
});

describe('the live WebSocket', () => {
  /**
   * The gateway authenticates a session itself and never sees this scheme
   * (section 5.5): a handshake carrying only a link is closed exactly as one
   * carrying nothing, with no frame first.
   */
  it('closes a handshake carrying only a PublicLink header, unauthenticated', async () => {
    await setSwitch(true);
    const runId = await seedRun();
    const { secret } = await makeLink(runId);
    const port = (ctx.app.getHttpServer().address() as AddressInfo).port;

    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/runs/${runId}/live`, {
      headers: { authorization: `PublicLink ${secret}` },
    });
    const frames: unknown[] = [];
    socket.on('message', (data) => frames.push(String(data)));
    const closed = await new Promise<number>((resolveClose) => {
      socket.on('error', () => resolveClose(0));
      socket.on('close', (code) => resolveClose(code));
    });

    expect(closed).toBe(CLOSE_UNAUTHORIZED);
    expect(frames).toHaveLength(0);
  });
});
