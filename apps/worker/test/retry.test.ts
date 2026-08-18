import { ingestError } from '@perfportal/core';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { isTransient } from '../src/pipeline/retry.js';

describe('isTransient', () => {
  it('treats a lost database connection as transient', () => {
    const e = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
    expect(isTransient(e)).toBe(true);
  });

  it('treats object storage being unreachable as transient', () => {
    const e = Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' });
    expect(isTransient(e)).toBe(true);
  });

  it('treats every IngestError as deterministic — retrying reaches the same conclusion', () => {
    for (const code of ['LOG_MALFORMED', 'BUNDLE_EMPTY', 'ENDPOINT_CARDINALITY_EXCEEDED'] as const) {
      expect(isTransient(ingestError(code, { message: 'm', remediation: 'r' }))).toBe(false);
    }
  });

  it('treats an unknown error as deterministic, so a bug does not burn three worker slots', () => {
    expect(isTransient(new TypeError('x is not a function'))).toBe(false);
  });

  // The pipeline reaches the database through Prisma for findByIdUnscoped,
  // markParsing, and RuleRepository.listEnabled — a real outage there never
  // produces a hand-shaped {code: 'ECONNRESET'} object, it produces one of
  // these two Prisma error classes. Constructed via the real Prisma
  // constructors (not plain object literals) so the test exercises the exact
  // shape — including which property the code actually lives on — that a
  // real outage would produce.
  it("treats Prisma's Can't-reach-database-server as transient (PrismaClientInitializationError, P1001)", () => {
    const e = new Prisma.PrismaClientInitializationError(
      'Can\'t reach database server at `localhost`:`5433`',
      '6.19.3',
      'P1001',
    );
    expect(isTransient(e)).toBe(true);
  });

  it('treats a Prisma connection pool timeout as transient (PrismaClientInitializationError, P1002)', () => {
    const e = new Prisma.PrismaClientInitializationError(
      'The database server was reached but timed out',
      '6.19.3',
      'P1002',
    );
    expect(isTransient(e)).toBe(true);
  });

  it('treats Prisma reporting the server closed the connection as transient (PrismaClientInitializationError, P1017)', () => {
    const e = new Prisma.PrismaClientInitializationError(
      'Server has closed the connection',
      '6.19.3',
      'P1017',
    );
    expect(isTransient(e)).toBe(true);
  });

  // Fix round 1, Important 5. PipelineService throws this (RunLockedError,
  // code 'RUN_LOCKED') when it loses the advisory-lock race to the live
  // fold owner rather than to another process() call for the same run --
  // see pipeline.service.ts's #handleLockLost. It must be retried, not
  // treated as a deterministic failure, or the run sits at 'parsing' for up
  // to parsingStaleAfterMs (15 minutes by default) despite the owner
  // releasing the lock within one liveTickMs.
  it("treats PipelineService's own RUN_LOCKED signal as transient", () => {
    const e = Object.assign(new Error('run r1 is locked by the live fold owner; will retry'), {
      code: 'RUN_LOCKED',
    });
    expect(isTransient(e)).toBe(true);
  });

  it('still treats a Prisma-shaped query error with an unrelated code as deterministic', () => {
    // A genuinely deterministic failure (e.g. a unique-constraint violation)
    // must not be swept into "retryable" just because it is Prisma-shaped.
    const e = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`id`)', {
      code: 'P2002',
      clientVersion: '6.19.3',
    });
    expect(isTransient(e)).toBe(false);
  });
});
