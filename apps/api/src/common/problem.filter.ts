import { randomUUID } from 'node:crypto';
import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { internalProblem, isIngestError, logInternalError, problem, problemFromIngestError } from './problem.js';

/** Every error leaves as application/problem+json. Stack traces never do. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const traceId = randomUUID();

    if (isIngestError(exception)) {
      const body = problemFromIngestError(exception, traceId);
      res.status(body.status).type('application/problem+json').send(body);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const detail =
        typeof raw === 'string' ? raw : ((raw as { message?: string }).message ?? exception.message);
      const body = problem(
        (exception as { code?: string }).code ?? httpCode(status),
        status,
        detail,
        (exception as { remediation?: string }).remediation ??
          'Check the request against the OpenAPI description at /v1/openapi.json.',
        traceId,
      );
      res.status(status).type('application/problem+json').send(body);
      return;
    }

    logInternalError(exception, traceId);
    res.status(500).type('application/problem+json').send(internalProblem(traceId));
  }
}

function httpCode(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 413) return 'BUNDLE_TOO_LARGE';
  if (status === 422) return 'SLA_FAILED';
  return 'BAD_REQUEST';
}
