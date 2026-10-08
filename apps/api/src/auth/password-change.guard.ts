import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { passwordChangeRequired } from '../common/validation.js';
import { ALLOWED_BEFORE_PASSWORD_CHANGE_KEY } from './access.decorator.js';

/**
 * The password gate (docs/superpowers/specs/2026-10-07-project-access-design.md,
 * section 3, "First sign-in"). An account an admin created or reset carries
 * `user.mustChangePassword`; until its owner chooses a password, every route
 * answers that session 403 PASSWORD_CHANGE_REQUIRED except a handler marked
 * `@AllowedBeforePasswordChange` — `PUT /v1/me/password`, and the route walk
 * pins it to that one.
 *
 * Registered as an APP_GUARD AFTER `AuthGuard` and BEFORE `AccessGuard` in
 * auth.module.ts, and the position is the point: `req.tenant` is set by the
 * time it runs, and a flagged session is refused before `AccessGuard` can
 * answer it with a 404 or ADMIN_REQUIRED that would say which projects exist
 * and what it may do.
 *
 * It reads the flag `authenticateSession` copied onto the tenant — set for a
 * session only, never for a bearer token, so a token is never judged here.
 * A `@Public` route outside /v1 has no tenant and is not judged either.
 *
 * `AuthGuard` runs first, so a route asking a scope no session holds
 * ("stream", "telemetry": the live-run and telemetry routes) answers a flagged
 * session with that scope refusal instead — the same 403 every session gets
 * there, whatever its account, and so no more telling than this one.
 *
 * A GUARD READING HANDLER METADATA, NOT PATH MATCHING IN THE MIDDLEWARE: PR 1
 * measured path matching in front of Better Auth bypassed by dot-segments and
 * by the Host and X-Forwarded-Proto headers. A guard sees the handler Nest
 * has already routed the request to.
 */
@Injectable()
export class PasswordChangeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (req.tenant?.mustChangePassword !== true) return true;
    // The handler's own metadata only — see AllowedBeforePasswordChange.
    if (this.reflector.get<boolean | undefined>(ALLOWED_BEFORE_PASSWORD_CHANGE_KEY, ctx.getHandler()) === true) {
      return true;
    }
    throw passwordChangeRequired();
  }
}
