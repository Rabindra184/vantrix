import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';
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
