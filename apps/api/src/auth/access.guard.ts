import { Injectable, RequestMethod, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { ACCESS_ACTIONS, type AccessAction } from '@perfportal/contracts';
import { isUuid, ProjectRepository, RunRepository } from '@perfportal/persistence';
import type { Request } from 'express';
import { accessDenied, projectNotFound, runNotFound } from '../common/validation.js';
import { accessDecision } from './access.js';
import { REQUIRES_KEY } from './access.decorator.js';
import { SESSION_TOKEN_ID_PREFIX } from './session-only.guard.js';

/**
 * Applies the permission table to a SESSION on a route that declares
 * `@Requires(action)` (docs/superpowers/specs/2026-10-07-project-access-design.md,
 * section 2). Registered as an APP_GUARD AFTER `AuthGuard` in auth.module.ts:
 * Nest runs global guards in the order their providers are listed, so the
 * scope check has already passed, and `req.tenant` is set, by the time this
 * runs.
 *
 * ═══ IT RETURNS `true` FOR EVERYTHING IT DOES NOT JUDGE ═══
 *
 * A route with no `@Requires`, and any tenant that is not a session — a
 * bearer token, or no tenant at all on a `@Public` route. A token's reach is
 * its one project and its scopes, decided by `AuthGuard`, `@Scopes` and
 * `SessionOnlyGuard` exactly as before this guard existed, and CI ingest
 * depends on that path not moving. A session is told apart the way
 * `SessionOnlyGuard` tells it: by the `session:` token id only
 * `authenticateSession` writes.
 *
 * For a session on a declared route:
 *
 *   1. An admin action passes an admin and refuses anyone else,
 *      ADMIN_REQUIRED. No project is involved.
 *   2. The project comes from `:slug`, or for a `/v1/runs/:id` route from
 *      the run. A route with neither is DECLARED WRONGLY and throws a plain
 *      `Error` naming it — a 500, and the route walk in
 *      `access-routes.integration.test.ts` keeps it unreachable. That is
 *      checked before anything else about the caller, so an admin hits it
 *      too.
 *   3. An admin passes without the lookup: nothing it could find changes the
 *      answer.
 *   4. A run id that is not a UUID passes through without a lookup: it names
 *      no run, and the controller's `uuidParam` answers it 400 for every
 *      caller alike. Anything else the org does NOT hold is answered here,
 *      with the same `projectNotFound` / `runNotFound` an invisible target
 *      gets. Passing a missing target on would let a pipe on another path
 *      parameter, or a body check, answer it before the controller's own
 *      lookup — a different answer from an invisible target's 404, and so a
 *      way to list which slugs and run ids exist.
 *   5. `accessDecision` decides. Not a member: that same 404, so membership
 *      cannot be probed either. Too low a role: ROLE_REQUIRED, naming the
 *      role.
 *
 * Both lookups are scoped by the session's org, which is what keeps another
 * org's project out — `canSeeProject` and `accessDecision` do not check it.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly projects: ProjectRepository,
    private readonly runs: RunRepository,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<AccessAction | undefined>(REQUIRES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (action === undefined) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const tenant = req.tenant;
    if (tenant === undefined || !tenant.tokenId.startsWith(SESSION_TOKEN_ID_PREFIX)) return true;

    const { role: required, label } = ACCESS_ACTIONS[action];
    if (required === 'admin') {
      if (tenant.isAdmin === true) return true;
      throw accessDenied('ADMIN_REQUIRED', `${label} needs an admin.`, 'Ask an admin to do this.');
    }

    const target = projectTarget(ctx, req, action);
    if (tenant.isAdmin === true) return true;

    let projectId: string | null;
    let notVisible: () => Error;
    if (target.kind === 'slug') {
      const project = await this.projects.findBySlugInOrg(tenant.orgId, target.slug);
      projectId = project?.id ?? null;
      notVisible = () => projectNotFound(target.slug);
    } else {
      // MALFORMED, not missing: an id that is not a UUID names no run at all,
      // so the controller's `uuidParam` answers it 400 for every caller alike
      // and that 400 reveals nothing. The one target left to the controller.
      if (!isUuid(target.id)) return true;
      projectId = await this.runs.projectIdOf(tenant.orgId, target.id);
      notVisible = () => runNotFound(target.id);
    }
    // MISSING answers exactly as INVISIBLE, from here. Passing it on would let
    // whatever runs between this guard and the controller's own lookup — a
    // pipe on another path parameter, a body check — answer a missing target
    // first, and the difference would list which slugs and run ids exist.
    if (projectId === null) throw notVisible();

    const decision = accessDecision({
      required,
      isAdmin: false,
      role: tenant.projectRoles?.get(projectId) ?? null,
    });
    if (decision === 'allow') return true;
    if (decision === 'role-required') {
      throw accessDenied(
        'ROLE_REQUIRED',
        `${label} needs the ${required.charAt(0).toUpperCase()}${required.slice(1)} role in this project.`,
        'Ask an admin to change your role.',
      );
    }
    // 'not-found'. ('admin-required' cannot arise: `required` is a project
    // role here, and the admin case returned above.)
    throw notVisible();
  }
}

type ProjectTarget = { kind: 'slug'; slug: string } | { kind: 'run'; id: string };

/**
 * Which project a declared route acts on, read from the route's own template
 * (Nest's `PATH_METADATA`, as `openapi.integration.test.ts` reads it) and the
 * request's params. `:slug` anywhere in the path names a project; a path
 * under `/v1/runs/:id` names a run, and through it a project.
 */
function projectTarget(ctx: ExecutionContext, req: Request, action: AccessAction): ProjectTarget {
  const path = routePath(ctx);
  const segments = path.split('/').filter(Boolean);
  const params = (req.params ?? {}) as Record<string, unknown>;
  if (segments.includes(':slug') && typeof params.slug === 'string') {
    return { kind: 'slug', slug: params.slug };
  }
  if (segments[0] === 'v1' && segments[1] === 'runs' && segments[2] === ':id' && typeof params.id === 'string') {
    return { kind: 'run', id: params.id };
  }
  const verb = Reflect.getMetadata(METHOD_METADATA, ctx.getHandler()) as RequestMethod | undefined;
  throw new Error(
    `${verb === undefined ? '?' : RequestMethod[verb]} ${path} declares @Requires('${action}'), a project ` +
      'action, but names no project: it has no :slug and is not under /v1/runs/:id.',
  );
}

/** The controller prefix and the handler path joined, e.g. `/v1/runs/:id/note`. */
function routePath(ctx: ExecutionContext): string {
  const one = (value: unknown): string => {
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0];
    throw new Error(`AccessGuard cannot judge a route registered under several paths: ${JSON.stringify(value)}`);
  };
  const prefix = one(Reflect.getMetadata(PATH_METADATA, ctx.getClass()));
  const sub = one(Reflect.getMetadata(PATH_METADATA, ctx.getHandler()));
  return `/${[prefix, sub].filter((p) => p && p !== '/').join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
}
