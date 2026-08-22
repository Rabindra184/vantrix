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
  // The BODY in the message, not just the code. This helper is called by every
  // test in the file, so when it fails the failure lands on whichever test got
  // there first and reads "expected 401 to be 200" while naming neither the
  // endpoint nor the reason. One occurrence of exactly that cost a full
  // investigation; the next one explains itself.
  expect(
    res.status,
    `GET /v1/openapi.json -> ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`,
  ).toBe(200);
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

  // The blanket loop below carves out exactly three exceptions:
  // POST /v1/projects/{slug}/tokens (Task 3), POST /v1/runs/live (Task 9)
  // and POST /v1/projects, all of which really do create synchronously — the
  // row exists (and, for token minting, the plaintext token is returned)
  // before the response is sent, the ordinary case 201 exists for. Every
  // other operation keeps the original reasoning: POST /v1/runs ingests
  // asynchronously and shares its run's own state machine (200/202/400/413/422)
  // with GET /v1/runs/{id} — there is no "created, still processing" state
  // distinct from 202 — and nothing else in this document creates a resource
  // at all. A future operation that starts returning 201 without being one
  // of these legitimate exceptions should still fail here.
  //
  // POST /v1/projects EARNED its place rather than being waved through: the
  // handler awaits a single Prisma insert and returns the project it just
  // wrote (`ProjectsController.create` → `ProjectRepository.createInOrg`),
  // so the resource is complete and addressable at `/projects/{slug}` the
  // instant the response is sent. That is the same shape as token minting,
  // and the opposite of `POST /v1/runs`, whose row is a promise to parse
  // something later. This gate went red when the project-creation UI landed,
  // which is exactly what it is for — a new 201 has to be argued for, not
  // absorbed.
  //
  // POST /v1/projects/{slug}/rules is the fourth, on exactly that standard:
  // `RulesController.create` awaits one `RuleRepository.create` insert and
  // returns the row, which is complete and addressable at
  // `/rules/{ruleId}` — the PATCH and DELETE beside it work on the id in
  // that very response. Nothing about the rule is deferred; what is deferred
  // is only the next RUN it will judge, which is not this resource.
  it('never declares a 201 response on any operation except token minting, opening a live run, creating a project, and creating an SLA rule, which really do create synchronously', async () => {
    const doc = await fetchDoc();
    const CREATES_SYNCHRONOUSLY = [
      { path: '/v1/projects/{slug}/tokens', method: 'post' },
      { path: '/v1/runs/live', method: 'post' },
      { path: '/v1/projects', method: 'post' },
      { path: '/v1/projects/{slug}/rules', method: 'post' },
    ];
    for (const { path, method, op } of operations(doc)) {
      if (CREATES_SYNCHRONOUSLY.some((c) => c.path === path && c.method === method)) {
        // The carve-out itself must be live: if either operation ever stops
        // declaring 201 while its handler keeps returning 201, this is the
        // assertion that notices instead of the loop just skipping it.
        expect(Object.keys(op.responses ?? {}), `${method.toUpperCase()} ${path}`).toContain('201');
        continue;
      }
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

  it('declares both bearerAuth and cookieAuth as document-level "either credential" security', async () => {
    const doc = await fetchDoc();

    const schemes = (doc.components as { securitySchemes?: unknown } | undefined)
      ?.securitySchemes as
      | Record<string, { type?: string; in?: string; name?: string }>
      | undefined;
    expect(schemes?.['bearerAuth']).toBeTruthy();
    expect(schemes?.['cookieAuth']).toBeTruthy();
    expect(schemes?.['cookieAuth']?.type).toBe('apiKey');
    expect(schemes?.['cookieAuth']?.in).toBe('cookie');
    expect(schemes?.['cookieAuth']?.name).toBe('better-auth.session_token');

    // An array of single-scheme entries is OR, not AND: either credential
    // alone satisfies a route with no per-operation override.
    const globalSecurity = (doc.security ?? []) as Record<string, unknown>[];
    expect(globalSecurity.some((req) => 'bearerAuth' in req)).toBe(true);
    expect(globalSecurity.some((req) => 'cookieAuth' in req)).toBe(true);
  });

  it('keeps POST /v1/runs and GET /v1/projects/{slug}/runs bearer-only — a session cannot name a project', async () => {
    const doc = await fetchDoc();

    for (const [path, method] of [
      ['/v1/runs', 'post'],
      ['/v1/projects/{slug}/runs', 'get'],
    ] as const) {
      const op = doc.paths?.[path]?.[method] as { security?: Record<string, unknown>[] } | undefined;
      expect(op, `${method.toUpperCase()} ${path} must be declared`).toBeTruthy();
      expect(op?.security, `${method.toUpperCase()} ${path} must override security`).toBeTruthy();
      expect(op?.security).toEqual([{ bearerAuth: [] }]);
    }
  });

  // The mirror image of the bearer-only test above: the three token
  // operations override to cookieAuth-only (SessionOnlyGuard refuses every
  // bearer credential). Without this, dropping `security: [{ cookieAuth: [] }]`
  // from a token path makes the document advertise `bearerAuth` on a route
  // that always answers 403 to it, with nothing here turning red.
  it('keeps the three token operations cookieAuth-only — SessionOnlyGuard refuses every bearer credential', async () => {
    const doc = await fetchDoc();

    for (const [path, method] of [
      ['/v1/projects/{slug}/tokens', 'post'],
      ['/v1/projects/{slug}/tokens', 'get'],
      ['/v1/projects/{slug}/tokens/{prefix}', 'delete'],
    ] as const) {
      const op = doc.paths?.[path]?.[method] as { security?: Record<string, unknown>[] } | undefined;
      expect(op, `${method.toUpperCase()} ${path} must be declared`).toBeTruthy();
      expect(op?.security, `${method.toUpperCase()} ${path} must override security`).toBeTruthy();
      expect(op?.security).toEqual([{ cookieAuth: [] }]);
    }
  });

  // The same shape as the token test above, and it guards a sharper edge.
  // These four routes edit the gate that decides whether a run passes, so a
  // bearer credential must never reach them at any scope — a CI token able to
  // raise its own threshold is a gate that does not gate. Drop the override
  // from one of them and the document advertises bearerAuth on a route that
  // always answers 403, with nothing else here turning red.
  it('keeps the four SLA-rule operations cookieAuth-only — a CI credential must not edit the gate that judges it', async () => {
    const doc = await fetchDoc();

    for (const [path, method] of [
      ['/v1/projects/{slug}/rules', 'post'],
      ['/v1/projects/{slug}/rules', 'get'],
      ['/v1/projects/{slug}/rules/{ruleId}', 'patch'],
      ['/v1/projects/{slug}/rules/{ruleId}', 'delete'],
    ] as const) {
      const op = doc.paths?.[path]?.[method] as { security?: Record<string, unknown>[] } | undefined;
      expect(op, `${method.toUpperCase()} ${path} must be declared`).toBeTruthy();
      expect(op?.security, `${method.toUpperCase()} ${path} must override security`).toBeTruthy();
      expect(op?.security).toEqual([{ cookieAuth: [] }]);
    }
  });

  /**
   * The tests routes SPLIT their guards, unlike the token and rule routes
   * beside them, so the document has to say so per operation. Reading which
   * tests exist is an ordinary read a CI job has every reason to make; naming
   * one is a human's choice about how their org reads.
   *
   * Two assertions, not one: that the PATCH overrides to cookieAuth, AND that
   * the GETs do NOT. Only the pair catches the split collapsing in either
   * direction — a GET that quietly became session-only would lock out the
   * bearer callers it exists for, and no other test here would notice.
   */
  it('keeps the test PATCH cookieAuth-only while its GETs take either credential', async () => {
    const doc = await fetchDoc();

    const patch = doc.paths?.['/v1/projects/{slug}/tests/{testSlug}']?.['patch'] as
      | { security?: Record<string, unknown>[] }
      | undefined;
    expect(patch, 'PATCH /v1/projects/{slug}/tests/{testSlug} must be declared').toBeTruthy();
    expect(patch?.security).toEqual([{ cookieAuth: [] }]);

    for (const path of ['/v1/projects/{slug}/tests', '/v1/projects/{slug}/tests/{testSlug}']) {
      const get = doc.paths?.[path]?.['get'] as { security?: unknown[] } | undefined;
      expect(get, `GET ${path} must be declared`).toBeTruthy();
      // No override at all: it inherits the document-level "either credential".
      expect(get?.security, `GET ${path} must not narrow to one credential`).toBeUndefined();
    }
  });

  it('declares the test filter on GET /v1/runs', async () => {
    const doc = await fetchDoc();
    const get = doc.paths?.['/v1/runs']?.['get'] as { parameters?: { name?: string }[] } | undefined;
    expect(get?.parameters?.map((p) => p.name)).toContain('test');
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

  // GET /v1/runs/{id}/series reads "family" too (SeriesController's group
  // page needs group_cumulated vs. group_duration), but the document only
  // ever listed [id, scope, name]. A client generated from the published
  // document could not request a group family at all: it would send
  // scope=group, silently default family to response_time, and get 200 with
  // an empty buckets array — indistinguishable from a group with no traffic.
  it('declares the query parameters GET /v1/runs/{id}/series actually reads', async () => {
    const doc = await fetchDoc();
    const names = (
      (doc.paths?.['/v1/runs/{id}/series']?.get as { parameters?: { name: string }[] } | undefined)
        ?.parameters ?? []
    ).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['id', 'scope', 'name', 'family']));
  });

  it('declares GET /v1/projects and its response schema', async () => {
    const doc = await fetchDoc();
    expect(doc.paths?.['/v1/projects']?.['get']).toBeTruthy();
    expect(doc.components?.schemas?.['ProjectListResponse']).toBeTruthy();
  });

  it('reports indicator bands on the stats response', async () => {
    const doc = await fetchDoc();
    const schemas = doc.components?.schemas ?? {};
    expect((schemas['StatsResponse'] as { properties?: Record<string, unknown> } | undefined)?.properties?.['configurable']).toBeDefined();
    expect((schemas['StatRow'] as { properties?: Record<string, unknown> } | undefined)?.properties?.['indicators']).toBeDefined();
  });

  it('declares the project filter on GET /v1/runs', async () => {
    const doc = await fetchDoc();
    const get = doc.paths?.['/v1/runs']?.['get'] as
      | { parameters?: { name?: string }[] }
      | undefined;
    expect(get?.parameters?.map((p) => p.name)).toContain('project');
  });

  // The precedent this fixes: commit 08a6967 on main shipped a fix for
  // run_series_bucket.family being absent from the document — "the document
  // validates" never catches an omission, because a document missing a
  // field is still a valid document. `RunResponse` is declared truthy
  // elsewhere in this file (see the "derives non-empty components.schemas"
  // test above), which passes regardless of which properties it carries;
  // these two are the properties assertions for project identity and ingest
  // provenance that spec §9 requires and that check does not provide.
  it('declares RunResponse.project and the three ingest fields', async () => {
    const doc = await fetchDoc();
    const schemas = doc.components?.schemas ?? {};
    const props = (schemas['RunResponse'] as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props['project']).toBeDefined();
    for (const f of ['environment', 'branch', 'commitSha']) expect(props[f], f).toBeDefined();
  });
});
