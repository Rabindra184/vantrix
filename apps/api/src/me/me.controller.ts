import { Body, Controller, HttpCode, Put, Req, UseGuards } from '@nestjs/common';
import {
  ChangePasswordRequestSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_UNCHANGED,
} from '@perfportal/contracts';
import { UserRepository } from '@perfportal/persistence';
import { APIError } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { AllowedBeforePasswordChange, OwnAccount } from '../auth/access.decorator.js';
import { auth } from '../auth/better-auth.instance.js';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { badRequest } from '../common/validation.js';

/**
 * The signed-in person's own account (docs/superpowers/specs/2026-10-07-project-access-design.md,
 * section 3, "Own password"). Session-only on the CLASS, so a route added here
 * later cannot forget it: a bearer token names nobody, so it has no own
 * account to act on.
 */
@Controller('/v1/me')
@UseGuards(SessionOnlyGuard)
export class MeController {
  constructor(private readonly users: UserRepository) {}

  /**
   * Change your own password, and with it clear `mustChangePassword` — which
   * is why this is the one route `PasswordChangeGuard` lets a flagged session
   * reach.
   *
   * 1. The body is checked first, against bounds Better Auth enforces too
   *    (`auth-cookies.test.ts` pins the two together), plus the rule Better
   *    Auth does not have: the new password must differ from the current one.
   * 2. Better Auth's `changePassword` reads the session authoritatively,
   *    verifies the current password against the stored hash, and writes the
   *    new one. `revokeOtherSessions: false` because its `true` deletes EVERY
   *    session, the asking one included, and sets a fresh cookie that this
   *    204 would drop — the person would be signed out by changing their
   *    password.
   * 3. So the OTHER sessions are ended here, with Better Auth's own
   *    `revokeOtherSessions` endpoint (1.6.26, dist/api/routes/session.mjs):
   *    it lists the user's sessions, keeps the one whose token the request
   *    carries, and deletes the rest. Their cookies answer 401 on their next
   *    request.
   * 4. The flag is cleared last, once the password it asks for exists.
   */
  @Put('password')
  @HttpCode(204)
  @OwnAccount()
  @AllowedBeforePasswordChange()
  async changePassword(@Req() req: Request, @Body() body: unknown): Promise<void> {
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

    await auth.api.revokeOtherSessions({ headers });
    await this.users.setMustChangePassword(req.tenant!.userId!, false);
  }
}
