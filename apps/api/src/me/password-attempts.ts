import { Inject, Injectable } from '@nestjs/common';
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

/** The limit and the window together, as `PasswordAttempts` takes them. */
export interface PasswordAttemptPolicy {
  /** Attempts allowed in one window; the next one is refused. */
  readonly limit: number;
  /** The window's length, from its FIRST attempt. */
  readonly windowSeconds: number;
}

/** Production's policy: the two constants above. Frozen, because it is one
 *  object shared by `MeModule` and the constructor default, and a caller that
 *  wrote to it would change production's throttle for every account. */
export const DEFAULT_PASSWORD_ATTEMPT_POLICY: PasswordAttemptPolicy = Object.freeze({
  limit: PASSWORD_ATTEMPT_LIMIT,
  windowSeconds: PASSWORD_ATTEMPT_WINDOW_SECONDS,
});

/**
 * The injection token for the policy. `MeModule` provides it as
 * `DEFAULT_PASSWORD_ATTEMPT_POLICY`; a test overrides it to take a longer
 * window than a loaded machine can be trusted to fit four scrypt-hashing
 * requests into.
 */
export const PASSWORD_ATTEMPT_POLICY = Symbol('PASSWORD_ATTEMPT_POLICY');

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
 * (Better Auth's `/auth/verify-password` is the same oracle with no throttle
 * at all, so it answers 404 over HTTP: `SERVER_ONLY_ROUTES` in createAuth.)
 *
 * PER ACCOUNT, NOT PER ADDRESS: the attacker this is for holds the person's
 * cookie, and can send from as many addresses as they like.
 *
 * EVERY call counts, a right password and a malformed body included, and the
 * count is taken before anything is hashed, so a refused call costs one Redis
 * round trip. One `MULTI`: `INCR` the counter, `EXPIRE … NX` so the FIRST call
 * of a window sets its end and later ones do not push it back — a FIXED
 * window, so an attacker who keeps guessing is refused until it ends rather
 * than for ever, and a person who mistyped three times waits at most one
 * window — and `TTL` for the `Retry-After`. Atomic, so no crash can leave a
 * counter without an expiry — an account locked out for ever.
 *
 * ═══ IT FAILS CLOSED ═══
 *
 * If Redis errors, or the transaction is aborted, `take` throws and the route
 * answers 500: a flagged session cannot clear its flag, and nobody can change
 * their password, until Redis is back. That is deliberate. A brute-force
 * guard that lets attempts through when it cannot count them is no guard
 * while its store is down, which is exactly when nobody is watching it.
 */
@Injectable()
export class PasswordAttempts {
  constructor(
    private readonly commands: RedisCommands,
    @Inject(PASSWORD_ATTEMPT_POLICY)
    private readonly policy: PasswordAttemptPolicy = DEFAULT_PASSWORD_ATTEMPT_POLICY,
  ) {}

  /**
   * Counts one attempt by `userId`. `null` when it may go ahead; otherwise
   * the whole seconds until its window ends (at least 1), for `Retry-After`.
   */
  async take(userId: string): Promise<number | null> {
    const key = passwordAttemptKey(userId);
    const replies = await this.commands.client
      .multi()
      .incr(key)
      // `NX` needs Redis 7.0 or later: an older server rejects it, and `take` throws.
      .expire(key, this.policy.windowSeconds, 'NX')
      .ttl(key)
      .exec();
    if (replies === null) throw new Error('The password-attempt counter transaction was aborted.');
    for (const [err] of replies) if (err) throw err;
    const count = replies[0]![1] as number;
    if (count <= this.policy.limit) return null;
    // Redis rounds a TTL to the nearest second, so with under half a second
    // left it reports 0; a `Retry-After: 0` would invite an immediate retry
    // that is refused again. (-1 and -2 cannot follow the EXPIRE above in one
    // MULTI, and would read as 1 too.)
    const ttl = replies[2]![1] as number;
    return Math.max(ttl, 1);
  }
}
