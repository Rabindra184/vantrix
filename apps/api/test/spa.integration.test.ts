import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

describe('SPA mount', () => {
  it('serves index.html at the root', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/').expect(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<div id="root">');
  });

  // The regression this task exists to prevent.
  it('leaves an unknown /v1 path as an RFC 9457 problem, not index.html', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/nonsense')
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.remediation).toBeTruthy();
    expect(res.text).not.toContain('<div id="root">');
  });

  it('leaves an unknown /auth path to Better Auth, not index.html', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/auth/nonsense');
    expect(res.text ?? '').not.toContain('<div id="root">');
  });

  // A deep link must reach the SPA, or refreshing /runs/<id> 404s.
  it('falls back to index.html for a client route', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/runs/abc').expect(200);
    expect(res.text).toContain('<div id="root">');
  });

  // Regression: the first version of mountSpa excluded only /v1 and /auth, so
  // it swallowed the health endpoints. A readiness probe answering 200 with
  // HTML tells an orchestrator the process is healthy while its database is
  // unreachable - the probe stops meaning anything.
  it.each(['/healthz', '/readyz'])('leaves %s to the API, not the SPA', async (path) => {
    const res = await request(ctx.app.getHttpServer()).get(path);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.text).not.toContain('<div id="root">');
  });
});
