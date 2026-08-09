import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

describe('/auth/*', () => {
  it('serves /auth/* without a session', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/auth/sign-up/email')
      .send({ email: 'a@example.test', password: 'correct-horse-battery', name: 'A' });

    // A real sign-up, not just "not a 500": with nothing mounted, Nest 404s
    // and ProblemFilter renders a non-empty problem+json body, which would
    // make the brief's original `status < 500 && body !== {}` assertion pass
    // even though /auth/* is not served at all.
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('a@example.test');
    // An empty body on a 404 here would mean basePath is misconfigured
    // (Better Auth 404s with an empty body when basePath doesn't match) —
    // a different failure from Nest's 404, useful to know when debugging.
    expect(res.headers['set-cookie']).toBeTruthy();
  });
});
