import { Body, Controller, HttpCode, Put, Req, Res, UseGuards } from '@nestjs/common';
import {
  ChangePasswordRequestSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_UNCHANGED,
} from '@perfportal/contracts';
import { UserRepository } from '@perfportal/persistence';
import { APIError } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import { AllowedBeforePasswordChange, OwnAccount } from '../auth/access.decorator.js';
import { auth } from '../auth/better-auth.instance.js';
import { SESSION_TOKEN_ID_PREFIX, SessionOnlyGuard } from '../auth/session-only.guard.js';
import { badRequest, rateLimited } from '../common/validation.js';
import { PasswordAttempts } from './password-attempts.js';

/**
 * The signed-in person's own account (docs/superpowers/specs/2026-10-07-project-access-design.md,
 * section 3, "Own password"). Session-only on the CLASS, so a route added here
 * later cannot forget it: a bearer token names nobody, so it has no own
 * account to act on.
 */
@Controller('/v1/me')
@UseGuards(SessionOnlyGuard)
export class MeController {
  constructor(
    private readonly users: UserRepository,
    private readonly attempts: PasswordAttempts,
  ) {}

  /**
   * Change your own password, and with it clear `mustChangePassword` — which
   * is why this is the one route `PasswordChangeGuard` lets a flagged session
   * reach.
   *
   * The ONLY way to change one's own password: Better Auth's
   * `/auth/change-password` is refused over HTTP (`refuseServerOnlyRoutes` in
   * createAuth), because it would skip the unchanged-password rule and the
   * flag. `auth.api.changePassword` below is unaffected — a server-side call
   * skips Better Auth's router, where that refusal runs.
   *
   * 1. The attempt is counted, before anything else and before anything is
   *    hashed: the 4th within a window answers 429 RATE_LIMITED with a
   *    `Retry-After` (see `PasswordAttempts`).
   * 2. The body is checked against bounds Better Auth enforces too
   *    (`auth-cookies.test.ts` pins the two together), plus the rule Better
   *    Auth does not have: the new password must differ from the current one.
   * 3. Better Auth's `changePassword` reads the session authoritatively,
   *    verifies the current password against the stored hash, and writes the
   *    new one. `revokeOtherSessions: false` because its `true` deletes EVERY
   *    session, the asking one included, and sets a fresh cookie that this
   *    204 would drop — the person would be signed out by changing their
   *    password.
   * 4. Then, in ONE transaction (`UserRepository.finishPasswordChange`), the
   *    person's OTHER sessions end — their cookies answer 401 on their next
   *    request — and the flag clears. This session stays.
   */
  @Put('password')
  @HttpCode(204)
  @OwnAccount()
  @AllowedBeforePasswordChange()
  async changePassword(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    const tenant = req.tenant!;
    const userId = tenant.userId!;
    // `session:<id>`, written by authenticateSession; SessionOnlyGuard has
    // already refused anything else.
    const sessionId = tenant.tokenId.slice(SESSION_TOKEN_ID_PREFIX.length);

    const retryAfter = await this.attempts.take(userId);
    if (retryAfter !== null) {
      res.setHeader('Retry-After', String(retryAfter));
      throw rateLimited('Too many password attempts.', 'Wait a few seconds and try again.');
    }

    const parsed = ChangePasswordRequestSchema.safeParse(body);
    if (!parsed.success) {
      // By its code, not its position: zod reports a length issue on the same
      // body BEFORE the refinement's (see PASSWORD_UNCHANGED).
      const unchanged = parsed.error.issues.find(
        (issue) => issue.code === 'custom' && issue.params?.['code'] === PASSWORD_UNCHANGED,
      );
      if (unchanged !== undefined) {
        throw badRequest('PASSWORD_UNCHANGED', unchanged.message, 'Choose a different password.');
      }
      const issue = parsed.error.issues[0];
      throw badRequest(
        'INVALID_PASSWORD_REQUEST',
        `The password request is not valid: ${issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'unknown'}`,
        `Send "currentPassword" and a "newPassword" of ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} ` +
          'characters, and no other field.',
      );
    }

    const headers = fromNodeHeaders(req.headers);
    try {
      await auth.api.changePassword({
        body: {
          currentPassword: parsed.data.currentPassword,
          newPassword: parsed.data.newPassword,
          revokeOtherSessions: false,
        },
        headers,
      });
    } catch (err) {
      if (err instanceof APIError && err.body?.code === 'INVALID_PASSWORD') {
        throw badRequest(
          'INVALID_CURRENT_PASSWORD',
          'The current password is not correct.',
          'Type the password you signed in with.',
        );
      }
      throw err;
    }

    await this.users.finishPasswordChange(userId, sessionId);
  }
}
