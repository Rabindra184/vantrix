import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { LOOPBACK } from './support/loopback.js';

/**
 * createTestApp() listens, on 127.0.0.1, before it returns — so supertest
 * reuses that server instead of calling `listen(0)` on the wildcard address
 * per request, which is how a local process on 127.0.0.1:605xx came to answer
 * the suite's requests with `501 {}`. See loopback.test.ts for the mechanism.
 */
let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe('createTestApp', () => {
  it('listens on the loopback address, so no request reaches another process', async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();
    expect(server.listening).toBe(true);
    expect(server.address()).toMatchObject({ address: LOOPBACK, family: 'IPv4' });

    // And supertest goes to THAT server: the same port answers, and it is ours
    // (an unauthenticated /v1 read is our 401, never somebody else's 501).
    const port = (server.address() as AddressInfo).port;
    const res = await request(server).get('/v1/runs');
    expect(res.status).toBe(401);
    expect(res.request.url).toBe(`http://${LOOPBACK}:${port}/v1/runs`);
  });
});
