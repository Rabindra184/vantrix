import { describe, expect, it } from 'vitest';
import { resolveIdempotencyKey } from '../src/ingest/idempotency.js';

/**
 * FR-ING-7 is a P0 requirement and names an `Idempotency-Key` HEADER. Before
 * this resolver existed the server read only the `idempotencyKey` metadata
 * field, so a client sending the header got a 202 and a DUPLICATE RUN, with
 * nothing anywhere saying so — measured against a real API:
 *
 *     header   Idempotency-Key: k  x2  ->  two runs, both idempotency_key NULL
 *     metadata idempotencyKey: k    x2  ->  ONE run, the second returns 422
 *
 * These cases pin the resolver's rules. They deliberately do NOT prove the
 * controllers read it — a unit case that supplies both sides of that join
 * proves neither, so `ingest.integration.test.ts` drives a real request.
 */
describe('resolveIdempotencyKey', () => {
  const code = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      return (err as { code?: string }).code ?? 'NO_CODE';
    }
    return 'DID_NOT_THROW';
  };

  it('passes the metadata key through when no header is sent', () => {
    expect(resolveIdempotencyKey(undefined, 'from-metadata')).toBe('from-metadata');
    expect(resolveIdempotencyKey(undefined, undefined)).toBeUndefined();
  });

  it('accepts the header when no metadata key is sent', () => {
    expect(resolveIdempotencyKey(['from-header'], undefined)).toBe('from-header');
  });

  /**
   * The bound is the SHARED `IdempotencyKeySchema`, so the header and the
   * metadata field cannot drift about what a valid key is. Trimming is the
   * visible consequence: `contracts` records that an untrimmed key is half of
   * a unique index, so a whitespace-mangled key does not collide with its own
   * twin and the re-post it exists to absorb becomes a second run.
   */
  it('trims the header, the same way the metadata field is trimmed', () => {
    expect(resolveIdempotencyKey(['  padded  '], undefined)).toBe('padded');
  });

  it('accepts a header and metadata key that agree', () => {
    expect(resolveIdempotencyKey(['same'], 'same')).toBe('same');
  });

  /**
   * REFUSED RATHER THAN RESOLVED BY PRECEDENCE. Either choice silently
   * discards one spelling of the request's own identity, and a client sending
   * two different keys for one request has a bug — most likely middleware
   * minting a fresh header key underneath an application that already set its
   * own. Precedence makes that bug behave like working dedupe until it does
   * not; refusing names it on the first request.
   */
  it('refuses a header and metadata key that disagree', () => {
    expect(code(() => resolveIdempotencyKey(['aaa'], 'bbb'))).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  /**
   * THE ARRAY IS WHY THE CONTROLLERS READ `headersDistinct` AND NOT `headers`,
   * and that distinction is measured rather than stylistic: `req.headers`
   * comma-joins a repeated header into one string, so `xxx` + `yyy` arrives as
   * `'xxx, yyy'` — which passes min(1)/max(200) and was observed STORED as a
   * key. A comma is legal inside a key, so a joined duplicate is not
   * detectable after the fact; `headersDistinct` is what keeps these separable.
   */
  it('refuses a repeated header carrying different values', () => {
    expect(code(() => resolveIdempotencyKey(['xxx', 'yyy'], undefined))).toBe(
      'IDEMPOTENCY_KEY_CONFLICT',
    );
  });

  /**
   * The other half of that pair, and the one a precedence rule gets wrong.
   * Two IDENTICAL headers are not ambiguous — nothing about the request's
   * identity is in doubt — so this is accepted as the one value. Under
   * `req.headers` the same request yields `'twice, twice'`, a key the client
   * never sent and which a single-header retry would therefore never match.
   */
  it('accepts a repeated header whose values are identical, without joining them', () => {
    expect(resolveIdempotencyKey(['twice', 'twice'], undefined)).toBe('twice');
  });

  it('refuses a header that is empty or whitespace only', () => {
    expect(code(() => resolveIdempotencyKey([''], undefined))).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(code(() => resolveIdempotencyKey(['   '], undefined))).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('refuses a header longer than the shared bound', () => {
    expect(code(() => resolveIdempotencyKey(['k'.repeat(201)], undefined))).toBe(
      'IDEMPOTENCY_KEY_INVALID',
    );
    expect(resolveIdempotencyKey(['k'.repeat(200)], undefined)).toHaveLength(200);
  });

  /** An absent header and an empty array are the same fact: no header sent. */
  it('treats an empty header list as no header at all', () => {
    expect(resolveIdempotencyKey([], 'from-metadata')).toBe('from-metadata');
  });
});
