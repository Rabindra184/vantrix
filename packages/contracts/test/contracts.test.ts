import { describe, expect, it } from 'vitest';
import { IngestMetadataSchema, ProblemDetailsSchema, RunResponseSchema } from '../src/index.js';

describe('IngestMetadataSchema', () => {
  it('accepts a minimal payload', () => {
    const parsed = IngestMetadataSchema.parse({ tool: 'gatling' });
    expect(parsed.tool).toBe('gatling');
    expect(parsed.idempotencyKey).toBeUndefined();
  });

  it('rejects an unknown tool', () => {
    expect(() => IngestMetadataSchema.parse({ tool: 'notatool' })).toThrow();
  });

  it('rejects an idempotency key that is too long to index safely', () => {
    expect(() => IngestMetadataSchema.parse({ tool: 'gatling', idempotencyKey: 'x'.repeat(256) })).toThrow();
  });
});

describe('RunResponseSchema', () => {
  it('requires a verdict on a complete run', () => {
    const ok = RunResponseSchema.parse({
      id: '018f0000-0000-7000-8000-000000000000',
      project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
      status: 'complete',
      verdict: 'passed',
      tool: 'gatling',
      startedAt: '2026-08-07T00:00:00.000Z',
      assertions: [],
    });
    expect(ok.verdict).toBe('passed');
  });

  it('accepts a null toolStartedAt (not yet parsed) additively — every existing field still validates', () => {
    const ok = RunResponseSchema.parse({
      id: '018f0000-0000-7000-8000-000000000000',
      project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
      status: 'complete',
      verdict: 'passed',
      tool: 'gatling',
      startedAt: '2026-08-07T00:00:00.000Z',
      toolStartedAt: null,
      assertions: [],
    });
    expect(ok.toolStartedAt).toBeNull();
  });

  it('accepts a distinct, non-null toolStartedAt alongside startedAt', () => {
    const ok = RunResponseSchema.parse({
      id: '018f0000-0000-7000-8000-000000000000',
      project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
      status: 'complete',
      verdict: 'passed',
      tool: 'gatling',
      startedAt: '2026-08-07T10:00:00.000Z',
      toolStartedAt: '2026-08-07T05:30:02.171Z',
      assertions: [],
    });
    expect(ok.toolStartedAt).toBe('2026-08-07T05:30:02.171Z');
    expect(ok.toolStartedAt).not.toBe(ok.startedAt);
  });

  it('rejects a verdict outside the enum', () => {
    expect(() =>
      RunResponseSchema.parse({
        id: '018f0000-0000-7000-8000-000000000000',
        status: 'complete',
        verdict: 'maybe',
        tool: 'gatling',
        startedAt: '2026-08-07T00:00:00.000Z',
        assertions: [],
      }),
    ).toThrow();
  });
});

describe('RunResponseSchema project identity', () => {
  const base = {
    id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    status: 'complete',
    verdict: 'passed',
    tool: 'gatling',
    startedAt: '2026-08-15T10:00:00.000Z',
    assertions: [],
  };

  it('rejects a run with no project — run.project_id is NOT NULL', () => {
    expect(() => RunResponseSchema.parse(base)).toThrow();
  });

  it('carries the project through', () => {
    const ok = RunResponseSchema.parse({
      ...base,
      project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
    });
    expect(ok.project.slug).toBe('checkout');
    expect(ok.project.name).toBe('Checkout');
  });
});

describe('ProblemDetailsSchema', () => {
  it('requires remediation — an error that cannot state a fix is not a valid response', () => {
    expect(() =>
      ProblemDetailsSchema.parse({
        type: 'https://perfportal.dev/errors/BUNDLE_TOO_LARGE',
        title: 'Bundle too large',
        status: 400,
        code: 'BUNDLE_TOO_LARGE',
        detail: 'exceeded',
      }),
    ).toThrow();
  });
});
