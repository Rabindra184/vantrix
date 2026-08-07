import { IngestError } from '@perfportal/core';
import type { ProblemDetails } from '@perfportal/contracts';

const BASE = 'https://perfportal.dev/errors';

/** Deterministic status for each ingest failure mode. */
const STATUS: Record<string, number> = {
  BUNDLE_TOO_LARGE: 413,
  BUNDLE_NOT_ARCHIVE: 400,
  BUNDLE_EMPTY: 400,
  TOOL_AMBIGUOUS: 400,
  TOOL_UNKNOWN: 400,
  LOG_NOT_FOUND: 400,
  LOG_BINARY_FORMAT: 400,
  LOG_MALFORMED: 400,
  ENDPOINT_CARDINALITY_EXCEEDED: 400,
  NO_REQUESTS: 400,
  PROJECT_MISMATCH: 403,
  TOKEN_REVOKED: 401,
  PLUGIN_TIMEOUT: 400,
  PLUGIN_MEMORY_EXCEEDED: 400,
};

export function statusForCode(code: string): number {
  return STATUS[code] ?? 400;
}

export function problemFromIngestError(err: IngestError, traceId?: string): ProblemDetails {
  return {
    type: `${BASE}/${err.code}`,
    title: err.message.split('\n')[0] ?? err.code,
    status: statusForCode(err.code),
    code: err.code,
    detail: err.message,
    remediation: err.remediation,
    ...(traceId ? { traceId } : {}),
    ...(err.detail ? { meta: err.detail } : {}),
  };
}

export function problem(
  code: string,
  status: number,
  detail: string,
  remediation: string,
  traceId?: string,
): ProblemDetails {
  return {
    type: `${BASE}/${code}`,
    title: code.replaceAll('_', ' ').toLowerCase(),
    status,
    code,
    detail,
    remediation,
    ...(traceId ? { traceId } : {}),
  };
}

export function isIngestError(e: unknown): e is IngestError {
  return e instanceof IngestError || (e instanceof Error && e.name === 'IngestError');
}

/**
 * The generic, non-revealing body for any failure that isn't a deliberate,
 * recognized rejection (an IngestError or an HttpException thrown on
 * purpose). Shared by ProblemFilter's catch-all and AuthMiddleware's catch
 * so the two paths can't drift apart again — the fields it returns are
 * fixed and never derived from the triggering exception, so an internal
 * detail (a database host, an ORM stack frame) can never leak through it.
 */
export function internalProblem(traceId: string): ProblemDetails {
  return problem(
    'INTERNAL',
    500,
    'The request could not be completed.',
    `Retry the request. If it keeps failing, report trace ${traceId}.`,
    traceId,
  );
}

/** Server-side record of an unrecognized failure, keyed by the trace id returned to the caller. */
export function logInternalError(exception: unknown, traceId: string): void {
  console.error('unhandled', traceId, exception);
}
