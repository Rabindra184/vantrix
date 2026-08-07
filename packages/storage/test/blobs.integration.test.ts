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
});
