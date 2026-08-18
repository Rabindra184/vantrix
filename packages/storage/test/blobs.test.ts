import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BLOB_SOCKET_TIMEOUT_MS, BlobStore } from '../src/blobs.js';

/**
 * A server that completes the TCP handshake and then answers NOTHING, ever.
 *
 * This is the failure the request timeout exists for, and it is the one an
 * ordinary `AbortSignal`-free client cannot survive: the connection is
 * healthy by every check the SDK makes, so without a socket timeout the
 * `send()` promise simply never settles. A refused or reset connection
 * would prove nothing here -- those already reject on their own.
 */
function blackHole(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    // Held, never written to, never ended.
    sockets.push(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

describe('BlobStore request timeout', () => {
  let hole: { port: number; close: () => Promise<void> };

  beforeEach(async () => {
    hole = await blackHole();
  });

  afterEach(async () => {
    await hole.close();
  });

  /**
   * The single highest-value line on the live path: without a
   * `requestTimeout`, a `get()` whose socket goes quiet never rejects, and
   * `LiveFoldOwner#fold` awaits exactly this call while holding `#ticking`
   * -- so one stalled read stops every owned run's fold and publish for the
   * life of the process, and closed runs keep the advisory lock the
   * pipeline needs.
   *
   * The override exists so this case can run in a unit suite: the
   * production value is {@link BLOB_SOCKET_TIMEOUT_MS} (10 s), and the SDK
   * retries a `TimeoutError` up to `maxAttempts` on top of that, which is
   * well past what a unit test should sit through. What is being proved is
   * that the option is WIRED and that the rejection is a timeout -- not the
   * particular number of milliseconds.
   *
   * THIS CASE IS ALSO THE ONLY THING THAT CATCHES THE WRONG OPTION.
   * `requestHandler: { requestTimeout }` -- the obvious reading of "give
   * the S3Client a request timeout" -- makes this test hang until vitest
   * kills it at 30 s while `@smithy/node-http-handler` prints
   * `[WARN] a request has exceeded the configured 100 ms requestTimeout`,
   * because that option warns rather than throwing unless
   * `throwOnRequestTimeout` is also set (and is a total deadline, not an
   * idle one -- see `BLOB_SOCKET_TIMEOUT_MS`'s own doc comment). Nothing
   * else in this repository would have noticed.
   */
  it('rejects a request whose socket goes quiet instead of hanging forever', async () => {
    const store = new BlobStore({
      endpoint: `http://127.0.0.1:${hole.port}`,
      region: 'us-east-1',
      bucket: 'perfportal',
      accessKeyId: 'k',
      secretAccessKey: 's',
      socketTimeoutMs: 100,
    });

    await expect(store.get('live/whatever/0000000000000000.bin')).rejects.toThrow(
      /timed out/i,
    );
  });

  /** The production default is a real, finite bound -- 0 is the SDK's own
   * "wait forever", and reintroducing it is exactly the defect this file
   * guards. */
  it('defaults to a finite, non-zero socket timeout', () => {
    expect(BLOB_SOCKET_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(BLOB_SOCKET_TIMEOUT_MS)).toBe(true);
  });
});
