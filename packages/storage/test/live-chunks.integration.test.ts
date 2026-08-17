import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BlobStore } from '../src/index.js';
import { LiveChunkStore } from '../src/live-chunks.js';

// Same construction the sibling storage integration test
// (blobs.integration.test.ts) uses: a fresh, disposable per-run bucket
// rather than a shared fixture module.
const cfg = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-east-1',
  bucket: `test-${randomUUID()}`,
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'perfportal',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'perfportal123',
  forcePathStyle: true,
};

const blobs = new BlobStore(cfg);

describe('LiveChunkStore', () => {
  it('assembles chunks in numeric offset order, not lexicographic', async () => {
    await blobs.ensureBucket();
    const store = new LiveChunkStore(blobs);
    const runId = 'ordering-probe';

    // Offsets chosen so naive string sorting reverses them: '1000' < '999'.
    await store.put(runId, 0, Buffer.from('a'.repeat(999), 'latin1'));
    await store.put(runId, 999, Buffer.from('b', 'latin1'));
    await store.put(runId, 1000, Buffer.from('c', 'latin1'));

    const out = await store.assemble(runId);
    expect(out.toString('latin1')).toBe(`${'a'.repeat(999)}bc`);
  });

  it('finalize writes the whole log to the key and clears the chunks', async () => {
    await blobs.ensureBucket();
    const store = new LiveChunkStore(blobs);
    const runId = 'finalize-probe';
    await store.put(runId, 0, Buffer.from('hello ', 'latin1'));
    await store.put(runId, 6, Buffer.from('world', 'latin1'));

    await store.finalize(runId, 'runs/finalize-probe/simulation.log');
    expect((await blobs.get('runs/finalize-probe/simulation.log')).toString('latin1')).toBe(
      'hello world',
    );
    await expect(store.assemble(runId)).resolves.toHaveLength(0);
  });

  it('finalize is a no-op the second time, and does not clobber the log it already wrote', async () => {
    await blobs.ensureBucket();
    const store = new LiveChunkStore(blobs);
    const runId = 'finalize-twice-probe';
    const key = 'runs/finalize-twice-probe/simulation.log';
    await store.put(runId, 0, Buffer.from('hello ', 'latin1'));
    await store.put(runId, 6, Buffer.from('world', 'latin1'));

    await store.finalize(runId, key);
    await store.finalize(runId, key); // e.g. a redelivered close event

    expect((await blobs.get(key)).toString('latin1')).toBe('hello world');
  });

  it('assemble returns an empty buffer for a run with no chunks, rather than throwing', async () => {
    await blobs.ensureBucket();
    const store = new LiveChunkStore(blobs);

    await expect(store.assemble('never-received-a-byte')).resolves.toHaveLength(0);
  });
});
