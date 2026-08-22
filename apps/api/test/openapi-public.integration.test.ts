import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestContext } from './support/app.js';

/**
 * THE API DESCRIPTION IS REACHABLE WITHOUT A CREDENTIAL, ON PURPOSE.
 *
 * `/v1/docs` and `/v1/openapi.json` live under `/v1`, which `AuthMiddleware`
 * authenticates wholesale (app.module.ts) — and yet both have always answered
 * 200 unauthenticated, because `mountOpenApi` registers them straight onto the
 * Express instance BEFORE `app.init()` and Express matches in registration
 * order. Nothing declared that, and nothing tested it.
 *
 * That silence is what makes it worth a file. The contract is invisible in the
 * code (it is a side effect of mount ordering), so any change to WHEN Swagger
 * is mounted flips these two from public to 401 — and the only thing that
 * would notice is `openapi.integration.test.ts`, whose every test calls
 * `fetchDoc()`, so the failure would land on whichever test ran first and say
 * "expected 401 to be 200" while naming nothing. That happened once.
 *
 * `app.module.ts` now excludes these paths from the middleware explicitly, so
 * the behaviour no longer depends on the ordering. These cases pin both halves
 * of it: the doc routes are open, and the exclusion did not widen anything.
 */
describe('the OpenAPI description is public, and only it', () => {
  let ctx: TestContext;
  afterEach(async () => { await ctx?.close(); });

  it('serves /v1/openapi.json with no credential at all', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/v1/openapi.json');
    expect(res.status).toBe(200);
    // A real document, not an error body that happens to be 200.
    expect(res.body?.openapi).toBeTruthy();
    expect(res.body?.paths?.['/v1/runs']).toBeTruthy();
  });

  it('serves /v1/docs with no credential at all', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/v1/docs');
    expect(res.status).toBe(200);
  });

  /**
   * A MATCHED ROUTE IS DEFENDED TWICE, and this pins the outer layer only.
   *
   * Measured, not assumed: widening the exclusion to all of `v1/*path` leaves
   * this case GREEN, because `AuthGuard` (registered globally via APP_GUARD)
   * still runs for any request that reaches a controller. So this asserts the
   * middleware and the guard together, and it is NOT the case that would
   * catch an over-broad exclusion — the perimeter case below is.
   */
  it('still refuses a real /v1 route without a credential', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/v1/runs');
    expect(res.status).toBe(401);
    expect(res.body?.code).toBe('UNAUTHENTICATED');
  });

  /**
   * THE CASE THAT ACTUALLY CATCHES AN OVER-BROAD EXCLUSION.
   *
   * The perimeter rule `AuthMiddleware` exists for (app.module.ts): a path
   * under /v1 that no controller implements must 401, not 404 — otherwise the
   * API leaks which routes exist to an anonymous caller. Nothing but
   * middleware can enforce that, since a guard never runs for a request that
   * matched no handler.
   *
   * Verified red: widening the exclusion to `v1/*path` fails exactly this
   * case, with "expected 404 to be 401", while the three above stay green.
   */
  it('still refuses an unimplemented /v1 path with 401, not 404', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/v1/no-such-route');
    expect(res.status).toBe(401);
  });
});
