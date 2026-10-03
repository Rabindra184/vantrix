import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '@readme/openapi-parser';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { AppModule } from '../src/app.module.js';
import { SessionOnlyGuard } from '../src/auth/session-only.guard.js';
import { createTestApp, type TestContext } from './support/app.js';

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

interface AnyDoc {
  openapi?: string;
  security?: unknown[];
  paths?: Record<
    string,
    Record<
      string,
      {
        responses?: Record<string, unknown>;
        security?: unknown[];
        /** Widened for the run-scoped route guard below, which reads parameter names. */
        parameters?: { name?: string }[];
      }
    >
  >;
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
  it('never declares a 201 response on any operation except token minting, opening a live run, creating a project, creating an SLA rule, and queueing or retrying a runner job, which really do create synchronously', async () => {
    const doc = await fetchDoc();
    const CREATES_SYNCHRONOUSLY = [
      { path: '/v1/projects/{slug}/tokens', method: 'post' },
      { path: '/v1/runs/live', method: 'post' },
      { path: '/v1/projects', method: 'post' },
      { path: '/v1/projects/{slug}/rules', method: 'post' },
      // MEASURED, not inferred from Nest's default for @Post. Probed against a
      // real API with a real jar: 201, carrying the artifact and the job. It
      // meets this list's standard — the JOB is the resource created, and it
      // is complete and addressable the moment the response is sent (GET
      // .../runner/runs lists it immediately). The RUN it will later produce
      // is a different resource created asynchronously, which is exactly why
      // this response is the job and not a run.
      { path: '/v1/projects/{slug}/runner/runs', method: 'post' },
      // MEASURED the same way, and it is the same resource: a retry INSERTs a
      // NEW job (its own id, status queued) and returns it, and the list
      // carries it in the very next read — runner.integration.test.ts's
      // cancel-and-retry case asserts both. It answered 201 all along while
      // the document said 200; what changed is that the document stopped
      // saying otherwise. Cancel, beside it, creates nothing and answers 200.
      { path: '/v1/projects/{slug}/runner/runs/{jobId}/retry', method: 'post' },
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

  /**
   * ═══ A `.refine()` CAN ERASE THE FIELDS IT GUARDS, SILENTLY ═══
   *
   * `MintTokenRequestSchema` gained `expiresAt` and a refinement refusing an
   * instant in the past (review 09-13 M18). That refinement wraps the object,
   * and `components.schemas` is DERIVED from these zod schemas — so a
   * conversion that does not see through the wrapper emits a schema with no
   * properties at all, or drops the new one, while every runtime test stays
   * green because the SERVER still validates correctly.
   *
   * What would break is only the document: callers reading it would not know
   * the field exists, and nothing else here asks. `expiresAt` is asserted
   * beside `name` and `scopes` for that reason — the two that were always
   * there prove the conversion produced a real object rather than an empty
   * one, and the new one proves the refinement did not cost it.
   */
  it('keeps the mint request\'s own fields on the derived schema, refinement and all', async () => {
    const doc = await fetchDoc();
    const schema = (doc.components as { schemas?: Record<string, { properties?: Record<string, unknown>; required?: string[] }> })
      ?.schemas?.['MintTokenRequest'];

    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(['expiresAt', 'name', 'scopes']);
    // Optional, and the document has to say so: a required expiry would be a
    // lifetime policy imposed on every caller, which M18 deliberately refuses.
    expect(schema?.required ?? []).not.toContain('expiresAt');
    expect(schema?.required ?? []).toEqual(expect.arrayContaining(['name', 'scopes']));
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

  // ═══ ONE PATH, TWO OPPOSITE OVERRIDES, AND THAT IS THE DESIGN ═══
  //
  // `/v1/projects/{slug}/runs` carries a bearer-only GET (asserted above) and a
  // cookieAuth-only POST (review 09-13 M05's browser upload). Each credential
  // has exactly one way to ingest: a session cannot reach POST /v1/runs because
  // it names no project, and a project-scoped token does not need this one.
  //
  // Asserted as a PAIR, because either half alone passes against the collapse
  // that matters: give the POST `bearerAuth` as well and this route becomes a
  // second, redundant ingest path for tokens while the GET assertion above
  // stays green; drop the GET's override and the document advertises a session
  // scheme for a route that answers 400 PROJECT_REQUIRED to every session.
  it('keeps POST /v1/projects/{slug}/runs cookieAuth-only, opposite the GET on the same path', async () => {
    const doc = await fetchDoc();
    const path = doc.paths?.['/v1/projects/{slug}/runs'] as
      | Record<string, { security?: Record<string, unknown>[] } | undefined>
      | undefined;

    expect(path?.['post'], 'POST /v1/projects/{slug}/runs must be declared').toBeTruthy();
    expect(path?.['post']?.security).toEqual([{ cookieAuth: [] }]);
    expect(path?.['get']?.security).toEqual([{ bearerAuth: [] }]);
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

  /**
   * Every documented GET with a path parameter, probed with a malformed one —
   * and the status it really answers has to be a status it DECLARES.
   *
   * ═══ WHY THIS IS DERIVED RATHER THAN A CASE PER OPERATION ═══
   *
   * `GET /v1/runs/{id}/trends` shipped declaring [200, 401, 403, 404] while
   * answering 400 INVALID_ID for a malformed uuid — through `uuidParam('id')`,
   * the identical pipe its eight siblings on `/v1/runs/{id}` use, every one of
   * which documented the 400. A hand-maintained response map, one member short.
   * A case naming trends would close that one hole and leave the next operation
   * to somebody remembering; this collects the operations FROM THE DOCUMENT, so
   * a new path-param GET joins the check by existing.
   *
   * ═══ THE ASSERTION IS "OBSERVED ⊆ DECLARED", NOT "MUST 400" ═══
   *
   * A `{slug}` is any string, so those operations correctly answer 404 (no such
   * project) or 403 — and they document both. Requiring a 400 everywhere would
   * be false for every slug-scoped route in the product.
   *
   * ═══ TWO VACUITY GUARDS, AND THE SECOND IS THE ONE THAT BITES ═══
   *
   * A probe sent with NO credential answers 401 everywhere, and 401 is declared
   * on every one of these — so an unauthenticated version of this test passes
   * against any document at all, including the defect it was written for. It
   * sends the read token and requires that at least one probe got past auth.
   */
  it('answers no path-param GET with a status its own OpenAPI operation does not declare', async () => {
    const doc = await fetchDoc();
    const auth = { Authorization: `Bearer ${ctx.readToken}` };

    const probes = operations(doc).filter((o) => o.method === 'get' && o.path.includes('{'));
    expect(probes.length, 'collected no path-param GETs — the filter has rotted').toBeGreaterThan(5);

    const undocumented: string[] = [];
    const observed: number[] = [];
    for (const { path, op } of probes) {
      const declared = Object.keys(op.responses ?? {});
      const url = path.replace(/\{[^}]+\}/g, 'not-a-uuid');
      const res = await request(ctx.app.getHttpServer()).get(url).set(auth);
      observed.push(res.status);
      if (!declared.includes(String(res.status))) {
        undocumented.push(`GET ${path} answered ${res.status} ${String(res.body?.code ?? '')} — declares [${declared.sort().join(',')}]`);
      }
    }

    expect(
      observed.some((s) => s !== 401),
      'every probe answered 401, so this proves nothing — the credential did not work',
    ).toBe(true);
    expect(undocumented, undocumented.join('; ')).toEqual([]);
  }, 120_000);
});

/**
 * THE DOCUMENT'S RUN-SCOPED ROUTES ARE DERIVED FROM THE REGISTERED ONES.
 *
 * `GET /v1/runs/{id}/errors/series` was registered, answered 200, honoured
 * "from"/"to" — and appeared nowhere in this document, so a generated client
 * could not draw the errors chart at all. It is the ONLY two-segment
 * run-scoped route, which is why it keeps being the one that is missed:
 * everything else under `/v1/runs/{id}` is a single segment, so any list
 * assembled by eye drops it. `session-auth.integration.test.ts` records the
 * same endpoint missing from its cross-org array — a different hand-written
 * list, the identical omission.
 *
 * AND THE ROUTES LIVE IN TWO CONTROLLERS, which is the other half of why this
 * survived. `metrics.controller.ts` serves six and `parity.controller.ts`
 * serves distribution, users and scatter; a check that opens "the metrics
 * controller" sees two thirds of them. This collector keeps every
 * `*.controller.ts` whose `@Controller` prefix is `/v1/runs/:id`, which is the
 * collector `session-auth.integration.test.ts` already uses and the reason it
 * would have found this had it been pointed here.
 */
describe('the document describes every run-scoped route that exists', () => {
  const PREFIX = "@Controller('/v1/runs/:id')";

  /** Comments stripped, so prose quoting a decorator is never a route. */
  const strip = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  function controllerSources(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (!['node_modules', 'dist'].includes(e.name)) walk(full);
        } else if (e.name.endsWith('.controller.ts')) out.push(full);
      }
    };
    walk(join(process.cwd(), 'apps/api/src'));
    return out;
  }

  interface Route {
    readonly path: string;
    readonly file: string;
    readonly window: boolean;
  }

  function registeredRunRoutes(): { routes: Route[]; controllers: number } {
    const routes: Route[] = [];
    let controllers = 0;
    for (const file of controllerSources()) {
      const src = strip(readFileSync(file, 'utf8'));
      if (!src.includes(PREFIX)) continue;
      controllers += 1;
      // Each @Get(...) owns the text up to the next @Get or end of file, which
      // is where its own @Query parameters live.
      const parts = src.split(/@Get\(/).slice(1);
      for (const part of parts) {
        const m = /^'([^']*)'/.exec(part);
        if (!m) continue;
        const body = part.split(/@(?:Get|Post|Patch|Delete)\(/)[0] ?? '';
        routes.push({
          path: m[1] === '' ? '/v1/runs/{id}' : `/v1/runs/{id}/${m[1]}`,
          file: file.replace(`${process.cwd()}/`, ''),
          window: body.includes("@Query('from')") && body.includes("@Query('to')"),
        });
      }
    }
    return { routes, controllers };
  }

  it('has a path for every registered run-scoped GET', async () => {
    const { routes, controllers } = registeredRunRoutes();

    // VACUITY, both halves: a collector that finds no controller, or one that
    // finds a controller and no route, passes as quietly as one that works.
    expect(controllers, 'collected no run-scoped controllers — the prefix has changed').toBeGreaterThan(1);
    expect(routes.length, 'collected no run-scoped GETs — the @Get scan has rotted').toBeGreaterThan(5);

    const doc = await fetchDoc();
    const documented = new Set(Object.keys(doc.paths ?? {}));
    const missing = routes.filter((r) => !documented.has(r.path)).map((r) => `${r.path}  (${r.file})`);

    expect(missing, `registered but undocumented: ${missing.join('; ')}`).toEqual([]);
  }, 60_000);

  it('declares the window on every route whose handler reads one', async () => {
    const { routes } = registeredRunRoutes();
    const windowed = routes.filter((r) => r.window);

    // The same vacuity question one axis over: if nothing reads a window, this
    // case is comparing two empty sets and would pass against any document.
    expect(windowed.length, 'no handler reads from/to — the @Query scan has rotted').toBeGreaterThan(4);

    const doc = await fetchDoc();
    const undeclared: string[] = [];
    for (const r of windowed) {
      const op = (doc.paths ?? {})[r.path]?.get;
      const names = new Set((op?.parameters ?? []).map((p) => p.name));
      if (!names.has('from') || !names.has('to')) undeclared.push(r.path);
    }

    expect(
      undeclared,
      `handlers read "from"/"to" and the document does not declare them: ${undeclared.join('; ')}`,
    ).toEqual([]);
  }, 60_000);
});

/**
 * EVERY ROUTE NEST REGISTERED IS IN THE DOCUMENT, AND EVERY DOCUMENTED
 * OPERATION IS A ROUTE.
 *
 * WHY THIS IS DERIVED RATHER THAN A LIST. Six live routes were absent from
 * this document when it was written: the WHOLE on-prem runner job API (start,
 * list, cancel, logs, retry) and DELETE on a test. The document meanwhile
 * described a "runner" scope a token can hold and told readers tokens exist
 * for "on-prem runner jobs" — advertising a capability whose every endpoint it
 * omitted — and its `updateProjectTest` description asserted outright that
 * "there is no delete either", about an endpoint that is registered, wired to
 * a Delete test button in the browser, covered by its own integration
 * describe, and which returns 200 and removes the row.
 *
 * `/v1/runs/{id}/errors/series` had gone missing the same way one branch
 * earlier. Twice is a pattern, and the pattern is that a hand-written document
 * drifts from a route table nobody joins it against.
 *
 * READ FROM NEST'S OWN METADATA, NOT FROM THE SOURCE. A throwaway regex over
 * the controllers got this wrong twice while the finding was being
 * established — it matched across decorator boundaries and invented routes out
 * of `@Get()` with no argument. What settled it was the framework's own
 * `Mapped {...}` log, and `PATH_METADATA`/`METHOD_METADATA` are where that log
 * comes from. A sweep is a claim about its own collector before it is a claim
 * about the system.
 *
 * NOT EVERY HTTP SURFACE IS A NEST ROUTE, which is why this compares against
 * Nest rather than against the server: `/v1/openapi.json`, `/v1/docs` and the
 * Better Auth routes are mounted on Express directly (see `mountOpenApi` and
 * `app.module.ts`), so they never appear here and are not expected to.
 */
describe('the document covers exactly the routes Nest registers', () => {
  interface RouteRef {
    method: string;
    path: string;
    /** Whether SessionOnlyGuard sits on this handler or its controller class
     *  — read off Nest's own `@UseGuards` metadata, the same way the path is. */
    sessionOnly?: boolean;
    /** The status Nest sends when the handler returns normally: its
     *  `@HttpCode`, else Nest's own default — 201 for POST, 200 for anything
     *  else (RouterResponseController.setStatus). */
    successStatus?: number;
    /** Whether `@HttpCode` is set at all — the construct the vacuity guard
     *  counts, since an explicit `@HttpCode(201)` on a POST changes nothing. */
    hasHttpCode?: boolean;
    /** Whether the handler takes `@Res()` without passthrough, i.e. writes its
     *  own status. Nest sends nothing for those, so `successStatus` describes
     *  nothing they do. */
    ownsResponse?: boolean;
  }

  const guardedBySessionOnly = (target: object): boolean =>
    ((Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? []).includes(SessionOnlyGuard);

  /** `@Res()` is recorded on the CLASS, keyed by method name, as
   *  `"<paramtype>:<index>"` entries; passthrough leaves Nest sending. */
  const takesOwnResponse = (ctor: object, key: string): boolean =>
    Object.entries(
      (Reflect.getMetadata(ROUTE_ARGS_METADATA, ctor, key) as Record<string, { data?: unknown }> | undefined) ?? {},
    ).some(
      ([argKey, arg]) =>
        argKey.split(':')[0] === String(RouteParamtypes.RESPONSE) &&
        (arg.data as { passthrough?: boolean } | undefined)?.passthrough !== true,
    );

  /** Path params are compared by POSITION, not by name: `{id}` and `{runId}`
   *  are the same route shape, and the document is free to name them
   *  differently from the controller. */
  const shape = (r: RouteRef): string => `${r.method} ${r.path.replace(/\{[^}]+\}/g, '{}')}`;

  function registeredRoutes(): RouteRef[] {
    const seen = new Set<unknown>();
    const out: RouteRef[] = [];
    const walk = (mod: unknown): void => {
      if (!mod || seen.has(mod)) return;
      seen.add(mod);
      const controllers: unknown[] = Reflect.getMetadata('controllers', mod as object) ?? [];
      for (const c of controllers) {
        const ctor = c as { prototype: object };
        const prefix: string = Reflect.getMetadata(PATH_METADATA, c as object) ?? '';
        const classSessionOnly = guardedBySessionOnly(c as object);
        for (const key of Object.getOwnPropertyNames(ctor.prototype)) {
          if (key === 'constructor') continue;
          const fn = (ctor.prototype as Record<string, unknown>)[key];
          if (typeof fn !== 'function') continue;
          const sub: string | undefined = Reflect.getMetadata(PATH_METADATA, fn);
          const verb: number | undefined = Reflect.getMetadata(METHOD_METADATA, fn);
          if (sub === undefined || verb === undefined) continue;
          const joined = `/${[prefix, sub].filter((x) => x && x !== '/').join('/')}`
            .replace(/\/+/g, '/')
            .replace(/(.)\/$/, '$1');
          out.push({
            method: String(RequestMethod[verb]).toLowerCase(),
            path: joined.replace(/:([A-Za-z0-9_]+)/g, '{$1}'),
            sessionOnly: classSessionOnly || guardedBySessionOnly(fn),
            successStatus:
              (Reflect.getMetadata(HTTP_CODE_METADATA, fn) as number | undefined) ??
              (verb === RequestMethod.POST ? 201 : 200),
            hasHttpCode: Reflect.getMetadata(HTTP_CODE_METADATA, fn) !== undefined,
            ownsResponse: takesOwnResponse(c as object, key),
          });
        }
      }
      const imports: unknown[] = Reflect.getMetadata('imports', mod as object) ?? [];
      for (const im of imports) {
        const inner = (im as { module?: unknown })?.module ?? im;
        walk(inner);
      }
    };
    walk(AppModule);
    return out;
  }

  function documentedRoutes(doc: AnyDoc): RouteRef[] {
    const out: RouteRef[] = [];
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const [method, op] of Object.entries(item)) {
        if (op && typeof op === 'object' && 'operationId' in op) out.push({ method, path });
      }
    }
    return out;
  }

  it('documents every route Nest registers', async () => {
    const doc = await fetchDoc();
    const registered = registeredRoutes();

    // VACUITY GUARD. A metadata walk that finds nothing passes this case
    // perfectly, and Nest's decorator keys are exactly the kind of internal
    // that a major version renames. The floor is deliberately well under the
    // real count so an added route never trips it.
    expect(registered.length).toBeGreaterThan(20);

    const documented = new Set(documentedRoutes(doc).map(shape));
    const undocumented = registered.filter((r) => !documented.has(shape(r))).map(shape).sort();
    expect(undocumented, 'routes Nest serves that the document does not describe').toEqual([]);
  });

  /**
   * THE OTHER DIRECTION, because it fails differently and worse. An operation
   * describing a route nobody serves sends a generated client at a 404, and
   * nothing in the product would ever notice: the document builds, validates,
   * and every assertion above it still passes.
   */
  it('describes no operation that Nest does not serve', async () => {
    const doc = await fetchDoc();
    const registered = new Set(registeredRoutes().map(shape));
    const phantom = documentedRoutes(doc)
      .map(shape)
      .filter((r) => !registered.has(r))
      .sort();
    expect(phantom, 'operations the document describes that no handler serves').toEqual([]);
  });

  /**
   * ═══ A SESSION-ONLY ROUTE DECLARES THE SESSION-ONLY 403, AND ONLY IT DOES ═══
   *
   * `SessionOnlyGuard` refuses every bearer token with its own sentence, and
   * `SessionRequired` is the response that describes it. Those two were joined
   * by hand, operation by operation, and the browser upload
   * (`POST /v1/projects/{slug}/runs`) was the one that missed: its controller
   * carries the guard, its own description said "the same refusal the token and
   * SLA-rule operations carry", and its response map spread
   * `authFailureResponses` — whose 403 is the SCOPE refusal, a route with no
   * `@Scopes` at all can never send. A generated client branching on the
   * documented 403 was told the wrong reason.
   *
   * So the set is DERIVED, in both directions, from the metadata `@UseGuards`
   * writes: a guarded route that documents another 403 fails naming it, and an
   * operation documenting `SessionRequired` that nothing guards fails too — the
   * second is a document promising a refusal the server never sends.
   */
  it('gives every SessionOnlyGuard route the SessionRequired 403, and no other route', async () => {
    const doc = await fetchDoc();
    const guarded = new Set(registeredRoutes().filter((r) => r.sessionOnly).map(shape));

    // VACUITY GUARD, counting the construct rather than the verdict: guarded
    // routes FOUND. A guards key Nest renamed, or a guard compared by the wrong
    // identity, finds none — and "none undeclared" would then read as clean.
    expect(guarded.size, 'found no SessionOnlyGuard routes — the guards walk has rotted').toBeGreaterThan(5);

    const declaring = new Set(
      operations(doc)
        .filter(({ op }) => (op.responses?.['403'] as { $ref?: string } | undefined)?.$ref === '#/components/responses/SessionRequired')
        .map(({ path, method }) => shape({ method, path })),
    );
    const undeclared = [...guarded].filter((r) => !declaring.has(r)).sort();
    const unguarded = [...declaring].filter((r) => !guarded.has(r)).sort();
    expect(undeclared, 'SessionOnlyGuard routes whose documented 403 is not SessionRequired').toEqual([]);
    expect(unguarded, 'operations documenting SessionRequired that no SessionOnlyGuard protects').toEqual([]);
  });

  /**
   * ═══ A HANDLER SENDS ONE SUCCESS STATUS, AND THE DOCUMENT NAMES THAT ONE ═══
   *
   * Cancel and retry on a runner job both answered 201 — Nest's default for a
   * `@Post` with no `@HttpCode` — while the document declared 200 for each. A
   * generated client branching on the declared status took its error path on
   * every success, and nothing here compared the two: the 201 list above only
   * asks whether an operation is ALLOWED to declare 201, never what its handler
   * actually sends.
   *
   * So the status is DERIVED from the same metadata Nest reads when it
   * answers: `@HttpCode`, else 201 for POST and 200 for everything else. A
   * handler that returns normally can send exactly that one 2xx, so its
   * operation must declare exactly that one — which catches a wrong code and a
   * spare one alike. A handler taking `@Res()` writes its own status (the run
   * state machine's 200/202/422, the live protocol's 202) and is out of scope:
   * Nest sends nothing for it, so there is nothing to derive.
   */
  it('declares, for every handler Nest answers for, exactly the success status Nest sends', async () => {
    const doc = await fetchDoc();
    const routes = registeredRoutes();
    const answered = routes.filter((r) => !r.ownsResponse);

    // VACUITY GUARDS, counting the construct rather than the verdict. A
    // route-args walk that misreads `@Res()` would put every handler in or out
    // of scope, and an `@HttpCode` key Nest renamed would make every status a
    // default — under which this case could pass while checking nothing real.
    expect(routes.length - answered.length, 'found no @Res() handlers — the route-args walk has rotted').toBeGreaterThan(3);
    expect(answered.length).toBeGreaterThan(20);
    expect(
      routes.filter((r) => r.hasHttpCode).length,
      'found no @HttpCode handlers — the HTTP_CODE_METADATA read has rotted',
    ).toBeGreaterThan(3);

    const declaredSuccess = new Map(
      operations(doc).map(({ path, method, op }) => [
        shape({ method, path }),
        Object.keys(op.responses ?? {}).filter((code) => code.startsWith('2')).sort(),
      ]),
    );
    const mismatched = answered
      .map((r) => ({ route: shape(r), sends: [String(r.successStatus)], declares: declaredSuccess.get(shape(r)) }))
      .filter((m) => m.declares !== undefined && JSON.stringify(m.declares) !== JSON.stringify(m.sends))
      .map((m) => `${m.route}: sends ${m.sends[0]}, declares ${m.declares!.join('/') || 'no 2xx'}`)
      .sort();
    expect(mismatched, 'handlers whose documented success status is not the one Nest sends').toEqual([]);
  });
});
