import { randomUUID } from 'node:crypto';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import {
  ACCESS_ACTIONS,
  PROJECT_ROLES,
  type AccessAction,
  type AccessRole,
  type ProjectRole,
} from '@perfportal/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { BEARER_ONLY_KEY, NOT_PROJECT_SCOPED_KEY, REQUIRES_KEY } from '../src/auth/access.decorator.js';
import { IS_PUBLIC_KEY, SCOPES_KEY } from '../src/auth/scopes.decorator.js';
import { SessionOnlyGuard } from '../src/auth/session-only.guard.js';
import { projectNotFound, runNotFound } from '../src/common/validation.js';
import { buildOpenApiDocument } from '../src/openapi/document.js';
import { createTestApp, type TestContext } from './support/app.js';
import { signInAsAdmin, signInAsProjectMember } from './support/session.js';

/*
 * ═══ EVERY ROUTE DECLARES WHO MAY CALL IT, AND THE TABLE IS WHAT ANSWERS ═══
 * (docs/superpowers/specs/2026-10-07-project-access-design.md, section 2)
 *
 * `AccessGuard` judges a session only on a route carrying `@Requires`, so a
 * route that forgot the decorator is open to every session in the org, and
 * nothing about it looks wrong. The groups below therefore start from Nest's
 * own metadata on every controller `AppModule` registers — the walk
 * `openapi.integration.test.ts` uses — rather than a list of routes kept by
 * hand: a route added later joins these checks by existing. They check that
 * each route declares one way in, that its token scope agrees with its
 * action's row, that a project action names its project, and that the
 * document declares the refusals the guard can now send.
 *
 * The role matrix then drives one representative request per declared action
 * through the real app, for each kind of caller, and the last group checks the
 * bearer path did not move.
 */

interface WalkedRoute {
  /** `PUT /v1/runs/:id/note`: the verb, and the controller prefix joined to the handler's path. */
  readonly label: string;
  readonly path: string;
  readonly requires: AccessAction | undefined;
  readonly bearerOnly: boolean;
  readonly notProjectScoped: boolean;
  readonly isPublic: boolean;
  /** `@Scopes` as `AuthGuard` reads it: the handler's, else the class's. */
  readonly scopes: readonly string[] | undefined;
  /** `SessionOnlyGuard` on the handler or its class. */
  readonly sessionOnly: boolean;
}

/**
 * Read off metadata the way the guards read it: `getAllAndOverride` over
 * `[handler, class]` is "the handler's value, else the class's", and that is
 * what `??` below spells.
 */
