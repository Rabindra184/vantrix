import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ParseUUIDPipe, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import {
  ACCESS_ACTIONS,
  PROJECT_ROLES,
  type AccessAction,
  type AccessRole,
  type ProjectRole,
} from '@perfportal/contracts';
import { UserRepository } from '@perfportal/persistence';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  ALLOWED_BEFORE_PASSWORD_CHANGE_KEY,
  BEARER_ONLY_KEY,
  NOT_PROJECT_SCOPED_KEY,
  OWN_ACCOUNT_KEY,
  REQUIRES_KEY,
} from '../src/auth/access.decorator.js';
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
 * each route declares one way in, and that the way in is the one written down
 * for it below; that its token scope agrees with its action's row; that a
 * project action names its project and a `@NotProjectScoped` route names
 * none; and that the document declares the refusals the guard can now send.
 *
 * The role matrix then drives one representative request per declared action
 * through the real app, for each kind of caller; every route with a
 * uuid-piped sub-parameter and every `@BearerOnly` route gets a request of its
 * own; and the last group checks the bearer path did not move.
 */

interface WalkedRoute {
  /** `PUT /v1/runs/:id/note`: the verb, and the controller prefix joined to the handler's path. */
  readonly label: string;
  readonly path: string;
  readonly requires: AccessAction | undefined;
  readonly bearerOnly: boolean;
  readonly notProjectScoped: boolean;
  readonly ownAccount: boolean;
  readonly isPublic: boolean;
  /** `@AllowedBeforePasswordChange` on the HANDLER: reachable by a session that must still choose its password. */
  readonly allowedBeforePasswordChange: boolean;
  /** `@AllowedBeforePasswordChange` on the route's CONTROLLER CLASS, which the guard does not read. */
  readonly allowedBeforePasswordChangeOnClass: boolean;
  /** `@Scopes` as `AuthGuard` reads it: the handler's, else the class's. */
  readonly scopes: readonly string[] | undefined;
  /** `SessionOnlyGuard` on the handler or its class. */
  readonly sessionOnly: boolean;
  /** Path parameters whose `@Param` carries a `ParseUUIDPipe` (`uuidParam`). */
  readonly uuidParams: readonly string[];
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
        // `@Param(name, pipe)` is recorded on the CLASS, keyed by method name,
        // as "<paramtype>:<index>" entries — the read openapi.integration.test.ts
        // uses for `@Res()`.
        const args =
          (Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, key) as
            | Record<string, { data?: unknown; pipes?: unknown[] }>
            | undefined) ?? {};
        const uuidParams = Object.entries(args)
          .filter(([argKey]) => argKey.split(':')[0] === String(RouteParamtypes.PARAM))
          // An instance (`uuidParam`, `new ParseUUIDPipe(...)`) or the class itself
          // (`@Param('x', ParseUUIDPipe)`), which Nest instantiates.
          .filter(([, arg]) => (arg.pipes ?? []).some((pipe) => pipe instanceof ParseUUIDPipe || pipe === ParseUUIDPipe))
          .map(([, arg]) => String(arg.data));
        out.push({
          label: `${RequestMethod[verb]} ${path}`,
          path,
          requires: meta<AccessAction>(REQUIRES_KEY),
          bearerOnly: meta<boolean>(BEARER_ONLY_KEY) === true,
          notProjectScoped: meta<boolean>(NOT_PROJECT_SCOPED_KEY) === true,
          ownAccount: meta<boolean>(OWN_ACCOUNT_KEY) === true,
          isPublic: meta<boolean>(IS_PUBLIC_KEY) === true,
          // The HANDLER's alone, as `PasswordChangeGuard` reads it: on a class
          // it opens nothing, so it must not be counted as opening anything.
          allowedBeforePasswordChange: Reflect.getMetadata(ALLOWED_BEFORE_PASSWORD_CHANGE_KEY, fn) === true,
          allowedBeforePasswordChangeOnClass: Reflect.getMetadata(ALLOWED_BEFORE_PASSWORD_CHANGE_KEY, cls) === true,
          scopes: meta<string[]>(SCOPES_KEY),
          sessionOnly: guardedBySessionOnly(cls) || guardedBySessionOnly(fn),
          uuidParams,
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

/** How a route is reached: the action it `@Requires`, or one of the four statements. */
type Access = AccessAction | 'bearer-only' | 'not-project-scoped' | 'own-account' | 'public';

/** Every marker a walked route carries, as `Access` values — one, if it is declared right. */
function markers(r: WalkedRoute): Access[] {
  return [
    r.requires ?? null,
    r.bearerOnly ? 'bearer-only' : null,
    r.notProjectScoped ? 'not-project-scoped' : null,
    r.ownAccount ? 'own-account' : null,
    r.isPublic ? 'public' : null,
  ].filter((m): m is Access => m !== null);
}

/**
 * ═══ WHICH ROUTE TAKES WHICH ACCESS, WRITTEN DOWN ═══
 *
 * Copied from the annotation table in
 * docs/superpowers/plans/2026-10-07-project-access-pr1-enforcement.md (Task
 * 6), one row per route the app registers. The walk proves each route carries
 * SOME marker; only a list written apart from the controllers can say it
 * carries the RIGHT one. Without it, `@Requires('rules:read')` on token
 * minting passed every check in this file: one marker, a null scope like
 * every session-only action, and nothing in the matrix sending that request.
 *
 * So the walked map must EQUAL this one. A route added later fails here until
 * someone writes down who may call it; a route whose marker changes fails
 * naming both. Keep it in step with the plan, never with the code.
 */
const ACCESS_BY_ROUTE: Readonly<Record<string, Access>> = {
  'GET /healthz': 'public',
  'GET /readyz': 'public',

  'GET /v1/activity': 'not-project-scoped',
  'GET /v1/projects': 'not-project-scoped',
  'GET /v1/runs': 'not-project-scoped',
  'GET /v1/tests': 'not-project-scoped',

  'POST /v1/runs': 'bearer-only',
  'POST /v1/runs/live': 'bearer-only',
  'POST /v1/runs/:id/stream': 'bearer-only',
  'POST /v1/runs/:id/close': 'bearer-only',
  'POST /v1/telemetry': 'bearer-only',
  'GET /v1/projects/:slug/runs': 'bearer-only',

  'POST /v1/projects': 'projects:create',

  'GET /v1/runs/:id': 'project:read',
  'GET /v1/runs/:id/stats': 'project:read',
  'GET /v1/runs/:id/series': 'project:read',
  'GET /v1/runs/:id/errors': 'project:read',
  'GET /v1/runs/:id/errors/series': 'project:read',
  'GET /v1/runs/:id/telemetry': 'project:read',
  'GET /v1/runs/:id/distribution': 'project:read',
  'GET /v1/runs/:id/users': 'project:read',
  'GET /v1/runs/:id/scatter': 'project:read',
  'GET /v1/runs/:id/trends': 'project:read',
  'GET /v1/runs/:id/events': 'project:read',
  'PUT /v1/runs/:id/note': 'run:note',

  'GET /v1/projects/:slug/tests': 'project:read',
  'GET /v1/projects/:slug/tests/:testSlug': 'project:read',
  'PATCH /v1/projects/:slug/tests/:testSlug': 'tests:manage',
  'DELETE /v1/projects/:slug/tests/:testSlug': 'tests:manage',

  'POST /v1/projects/:slug/runs': 'run:upload',

  'POST /v1/projects/:slug/runner/runs': 'runner:run',
  'GET /v1/projects/:slug/runner/runs': 'project:read',
  'POST /v1/projects/:slug/runner/runs/:jobId/cancel': 'runner:run',
  'GET /v1/projects/:slug/runner/runs/:jobId/logs': 'project:read',
  'POST /v1/projects/:slug/runner/runs/:jobId/retry': 'runner:run',

  'GET /v1/projects/:slug/packages': 'project:read',
  'POST /v1/projects/:slug/packages': 'packages:manage',
  'PUT /v1/projects/:slug/packages/:packageId/content': 'packages:manage',
  'PATCH /v1/projects/:slug/packages/:packageId': 'packages:manage',
  'DELETE /v1/projects/:slug/packages/:packageId': 'packages:delete',

  'GET /v1/projects/:slug/rules': 'rules:read',
  'POST /v1/projects/:slug/rules': 'rules:edit',
  'PATCH /v1/projects/:slug/rules/:ruleId': 'rules:edit',
  'DELETE /v1/projects/:slug/rules/:ruleId': 'rules:edit',

  'GET /v1/projects/:slug/tokens': 'tokens:manage',
  'POST /v1/projects/:slug/tokens': 'tokens:manage',
  'DELETE /v1/projects/:slug/tokens/:prefix': 'tokens:manage',

  'GET /v1/projects/:slug/members': 'members:read',
  'POST /v1/projects/:slug/members': 'members:manage',
  'PATCH /v1/projects/:slug/members/:userId': 'members:manage',
  'DELETE /v1/projects/:slug/members/:userId': 'members:manage',

  'PUT /v1/me/password': 'own-account',

  'GET /v1/admin/users': 'users:manage',
  'POST /v1/admin/users': 'users:manage',
  'PATCH /v1/admin/users/:userId': 'users:manage',
  'PUT /v1/admin/users/:userId/password': 'users:manage',
  'DELETE /v1/admin/users/:userId': 'users:manage',
  'GET /v1/admin/projects': 'users:manage',
};

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

  it('gives each route exactly one of @Requires, @BearerOnly, @NotProjectScoped, @OwnAccount and @Public', () => {
    const wrong = ROUTES.map((r) => ({ label: r.label, markers: markers(r) }))
      .filter((r) => r.markers.length !== 1)
      .map((r) => `${r.label}: ${r.markers.length === 0 ? 'none' : r.markers.join(' + ')}`)
      .sort();
    expect(wrong, `routes that do not declare exactly one way in:\n${wrong.join('\n')}`).toEqual([]);
  });

  /**
   * A pair the rule above already refuses, named on its own because what it
   * would MEAN is worse than a missing marker. `@Public` makes `AuthGuard`
   * pass without authenticating, so outside `/v1` — where `AuthMiddleware`
   * does not run — the request reaches `AccessGuard` with no tenant, and the
   * guard returns true for no tenant: the route would be public, silently,
   * while reading as guarded.
   */
  it('lets no route carry both @Public and @Requires', () => {
    const both = ROUTES.filter((r) => r.isPublic && r.requires !== undefined).map((r) => r.label).sort();
    expect(both, `routes that are @Public AND @Requires — public in effect:\n${both.join('\n')}`).toEqual([]);
  });

  /**
   * `@OwnAccount` acts on the caller's own account and takes no action, so
   * `AccessGuard` judges nothing on it — what keeps it to a person is
   * `SessionOnlyGuard`, and a bearer token, which names nobody, has no own
   * account to act on. Like `@NotProjectScoped`, it is no way into a project
   * either: a route naming one or a run would be open to every session in the
   * org.
   */
  it('puts every @OwnAccount route behind SessionOnlyGuard, on a path that names no project or run', () => {
    const own = ROUTES.filter((r) => r.ownAccount);
    expect(own.length, 'no @OwnAccount route found — the walk has rotted').toBeGreaterThan(0);
    const wrong = [
      ...own.filter((r) => !r.sessionOnly).map((r) => `${r.label}: no SessionOnlyGuard on the route or its class`),
      ...own
        .filter((r) => r.path.split('/').includes(':slug') || isRunRoute(r.path))
        .map((r) => `${r.label}: names a project or a run`),
    ].sort();
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  /**
   * THE PASSWORD GATE'S ALLOW-LIST, PINNED. `PasswordChangeGuard` lets a
   * session that must still choose its password through exactly the routes
   * carrying `@AllowedBeforePasswordChange`; one more is one more thing such a
   * session can do. The list is written here, apart from the controllers, so
   * a route that gains the decorator fails until someone writes it down.
   */
  it('lets a session that must change its password reach PUT /v1/me/password and nothing else', () => {
    const allowed = ROUTES.filter((r) => r.allowedBeforePasswordChange).map((r) => r.label).sort();
    expect(allowed).toEqual(['PUT /v1/me/password']);
  });

  /**
   * The guard reads the marker off the handler alone, and the pin above does
   * too — so a marker on a CONTROLLER CLASS opens nothing today and is
   * counted nowhere. The day the guard switches to `getAllAndOverride`, that
   * marker would open every route of the class while the pin stayed green.
   * So no class may carry it at all.
   */
  it('lets no controller class carry @AllowedBeforePasswordChange', () => {
    const onClass = [
      ...new Set(ROUTES.filter((r) => r.allowedBeforePasswordChangeOnClass).map((r) => r.label)),
    ].sort();
    expect(onClass, `routes whose controller class is marked:\n${onClass.join('\n')}`).toEqual([]);
  });

  it('declares, route by route, exactly the access written down for it', () => {
    const walked = new Map(ROUTES.map((r) => [r.label, markers(r).join(' + ') || 'none']));
    expect(walked.size, 'two routes walked to one label').toBe(ROUTES.length);
    const written = new Map<string, string>(Object.entries(ACCESS_BY_ROUTE));

    const diff = [
      ...[...written].filter(([label]) => !walked.has(label)).map(([label, access]) => `missing: ${label} (written ${access}) is not a registered route`),
      ...[...walked].filter(([label]) => !written.has(label)).map(([label, access]) => `extra: ${label} declares ${access} — write its access down in ACCESS_BY_ROUTE`),
      ...[...walked]
        .filter(([label, access]) => written.has(label) && written.get(label) !== access)
        .map(([label, access]) => `changed: ${label} declares ${access}, written ${written.get(label)}`),
    ].sort();
    expect(diff, `the routes' access differs from ACCESS_BY_ROUTE:\n${diff.join('\n')}`).toEqual([]);
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
  it('takes exactly the table’s scope and admits tokens, or is session-only where the table names none', () => {
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
      // The other direction: SessionOnlyGuard on a route the table opens to a
      // token refuses that token outright, so the scope above would be a
      // promise the route never keeps.
      ...withScope
        .filter((r) => r.sessionOnly)
        .map((r) => `${r.label}: ${r.requires} is open to a "${ACCESS_ACTIONS[r.requires!].scope}" token, but SessionOnlyGuard refuses every token`),
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

  /**
   * THE ESCAPE HATCH STAYS NARROW. `@NotProjectScoped` takes no action, so
   * `AccessGuard` judges nothing on it. On a route that names a project or a
   * run, that is the whole hole: any session in the org could act on any
   * project through it. It is for org-wide routes only.
   */
  it('puts no @NotProjectScoped route on a path that names a project or a run', () => {
    const orgWide = ROUTES.filter((r) => r.notProjectScoped);
    expect(orgWide.length).toBeGreaterThan(3);
    const named = orgWide
      .filter((r) => r.path.split('/').includes(':slug') || isRunRoute(r.path))
      .map((r) => r.label)
      .sort();
    expect(named, `@NotProjectScoped routes that name a project or a run:\n${named.join('\n')}`).toEqual([]);
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
  { action: 'members:read', role: 'viewer', route: 'GET /v1/projects/:slug/members' },
  { action: 'members:manage', role: 'admin', route: 'POST /v1/projects/:slug/members', body: {} },
  { action: 'projects:create', role: 'admin', route: 'POST /v1/projects', body: {} },
  { action: 'users:manage', role: 'admin', route: 'GET /v1/admin/users' },
];

/** What a request's path parameters are filled with: project A and its run, or targets that do not exist. */
interface Target {
  readonly slug: string;
  readonly runId: string;
}

/** A package id no project holds: a well-formed uuid, so it reaches past `uuidParam` to the lookup. */
const NO_PACKAGE = randomUUID();
/** An account id nobody holds. Account ids are opaque strings (Better Auth's own, or a uuid an admin's create chose); nothing pipes them. */
const NO_USER = `no-such-user-${randomUUID()}`;

function fill(route: string, target: Target): { verb: Verb; url: string } {
  const [verb, template] = route.split(' ') as [Verb, string];
  const url = template
    .replace(':slug', target.slug)
    .replace(':id', target.runId)
    .replace(':packageId', NO_PACKAGE)
    .replace(':testSlug', 'missing')
    .replace(':userId', NO_USER);
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
    // A live close waits INGEST_WAIT_MS (25s by default) for a verdict nothing
    // here will produce. Only a session let through the close route would
    // reach that wait — the failure the @BearerOnly cases exist to catch — so
    // it is shortened to let that failure surface as a status rather than as
    // a request deadline. Read once, when createTestApp loads the config, the
    // way live.integration.test.ts sets it.
    const previousWait = process.env.INGEST_WAIT_MS;
    process.env.INGEST_WAIT_MS = '50';
    try {
      ctx = await createTestApp();
    } finally {
      if (previousWait === undefined) delete process.env.INGEST_WAIT_MS;
      else process.env.INGEST_WAIT_MS = previousWait;
    }
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

        // On a :slug route the refusal comes before any lookup (PR 1 Ruling
        // 2), so a project that does not exist gets the very answer a real
        // one the caller cannot see gets, and neither names the project.
        const namesProject = p.route.split(' ')[1]!.split('/').includes(':slug');
        for (const { key, who } of OUTSIDERS) {
          it(`refuses a ${who} ADMIN_REQUIRED${namesProject ? ', for a missing project as for a real one' : ''}`, async () => {
            const res = await probe(p, A, cookies[key]);
            expect([res.status, res.body.code]).toStrictEqual([403, 'ADMIN_REQUIRED']);
            if (namesProject) {
              const missing = await probe(p, MISSING, cookies[key]);
              expect(
                masked(missing.body, MISSING.slug),
                'a missing project answered differently from an invisible one',
              ).toStrictEqual(masked(res.body, A.slug));
            }
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
    /*
     * EVERY project route with a uuid-piped sub-parameter, read off the walk
     * (`uuidParam` is a `ParseUUIDPipe`), with that parameter malformed. The
     * lowest role the spec gives the route's action reaches the pipe — 400
     * INVALID_ID, which proves there is a pipe to reach — and both outsiders
     * get the 404 a missing slug gets.
     */
    const SPEC_ROLE = new Map(PROBES.map((p) => [p.action, p.role]));
    const piped = ROUTES.filter(
      (r) =>
        r.requires !== undefined &&
        r.path.split('/').includes(':slug') &&
        r.uuidParams.some((name) => name !== 'slug'),
    );

    it('finds the uuid-piped project routes, the runner job’s among them', () => {
      expect(piped.length).toBeGreaterThan(7);
      const labels = piped.map((r) => r.label);
      for (const job of [
        'POST /v1/projects/:slug/runner/runs/:jobId/cancel',
        'GET /v1/projects/:slug/runner/runs/:jobId/logs',
        'POST /v1/projects/:slug/runner/runs/:jobId/retry',
      ]) {
        expect(labels, job).toContain(job);
      }
    });

    for (const r of piped) {
      const route = r.uuidParams.reduce((label, name) => label.replace(`:${name}`, 'not-a-uuid'), r.label);
      it(`${route}: the same 404 for a real project as for a missing one`, async () => {
        const role = SPEC_ROLE.get(r.requires!);
        if (role === undefined || role === 'admin') throw new Error(`${r.label}: no project role for ${r.requires}`);
        const reached = fill(route, A);
        const asLowest = await send(reached.verb, reached.url, cookies[role]);
        expect([asLowest.status, asLowest.body.code], role).toStrictEqual([400, 'INVALID_ID']);

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
   * ═══ A @BearerOnly ROUTE REFUSES A SESSION, AND EACH REFUSAL IS PINNED ═══
   *
   * `@BearerOnly` takes no action, so `AccessGuard` judges nothing on it: the
   * marker claims a session cannot use the route at all. Each route is sent
   * as a signed-in ADMIN, the session with the most reach, and must answer
   * the EXACT refusal written below — a bare "some 4xx" was satisfied by
   * validation or run state, which answers whoever asks: with the `stream`
   * and `telemetry` scopes handed to sessions, all six stayed green.
   *
   * So each request is shaped to be one the route WOULD accept from a token
   * of its project — a real bundle, a valid body and headers, a run that is
   * running — leaving the credential as the only thing that can refuse it.
   * There are two kinds of refusal:
   *
   *   - THE SCOPE, 403 FORBIDDEN, where no session holds it (`stream`,
   *     `telemetry`). On stream and close this is the ONLY refusal: those
   *     handlers look the run up by org when the credential names no project,
   *     so a session let past the scope would write to, or close, any running
   *     run in its org.
   *   - PROJECT_REQUIRED, 400, raised before the handler looks up a project
   *     or validates a body (on GET /v1/projects/:slug/runs only the query's
   *     single-value checks come first). A session names no project
   *     (`authenticateSession` sets no `projectId`), so this is a
   *     STRUCTURAL refusal: it holds whatever scopes a session carries, and on
   *     POST /v1/runs and GET /v1/projects/:slug/runs — whose scopes, `ingest`
   *     and `read`, every session holds — it is the real and only one.
   *     Opening a live run and posting telemetry reach it too once past their
   *     scope, which is why their pair is the scope's: a session reaching the
   *     handler there means the scope stopped refusing it.
   *
   * The list must equal the walk's @BearerOnly set, so a seventh route fails
   * until its refusal is written down.
   */
  describe('a @BearerOnly route refuses a session', () => {
    const LOG = fileURLToPath(
      new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
    );
    /** A run opened over the stream token for A, left running. */
    let liveRunId: string;
    /** A real results bundle: the reference simulation.log, tarred the way ingest expects. */
    let bundle: Buffer;

    beforeAll(async () => {
      // Built in a scratch directory and removed once read: the bundle lives
      // in memory from here on, and nothing else here cleans the temp dir.
      const dir = mkdtempSync(join(tmpdir(), 'access-routes-'));
      try {
        const results = join(dir, 'paritysimulation');
        mkdirSync(results, { recursive: true });
        copyFileSync(LOG, join(results, 'simulation.log'));
        execFileSync('tar', ['-czf', join(dir, 'bundle.tgz'), '-C', dir, 'paritysimulation']);
        bundle = readFileSync(join(dir, 'bundle.tgz'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      const opened = await request(ctx.app.getHttpServer())
        .post('/v1/runs/live')
        .set('Authorization', `Bearer ${ctx.streamToken}`)
        .send({ tool: 'gatling' });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      liveRunId = opened.body.runId as string;
    });

    const asAdmin = (req: request.Test): request.Test =>
      req.set('Cookie', cookies.admin).timeout({ deadline: 15_000, response: 15_000 });
    const server = () => request(ctx.app.getHttpServer());
    const telemetrySample = () => ({
      sampledAt: new Date().toISOString(),
      cpuUserMs: 1000, cpuSystemMs: 500, cpuIdleMs: 8000, cpuIowaitMs: 10,
      memUsedBytes: 1_000_000, memTotalBytes: 8_000_000,
      netRxBytes: 10_000, netTxBytes: 20_000,
      tcpInSegs: 100, tcpOutSegs: 120, tcpRetransSegs: 1, tcpInErrs: 0,
      tcpActiveOpens: 5, tcpPassiveOpens: 3,
      tcpStates: { ESTABLISHED: 10 },
    });

    const REFUSALS: Readonly<Record<string, { expected: readonly [number, string]; send: () => request.Test }>> = {
      // A real bundle and valid metadata; `waitMs: 0` so a token's post would
      // not wait. PROJECT_REQUIRED is checked before the body is read.
      'POST /v1/runs': {
        expected: [400, 'PROJECT_REQUIRED'],
        send: () =>
          asAdmin(server().post('/v1/runs'))
            .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
            .attach('bundle', bundle, 'bundle.tgz'),
      },
      // A real project's slug and no query parameters, so nothing else in the
      // handler has anything to refuse.
      'GET /v1/projects/:slug/runs': {
        expected: [400, 'PROJECT_REQUIRED'],
        send: () => asAdmin(server().get(`/v1/projects/${A.slug}/runs`)),
      },
      // A valid open body: INVALID_LIVE_OPEN cannot answer it.
      'POST /v1/runs/live': {
        expected: [403, 'FORBIDDEN'],
        send: () => asAdmin(server().post('/v1/runs/live')).send({ tool: 'gatling' }),
      },
      // A running run, its cursor's offset (0, nothing streamed yet) and a
      // non-empty octet-stream body: past the scope, a token's chunk lands.
      'POST /v1/runs/:id/stream': {
        expected: [403, 'FORBIDDEN'],
        send: () =>
          asAdmin(server().post(`/v1/runs/${liveRunId}/stream`))
            .set('Content-Type', 'application/octet-stream')
            .set('X-Stream-Offset', '0')
            .send(Buffer.from('bytes')),
      },
      // A running run, so RUN_NOT_RUNNING cannot answer.
      'POST /v1/runs/:id/close': {
        expected: [403, 'FORBIDDEN'],
        send: () => asAdmin(server().post(`/v1/runs/${liveRunId}/close`)),
      },
      // A valid batch: INVALID_TELEMETRY cannot answer it.
      'POST /v1/telemetry': {
        expected: [403, 'FORBIDDEN'],
        send: () => asAdmin(server().post('/v1/telemetry')).send({ host: 'gen-1', samples: [telemetrySample()] }),
      },
    };

    it('pins a refusal for exactly the walk’s @BearerOnly routes', () => {
      const walked = ROUTES.filter((r) => r.bearerOnly).map((r) => r.label).sort();
      expect(walked.length).toBeGreaterThan(4);
      expect(Object.keys(REFUSALS).sort(), 'write each @BearerOnly route’s refusal into REFUSALS').toEqual(walked);
    });

    for (const [label, { expected, send: request_ }] of Object.entries(REFUSALS)) {
      it(`${label} refuses a signed-in admin ${expected.join(' ')}`, async () => {
        const res = await request_();
        expect([res.status, res.body.code], `${label}: ${JSON.stringify(res.body)}`).toStrictEqual([...expected]);
      });
    }
  });

  /*
   * ═══ A SESSION THAT MUST CHANGE ITS PASSWORD REACHES NOTHING ═══
   * (Review Focus 1)
   *
   * Every route the walk finds, sent by an ADMIN of A — who passes
   * `AccessGuard` everywhere — whose account must choose a new password. Each
   * is refused 403 by the password gate, except:
   *
   *   - the gate's allow-list, `PUT /v1/me/password`, which answers its own
   *     400 for the empty body sent;
   *   - a route asking a scope no session holds (`stream`, `telemetry`):
   *     `AuthGuard` runs before the gate and answers that scope refusal, the
   *     same 403 FORBIDDEN every session gets there;
   *   - `@Public` routes, which no session is needed for.
   *
   * Derived from the walk, so a route added later is held to it by existing.
   * Path parameters are filled with A's slug, A's run, and fresh uuids: the
   * gate runs before any pipe or lookup, so their values cannot matter.
   */
  describe('a session that must change its password', () => {
    /** The scopes `authenticateSession` gives every session (auth.middleware.ts). */
    const SESSION_SCOPES: readonly string[] = ['read', 'ingest', 'runner'];
    let flagged: string;

    beforeAll(async () => {
      const { cookie, userId } = await signInAsAdmin(ctx, `flagged-${randomUUID()}@example.test`);
      await new UserRepository(ctx.prisma).setMustChangePassword(userId, true);
      flagged = cookie;
    });

    it('is refused on every route but PUT /v1/me/password', async () => {
      const swept = ROUTES.filter((r) => !r.isPublic);
      expect(swept.length, 'the walk found too few routes to sweep').toBeGreaterThan(40);
      const wrong: string[] = [];
      for (const r of swept) {
        const [verb] = r.label.split(' ') as [Verb];
        const url = r.path
          .replace(':slug', A.slug)
          .replace(':id', A.runId)
          .replace(/:[A-Za-z]+/g, () => randomUUID());
        const res = await send(verb, url, flagged);
        const expected: readonly [number, string] = r.allowedBeforePasswordChange
          ? [400, 'INVALID_PASSWORD_REQUEST']
          : (r.scopes ?? []).some((scope) => !SESSION_SCOPES.includes(scope))
            ? [403, 'FORBIDDEN']
            : [403, 'PASSWORD_CHANGE_REQUIRED'];
        if (res.status !== expected[0] || res.body.code !== expected[1]) {
          wrong.push(`${r.label}: ${res.status} ${String(res.body.code)}, expected ${expected.join(' ')}`);
        }
      }
      expect(wrong, wrong.join('\n')).toEqual([]);
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
