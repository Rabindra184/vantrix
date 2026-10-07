import { Injectable } from '@nestjs/common';
import { RedisCommands } from '../common/redis-commands.js';

/**
 * How many times one account may call `PUT /v1/me/password` within one
 * window, and how long the window is. Better Auth's own rate for its
 * `/change-password` route (3 per 10 s), which `auth.api.changePassword` does
 * not apply: Better Auth's limiter runs in its HTTP router, and a server-side
 * `auth.api.*` call skips the router.
 */
export const PASSWORD_ATTEMPT_LIMIT = 3;
export const PASSWORD_ATTEMPT_WINDOW_SECONDS = 10;

/** The counter for one account's attempts. Exported so a test can read its TTL or end its window. */
export function passwordAttemptKey(userId: string): string {
  return `perfportal:password-attempts:${userId}`;
}

/**
 * ═══ A CURRENT-PASSWORD ORACLE, THROTTLED PER ACCOUNT ═══
 *
 * `PUT /v1/me/password` answers a wrong current password 400 and a right one
 * 204, so without a limit a stolen session cookie could guess the plaintext
 * password as fast as the server hashes — and every guess costs two scrypt
 * hashes. Measured before this existed, with NODE_ENV=production: Better
 * Auth's own `/auth/change-password` answered 400, 400, 400, 429, 429, 429,
 * while this route took 20 wrong guesses in 2.8 s and then a right one.
 *
 * PER ACCOUNT, NOT PER ADDRESS: the attacker this is for holds the person's
 * cookie, and can send from as many addresses as they like.
 *
 * EVERY call counts, a right password and a malformed body included, and the
 * count is taken before anything is hashed, so a refused call costs one Redis
 * round trip. One `MULTI`: `INCR` the counter, `EXPIRE … NX` so the FIRST call
 * of a window sets its end and later ones do not push it back, and `TTL` for
 * the `Retry-After`. Atomic, so no crash can leave a counter without an
 * expiry — an account locked out for ever.
 */
@Injectable()
export class PasswordAttempts {
  constructor(private readonly commands: RedisCommands) {}

  /**
   * Counts one attempt by `userId`. `null` when it may go ahead; otherwise
   * the whole seconds until its window ends (at least 1), for `Retry-After`.
   */
  async take(userId: string): Promise<number | null> {
    const key = passwordAttemptKey(userId);
    const replies = await this.commands.client
      .multi()
      .incr(key)
      .expire(key, PASSWORD_ATTEMPT_WINDOW_SECONDS, 'NX')
      .ttl(key)
      .exec();
    if (replies === null) throw new Error('The password-attempt counter transaction was aborted.');
    for (const [err] of replies) if (err) throw err;
    const count = replies[0]![1] as number;
    if (count <= PASSWORD_ATTEMPT_LIMIT) return null;
    const ttl = replies[2]![1] as number;
    return ttl > 0 ? ttl : PASSWORD_ATTEMPT_WINDOW_SECONDS;
  }
}
