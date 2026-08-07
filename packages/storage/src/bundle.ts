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

/** Decompressed-bytes budget enforced by {@link openTarGzBundle}. */
export interface BundleSizeLimits {
  /** Running total across every entry's decompressed bytes. */
  maxTotalBytes: number;
  /** Cap on any single entry's decompressed bytes. Defaults to `maxTotalBytes`. */
  maxEntryBytes?: number;
}

/**
 * Default decompressed-bytes budget when no caller-supplied limit is given.
 * Chosen well above the default *compressed* upload cap (512 MiB, see
 * apps/api/src/config.ts's `maxBundleBytes`) so ordinary legitimate bundles
 * are never affected, while still bounding worst-case worker RSS to a
 * multiple of that, not to whatever a decompression bomb decides.
 */
export const DEFAULT_MAX_DECOMPRESSED_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

function tooLarge(limitBytes: number) {
  return ingestError('BUNDLE_TOO_LARGE', {
    message: `The archive's decompressed contents exceed the ${limitBytes}-byte limit.`,
    remediation:
      'Archive only the Gatling results directory, without extraneous or oversized files, or raise the decompressed-size limit in project settings.',
    detail: { maxBytes: limitBytes },
  });
}

/**
 * Reads a gzipped tar into memory and presents it as a BundleSource.
 *
 * In memory by design (spec §5.1). The compressed-bytes cap in
 * BlobStore.putStream does NOT bound this: gzip lets a small file on the
 * wire expand enormously once decompressed (a few hundred KiB of zeros can
 * decompress to hundreds of MiB), so this function enforces its own
 * decompressed-bytes budget — a running total across all entries, and a
 * per-entry cap — independent of whatever the compressed upload cap allowed.
 */
export async function openTarGzBundle(
  archive: Buffer,
  limits: BundleSizeLimits = { maxTotalBytes: DEFAULT_MAX_DECOMPRESSED_BUNDLE_BYTES },
): Promise<BundleSource> {
  const maxTotalBytes = limits.maxTotalBytes;
  const maxEntryBytes = limits.maxEntryBytes ?? maxTotalBytes;
  const files = new Map<string, Buffer>();
  let totalBytes = 0;

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
      let entryBytes = 0;
      let overLimit = false;
      stream.on('data', (c: Buffer) => {
        if (overLimit) return;
        entryBytes += c.length;
        totalBytes += c.length;
        if (entryBytes > maxEntryBytes || totalBytes > maxTotalBytes) {
          overLimit = true;
          reject(tooLarge(entryBytes > maxEntryBytes ? maxEntryBytes : maxTotalBytes));
          stream.destroy();
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => {
        if (overLimit) return;
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
