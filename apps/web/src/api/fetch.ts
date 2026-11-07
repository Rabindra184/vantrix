import type { ZodSchema } from 'zod';
import { PUBLIC_LINK_SECRET_PATTERN, ProblemDetailsSchema, type ProblemDetails } from '@perfportal/contracts';

/**
 * Every non-2xx `/v1` response is RFC 9457 `application/problem+json` with a
 * compile-time-required `remediation` (session-auth spec §5, D-1; parity-ui
 * design §4). Only the fields the client actually needs are validated here —
 * `type`/`title` exist for HTTP tooling, not for this app — but they are
 * picked straight off the same `ProblemDetailsSchema` the server validates
 * its own output against, never redeclared.
 */
const ProblemFieldsSchema = ProblemDetailsSchema.pick({ code: true, detail: true, remediation: true });

/**
 * Carries the one `/v1` error shape. `status` is the actual HTTP response
 * status, not the body's own `status` field, so it stays correct even if a
 * caller and the wire ever disagreed. A 401 is just a `ProblemError` with
 * `status: 401` — this module never redirects (see apiFetch's docstring).
 */
export class ProblemError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string;
  readonly remediation: string;

  constructor(status: number, problem: Pick<ProblemDetails, 'code' | 'detail' | 'remediation'>) {
    super(problem.detail);
    this.name = 'ProblemError';
    this.code = problem.code;
    this.status = status;
    this.detail = problem.detail;
    this.remediation = problem.remediation;
  }
}

/**
 * Turns a non-2xx `Response` into a `ProblemError` — never anything else.
 *
 * Reads the body as text first, never `res.json()` directly, because a
 * non-2xx response is not guaranteed to come from the API at all: a reverse
 * proxy or gateway sitting between the browser and the API is free to return
 * an HTML or plain-text error page (a `502`/`504`), or JSON that isn't
 * problem-shaped, and none of that is under the API's contract. Text is
 * parsed as JSON, then checked against `ProblemFieldsSchema` with
 * `safeParse` — not `parse` inside a `try`/`catch` — so a body that is valid
 * JSON but not problem-shaped is a distinguishable, deliberate branch rather
 * than an incidentally-caught throw.
 *
 * When either step fails, a `ProblemError` is synthesized instead of letting
 * the `SyntaxError` or `ZodError` propagate, so `apiFetch`'s guarantee — a
 * rejected non-2xx call always rejects with a `ProblemError` — holds even
 * when infrastructure, not the API, produced the response. This function
 * never itself throws: `res.text()` rejecting on a dropped connection is
 * caught too and synthesizes with an empty raw body.
 *
 * `code: 'CLIENT_UNREADABLE_ERROR'` is prefixed `CLIENT_` deliberately: it
 * is synthesized here in the browser and must never be mistaken for a code
 * the API itself emitted.
 *
 * EXPORTED, and no longer only `apiFetch`'s. Its second caller is
 * `fetchRun` (`./run.ts`), which cannot go through `apiFetch` at all:
 * `GET /v1/runs/:id` answers 422 and 202 with ordinary run bodies rather
 * than problem documents, so it must branch on the status itself. What it
 * still needs is the ONE error path — a 404 or a 502 from that endpoint has
 * to become the same `ProblemError`, read the same way, as every other `/v1`
 * failure. Exporting this is what keeps that a single implementation rather
 * than a second, subtly different reader of problem+json.
 */
export async function problemFrom(res: Response): Promise<ProblemError> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    text = '';
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return synthesizeUnreadable(res.status, text);
  }

  const parsed = ProblemFieldsSchema.safeParse(json);
  if (parsed.success) {
    return new ProblemError(res.status, parsed.data);
  }

  return synthesizeUnreadable(res.status, text);
}

function synthesizeUnreadable(status: number, rawBody: string): ProblemError {
  return new ProblemError(status, {
    code: 'CLIENT_UNREADABLE_ERROR',
    detail: `Response body could not be parsed as a problem+json error. First 200 characters of the raw body: ${rawBody.slice(0, 200)}`,
    remediation:
      'This response did not come from the API in the expected form. A proxy or gateway between the browser and the API is the likely source — check infrastructure logs rather than the API itself.',
  });
}

/**
 * The secret a public link's page carries in its own URL, or `null` on any
 * other page: `/share/<secret>`, `/share/<secret>/` and `/share/<secret>/<section>`.
 *
 * The first segment is `share` compared WITHOUT regard to case, because the
 * router matches `/share/:token/*` that way (React Router's default, which
 * `RunShell` also allows for), and the page a reader is shown and the
 * credential its reads carry must agree about `/Share/…`. The secret itself is
 * never folded — it is case-sensitive base64url — and must match
 * `PUBLIC_LINK_SECRET_PATTERN` exactly, the one grammar the API checks it
 * against too. A segment that merely looks like one (a character short, the
 * wrong prefix, a stray character) is no secret, and the page then sends the
 * cookie as any other page does.
 */