function walkRoutes(): WalkedRoute[] {
  const seen = new Set<unknown>();
  const out: WalkedRoute[] = [];
  const guardedBySessionOnly = (target: object): boolean =>
    ((Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? []).includes(SessionOnlyGuard);

  const walk = (mod: unknown): void => {
    if (!mod || seen.has(mod)) return;
    seen.add(mod);
    const controllers: unknown[] = Reflect.getMetadata('controllers', mod as object) ?? [];
    for (const c of controllers) {
      const cls = c as { prototype: object };
      const prefix: string = Reflect.getMetadata(PATH_METADATA, cls) ?? '';
      for (const key of Object.getOwnPropertyNames(cls.prototype)) {
        if (key === 'constructor') continue;
        const fn = (cls.prototype as Record<string, unknown>)[key];
        if (typeof fn !== 'function') continue;
        const sub: string | undefined = Reflect.getMetadata(PATH_METADATA, fn);
        const verb: number | undefined = Reflect.getMetadata(METHOD_METADATA, fn);
        if (sub === undefined || verb === undefined) continue;
        const path = `/${[prefix, sub].filter((x) => x && x !== '/').join('/')}`
          .replace(/\/+/g, '/')
          .replace(/(.)\/$/, '$1');
        const meta = <T>(k: string): T | undefined =>
          (Reflect.getMetadata(k, fn) as T | undefined) ?? (Reflect.getMetadata(k, cls) as T | undefined);
        out.push({
          label: `${RequestMethod[verb]} ${path}`,
          path,
          requires: meta<AccessAction>(REQUIRES_KEY),
          bearerOnly: meta<boolean>(BEARER_ONLY_KEY) === true,
          notProjectScoped: meta<boolean>(NOT_PROJECT_SCOPED_KEY) === true,
          isPublic: meta<boolean>(IS_PUBLIC_KEY) === true,
          scopes: meta<string[]>(SCOPES_KEY),
          sessionOnly: guardedBySessionOnly(cls) || guardedBySessionOnly(fn),
        });
      }
    }
    const imports: unknown[] = Reflect.getMetadata('imports', mod as object) ?? [];
    for (const im of imports) walk((im as { module?: unknown })?.module ?? im);
  };
  walk(AppModule);
  return out;
}

const ROUTES = walkRoutes();

/** Where the run routes live. A run names its project through the run row. */
const isRunRoute = (path: string): boolean => path === '/v1/runs/:id' || path.startsWith('/v1/runs/:id/');

describe('every route declares how it is reached', () => {
  /**
   * The vacuity floor counts routes FOUND, never routes that passed: a walk
   * that matched nothing would otherwise report "no undeclared routes", which
   * reads exactly like a clean tree. The real count is above 40 by a margin.
   */
  it('collects the app’s routes', () => {
    expect(ROUTES.length, 'the route walk found too few routes — it has rotted').toBeGreaterThan(40);
  });

  it('gives each route exactly one of @Requires, @BearerOnly, @NotProjectScoped and @Public', () => {
    const wrong = ROUTES.map((r) => ({
      label: r.label,
      markers: [
        r.requires === undefined ? null : `@Requires('${r.requires}')`,
        r.bearerOnly ? '@BearerOnly' : null,
        r.notProjectScoped ? '@NotProjectScoped' : null,
        r.isPublic ? '@Public' : null,
      ].filter((m): m is string => m !== null),
    }))
      .filter((r) => r.markers.length !== 1)
      .map((r) => `${r.label}: ${r.markers.length === 0 ? 'none' : r.markers.join(' + ')}`)
      .sort();
    expect(wrong, `routes that do not declare exactly one way in:\n${wrong.join('\n')}`).toEqual([]);
  });

  /**
   * A pair the rule above already refuses, named on its own because what it
   * would MEAN is worse than a missing marker: `AccessGuard` returns true when
   * there is no tenant, and `@Public` is what leaves a route with none — so a
   * route carrying both would be public, silently, while reading as guarded.
   */
  it('lets no route carry both @Public and @Requires', () => {
    const both = ROUTES.filter((r) => r.isPublic && r.requires !== undefined).map((r) => r.label).sort();
    expect(both, `routes that are @Public AND @Requires — public in effect:\n${both.join('\n')}`).toEqual([]);
  });
});

describe('each route’s token scope agrees with its action', () => {
  /**
   * ONE TABLE FOR BOTH CREDENTIALS. `ACCESS_ACTIONS` gives each action the
   * scope a bearer token needs for it, or `null` for "no token, ever". The
   * bearer path is decided by `@Scopes` and `SessionOnlyGuard`, which this
   * change does not touch — so the two are joined here, and a route whose
   * scope says one thing while its action's row says another fails naming
   * both.
   */
  it('takes exactly the table’s scope, or is session-only where the table names none', () => {
    const declared = ROUTES.filter((r) => r.requires !== undefined);
    const withScope = declared.filter((r) => ACCESS_ACTIONS[r.requires!].scope !== null);
    const sessionOnly = declared.filter((r) => ACCESS_ACTIONS[r.requires!].scope === null);
    // Both halves have to have been checked for "no disagreement" to mean anything.
    expect(withScope.length, 'no @Requires route has a token scope — nothing was checked').toBeGreaterThan(5);
    expect(sessionOnly.length, 'no @Requires route is session-only — nothing was checked').toBeGreaterThan(5);

    const disagree = [
      ...withScope
        .filter((r) => JSON.stringify(r.scopes ?? []) !== JSON.stringify([ACCESS_ACTIONS[r.requires!].scope]))
        .map((r) => `${r.label}: ${r.requires} takes "${ACCESS_ACTIONS[r.requires!].scope}", @Scopes is ${JSON.stringify(r.scopes ?? [])}`),
      ...sessionOnly
        .filter((r) => !r.sessionOnly)
        .map((r) => `${r.label}: ${r.requires} is session-only, and neither the route nor its class carries SessionOnlyGuard`),
    ].sort();
    expect(disagree, disagree.join('\n')).toEqual([]);
  });
});

describe('a project action sits on a route that names its project', () => {
  /**
   * `AccessGuard` finds the project from `:slug`, or from the run under
   * `/v1/runs/:id`; a project action on a route with neither is a 500 at
   * request time. Asserted here, so it is a failing test instead.
   */
  it('puts every non-admin action on a :slug route or under /v1/runs/:id', () => {
    const projectActions = ROUTES.filter((r) => r.requires !== undefined && ACCESS_ACTIONS[r.requires].role !== 'admin');
    expect(projectActions.length).toBeGreaterThan(20);
    const unnamed = projectActions
      .filter((r) => !r.path.split('/').includes(':slug') && !isRunRoute(r.path))
      .map((r) => `${r.label}: ${r.requires}`)
      .sort();
    expect(unnamed, unnamed.join('\n')).toEqual([]);
  });
});

describe('the document names the refusals the guard sends', () => {
  /**
   * A generated client branches on the documented 403 and 404. Every
   * `@Requires` route can now send ROLE_REQUIRED or ADMIN_REQUIRED, and every
   * project action the not-yours 404, so each such operation's 403 must be a
   * response whose description names both codes, and a project action's
   * operation must declare a 404. Read off the routes, so a route annotated
   * later is held to it by existing.
   */
  it('gives every @Requires operation a 403 naming both codes, and every project action a 404', () => {
    type Op = { responses?: Record<string, { $ref?: string; description?: string }> };
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, Op>>;
      components: { responses: Record<string, { description?: string }> };
    };
    const shape = (path: string) => path.replace(/:[A-Za-z0-9_]+/g, '{}');
    const ops = new Map<string, Op>();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [verb, op] of Object.entries(item)) ops.set(`${verb.toUpperCase()} ${path.replace(/\{[^}]+\}/g, '{}')}`, op);
    }
    const describeResponse = (r: { $ref?: string; description?: string } | undefined): string =>
      r?.$ref ? (doc.components.responses[r.$ref.replace('#/components/responses/', '')]?.description ?? '') : (r?.description ?? '');

    const declared = ROUTES.filter((r) => r.requires !== undefined);
    expect(declared.length).toBeGreaterThan(20);
    const gaps: string[] = [];
    for (const r of declared) {
      const [verb] = r.label.split(' ');
      const op = ops.get(`${verb} ${shape(r.path)}`);
      if (op === undefined) {
        gaps.push(`${r.label}: no operation`);
        continue;
      }
      const forbidden = describeResponse(op.responses?.['403']);
      if (!forbidden.includes('ROLE_REQUIRED') || !forbidden.includes('ADMIN_REQUIRED')) {
        gaps.push(`${r.label}: its 403 does not name ROLE_REQUIRED and ADMIN_REQUIRED`);
      }
      if (ACCESS_ACTIONS[r.requires!].role !== 'admin' && op.responses?.['404'] === undefined) {
        gaps.push(`${r.label}: a project action with no 404`);
      }
    }
    expect(gaps, gaps.join('\n')).toEqual([]);
  });
});

