import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { BlobStore } from '../src/index.js';

const cfg = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-east-1',
  bucket: `test-${randomUUID()}`,
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'perfportal',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'perfportal123',
  forcePathStyle: true,
};

const store = new BlobStore(cfg);

afterAll(async () => {
  /* the bucket is per-run and disposable */
});

describe('BlobStore', () => {
  it('stores a stream and reports the sha256 computed inline', async () => {
    await store.ensureBucket();
    const payload = Buffer.from('hello bundle');
    const expected = createHash('sha256').update(payload).digest('hex');

    const res = await store.putStream('runs/a.tgz', Readable.from([payload]), 1_000_000);
    expect(res.sha256).toBe(expected);
    expect(res.bytes).toBe(payload.length);
    expect(await store.get('runs/a.tgz')).toEqual(payload);
  });

  it('aborts past the size cap instead of buffering an unbounded body', async () => {
    await store.ensureBucket();
    const big = Readable.from([Buffer.alloc(2048, 1), Buffer.alloc(2048, 2)]);
    await expect(store.putStream('runs/big.tgz', big, 1024)).rejects.toMatchObject({
      code: 'BUNDLE_TOO_LARGE',
      remediation: expect.stringMatching(/.+/),
    });
  });

  // Regression test for a hang: putStream used to `await pipeline(body, meter)`
  // where nothing ever consumed `meter`'s readable side, so once the
  // unconsumed buffer exceeded the stream's highWaterMark the pipeline
  // stalled forever — the returned promise neither resolved nor rejected.
  // Every payload the old tests used was either tiny (well under the
  // highWaterMark) or exceeded the cap on the very first chunk, so the
  // backpressure that triggers the stall never built up and this went
  // uncaught. A multi-megabyte body delivered across many small chunks,
  // comfortably under the cap, reproduces it reliably.
  it(
    'resolves for a multi-megabyte body delivered across many chunks, under a generous cap',
    async () => {
      await store.ensureBucket();

      const chunkSize = 16 * 1024;
      const totalBytes = 6 * 1024 * 1024; // > lib-storage's 5 MB min part size
      const parts: Buffer[] = [];
      for (let sent = 0; sent < totalBytes; sent += chunkSize) {
        const len = Math.min(chunkSize, totalBytes - sent);
        const part = Buffer.alloc(len);
        for (let i = 0; i < len; i++) part[i] = (sent + i) % 256;
        parts.push(part);
      }
      const payload = Buffer.concat(parts);
      const expectedSha256 = createHash('sha256').update(payload).digest('hex');

      const res = await store.putStream(
        'runs/multi-chunk.tgz',
        Readable.from(parts),
        50 * 1024 * 1024,
      );

      expect(res.sha256).toBe(expectedSha256);
      expect(res.bytes).toBe(totalBytes);
      expect(await store.get('runs/multi-chunk.tgz')).toEqual(payload);
    },
    30_000,
  );
});
