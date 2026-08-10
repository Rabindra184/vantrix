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
 * The one path everything under `/v1` goes through. Validates the response
 * against `schema` — the same Zod schema `@perfportal/contracts` exports and
 * the API validates its own output against — so client and server share one
 * definition of the shape; a response the schema rejects is a bug, not data,
 * and `schema.parse` is left to throw rather than being swallowed.
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
  const body: unknown = await res.json();

  if (!res.ok) {
    throw new ProblemError(res.status, ProblemFieldsSchema.parse(body));
  }

  return schema.parse(body);
}