/*
 * ═══ THE ROLE MATRIX ═══
 *
 * Two projects in one org: A (`checkout`, the fixture's) and B (`search`),
 * each holding a run. For every action some route declares, one
 * representative request, sent by:
 *
 *   - the lowest role the spec gives the action, in A — it passes the
 *     guard: not a 403, and not the 404 an invisible project or run gets;
 *   - the role just below it, in A — 403 ROLE_REQUIRED naming the role it
 *     needs. Only member- and manager-level actions have one; a viewer-level
 *     action's "below" is holding no role at all, which is the next row. For
 *     an admin action it is a manager of A, refused ADMIN_REQUIRED;
 *   - two outsiders: a manager of B, and a member of no project. For a
 *     project action each gets a 404 whose body, traceId aside and the target
 *     masked, is the body the SAME request gets for a project or run that
 *     does not exist — so neither membership nor existence can be probed
 *     (Review Focus 2). For an admin action, ADMIN_REQUIRED;
 *   - an admin with no project row — passes.
 *
 * An invalid body is enough wherever the guard runs before validation: a
 * caller who passes the guard then meets the controller's own 400, which is
 * how "passed" is told apart from "refused" without creating anything.
 */

type Verb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Probe {
  readonly action: AccessAction;
  /**
   * The lowest role the spec's permission table gives this action, WRITTEN
   * HERE rather than read from `ACCESS_ACTIONS`. The guard reads that table;
   * a matrix taking its expectations from the same row would agree with the
   * guard whatever the row said, so a table edit that hands viewers an edit
   * action would pass it. Spelled out, that edit fails the row below.
   */
  readonly role: AccessRole;
  /** The route, spelled as the walk spells it; the matrix asserts that route declares `action`. */
  readonly route: `${Verb} /${string}`;
  readonly body?: object;
}

