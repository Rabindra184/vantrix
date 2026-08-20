import { describe, expect, it } from 'vitest';
import {
  OpenLiveRunRequestSchema, OpenLiveRunResponseSchema,
  ProblemDetailsSchema, RunIdentitySchema, RunProcessingSchema, RunStatusSchema,
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

  it('accepts a 202 body carrying the run identity a header needs', () => {
    const parsed = RunProcessingSchema.parse({
      id: '0f9b1d4e-1111-2222-3333-444455556666',
      status: 'running',
      statusUrl: '/v1/runs/0f9b1d4e-1111-2222-3333-444455556666',
      project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
      tool: 'gatling',
      toolVersion: null,
      environment: 'staging',
      branch: 'main',
      commitSha: 'deadbeefcafe',
      simulation: null,
      description: null,
      durationMs: null,
      startedAt: '2026-08-20T10:43:49.546Z',
      toolStartedAt: null,
    });
    expect(parsed.project?.slug).toBe('checkout');
    expect(parsed.environment).toBe('staging');
  });

  it('still accepts the NARROW 202 body an older API pod sends', () => {
    // The rolling-deploy direction that matters most: a new browser polling an
    // old pod. A required identity field here blanks the run page for the whole
    // rollout, because the client parses with .parse() and drops what fails.
    const parsed = RunProcessingSchema.parse({
      id: '0f9b1d4e-1111-2222-3333-444455556666',
      status: 'running',
      statusUrl: '/v1/runs/0f9b1d4e-1111-2222-3333-444455556666',
    });
    expect(parsed.project).toBeUndefined();
    expect(parsed.tool).toBeUndefined();
  });

  it('keeps a verdict off the 202 body entirely, however wide it gets', () => {
    // Identity is what a run knows about ITSELF; a verdict is a measurement.
    // z.object strips unknown keys, so this asserts the field is absent from
    // the parsed result rather than merely unvalidated.
    const parsed = RunProcessingSchema.parse({
      id: '0f9b1d4e-1111-2222-3333-444455556666',
      status: 'running',
      statusUrl: '/v1/runs/0f9b1d4e-1111-2222-3333-444455556666',
      verdict: 'passed',
      assertions: [],
    }) as Record<string, unknown>;
    expect(parsed.verdict).toBeUndefined();
    expect(parsed.assertions).toBeUndefined();
  });

  it('a run body still requires the project a run row cannot be missing', () => {
    // RunResponseSchema extends the NON-partial identity, so extraction must
    // not have loosened the required-ness its own comment argues for.
    expect(() => RunIdentitySchema.parse({
      id: '0f9b1d4e-1111-2222-3333-444455556666',
      tool: 'gatling',
      startedAt: '2026-08-20T10:43:49.546Z',
    })).toThrow();
  });
});
