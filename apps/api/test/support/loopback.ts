import http from 'node:http';
import type { INestApplication } from '@nestjs/common';

/**
 * Every server a test starts listens HERE, named. A wildcard bind on an
 * ephemeral port — what supertest does with a server that is not yet
 * listening — can share a port another process holds on 127.0.0.1 (macOS
 * allows it), and the request then reaches that process instead of ours.
 * loopback.test.ts has the measurement; loopback-guard.ts refuses the shape.
 */
export const LOOPBACK = '127.0.0.1';

/** Starts a Nest app on an ephemeral loopback port. `listen` runs `init()`
 *  itself, and Nest makes that idempotent. `app.close()` stops it again. */
export async function listenNestOnLoopback(app: INestApplication): Promise<void> {
  await app.listen(0, LOOPBACK);
}

/** Starts a plain request handler (an Express app, say) on an ephemeral
 *  loopback port. The caller closes the server it gets back. */
export function listenOnLoopback(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
