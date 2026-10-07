import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { MAX_OFFSET_MS } from '@perfportal/persistence';
import { z } from 'zod';

const UUID_EXAMPLE = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

/**
 * A BadRequestException carrying the `code`/`remediation` pair ProblemFilter
 * already knows how to surface (see problem.filter.ts). Without this, a
 * validation failure only ever gets the filter's generic fallback
 * remediation ("Check the request against the OpenAPI description..."),
 * which does not say what a valid value actually looks like.
 */
export function badRequest(code: string, message: string, remediation: string): BadRequestException {
  return Object.assign(new BadRequestException(message), { code, remediation });
}

/**
 * The 409 counterpart of `badRequest`, for a request that is well-formed and
 * still cannot be satisfied because something already exists.
 *
 * It exists for the same reason: `ProblemFilter` falls back to
 * "Check the request against the OpenAPI description at /v1/openapi.json"
 * when an exception carries no `remediation`, and that is unhelpful advice
 * for the one error a user hits routinely. A duplicate project slug is not a
 * malformed request — the OpenAPI document describes it perfectly — so the
 * only useful thing to say is "choose a different one", which the caller
 * supplies here. The status is what distinguishes it: 400 means "you sent
 * something wrong", 409 means "the world is not in the state you assumed".
 */
export function conflict(code: string, message: string, remediation: string): ConflictException {
  return Object.assign(new ConflictException(message), { code, remediation });
}

/**
 * The 404 counterpart, and the one that was missing for longest.
 *
 * `conflict` above argues the general case and then applies it to one status:
 * "`ProblemFilter` falls back to 'Check the request against the OpenAPI
 * description at /v1/openapi.json' when an exception carries no
 * `remediation`, and that is unhelpful advice ... the OpenAPI document
 * describes it perfectly." **Every word of that is true of a 404**, and there
 * were nineteen of them. Measured against a real API before this existed:
 *
 *     404 NOT_FOUND  detail: No run <uuid> in this project.
 *                    remediation: Check the request against the OpenAPI
 *                                 description at /v1/openapi.json.
 *
 * NO `code` PARAMETER, UNLIKE `badRequest` AND `conflict`, AND THAT IS
 * DELIBERATE. `ProblemFilter` derives `NOT_FOUND` from the status today, and
 * a per-site code would change the wire contract — `code` is what a generated
 * client branches on, and the OpenAPI document declares it. This fixes the
 * remediation and nothing else, so the only field that moves is the one that
 * was wrong.
 */
export function notFound(message: string, remediation: string): NotFoundException {
  return Object.assign(new NotFoundException(message), { remediation });
}

/**
 * The 403 counterpart, for the two GUARDS.
 *
 * The authentication path does not need this: `AuthMiddleware` catches every
 * `HttpException` thrown out of `authenticateRequest`/`authenticateSession`
 * and writes its own problem document with a real remediation — measured, a
 * missing credential answers "Provide a bearer API token in the Authorization
 * header ... or sign in at POST /auth/sign-in/email". Middleware runs BEFORE
 * guards, so `AuthGuard`'s scope check and `SessionOnlyGuard` are outside
 * that catch and fell through to the generic fallback instead.
 */
export function forbidden(message: string, remediation: string): ForbiddenException {
  return Object.assign(new ForbiddenException(message), { remediation });
}

/*
 * ═══ ONE 404 FOR "NOT THERE" AND "NOT YOURS" ═══
 *
 * A project or run the caller cannot see must answer exactly as one that does
 * not exist, or comparing the two answers reveals which projects and runs
 * exist (docs/superpowers/specs/2026-10-07-project-access-design.md, section
 * 2). For a non-admin session on a `@Requires` route, `AccessGuard` answers
 * BOTH itself, with one of these — a missing target and an invisible one go
 * through the same call, so their bodies differ only in traceId. (A malformed
 * run id is the exception it leaves to the controller's 400.)
 *
 * The controllers' own "not there" answers, which admins and bearer tokens
 * still reach, call these too, so the wording is one thing everywhere — and
 * is what those controllers already sent, unchanged. The run note's 404 was
 * the exception ("…in this organisation."), so an admin and a non-member got
 * two wordings from one route; it calls `runNotFound` now. One 404 in
 * runs.controller.ts still spells its own: the bearer-only project run
 * list's, which only a token reaches and no guard answers for.
 */

/** A project slug the caller's org does not hold, or holds out of their reach. */
export function projectNotFound(slug: string): NotFoundException {
  return notFound(
    `No project "${slug}" in this organisation.`,
    'Check the slug, or list the projects this credential can reach with GET /v1/projects.',
  );
}

/** A run id that is not in the caller's reach: no such run, or one in a project they cannot see. */
export function runNotFound(id: string): NotFoundException {
  return notFound(
    `No run ${id} in this project.`,
    'Check the run id. GET /v1/runs lists the runs a signed-in user can reach; '
      + 'GET /v1/projects/{slug}/runs lists those a project token can.',
  );
}

/**
 * A refusal the caller CAN see the reason for: the project is visible to
 * them, and their standing is not enough. Unlike `forbidden`, it carries its
 * own `code`, because a client tells "ask for a role" from "ask an admin"
 * by it.
 */
