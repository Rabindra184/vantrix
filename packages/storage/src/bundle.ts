import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { ingestError, type BundleIndex, type BundleSource } from '@perfportal/core';
import { extract } from 'tar-stream';

/** Rejects absolute paths and any traversal segment. */
function safePath(name: string): string {
  const normalized = name.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw ingestError('BUNDLE_NOT_ARCHIVE', {
      message: `The archive contains an unsafe entry path: ${name}`,
      remediation:
        'Re-create the archive from inside the results directory, without absolute or parent-relative paths.',
      detail: { entry: name },
    });
  }
  return normalized;
}

/**
 * Reads a gzipped tar into memory and presents it as a BundleSource.
 *
 * In memory by design (spec §5.1): the size cap in BlobStore.putStream bounds
 * this, and the worker is the only caller.
 */
export async function openTarGzBundle(archive: Buffer): Promise<BundleSource> {
  const files = new Map<string, Buffer>();

  await new Promise<void>((resolve, reject) => {
    const ex = extract();
    ex.on('entry', (header, stream, next) => {
      if (header.type !== 'file') {
        stream.resume();
        stream.on('end', next);
        return;
      }
      let path: string;
      try {
        path = safePath(header.name);
      } catch (err) {
        reject(err);
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        files.set(path, Buffer.concat(chunks));
        next();
      });
      stream.on('error', reject);
    });
    ex.on('finish', resolve);
    ex.on('error', reject);

    Readable.from(archive)
      .pipe(createGunzip())
      .on('error', () =>
        reject(
          ingestError('BUNDLE_NOT_ARCHIVE', {
            message: 'The upload is not a gzipped tar archive.',
            remediation:
              'Upload the Gatling results directory as a .tar.gz, for example: tar -czf results.tgz -C target/gatling <run-directory>',
          }),
        ),
      )
      .pipe(ex);
  });

  if (files.size === 0) {
    throw ingestError('BUNDLE_EMPTY', {
      message: 'The archive contains no files.',
      remediation: 'Archive the Gatling results directory itself, not an empty parent directory.',
    });
  }

  const index: BundleIndex = {
    files: [...files.keys()],
    head: async (path, bytes) => {
      const f = files.get(path);
      if (!f) throw new Error(`no such entry: ${path}`);
      return new Uint8Array(f.subarray(0, bytes));
    },
  };

  return {
    index,
    read: async (path) => {
      const f = files.get(path);
      if (!f) throw new Error(`no such entry: ${path}`);
      return new Uint8Array(f);
    },
  };
}
