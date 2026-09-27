import { describe, expect, it } from 'vitest';
import { RunIdentitySchema, RunProcessingSchema } from '../src/index.js';

/**
 * ═══ THE RUN'S LIFECYCLE STAMPS ON THE WIRE ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * Stamps PerfPortal already stores, published for the run page's lifecycle
 * strip. OPTIONAL as well as nullable: the browser drops a body that fails
 * the schema, so a required field would blank the run page for every
 * response from an API pod that predates it.
 */
const MINIMAL = {
  id: '0f9b1d4e-1111-2222-3333-444455556666',
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  tool: 'gatling',
  startedAt: '2026-09-19T16:39:56.406Z',
};

describe('RunIdentity — the lifecycle stamps', () => {
  it('still parses an identity without them — the rolling-deploy guarantee', () => {
    const parsed = RunIdentitySchema.parse(MINIMAL);
    expect(parsed.parsingStartedAt).toBeUndefined();
    expect(parsed.streamUpdatedAt).toBeUndefined();
    expect(parsed.queuedAt).toBeUndefined();
  });

  it('carries all three, and null for any the row has not stamped', () => {
    const parsed = RunIdentitySchema.parse({
      ...MINIMAL,
      parsingStartedAt: '2026-09-19T16:41:46.000Z',
      streamUpdatedAt: null,
      queuedAt: '2026-09-19T16:39:15.000Z',
    });
    expect(parsed.parsingStartedAt).toBe('2026-09-19T16:41:46.000Z');
    expect(parsed.streamUpdatedAt).toBeNull();
    expect(parsed.queuedAt).toBe('2026-09-19T16:39:15.000Z');
  });

  it('refuses a stamp that is not an instant', () => {
    expect(() => RunIdentitySchema.parse({ ...MINIMAL, queuedAt: 'yesterday' })).toThrow();
  });

  it('reaches the 202 body, which is what a live run is read through', () => {
    const parsed = RunProcessingSchema.parse({
      ...MINIMAL,
      status: 'running',
      statusUrl: `/v1/runs/${MINIMAL.id}`,
      streamUpdatedAt: '2026-09-19T16:40:38.000Z',
    });
    expect(parsed.streamUpdatedAt).toBe('2026-09-19T16:40:38.000Z');
  });
});
