import { describe, expect, it } from 'vitest';
import {
  OpenLiveRunRequestSchema, OpenLiveRunResponseSchema,
  ProblemDetailsSchema, RunProcessingSchema, RunStatusSchema,
  StreamRejectedSchema, TokenScopeSchema,
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

  it('rejects incomplete as a processing status, because incomplete is terminal', () => {
    // The exclusion this task cares most about: an aborted run must not be
    // reportable as "still working" forever. It currently holds only by what
    // this enum literally lists, so pin it directly rather than relying on
    // the positive case above to imply it.
    expect(() => RunProcessingSchema.parse({
      id: '0f9b1d4e-1111-2222-3333-444455556666',
      status: 'incomplete', statusUrl: 'https://example.test/v1/runs/abc',
    })).toThrow();
  });

  it('knows the stream scope', () => {
    expect(TokenScopeSchema.parse('stream')).toBe('stream');
  });

  it('open takes the same frozen metadata a bundle upload takes', () => {
    const parsed = OpenLiveRunRequestSchema.parse({
      tool: 'gatling',
      environment: 'staging', branch: 'main',
      commitSha: 'deadbeef', idempotencyKey: 'run-42',
    });
    expect(parsed.branch).toBe('main');
  });

  it('open with no OPTIONAL metadata is valid', () => {
    // tool is still required -- see the next case -- but everything else may
    // be omitted, same as on a bundle upload.
    expect(() => OpenLiveRunRequestSchema.parse({ tool: 'gatling' })).not.toThrow();
  });

  it('open requires tool, because a run cannot exist without knowing which plugin decodes it', () => {
    expect(() => OpenLiveRunRequestSchema.parse({})).toThrow();
  });

  it('open returns where to stream and from which byte', () => {
    const r = OpenLiveRunResponseSchema.parse({
      runId: '0f9b1d4e-1111-2222-3333-444455556666',
      streamUrl: '/v1/runs/0f9b1d4e-1111-2222-3333-444455556666/stream',
      nextOffset: 0,
    });
    expect(r.nextOffset).toBe(0);
  });

  const PROBLEM_FIELDS = {
    type: 'https://perfportal.dev/errors/STREAM_OFFSET_REJECTED',
    title: 'stream offset rejected',
    status: 409,
    code: 'STREAM_OFFSET_REJECTED',
    detail: 'gap',
    remediation: 'resume from nextOffset',
  };

  it('a stream rejection carries nextOffset alongside every ProblemDetails field', () => {
    // The bug this schema exists to prevent: ProblemDetailsSchema is a
    // plain z.object with no .passthrough(), so zodToJsonSchema (which the
    // OpenAPI document derives components.schemas from) emits
    // "additionalProperties: false" for it -- a document pointing this
    // response at THAT schema would describe itself as forbidding the one
    // field its own prose says the response carries.
    const parsed = StreamRejectedSchema.parse({ ...PROBLEM_FIELDS, nextOffset: 4096 });
    expect(parsed.nextOffset).toBe(4096);
    // Still a real ProblemDetails underneath -- every required field there
    // is still required here too, not loosened by the extension.
    expect(() => ProblemDetailsSchema.parse(parsed)).not.toThrow();
  });

  it('a stream rejection without nextOffset is invalid -- the field the resume loop depends on', () => {
    expect(() => StreamRejectedSchema.parse(PROBLEM_FIELDS)).toThrow();
  });
});
