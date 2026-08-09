import { validate } from '@readme/openapi-parser';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

interface AnyDoc {
  openapi?: string;
  security?: unknown[];
  paths?: Record<string, Record<string, { responses?: Record<string, unknown>; security?: unknown[] }>>;
  components?: {
    schemas?: Record<string, { required?: string[] }>;
  };
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Every (path, method, operation) triple the document declares. */
function operations(doc: AnyDoc): { path: string; method: string; op: { responses?: Record<string, unknown>; security?: unknown[] } }[] {
  const out: { path: string; method: string; op: { responses?: Record<string, unknown>; security?: unknown[] } }[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (op) out.push({ path, method, op });
    }
  }
  return out;
}

async function fetchDoc(): Promise<AnyDoc> {
  ctx = await createTestApp();
  const res = await request(ctx.app.getHttpServer()).get('/v1/openapi.json');
  expect(res.status).toBe(200);
  return res.body as AnyDoc;
}

// This suite replaces a single assertion — `paths['/v1/runs']` is truthy —
// that passed identically against the empty stub document and a correct
// one. Every assertion below is chosen to fail against that stub: see
// .superpowers/sdd/harden-2-report.md for the captured pre-fix run.
describe('OpenAPI document', () => {
  it('validates against a real OpenAPI validator, with no broken $refs', async () => {
    const doc = await fetchDoc();
    const result = await validate(doc as never);
    if (!result.valid) {
      console.error(JSON.stringify(result.errors, null, 2));
    }
    expect(result.valid).toBe(true);
  });

  it('derives non-empty components.schemas, including the run, stats, and problem-details schemas', async () => {
    const doc = await fetchDoc();
    const schemas = doc.components?.schemas ?? {};
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
    expect(schemas['RunResponse']).toBeTruthy();
    expect(schemas['StatsResponse']).toBeTruthy();
    expect(schemas['ProblemDetails']).toBeTruthy();
  });

  it('never declares a 201 response on any operation — POST /v1/runs does not create synchronously', async () => {
    const doc = await fetchDoc();
    for (const { path, method, op } of operations(doc)) {
      expect(Object.keys(op.responses ?? {}), `${method.toUpperCase()} ${path}`).not.toContain('201');
    }
  });

  it('declares POST /v1/runs as multipart/form-data with a required "bundle" file part', async () => {
    const doc = await fetchDoc();
    const post = doc.paths?.['/v1/runs']?.['post'] as
      | { requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> } }
      | undefined;
    expect(post).toBeTruthy();
    const multipart = post?.requestBody?.content?.['multipart/form-data'];
    expect(multipart).toBeTruthy();
    expect(multipart?.schema?.properties?.['bundle']).toBeTruthy();
  });

  it('declares the same run-state status codes on POST /v1/runs and GET /v1/runs/{id}', async () => {
    const doc = await fetchDoc();
    const post = doc.paths?.['/v1/runs']?.['post'];
    const get = doc.paths?.['/v1/runs/{id}']?.['get'];
    expect(post, 'POST /v1/runs must be declared').toBeTruthy();
    expect(get, 'GET /v1/runs/{id} must be declared').toBeTruthy();

    // The identity is over the run's own state machine (200/202/400/413/422)
    // — not over every response either operation happens to declare: GET
    // alone can 404 (no such run), which is a real asymmetry, not a bug.
    const stateCodes = ['200', '202', '400', '413', '422'];
    const postCodes = Object.keys(post?.responses ?? {});
    const getCodes = Object.keys(get?.responses ?? {});
    for (const code of stateCodes) {
      expect(postCodes, `POST /v1/runs is missing ${code}`).toContain(code);
      expect(getCodes, `GET /v1/runs/{id} is missing ${code}`).toContain(code);
    }
  });

  it('lists "remediation" as required on the problem-details schema', async () => {
    const doc = await fetchDoc();
    const problemDetails = doc.components?.schemas?.['ProblemDetails'];
    expect(problemDetails, 'components.schemas.ProblemDetails must exist').toBeTruthy();
    expect(problemDetails?.required ?? []).toContain('remediation');
  });

  it('exempts the health routes from auth while /v1 routes require the bearer scheme', async () => {
    const doc = await fetchDoc();

    const globalSecurity = doc.security ?? [];
    expect(globalSecurity.length, 'a default security requirement must exist').toBeGreaterThan(0);

    for (const path of ['/healthz', '/readyz']) {
      const op = doc.paths?.[path]?.['get'];
      expect(op, `${path} must be declared`).toBeTruthy();
      expect(op?.security, `${path} must explicitly opt out of auth`).toEqual([]);
    }

    // A /v1 operation authenticates either by inheriting the non-empty
    // document-level default (no per-operation override) or by repeating a
    // non-empty requirement of its own — either way it must not carry the
    // health routes' explicit "no auth" override.
    const post = doc.paths?.['/v1/runs']?.['post'];
    expect(post?.security === undefined || (post.security as unknown[]).length > 0).toBe(true);
  });

  it('documents every parity endpoint', async () => {
    const doc = await fetchDoc();
    for (const path of [
      '/v1/runs/{id}/distribution', '/v1/runs/{id}/users', '/v1/runs/{id}/scatter',
    ]) {
      expect(doc.paths?.[path]?.get).toBeDefined();
    }
  });

  it('documents the new component schemas', async () => {
    const doc = await fetchDoc();
    for (const name of ['DistributionResponse', 'UsersResponse', 'ScatterResponse', 'IndicatorBands']) {
      expect(doc.components?.schemas?.[name]).toBeDefined();
    }
  });

  it('declares the query parameters the parity endpoints actually read', async () => {
    const doc = await fetchDoc();
    const names = (
      (doc.paths?.['/v1/runs/{id}/distribution']?.get as { parameters?: { name: string }[] } | undefined)
        ?.parameters ?? []
    ).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['id', 'scope', 'name', 'family']));
  });

  it('reports indicator bands on the stats response', async () => {
    const doc = await fetchDoc();
    const schemas = doc.components?.schemas ?? {};
    expect((schemas['StatsResponse'] as { properties?: Record<string, unknown> } | undefined)?.properties?.['configurable']).toBeDefined();
    expect((schemas['StatRow'] as { properties?: Record<string, unknown> } | undefined)?.properties?.['indicators']).toBeDefined();
  });
});
