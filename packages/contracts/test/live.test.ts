import { describe, expect, it } from 'vitest';
import {
  OpenLiveRunRequestSchema, OpenLiveRunResponseSchema,
  RunProcessingSchema, RunStatusSchema, TokenScopeSchema,
} from '../src/index.js';

describe('live contracts', () => {
  it('accepts the two new run states', () => {
    expect(RunStatusSchema.parse('running')).toBe('running');
    expect(RunStatusSchema.parse('incomplete')).toBe('incomplete');
  });

  it('treats a running run as pending-shaped, so a CI poll loop is unchanged', () => {
    // RunProcessingSchema (the 202 body) enumerates its own statuses
    // INDEPENDENTLY of RunStatusSchema (run.ts:148), so widening one does not
    // widen the other and a typecheck will not catch the omission.
    expect(() => RunProcessingSchema.parse({
      id: '0f9b1d4e-1111-2222-3333-444455556666',
      status: 'running', statusUrl: 'https://example.test/v1/runs/abc',
    })).not.toThrow();
  });

  it('knows the stream scope', () => {
    expect(TokenScopeSchema.parse('stream')).toBe('stream');
  });

  it('open takes the same frozen metadata a bundle upload takes', () => {
    const parsed = OpenLiveRunRequestSchema.parse({
      environment: 'staging', branch: 'main',
      commitSha: 'deadbeef', idempotencyKey: 'run-42',
    });
    expect(parsed.branch).toBe('main');
  });

  it('open with no metadata is valid', () => {
    expect(() => OpenLiveRunRequestSchema.parse({})).not.toThrow();
  });

  it('open returns where to stream and from which byte', () => {
    const r = OpenLiveRunResponseSchema.parse({
      runId: '0f9b1d4e-1111-2222-3333-444455556666',
      streamUrl: '/v1/runs/0f9b1d4e-1111-2222-3333-444455556666/stream',
      nextOffset: 0,
    });
    expect(r.nextOffset).toBe(0);
  });
});
