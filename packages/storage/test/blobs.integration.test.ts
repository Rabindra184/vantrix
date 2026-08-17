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

  // ListObjectsV2 caps a single page at 1000 keys. A `list()` that trusted
  // the first page would pass every test that writes only a handful of
  // objects and still silently truncate the one caller that matters
  // (LiveChunkStore.assemble reading back a real live run's chunks) — so the
  // only way to prove pagination actually happens is to cross that boundary
  // for real and check nothing on either side of the cut went missing.
  // Deliberately slow: it puts 1200 objects (in bounded-concurrency batches,
  // or this would take minutes against a local MinIO) to guarantee at least
  // two ListObjectsV2 pages.
  it(
    "list() paginates past ListObjectsV2's 1000-key page limit",
    async () => {
      await store.ensureBucket();
      const prefix = `list-pagination-probe/${randomUUID()}/`;
      const total = 1200;
      const concurrency = 40;

      for (let start = 0; start < total; start += concurrency) {
        const batch: Promise<unknown>[] = [];
        for (let i = start; i < Math.min(start + concurrency, total); i++) {
          const key = `${prefix}${String(i).padStart(6, '0')}.bin`;
          batch.push(store.putStream(key, Readable.from([Buffer.from('x')]), 10));
        }
        await Promise.all(batch);
      }

      const keys = await store.list(prefix);
      const expected = Array.from(
        { length: total },
        (_, i) => `${prefix}${String(i).padStart(6, '0')}.bin`,
      );

      expect(keys).toHaveLength(total);
      expect(new Set(keys)).toEqual(new Set(expected));
    },
    180_000,
  );
});
