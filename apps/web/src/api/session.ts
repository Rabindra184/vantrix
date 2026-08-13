/**
 * D-1 (session-auth spec §5): `/auth/*` returns Better Auth's own native
 * shapes, not RFC 9457 `application/problem+json` — there is no
 * `remediation`, because wrapping a library's own error distinctions risks
 * flattening ones it drew deliberately. This file is the only place that
 * shape is understood; everything else in this app consumes `ProblemError`
 * (parity-ui design §5) instead. Nothing here ever invents a `remediation`
 * Better Auth did not send.
 */

/**
 * Better Auth's own `{ code, message }` error body (see e.g.
 * `BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD` in the `better-auth`
 * package) — deliberately shaped nothing like `ProblemError`, and with no
 * `remediation` field to synthesise one into.
 */
export class AuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/**
 * Better Auth's own `get-session`/`sign-in` response shape — the base
 * `user`/`session` models with no plugins enabled (the organization plugin
 * is deliberately absent; see `packages/persistence/src/auth.ts`). Not a
 * `@perfportal/contracts` schema: this surface is deliberately outside that
 * contract (D-1), so there is nothing to import here.
 */
export interface Session {
  session: {
    id: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
    ipAddress: string | null;
    userAgent: string | null;
  };
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
    name: string;
    image: string | null;
    createdAt: string;
    updatedAt: string;
  };
}

/** Reads Better Auth's `{ code, message }` error body off a failed `/auth/*` response. */
async function authError(res: Response): Promise<AuthError> {
  const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
  return new AuthError(body?.code ?? 'UNKNOWN', body?.message ?? `Request to ${res.url} failed with status ${res.status}`);
}

/**
 * ONE query key for the session bootstrap, exported here beside its fetcher
 * exactly as `runsQueryKey` is exported beside `fetchRuns` — so a consumer
 * that needs to read, invalidate or seed the session cache names the same
 * array this module does, rather than re-spelling a string literal that
 * nothing would catch drifting.
 */
export const sessionQueryKey = ['session'] as const;

/**
 * Asked once on load; the answer decides `/login` versus the shell (design
 * §4) — Task 5's job, not this module's. Returns null when Better Auth
 * reports no session: a 200 with a JSON `null` body is its own signal for
 * "no session", not something this module infers. Any other failure throws
 * `AuthError` rather than being silently treated as "logged out".
 */
export async function getSession(): Promise<Session | null> {
  const res = await fetch('/auth/get-session', { credentials: 'same-origin' });
  if (!res.ok) throw await authError(res);
  return (await res.json()) as Session | null;
}

/** Signs in with Better Auth's email/password provider. Sets the session cookie on success. */
export async function signIn(email: string, password: string): Promise<void> {
  const res = await fetch('/auth/sign-in/email', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await authError(res);
}

/**
 * Invalidates the session cookie. Clearing the query cache and redirecting
 * (design §5.1: "leaving a previous user's run list in memory ... is a data
 * leak") is Task 5's job — this function only performs the sign-out call.
 */
export async function signOut(): Promise<void> {
  const res = await fetch('/auth/sign-out', { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) throw await authError(res);
}
