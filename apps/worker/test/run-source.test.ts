import { createHash } from 'node:crypto';
import { IngestError } from '@perfportal/core';
import type { BlobStore } from '@perfportal/storage';
import { describe, expect, it } from 'vitest';
import { openRunSource, RawLogMissingError } from '../src/pipeline/run-source.js';

/**
 * A stand-in for the two `BlobStore` methods `openRunSource` reaches. It
 * records every `get`, because "checked BEFORE reading" is a claim about
 * which calls happen, not only about which error comes out.
 */
function fakeBlobs(objects: Record<string, Buffer>): BlobStore & { gets: string[] } {
  const gets: string[] = [];
  return {
    gets,
    exists: async (key: string) => key in objects,
    get: async (key: string) => {
      gets.push(key);
      const body = objects[key];
      if (!body) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
      return body;
    },
  } as unknown as BlobStore & { gets: string[] };
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const LOG_KEY = 'live/r1/simulation.log';
const LOG = Buffer.from('not really a gatling log, but bytes all the same');

describe('openRunSource', () => {
  it('throws RawLogMissingError for a run that stored no log, without reading anything', async () => {
    const blobs = fakeBlobs({ [LOG_KEY]: LOG });
    await expect(
      openRunSource({ bundleKey: LOG_KEY, bundleSha256: '', projectId: 'p' }, { blobs, maxTotalBytes: 1e9 }),
    ).rejects.toBeInstanceOf(RawLogMissingError);
    expect(blobs.gets).toEqual([]);
  });

  it('throws RawLogMissingError when the object is gone, without reading it', async () => {
    const blobs = fakeBlobs({});
    await expect(
      openRunSource({ bundleKey: LOG_KEY, bundleSha256: sha256(LOG), projectId: 'p' }, { blobs, maxTotalBytes: 1e9 }),
    ).rejects.toBeInstanceOf(RawLogMissingError);
    expect(blobs.gets).toEqual([]);
  });

  it('throws BUNDLE_CHECKSUM_MISMATCH when the bytes differ from the recorded checksum', async () => {
    const blobs = fakeBlobs({ [LOG_KEY]: LOG });
    const err = await openRunSource(
      { bundleKey: LOG_KEY, bundleSha256: 'a'.repeat(64), projectId: 'p' },
      { blobs, maxTotalBytes: 1e9 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).code).toBe('BUNDLE_CHECKSUM_MISMATCH');
    expect((err as IngestError).detail).toEqual({ expected: 'a'.repeat(64), actual: sha256(LOG) });
  });

  it('opens a raw log as a one-file source', async () => {
    const blobs = fakeBlobs({ [LOG_KEY]: LOG });
    const source = await openRunSource(
      { bundleKey: LOG_KEY, bundleSha256: sha256(LOG), projectId: 'p' },
      { blobs, maxTotalBytes: 1e9 },
    );
    expect(source.index.files).toEqual(['simulation.log']);
    expect(Buffer.from(await source.read('simulation.log')).equals(LOG)).toBe(true);
    expect(Buffer.from(await source.index.head('simulation.log', 3)).toString()).toBe('not');
  });

  it('opens anything else as a gzipped tar, so a raw log under an upload key is refused', async () => {
    const key = 'runs/p/u.tgz';
    const blobs = fakeBlobs({ [key]: LOG });
    const err = await openRunSource(
      { bundleKey: key, bundleSha256: sha256(LOG), projectId: 'p' },
      { blobs, maxTotalBytes: 1e9 },
    ).catch((e: unknown) => e);
    expect((err as IngestError).code).toBe('BUNDLE_NOT_ARCHIVE');
  });
});