const PROBES: readonly Probe[] = [
  { action: 'project:read', role: 'viewer', route: 'GET /v1/projects/:slug/tests' },
  { action: 'rules:read', role: 'viewer', route: 'GET /v1/projects/:slug/rules' },
  { action: 'run:note', role: 'member', route: 'PUT /v1/runs/:id/note', body: {} },
  { action: 'run:upload', role: 'member', route: 'POST /v1/projects/:slug/runs' },
  { action: 'runner:run', role: 'member', route: 'POST /v1/projects/:slug/runner/runs' },
  { action: 'packages:manage', role: 'member', route: 'POST /v1/projects/:slug/packages' },
  { action: 'packages:delete', role: 'member', route: 'DELETE /v1/projects/:slug/packages/:packageId' },
  { action: 'rules:edit', role: 'member', route: 'POST /v1/projects/:slug/rules', body: {} },
  { action: 'tests:manage', role: 'manager', route: 'PATCH /v1/projects/:slug/tests/:testSlug', body: {} },
  { action: 'tokens:manage', role: 'manager', route: 'GET /v1/projects/:slug/tokens' },
  { action: 'projects:create', role: 'admin', route: 'POST /v1/projects', body: {} },
];

/** What a request's path parameters are filled with: project A and its run, or targets that do not exist. */
interface Target {
  readonly slug: string;
  readonly runId: string;
}

/** A package id no project holds: a well-formed uuid, so it reaches past `uuidParam` to the lookup. */
const NO_PACKAGE = randomUUID();

function fill(route: string, target: Target): { verb: Verb; url: string } {
  const [verb, template] = route.split(' ') as [Verb, string];
  const url = template
    .replace(':slug', target.slug)
    .replace(':id', target.runId)
    .replace(':packageId', NO_PACKAGE)
    .replace(':testSlug', 'missing');
  return { verb, url };
}

/** A problem body with its traceId dropped and the caller-supplied target masked. */
function masked(body: Record<string, unknown>, identifier: string): Record<string, unknown> {
  const { traceId, ...rest } = body;
  expect(typeof traceId).toBe('string');
  return JSON.parse(JSON.stringify(rest).replaceAll(identifier, '<target>')) as Record<string, unknown>;
}

const capitalised = (role: string): string => `${role.charAt(0).toUpperCase()}${role.slice(1)}`;