export function accessDenied(
  code: 'ROLE_REQUIRED' | 'ADMIN_REQUIRED',
  message: string,
  remediation: string,
): ForbiddenException {
  return Object.assign(new ForbiddenException(message), { code, remediation });
}

/**
 * The password gate's refusal (`PasswordChangeGuard`): this session's account
 * must choose a new password before anything else. One body for every route
 * it guards, so the refusal says nothing about the route it was asked of.
 */
export function passwordChangeRequired(): ForbiddenException {
  return Object.assign(new ForbiddenException('Choose a new password before doing anything else.'), {
    code: 'PASSWORD_CHANGE_REQUIRED',
    remediation: 'Change it with PUT /v1/me/password.',
  });
}

/**
 * `?from=&to=` as elapsed ms from run start.
 *
 * ═══ EACH BOUND IS INDEPENDENTLY OPTIONAL AND MEANINGFUL ALONE ═══
 *
 * `from` with no `to` means "to the end"; `to` with no `from` means "from the
 * start". NEITHER is ever silently ignored — that is the trap the metrics
 * endpoints already carry for `?name=` without `scope`, where the parameter
 * looks honoured and is not.
 *
 * Returns null when neither is present, which means the whole run.
 *
 * The open upper bound is MAX_OFFSET_MS, not Number.MAX_SAFE_INTEGER:
 * `start_offset_ms` is an int4 column and an unclamped bound fails the query
 * outright rather than matching everything.
 */
export function parseRange(
  from: string | undefined,
  to: string | undefined,
): { fromMs: number; toMs: number } | null {
  if (from === undefined && to === undefined) return null;

  const bound = (raw: string | undefined, fallback: number, label: string): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw badRequest(
        'RANGE_INVALID',
        `"${label}" must be a non-negative integer number of milliseconds, not "${raw}".`,
        'Pass elapsed milliseconds from the run start, for example ?from=0&to=60000.',
      );
    }
    return n;
  };

  const fromMs = bound(from, 0, 'from');
  const toMs = Math.min(bound(to, MAX_OFFSET_MS, 'to'), MAX_OFFSET_MS);
  if (fromMs >= toMs) {
    throw badRequest(
      'RANGE_INVALID',
      `"from" (${fromMs}) must be strictly before "to" (${toMs}).`,
      'An empty window has no statistics to report; widen the range.',
    );
  }
  return { fromMs, toMs };
}

/**
 * A path segment that must be a UUID (a run id). Malformed input must be a
 * 400 telling the caller what a valid value looks like — not a 500 that
 * dumps a Prisma "invalid input syntax for type uuid" error to stderr and
 * tells the caller to retry a request that can never succeed unmodified.
 */
export function uuidParam(paramName: string): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      badRequest(
        'INVALID_ID',
        `The "${paramName}" path parameter is not a valid UUID.`,
        `Provide a valid UUID for "${paramName}", for example ${UUID_EXAMPLE}.`,
      ),
  });
}

const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
const LIMIT_DEFAULT = 25;

const LimitSchema = z.coerce
  .number()
  .finite()
  .catch(LIMIT_DEFAULT)
  .transform((n) => Math.min(Math.max(Math.trunc(n), LIMIT_MIN), LIMIT_MAX));

/**
 * Coerces `limit` into the sane positive range [1, 100], defaulting to 25 for
 * missing or non-numeric input. `limit=-5` used to reach
 * `Math.min(-5, 100)` === -5, and `Array.prototype.slice(0, -5)` silently
 * returns `[]` — a paginating client would conclude the project has no runs
 * at all instead of getting an error it could act on. Clamping instead of
 * rejecting keeps pagination usable for a slightly-out-of-range value while
 * still being a sane positive number by the time it reaches the query.
 */
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return LIMIT_DEFAULT;
  return LimitSchema.parse(raw);
}

const CursorSchema = z.string().uuid();

/**
 * `cursor` feeds Prisma's `cursor: { id: ... }` keyset pagination directly.
 * An arbitrary non-UUID string there throws a raw Prisma validation error —
 * the same "500 that blames the caller for a bug in application input
 * handling" shape as an unvalidated run id.
 */
export function parseCursor(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const parsed = CursorSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(
      'INVALID_CURSOR',
      `"${raw}" is not a valid cursor.`,
      `A cursor must be the "id" of a previously-returned item, a UUID such as ${UUID_EXAMPLE}.`,
    );
  }
  return parsed.data;
}

/**
 * A query parameter that must be ONE string, or a 400 naming it.
 *
 * Express parses a repeated parameter (`?q=a&q=b`) into an array, and a
 * bracketed one (`?q[x]=1`) into an object, while `@Query('q') q?: string`
 * types it as a string regardless. The run lists then called `.trim()` on it
 * (a TypeError) or handed it to Prisma as a slug (a validation error): a 500
 * for a request only the caller can have got wrong. Typing the parameter
 * `unknown` and passing it through here is what makes that shape refusable.
 *
 * `limit` does not need it: `parseLimit` already reads anything it cannot use
 * as the default page size, by design.
 */
export function singleValue(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw badRequest(
      'INVALID_QUERY',
      `"${name}" must be given once, as a single value.`,
      `Send "${name}" at most once, for example ?${name}=checkout.`,
    );
  }
  return value;
}