export function publicLinkSecretFromPath(pathname: string): string | null {
  const segment = /^\/share\/([^/]+)(?:\/|$)/i.exec(pathname)?.[1];
  return segment !== undefined && PUBLIC_LINK_SECRET_PATTERN.test(segment) ? segment : null;
}

/**
 * ═══ WHICH CREDENTIAL A REQUEST CARRIES, DECIDED PER REQUEST FROM THE URL ═══
 *
 * On a public link's page: `Authorization: PublicLink <secret>`, merged into
 * the caller's own headers (whichever of `HeadersInit`'s three forms they came
 * in), and `credentials: 'omit'` — so a signed-in sharer opening their own link
 * in the same browser sends no cookie and reads exactly what a stranger reads.
 * The link REPLACES any `Authorization` the caller set: two credentials on one
 * request is one the API refuses.
 *
 * Everywhere else, the request is what it always was: the caller's `init`
 * untouched, and `credentials: 'same-origin'`.
 *
 * READ FROM `window.location.pathname` ON EVERY CALL, never remembered. A
 * module-level setter would still be holding the secret after a history
 * navigation from `/share/…` back into the app in the same tab, and would send
 * the link where the cookie belongs; a setter written by the public page's own
 * effect would run after its children's queries had already gone out without
 * it. The URL is the one answer that is right at the moment the request is
 * made (spec 6.2). `credentials` is set AFTER `init` on both paths, so a caller
 * cannot override it.
 *
 * Exported for `fetchRun` (`./run.ts`), which cannot go through `apiFetch` and
 * is the read the public page starts from. No `window` (the node test project)
 * is no share path.
 */
export function withCredential(init?: RequestInit): RequestInit {
  const secret = typeof window === 'undefined' ? null : publicLinkSecretFromPath(window.location.pathname);
  if (secret === null) return { ...init, credentials: 'same-origin' };

  const headers = new Headers(init?.headers);
  headers.set('Authorization', `PublicLink ${secret}`);
  return { ...init, headers, credentials: 'omit' };
}

/**
 * The one path everything under `/v1` goes through. Validates the response
 * against `schema` — the same Zod schema `@perfportal/contracts` exports and
 * the API validates its own output against — so client and server share one
 * definition of the shape; a response the schema rejects is a bug, not data,
 * and `schema.parse` is left to throw rather than being swallowed. That is
 * scoped strictly to the success path: a `SyntaxError` from a non-JSON 2xx
 * body, or a `ZodError` from a 2xx body the schema rejects, is a loud, correct
 * failure and must not be disguised as a `ProblemError`.
 *
 * The error path is different: a rejected non-2xx call always rejects with a
 * `ProblemError` (see `problemFrom`), because non-2xx responses are not
 * guaranteed to have come from the API's own contract in the first place.
 *
 * `credentials: 'same-origin'` is forced on every call (after `init`, so a
 * caller cannot accidentally override it): the session cookie is
 * `sameSite: 'strict'`, and same-origin is how this app is served. On a public
 * link's page it is `'omit'` instead, with the link's own header — see
 * `withCredential`, which both this and `apiFetchNoContent` call per request.
 *
 * Does not redirect on 401, or touch the DOM/router at all — keeping it out
 * is what lets this module be unit-tested without a browser. The decision is
 * the query client's (`queryClient.ts`), which ends the session on a 401 from
 * any query or mutation, and `AuthGate`'s, which turns that into a redirect
 * to sign-in.
 */
export async function apiFetch<T>(schema: ZodSchema<T>, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, withCredential(init));

  if (!res.ok) {
    throw await problemFrom(res);
  }

  return schema.parse(await res.json());
}

/**
 * `apiFetch` for a route that answers success with NO BODY — a 204, such as
 * `PUT /v1/me/password`.
 *
 * `apiFetch` cannot serve one: it ends in `res.json()`, which throws on an
 * empty body, so a change that succeeded would reject as a `SyntaxError`. This
 * keeps `apiFetch`'s other two guarantees and drops that one: the credential is
 * `withCredential`'s, forced after `init`, every non-2xx rejects as a
 * `ProblemError` through `problemFrom`, and a success's body is never read.
 * It resolves to nothing, because there is nothing to resolve to.
 *
 * `deletePackage` (`./packages.ts`) predates this and spells the same three
 * lines by hand.
 */
export async function apiFetchNoContent(path: string, init?: RequestInit): Promise<void> {
  const res = await fetch(path, withCredential(init));

  if (!res.ok) {
    throw await problemFrom(res);
  }
}