describe('the role matrix', () => {
  let ctx: TestContext;
  let A: Target;
  /** No such project, and a well-formed run id no org holds. */
  let MISSING: Target;
  let bRunId: string;
  const cookies = {} as Record<'admin' | ProjectRole | 'outsiderB' | 'outsiderNone', string>;
  const OUTSIDERS = [
    { key: 'outsiderB', who: 'manager of another project' },
    { key: 'outsiderNone', who: 'member of no project' },
  ] as const;

  async function seedRun(projectId: string): Promise<string> {
    const run = await ctx.prisma.run.create({
      data: {
        orgId: ctx.orgId,
        projectId,
        status: 'complete',
        verdict: 'not_evaluated',
        tool: 'gatling',
        bundleKey: `runs/${projectId}/${randomUUID()}.tgz`,
        bundleSha256: 'a'.repeat(64),
        bundleBytes: 1n,
        startedAt: new Date('2026-10-07T09:00:00Z'),
        startedOn: new Date('2026-10-07T00:00:00Z'),
        engineOptions: {},
      },
    });
    return run.id;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    const b = await ctx.prisma.project.create({
      data: { orgId: ctx.orgId, slug: 'search', name: 'Search', settings: {} },
    });
    A = { slug: 'checkout', runId: await seedRun(ctx.projectId) };
    bRunId = await seedRun(b.id);
    MISSING = { slug: 'no-such-project', runId: randomUUID() };

    const email = (who: string) => `${who}-${randomUUID()}@example.test`;
    cookies.admin = (await signInAsAdmin(ctx, email('admin'))).cookie;
    for (const role of PROJECT_ROLES) {
      cookies[role] = (await signInAsProjectMember(ctx, email(role), [{ projectId: ctx.projectId, role }])).cookie;
    }
    cookies.outsiderB = (await signInAsProjectMember(ctx, email('outsider-b'), [{ projectId: b.id, role: 'manager' }])).cookie;
    cookies.outsiderNone = (await signInAsProjectMember(ctx, email('outsider-none'), [])).cookie;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /**
   * A DEADLINE ON EVERY REQUEST. Several of these routes read their own
   * request body as a stream, and one that waits for bytes nobody sends does
   * not fail — it hangs, and takes the file's whole timeout with it.
   */
  function send(verb: Verb, url: string, cookie: string, body?: object): request.Test {
    const server = ctx.app.getHttpServer();
    const req =
      verb === 'GET'
        ? request(server).get(url)
        : verb === 'POST'
          ? request(server).post(url)
          : verb === 'PUT'
            ? request(server).put(url)
            : verb === 'PATCH'
              ? request(server).patch(url)
              : request(server).delete(url);
    req.set('Cookie', cookie).timeout({ deadline: 15_000, response: 15_000 });
    return body === undefined ? req : req.send(body);
  }

  const probe = (p: Probe, target: Target, cookie: string) => {
    const { verb, url } = fill(p.route, target);
    return send(verb, url, cookie, p.body);
  };

  /** The guard let the request through: no refusal, and not the answer an invisible target gets. */
  function expectPassed(res: request.Response, why: string): void {
    expect(res.status, `${why}: ${res.status} ${JSON.stringify(res.body)}`).not.toBe(403);
    expect(res.status, `${why}: ${res.status} ${JSON.stringify(res.body)}`).toBeLessThan(500);
    expect(res.body?.detail, why).not.toBe(projectNotFound(A.slug).message);
    expect(res.body?.detail, why).not.toBe(runNotFound(A.runId).message);
  }

  /**
   * VACUITY, both ways: every action a route declares has a probe, and every
   * probe's route really declares its action. The first keeps a newly
   * annotated action from going unexercised; the second keeps a probe from
   * quietly testing a route that no longer carries what it claims.
   */
  it('covers every action a route declares, each through a route that declares it', () => {
    const declared = [...new Set(ROUTES.map((r) => r.requires).filter((a): a is AccessAction => a !== undefined))].sort();
    expect([...new Set(PROBES.map((p) => p.action))].sort()).toEqual(declared);
    for (const p of PROBES) {
      expect(ROUTES.find((r) => r.label === p.route)?.requires, p.route).toBe(p.action);
    }
  });

  for (const p of PROBES) {
    const { role } = p;
    const { label } = ACCESS_ACTIONS[p.action];

    describe(`${p.action} — ${p.route}`, () => {
      if (role === 'admin') {
        it('refuses a manager of the project ADMIN_REQUIRED', async () => {
          const res = await probe(p, A, cookies.manager);
          expect([res.status, res.body.code, res.body.detail]).toStrictEqual([403, 'ADMIN_REQUIRED', `${label} needs an admin.`]);
        });

        for (const { key, who } of OUTSIDERS) {
          it(`refuses a ${who} ADMIN_REQUIRED`, async () => {
            const res = await probe(p, A, cookies[key]);
            expect([res.status, res.body.code]).toStrictEqual([403, 'ADMIN_REQUIRED']);
          });
        }
      } else {
        it(`passes the ${role} it asks for`, async () => {
          expectPassed(await probe(p, A, cookies[role]), `${role} of A`);
        });

        const below = PROJECT_ROLES[PROJECT_ROLES.indexOf(role) - 1];
        if (below !== undefined) {
          it(`refuses the ${below} below it ROLE_REQUIRED, naming ${capitalised(role)}`, async () => {
            const res = await probe(p, A, cookies[below]);
            expect([res.status, res.body.code, res.body.detail]).toStrictEqual([
              403,
              'ROLE_REQUIRED',
              `${label} needs the ${capitalised(role)} role in this project.`,
            ]);
          });
        }

        const onRun = isRunRoute(p.route.split(' ')[1]!);
        for (const { key, who } of OUTSIDERS) {
          it(`answers a ${who} with the 404 a nonexistent ${onRun ? 'run' : 'project'} gets`, async () => {
            const invisible = await probe(p, A, cookies[key]);
            const missing = await probe(p, MISSING, cookies[key]);

            expect([invisible.status, invisible.body.detail]).toStrictEqual([
              404,
              onRun ? runNotFound(A.runId).message : projectNotFound(A.slug).message,
            ]);
            expect(
              masked(missing.body, onRun ? MISSING.runId : MISSING.slug),
              'an invisible target answered differently from a missing one',
            ).toStrictEqual(masked(invisible.body, onRun ? A.runId : A.slug));
          });
        }
      }

      it('passes an admin who holds no project row', async () => {
        expectPassed(await probe(p, A, cookies.admin), 'admin');
      });
    });
  }

  /*
   * ═══ A PIPE OR A BODY CHECK MUST NOT ANSWER FIRST ═══
   *
   * The probes above use a well-formed target, so for an outsider the request
   * never gets past the guard to anything that could answer differently. These
   * send what WOULD be refused after the guard — a malformed sub-parameter, an
   * invalid body — and require that an outsider still gets the same 404 for a
   * real target as for a missing one. A member of A gets the later refusal,
   * which is what proves the route really has a pipe or a body check to reach.
   */
  describe('an outsider meets the 404 before any pipe or body check', () => {
    const malformedSubParam = [
      'DELETE /v1/projects/:slug/packages/not-a-uuid',
      'DELETE /v1/projects/:slug/rules/not-a-uuid',
    ] as const;

    for (const route of malformedSubParam) {
      it(`${route}: the same 404 for a real project as for a missing one`, async () => {
        const reached = fill(route, A);
        const asMember = await send(reached.verb, reached.url, cookies.member);
        expect([asMember.status, asMember.body.code]).toStrictEqual([400, 'INVALID_ID']);

        for (const { key } of OUTSIDERS) {
          const invisible = await send(reached.verb, reached.url, cookies[key]);
          const missing = fill(route, MISSING);
          const absent = await send(missing.verb, missing.url, cookies[key]);
          expect([invisible.status, invisible.body.detail], key).toStrictEqual([404, projectNotFound(A.slug).message]);
          expect(masked(absent.body, MISSING.slug), key).toStrictEqual(masked(invisible.body, A.slug));
        }
      });
    }

    it('PUT /v1/runs/:id/note with an invalid body: the same 404 for a real run as for a missing one', async () => {
      const asMember = await send('PUT', `/v1/runs/${A.runId}/note`, cookies.member, { bogus: 1 });
      expect([asMember.status, asMember.body.code]).toStrictEqual([400, 'INVALID_RUN_NOTE']);

      for (const { key } of OUTSIDERS) {
        const invisible = await send('PUT', `/v1/runs/${A.runId}/note`, cookies[key], { bogus: 1 });
        const missing = await send('PUT', `/v1/runs/${MISSING.runId}/note`, cookies[key], { bogus: 1 });
        expect([invisible.status, invisible.body.detail], key).toStrictEqual([404, runNotFound(A.runId).message]);
        expect(masked(missing.body, MISSING.runId), key).toStrictEqual(masked(invisible.body, A.runId));
      }
    });

    /**
     * ONE 404 ON THE RUN SURFACE. An admin passes the guard, so a missing run
     * is answered by the note handler's own lookup; an outsider is answered by
     * the guard. The handler used to word its 404 "…in this organisation." —
     * so one route had two answers to "no such run", depending on who asked.
     */
    it('answers a missing run on the note route with one body, whether the guard or the handler says it', async () => {
      const id = randomUUID();
      const fromHandler = await send('PUT', `/v1/runs/${id}/note`, cookies.admin, { note: 'x' });
      const fromGuard = await send('PUT', `/v1/runs/${id}/note`, cookies.outsiderB, { note: 'x' });
      expect([fromHandler.status, fromHandler.body.detail]).toStrictEqual([404, runNotFound(id).message]);
      expect(masked(fromHandler.body, id)).toStrictEqual(masked(fromGuard.body, id));
    });

    /**
     * B's run, from A's member: the other direction of the same rule, and the
     * one that checks the guard asked about the RUN's project rather than
     * about whichever project the caller holds.
     */
    it('answers a member of A asking for B’s run with the 404 a missing run gets', async () => {
      const invisible = await send('GET', `/v1/runs/${bRunId}`, cookies.member);
      const missing = await send('GET', `/v1/runs/${MISSING.runId}`, cookies.member);
      expect([invisible.status, invisible.body.detail]).toStrictEqual([404, runNotFound(bRunId).message]);
      expect(masked(missing.body, MISSING.runId)).toStrictEqual(masked(invisible.body, bRunId));
    });

    /**
     * A malformed run id names no run, so its 400 reveals nothing — and every
     * caller gets it, member or not. The one target the guard leaves to the
     * controller.
     */
    it('answers a malformed run id 400 INVALID_ID for a member and an outsider alike', async () => {
      for (const key of ['member', 'outsiderB', 'outsiderNone'] as const) {
        const read = await send('GET', '/v1/runs/not-a-uuid', cookies[key]);
        const note = await send('PUT', '/v1/runs/not-a-uuid/note', cookies[key], { note: 'x' });
        expect([read.status, read.body.code, note.status, note.body.code], key).toStrictEqual([
          400,
          'INVALID_ID',
          400,
          'INVALID_ID',
        ]);
      }
    });
  });

  /*
   * ═══ THE BEARER PATH DID NOT MOVE ═══
   *
   * `AccessGuard` returns true for every tenant that is not a session; a
   * token's reach is still its one project and its scopes. A read token for A
   * reads A's tests and A's run exactly as before.
   */
  describe('bearer tokens', () => {
    it('lets a read token for A read A’s tests and A’s run', async () => {
      const server = ctx.app.getHttpServer();
      const auth = { Authorization: `Bearer ${ctx.readToken}` };
      const tests = await request(server).get(`/v1/projects/${A.slug}/tests`).set(auth);
      const run = await request(server).get(`/v1/runs/${A.runId}`).set(auth);
      expect([tests.status, run.status]).toStrictEqual([200, 200]);
    });
  });
});
