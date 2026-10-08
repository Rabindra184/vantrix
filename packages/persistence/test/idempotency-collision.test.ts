import { describe, expect, it } from 'vitest';
import { isIdempotencyKeyCollision } from '../src/index.js';

/**
 * `isIdempotencyKeyCollision` decides which P2002 an idempotent create may
 * answer with the winner's run. The targets below are the shapes Prisma was
 * MEASURED reporting for `run`'s three unique indexes on a migrated database
 * — database column names, not Prisma field names.
 *
 * The call sites cannot exercise the narrowing on their own: a create there
 * sets neither `test_id`/`run_number` nor a caller-chosen `id`, so no other
 * index can refuse it today. This matrix is what pins the rule, and the
 * forced-race cases in run-live.integration and ingest.integration are what
 * pin that the REAL error still matches it.
 */
const p2002 = (target: unknown) => ({ code: 'P2002', meta: { modelName: 'Run', target } });

describe('isIdempotencyKeyCollision', () => {
  it('matches the (project_id, idempotency_key) index, in either order', () => {
    expect(isIdempotencyKeyCollision(p2002(['project_id', 'idempotency_key']))).toBe(true);
    expect(isIdempotencyKeyCollision(p2002(['idempotency_key', 'project_id']))).toBe(true);
  });

  it("refuses run's other unique indexes, which are faults and not replays", () => {
    expect(isIdempotencyKeyCollision(p2002(['test_id', 'run_number']))).toBe(false);
    expect(isIdempotencyKeyCollision(p2002(['id']))).toBe(false);
  });

  it('matches the exact set, not an index that merely shares a column', () => {
    expect(isIdempotencyKeyCollision(p2002(['project_id', 'idempotency_key', 'tool']))).toBe(false);
    expect(isIdempotencyKeyCollision(p2002(['idempotency_key']))).toBe(false);
    expect(isIdempotencyKeyCollision(p2002(['project_id']))).toBe(false);
  });

  it("reads database column names, not Prisma's field names", () => {
    expect(isIdempotencyKeyCollision(p2002(['projectId', 'idempotencyKey']))).toBe(false);
  });

  it('refuses anything that is not a P2002 carrying an array target', () => {
    expect(isIdempotencyKeyCollision({ code: 'P2003', meta: { target: ['project_id', 'idempotency_key'] } })).toBe(false);
    expect(isIdempotencyKeyCollision({ code: 'P2002' })).toBe(false);
    expect(isIdempotencyKeyCollision({ code: 'P2002', meta: null })).toBe(false);
    expect(isIdempotencyKeyCollision(p2002('run_project_id_idempotency_key_key'))).toBe(false);
    expect(isIdempotencyKeyCollision(p2002(undefined))).toBe(false);
    expect(isIdempotencyKeyCollision(new Error('P2002'))).toBe(false);
    expect(isIdempotencyKeyCollision(null)).toBe(false);
    expect(isIdempotencyKeyCollision('P2002')).toBe(false);
  });
});
