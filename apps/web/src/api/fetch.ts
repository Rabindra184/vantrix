import type { ZodSchema } from 'zod';
import { ProblemDetailsSchema, type ProblemDetails } from '@perfportal/contracts';

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
 */
async function problemFrom(res: Response): Promise<ProblemError> {
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
 * `sameSite: 'strict'`, and same-origin is how this app is served.
 *
 * Does not redirect on 401, or touch the DOM/router at all — that decision
 * belongs to Task 5's router, and keeping it out is what lets this module be
 * unit-tested without a browser.
 */
export async function apiFetch<T>(schema: ZodSchema<T>, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: 'same-origin' });

  if (!res.ok) {
    throw await problemFrom(res);
  }

  return schema.parse(await res.json());
}
