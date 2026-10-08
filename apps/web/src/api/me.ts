import type { ChangePasswordRequest } from '@perfportal/contracts';
import { apiFetchNoContent } from './fetch';

/**
 * Changes the signed-in person's own password, and with it clears a forced
 * change — the one `/v1` route a session that must change its password may
 * reach.
 *
 * 204 and no body on success, so it goes through `apiFetchNoContent`. The
 * refusals (`INVALID_CURRENT_PASSWORD`, `PASSWORD_UNCHANGED`,
 * `INVALID_PASSWORD_REQUEST`) arrive as a `ProblemError`, read like every
 * other `/v1` failure.
 *
 * The body is exactly `ChangePasswordRequest`: the server's schema is strict,
 * so a form's own fields — the repeated new password — never ride along.
 */
export function changeOwnPassword(body: ChangePasswordRequest): Promise<void> {
  return apiFetchNoContent('/v1/me/password', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
