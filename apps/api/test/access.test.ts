// First, for the decorators below: see test/support/app.ts.
import 'reflect-metadata';
import { Controller, Delete, Get, Post, Put, type ArgumentsHost, type Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { PROJECT_ROLES, type AccessRole, type ProjectRole } from '@perfportal/contracts';
import { RunRepository, type ProjectRecord, type ProjectRepository } from '@perfportal/persistence';
import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { accessDecision, canSeeProject, listScope, loadSessionAccess } from '../src/auth/access.js';
import { Requires } from '../src/auth/access.decorator.js';
import { AccessGuard } from '../src/auth/access.guard.js';
import type { Tenant } from '../src/auth/auth.guard.js';
import { ProblemFilter } from '../src/common/problem.filter.js';
import { accessDenied, projectNotFound, runNotFound, uuidParam } from '../src/common/validation.js';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

/** Shaped exactly as `authenticateSession` and `authenticateRequest` build each kind. */
function session(fields: Pick<Tenant, 'isAdmin' | 'projectRoles' | 'projectIds'>): Tenant {
  return { orgId: ORG, tokenId: 'session:s1', userId: 'u1', scopes: ['read', 'ingest', 'runner'], ...fields };
}

function nonAdmin(roles: ReadonlyArray<[string, ProjectRole]>): Tenant {
  const projectRoles = new Map(roles);
  return session({ isAdmin: false, projectRoles, projectIds: [...projectRoles.keys()] });
}

const admin = session({ isAdmin: true, projectRoles: new Map() });
const bearer: Tenant = { orgId: ORG, projectId: A, tokenId: 'tok-1', scopes: ['read'] };

describe('listScope', () => {
  it("copies a non-admin session's project list", () => {
    expect(listScope(nonAdmin([[A, 'viewer']]))).toStrictEqual({ orgId: ORG, projectIds: [A] });
  });

  /**
   * `[]` and absent mean OPPOSITE things to `visibilityClause`: `[]` sees
   * nothing, absent sees the org. A member of no project has to arrive as
   * `[]`, never be tidied away into absence.
   */
  it('keeps an empty list for a session that belongs to no project', () => {
    expect(listScope(nonAdmin([]))).toStrictEqual({ orgId: ORG, projectIds: [] });
  });

  /**
   * Fails closed. `authenticateSession` always sets the list for a non-admin,
   * so this tenant cannot be built today; if a later change drops it, the
   * session must see nothing rather than the whole org.
   */
  it('narrows a non-admin session that carries no list to nothing', () => {
    expect(listScope(session({ isAdmin: false, projectRoles: new Map() }))).toStrictEqual({
      orgId: ORG,
      projectIds: [],
    });
  });

  /**
   * The same decision tree `canSeeProject` follows, and for the same reason.
   * A tenant that is neither a bearer token (no `projectId`) nor marked admin
   * is what a session built WITHOUT `loadSessionAccess` looks like — a spread
   * dropped in a refactor, or a new path that never called it. `{ orgId }`
   * alone would be every project in the org; it has to be nothing.
   */
  it('narrows a tenant that is neither a bearer token nor an admin to nothing', () => {
    expect(listScope({ orgId: ORG, tokenId: 'session:s1', scopes: ['read'] })).toStrictEqual({
      orgId: ORG,
      projectIds: [],
    });
  });

  it('omits the list for an admin, who sees every project in the org', () => {
    expect(listScope(admin)).toStrictEqual({ orgId: ORG });
  });

  it('omits the list for a bearer token, which names its one project instead', () => {
    expect(listScope(bearer)).toStrictEqual({ orgId: ORG, projectId: A });
  });
});

describe('canSeeProject', () => {
  it('is false for a session holding roles only in another project', () => {
    expect(canSeeProject(nonAdmin([[A, 'manager']]), B)).toBe(false);
  });

  it('is true for a session holding any role in the project', () => {
    expect(canSeeProject(nonAdmin([[B, 'viewer']]), B)).toBe(true);
  });

  it('is false for a session that belongs to no project', () => {
    expect(canSeeProject(nonAdmin([]), A)).toBe(false);
  });

  it('is true for an admin holding no role anywhere', () => {
    expect(canSeeProject(admin, B)).toBe(true);
  });

  it("is true for a bearer token in its own project and false in any other", () => {
    expect(canSeeProject(bearer, A)).toBe(true);
    expect(canSeeProject(bearer, B)).toBe(false);
  });
});

describe('loadSessionAccess', () => {
  it('reads an admin from the role alone, without asking for project roles', async () => {
    const rolesForUser = vi.fn();

    const access = await loadSessionAccess({ id: 'u1', role: 'admin' }, { rolesForUser });

    expect(access).toStrictEqual({ isAdmin: true, projectRoles: new Map() });
    expect(rolesForUser).not.toHaveBeenCalled();
  });

  it("lists a non-admin's projects from one read of their roles", async () => {
    const roles = new Map<string, ProjectRole>([[A, 'member'], [B, 'viewer']]);
    const rolesForUser = vi.fn(async () => roles);

    const access = await loadSessionAccess({ id: 'u1', role: 'user' }, { rolesForUser });

    expect(access).toStrictEqual({ isAdmin: false, projectRoles: roles, projectIds: [A, B] });
    expect(rolesForUser).toHaveBeenCalledTimes(1);
    expect(rolesForUser).toHaveBeenCalledWith('u1');
  });

  it('gives a member of no project an empty list, not an absent one', async () => {
    const access = await loadSessionAccess({ id: 'u1', role: 'user' }, { rolesForUser: async () => new Map() });

    expect(access.isAdmin).toBe(false);
    expect(access.projectIds).toStrictEqual([]);
  });

  /**
   * The admin flag is EXACTLY `'admin'`. A role the plugin never wrote — or no
   * role at all, on a row that predates the column — is an ordinary account.
   */
  it.each([['user'], ['Admin'], [null], [undefined]])('treats role %s as not an admin', async (role) => {
    const access = await loadSessionAccess({ id: 'u1', role }, { rolesForUser: async () => new Map() });

    expect(access.isAdmin).toBe(false);
  });
});

describe('accessDecision', () => {
  const EVERY_ROLE: ReadonlyArray<ProjectRole | null> = [null, ...PROJECT_ROLES];

  it('lets an admin through every action, holding a role or not', () => {
    for (const required of [...PROJECT_ROLES, 'admin'] as AccessRole[]) {
      for (const role of EVERY_ROLE) {
        expect(accessDecision({ required, isAdmin: true, role }), `${required} / ${role}`).toBe('allow');
      }
    }
  });

  it('lets a viewer meet viewer and nothing above it', () => {
    expect(accessDecision({ required: 'viewer', isAdmin: false, role: 'viewer' })).toBe('allow');
    expect(accessDecision({ required: 'member', isAdmin: false, role: 'viewer' })).toBe('role-required');
    expect(accessDecision({ required: 'manager', isAdmin: false, role: 'viewer' })).toBe('role-required');
  });

  it('lets each role meet its own rank and the ranks below it', () => {
    expect(accessDecision({ required: 'member', isAdmin: false, role: 'member' })).toBe('allow');
    expect(accessDecision({ required: 'viewer', isAdmin: false, role: 'member' })).toBe('allow');
    expect(accessDecision({ required: 'manager', isAdmin: false, role: 'member' })).toBe('role-required');
    for (const required of PROJECT_ROLES) {
      expect(accessDecision({ required, isAdmin: false, role: 'manager' }), required).toBe('allow');
    }
  });

  /**
   * No role is not a LOW role: the project is one this person cannot see, so
   * the answer is the 404 a project that does not exist gets — never a 403
   * that would confirm it does.
   */
  it('answers not-found to a non-member for every project action', () => {
    for (const required of PROJECT_ROLES) {
      expect(accessDecision({ required, isAdmin: false, role: null }), required).toBe('not-found');
    }
  });

  it('refuses an admin action to a non-admin, even a manager', () => {
    for (const role of EVERY_ROLE) {
      expect(accessDecision({ required: 'admin', isAdmin: false, role }), String(role)).toBe('admin-required');
    }
  });
});

const RUN = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

/** The body `ProblemFilter` would send, without its per-request traceId. */
function problemOf(err: unknown): Record<string, unknown> {
  let sent: Record<string, unknown> = {};
  const res = { status: () => ({ type: () => ({ send: (body: Record<string, unknown>) => void (sent = body) }) }) };
  new ProblemFilter().catch(err, { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost);
  const body = { ...sent };
  delete body.traceId;
  return body;
}

describe('the shared 404s and 403', () => {
  /**
   * The wording every controller already sent, byte for byte. `AccessGuard`
   * answers a project or run the caller cannot see with these SAME helpers,
   * so the two cases are indistinguishable; a reworded helper would move
   * every one of those responses at once.
   */
  it('words a project the caller cannot reach exactly as the controllers always have', () => {
    expect(problemOf(projectNotFound('checkout'))).toStrictEqual({
      type: 'https://perfportal.dev/errors/NOT_FOUND',
      title: 'not found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'No project "checkout" in this organisation.',
      remediation: 'Check the slug, or list the projects this credential can reach with GET /v1/projects.',
    });
  });

  it('words a run the caller cannot reach exactly as the controllers always have', () => {
    expect(problemOf(runNotFound(RUN))).toStrictEqual({
      type: 'https://perfportal.dev/errors/NOT_FOUND',
      title: 'not found',
      status: 404,
      code: 'NOT_FOUND',
      detail: `No run ${RUN} in this project.`,
      remediation:
        'Check the run id. GET /v1/runs lists the runs a signed-in user can reach; '
        + 'GET /v1/projects/{slug}/runs lists those a project token can.',
    });
  });

  it('carries its own code on a 403', () => {
    expect(problemOf(accessDenied('ROLE_REQUIRED', 'Detail.', 'Fix.'))).toMatchObject({
      status: 403,
      code: 'ROLE_REQUIRED',
      detail: 'Detail.',
      remediation: 'Fix.',
    });
  });
});

/* ═══ THE GUARD ═══ */

const CHECKOUT = { id: A, orgId: ORG, slug: 'checkout', name: 'Checkout' } as ProjectRecord;

@Controller('/v1/projects/:slug/rules')
class SlugRoutes {
  @Get() @Requires('rules:read') read(): void {}
  @Post() @Requires('rules:edit') edit(): void {}
  @Delete(':ruleId') @Requires('tests:manage') manage(): void {}
  @Get('open') open(): void {}
}

@Controller('/v1/runs')
class RunRoutes {
  @Put(':id/note') @Requires('run:note') note(): void {}
}

@Controller('/v1/runs/:id')
class RunScopedRoutes {
  @Get('stats') @Requires('project:read') stats(): void {}
}

@Controller('/v1/admin/users')
class AdminRoutes {
  @Post() @Requires('users:manage') create(): void {}
}

/** Declares a project action on a route that names no project to judge it in. */
@Controller('/v1/elsewhere')
class MisdeclaredRoutes {
  @Get(':thing') @Requires('project:read') read(): void {}
}

/** A repository that fails the test if the guard asks it anything. */
function untouched<T>(): T {
  return new Proxy({}, {
    get(_t, prop) {
      throw new Error(`the guard made a lookup it should not have (${String(prop)})`);
    },
  }) as T;
}

function guardWith(opts: {
  projects?: Pick<ProjectRepository, 'findBySlugInOrg'>;
  runs?: Pick<RunRepository, 'projectIdOf'>;
} = {}): AccessGuard {
  return new AccessGuard(
    new Reflector(),
    (opts.projects ?? untouched<ProjectRepository>()) as ProjectRepository,
    (opts.runs ?? untouched<RunRepository>()) as RunRepository,
  );
}

/** Nest's own context class, so the guard reads route metadata as it will at runtime. */
function call<C>(controller: Type<C>, handler: keyof C & string, tenant: Tenant | undefined, params: Record<string, string> = {}) {
  const req = { tenant, params } as unknown as Request;
  const fn = (controller.prototype as Record<string, (...args: unknown[]) => unknown>)[handler]!;
  return new ExecutionContextHost([req, {}, () => undefined], controller, fn);
}

const findCheckout = () =>
  vi.fn(async (orgId: string, slug: string) => (orgId === ORG && slug === 'checkout' ? CHECKOUT : null));

/** The problem body a refused request gets. Fails if the guard let it through. */
async function refusal(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  const err = await promise.then(
    () => {
      throw new Error('the guard let the request through');
    },
    (e: unknown) => e,
  );
  return problemOf(err);
}

describe('AccessGuard', () => {
  it("lets a bearer token through a declared route without a lookup: its scopes are AuthGuard's", async () => {
    await expect(guardWith().canActivate(call(SlugRoutes, 'edit', bearer, { slug: 'checkout' }))).resolves.toBe(true);
  });

  it('lets a session through a route that declares no action, without a lookup', async () => {
    await expect(guardWith().canActivate(call(SlugRoutes, 'open', nonAdmin([]), { slug: 'checkout' }))).resolves.toBe(
      true,
    );
  });

  it('refuses an admin action to a non-admin with ADMIN_REQUIRED, naming the action', async () => {
    const body = await refusal(guardWith().canActivate(call(AdminRoutes, 'create', nonAdmin([[A, 'manager']]))));

    expect(body).toStrictEqual({
      type: 'https://perfportal.dev/errors/ADMIN_REQUIRED',
      title: 'admin required',
      status: 403,
      code: 'ADMIN_REQUIRED',
      detail: 'Managing users needs an admin.',
      remediation: 'Ask an admin to do this.',
    });
  });

  it('lets an admin through an admin action', async () => {
    await expect(guardWith().canActivate(call(AdminRoutes, 'create', admin))).resolves.toBe(true);
  });

  /** Review focus 2: membership must not be probeable by comparing answers. */
  it('answers a non-member exactly as it answers a project that does not exist', async () => {
    const findBySlugInOrg = findCheckout();
    const body = await refusal(
      guardWith({ projects: { findBySlugInOrg } }).canActivate(
        call(SlugRoutes, 'read', nonAdmin([[B, 'manager']]), { slug: 'checkout' }),
      ),
    );

    expect(findBySlugInOrg).toHaveBeenCalledWith(ORG, 'checkout');
    expect(body).toStrictEqual(problemOf(projectNotFound('checkout')));
  });

  it("answers a non-member of a run's project exactly as it answers a run that does not exist", async () => {
    const projectIdOf = vi.fn(async () => A);
    const body = await refusal(
      guardWith({ runs: { projectIdOf } }).canActivate(call(RunRoutes, 'note', nonAdmin([[B, 'manager']]), { id: RUN })),
    );

    expect(projectIdOf).toHaveBeenCalledWith(ORG, RUN);
    expect(body).toStrictEqual(problemOf(runNotFound(RUN)));
  });

  it('refuses a role below the action with ROLE_REQUIRED, naming the role it needs', async () => {
    const guard = guardWith({ projects: { findBySlugInOrg: findCheckout() } });

    expect(
      await refusal(guard.canActivate(call(SlugRoutes, 'edit', nonAdmin([[A, 'viewer']]), { slug: 'checkout' }))),
    ).toStrictEqual({
      type: 'https://perfportal.dev/errors/ROLE_REQUIRED',
      title: 'role required',
      status: 403,
      code: 'ROLE_REQUIRED',
      detail: 'Editing SLA rules needs the Member role in this project.',
      remediation: 'Ask an admin to change your role.',
    });
    const manage = await refusal(
      guard.canActivate(call(SlugRoutes, 'manage', nonAdmin([[A, 'member']]), { slug: 'checkout', ruleId: 'r' })),
    );
    expect(manage.detail).toBe('Renaming and deleting tests needs the Manager role in this project.');
  });

  it('lets a role that meets the action through', async () => {
    const guard = guardWith({ projects: { findBySlugInOrg: findCheckout() }, runs: { projectIdOf: async () => A } });

    await expect(guard.canActivate(call(SlugRoutes, 'read', nonAdmin([[A, 'viewer']]), { slug: 'checkout' }))).resolves.toBe(true);
    await expect(guard.canActivate(call(SlugRoutes, 'edit', nonAdmin([[A, 'member']]), { slug: 'checkout' }))).resolves.toBe(true);
    await expect(guard.canActivate(call(RunRoutes, 'note', nonAdmin([[A, 'manager']]), { id: RUN }))).resolves.toBe(true);
  });

  /**
   * A target the org does not hold gets the SAME 404 as one this session
   * cannot see, from the guard, rather than being passed to the controller.
   * Guards run before pipes and handlers, so a pass-through would let a pipe
   * on a sub-parameter, or a body check, answer the missing target first —
   * and the two answers would differ. Compared in two worlds that differ only
   * in whether the target exists, so the bodies can be equal byte for byte.
   */
  it('answers a project the org does not hold exactly as one this session cannot see', async () => {
    const outsider = nonAdmin([[B, 'manager']]);
    const missing = guardWith({ projects: { findBySlugInOrg: async () => null } });
    const invisible = guardWith({ projects: { findBySlugInOrg: findCheckout() } });

    const missingBody = await refusal(missing.canActivate(call(SlugRoutes, 'edit', outsider, { slug: 'checkout' })));
    const invisibleBody = await refusal(invisible.canActivate(call(SlugRoutes, 'edit', outsider, { slug: 'checkout' })));

    expect(missingBody).toStrictEqual(invisibleBody);
    expect(missingBody).toStrictEqual(problemOf(projectNotFound('checkout')));
  });

  it('answers a well-formed run id the org does not hold exactly as a run this session cannot see', async () => {
    const outsider = nonAdmin([[B, 'manager']]);
    const missing = guardWith({ runs: { projectIdOf: async () => null } });
    const invisible = guardWith({ runs: { projectIdOf: async () => A } });

    const missingBody = await refusal(missing.canActivate(call(RunRoutes, 'note', outsider, { id: RUN })));
    const invisibleBody = await refusal(invisible.canActivate(call(RunRoutes, 'note', outsider, { id: RUN })));

    expect(missingBody).toStrictEqual(invisibleBody);
    expect(missingBody).toStrictEqual(problemOf(runNotFound(RUN)));
  });

  /**
   * The one target left to the controller: an id that is not a UUID names no
   * run, so the pipe's 400 — which every caller gets alike — says nothing
   * about which runs exist. Passed through WITHOUT a lookup.
   */
  it('leaves a malformed run id to the controller, without a lookup', async () => {
    for (const id of ['not-a-uuid', `{${RUN}}`, RUN.replaceAll('-', '')]) {
      await expect(guardWith().canActivate(call(RunRoutes, 'note', nonAdmin([]), { id })), id).resolves.toBe(true);
    }
  });

  /** `/v1/runs/:id` with the parameter in the CONTROLLER's prefix — the shape of the metrics routes. */
  it("judges a run route whose controller prefix carries the id, as the metrics routes' does", async () => {
    const runs = { projectIdOf: vi.fn(async () => A) };

    await expect(guardWith({ runs }).canActivate(call(RunScopedRoutes, 'stats', nonAdmin([[A, 'viewer']]), { id: RUN }))).resolves.toBe(true);
    expect(runs.projectIdOf).toHaveBeenCalledWith(ORG, RUN);
    expect(
      await refusal(guardWith({ runs }).canActivate(call(RunScopedRoutes, 'stats', nonAdmin([[B, 'viewer']]), { id: RUN }))),
    ).toStrictEqual(problemOf(runNotFound(RUN)));
  });

  it('lets an admin through a project action without looking the project up', async () => {
    await expect(
      guardWith().canActivate(call(SlugRoutes, 'manage', admin, { slug: 'checkout', ruleId: 'r' })),
    ).resolves.toBe(true);
    await expect(guardWith().canActivate(call(RunRoutes, 'note', admin, { id: RUN }))).resolves.toBe(true);
  });

  /**
   * Fails closed, as `canSeeProject` does: a session built without
   * `loadSessionAccess` carries no roles and no admin flag, and is answered
   * as a non-member — never waved through.
   */
  it('answers a session that carries no access fields as a non-member', async () => {
    const bare: Tenant = { orgId: ORG, tokenId: 'session:s1', userId: 'u1', scopes: ['read', 'ingest', 'runner'] };
    const body = await refusal(
      guardWith({ projects: { findBySlugInOrg: findCheckout() } }).canActivate(
        call(SlugRoutes, 'read', bare, { slug: 'checkout' }),
      ),
    );

    expect(body).toStrictEqual(problemOf(projectNotFound('checkout')));
  });

  /** A programming error, not a refusal — and for an admin too. Task 6's route walk keeps it unreachable. */
  it('throws, naming the route, for a project action on a route that names no project', async () => {
    await expect(guardWith().canActivate(call(MisdeclaredRoutes, 'read', admin, { thing: 'x' }))).rejects.toThrow(
      /GET \/v1\/elsewhere\/:thing.*project:read/,
    );
  });
});

/**
 * ═══ THE GUARD'S IDEA OF A RUN ID IS THE PIPE'S, EXACTLY ═══
 *
 * `AccessGuard` runs before parameter pipes, sees the raw segment, and leaves
 * an id to the controller exactly when it judges it malformed. An id
 * `uuidParam` accepts that the guard left alone would reach the controller
 * unjudged; one the pipe refuses that the guard answered 404 would get a
 * non-member a 404 where a member gets 400. `projectIdOf` must not send what
 * the pipe refuses to the `uuid` column either. Measured against the pipe
 * itself, not a copy of its rule.
 */
describe('the guard, projectIdOf and uuidParam agree on what a run id is', () => {
  it.each([
    [RUN],
    [RUN.toUpperCase()],
    ['00000000-0000-0000-0000-000000000000'],
    ['01890a5d-ac96-774b-bcce-b302099a8057'],
    [`{${RUN}}`],
    [RUN.replaceAll('-', '')],
    [`${RUN} `],
    ['zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'],
    ['not-a-uuid'],
    [''],
  ])('%j', async (id) => {
    const pipeAccepts = await uuidParam('id')
      .transform(id, { type: 'param', data: 'id' })
      .then(
        () => true,
        () => false,
      );
    const findFirst = vi.fn(async () => null);
    const runs = new RunRepository({ run: { findFirst } } as unknown as PrismaClient);
    await runs.projectIdOf(ORG, id);
    expect(findFirst.mock.calls.length > 0, 'projectIdOf queries').toBe(pipeAccepts);

    // An outsider, and a run the org does not hold: judged (404) iff the pipe accepts the id.
    const judged = await guardWith({ runs })
      .canActivate(call(RunRoutes, 'note', nonAdmin([[B, 'manager']]), { id }))
      .then(
        () => false,
        (e: unknown) => problemOf(e).status === 404,
      );
    expect(judged, 'the guard answers 404').toBe(pipeAccepts);
  });
});
