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

  it('finalize is correct when the destination is already complete and a chunk survives a previous partial cleanup', async () => {
    await blobs.ensureBucket();
    const store = new LiveChunkStore(blobs);
    const runId = 'partial-cleanup-probe';
    const key = 'runs/partial-cleanup-probe/simulation.log';
    await store.put(runId, 0, Buffer.from('hello ', 'latin1'));
    await store.put(runId, 6, Buffer.from('world', 'latin1'));

    await store.finalize(runId, key);
    expect((await blobs.get(key)).toString('latin1')).toBe('hello world');

    // Simulate a finalize whose write succeeded but whose chunk cleanup
    // only partially completed (killed mid-loop, one delete failing while
    // others land): one chunk object survives, re-created at the exact key
    // it originally had. A guard keyed on "no chunks remain" would not
    // recognize this as already finalized, and would re-assemble just the
    // survivor on retry -- silently overwriting the correct 'hello world'
    // log with the truncated 'hello '.
    await store.put(runId, 0, Buffer.from('hello ', 'latin1'));

    await store.finalize(runId, key); // e.g. a retry after the partial cleanup

    expect((await blobs.get(key)).toString('latin1')).toBe('hello world');
    // The retry also finishes the interrupted cleanup: the straggler is gone.
    await expect(store.assemble(runId)).resolves.toHaveLength(0);
  });

  it('assemble returns an empty buffer for a run with no chunks, rather than throwing', async () => {
    await blobs.ensureBucket();
    const store = new LiveChunkStore(blobs);

    await expect(store.assemble('never-received-a-byte')).resolves.toHaveLength(0);
  });

  it('readFrom returns only the chunks at or past an offset, in order', async () => {
    await blobs.ensureBucket();
    const store = new LiveChunkStore(blobs);
    const runId = `readfrom-${randomUUID()}`;

    await store.put(runId, 0, Buffer.from('aaaa', 'latin1'));      // [0,4)
    await store.put(runId, 4, Buffer.from('bbbb', 'latin1'));      // [4,8)
    await store.put(runId, 8, Buffer.from('cccc', 'latin1'));      // [8,12)

    expect((await store.readFrom(runId, 0)).toString('latin1')).toBe('aaaabbbbcccc');
    expect((await store.readFrom(runId, 4)).toString('latin1')).toBe('bbbbcccc');
    expect((await store.readFrom(runId, 8)).toString('latin1')).toBe('cccc');
  });

  it('readFrom past the end is an empty buffer, not a throw', async () => {
    await blobs.ensureBucket();
    const store = new LiveChunkStore(blobs);
    const runId = `readfrom-end-${randomUUID()}`;
    await store.put(runId, 0, Buffer.from('aaaa', 'latin1'));

    expect(await store.readFrom(runId, 4)).toHaveLength(0);
    expect(await store.readFrom(`never-${randomUUID()}`, 0)).toHaveLength(0);
  });

  it('readFrom uses numeric threshold comparison, not string comparison, when filtering chunks', async () => {
    await blobs.ensureBucket();
    const store = new LiveChunkStore(blobs);
    const runId = `readfrom-order-${randomUUID()}`;
    // Chunks at offsets 0, 999, 1000. A string comparison of the padded
    // keys would agree with numeric comparison at this scale, but the filter
    // explicitly parses to Number to remain correct when offsets reach 17 digits.
    await store.put(runId, 0, Buffer.from('x'.repeat(999), 'latin1'));
    await store.put(runId, 999, Buffer.from('y', 'latin1'));
    await store.put(runId, 1000, Buffer.from('z', 'latin1'));

    expect((await store.readFrom(runId, 999)).toString('latin1')).toBe('yz');
  });

  /**
   * THIS CASE USED TO ASSERT THE OPPOSITE, and the old assertion was
   * describing a data-loss bug as a feature.
   *
   * Offset 5 sits INSIDE the chunk at 0. `readFrom` returned only the chunk
   * at 10 and called that "does not return chunks that straddle the
   * offset" -- but bytes [5,10) are then simply gone: they are in no chunk
   * the call returned, and the caller advances its frontier by the length
   * of what it did get, so nothing ever asks for them again. Silent. The
   * only way to reach that argument is to pass a DECODE position where the
   * contract asks for a fetch frontier, which this method's own doc comment
   * already forbids in capitals -- so the honest answer is not to skip five
   * bytes quietly, it is to refuse.
   *
   * Design §2.2.1's amendment says so directly: readFrom must assert the
   * contiguity it promises.
   */
  it('readFrom refuses an offset the chunks cannot start from, rather than silently skipping bytes', async () => {
    await blobs.ensureBucket();
    const store = new LiveChunkStore(blobs);
    const runId = `readfrom-straddle-${randomUUID()}`;
    // Chunks at offsets 0 (length 10) and 10 (length 10).
    await store.put(runId, 0, Buffer.from('0123456789', 'latin1'));
    await store.put(runId, 10, Buffer.from('abcdefghij', 'latin1'));

    await expect(store.readFrom(runId, 5)).rejects.toMatchObject({
      name: 'LiveChunkGapError',
      expectedOffset: 5,
      actualOffset: 10,
    });

    // The real chunk boundaries are still perfectly readable -- the refusal
    // is about THIS offset, not about the run.
    expect((await store.readFrom(runId, 10)).toString('latin1')).toBe('abcdefghij');
  });

  /**
   * The `finalize` race design §2.2.1 names, staged directly: `finalize`
   * lists a run's chunk keys and deletes them CONCURRENTLY, so a fold that
   * reads while a close is running can be handed a set with a hole punched
   * through the middle. Before the assertion, those bytes were concatenated
   * across the hole and fed to the decoder, whose absolute positions were
   * then wrong for the rest of the run, with nothing thrown and nothing
   * logged.
   *
   * Deleting the middle chunk by hand rather than racing a real `finalize`
   * is deliberate: the race is timing-dependent and would make this case
   * flaky, while the STATE it produces -- surviving keys with a gap -- is
   * exactly what is staged here and is the only thing `readFrom` can
   * actually see.
   */
  it('readFrom refuses a set of chunks with a hole in the middle', async () => {
    await blobs.ensureBucket();
    const store = new LiveChunkStore(blobs);
    const runId = `readfrom-hole-${randomUUID()}`;
    await store.put(runId, 0, Buffer.from('aaaa', 'latin1'));   // [0,4)
    await store.put(runId, 4, Buffer.from('bbbb', 'latin1'));   // [4,8)
    await store.put(runId, 8, Buffer.from('cccc', 'latin1'));   // [8,12)

    // A concurrent finalize got to the middle one first.
    await blobs.delete(`live/${runId}/${String(4).padStart(16, '0')}.bin`);

    await expect(store.readFrom(runId, 0)).rejects.toMatchObject({
      name: 'LiveChunkGapError',
      expectedOffset: 4,
      actualOffset: 8,
    });
  });

  /** The frontier case must stay a plain empty buffer -- it is by far the
   * most common outcome of this call (once per owned run per tick, whenever
   * no new chunk has landed), and turning it into a gap error would make
   * every idle tick throw. */
  it('readFrom at the exact end is empty, not a gap error', async () => {
    await blobs.ensureBucket();
    const store = new LiveChunkStore(blobs);
    const runId = `readfrom-frontier-${randomUUID()}`;
    await store.put(runId, 0, Buffer.from('aaaa', 'latin1'));

    expect(await store.readFrom(runId, 4)).toHaveLength(0);
  });
});
