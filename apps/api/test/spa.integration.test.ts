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
});
