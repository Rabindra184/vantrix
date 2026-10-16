import { createHash } from 'node:crypto';
import { ingestError, type BundleSource } from '@perfportal/core';
import type { RunRecord } from '@perfportal/persistence';
import { SIMULATION_LOG } from '@perfportal/plugin-gatling';
import { openTarGzBundle, type BlobStore } from '@perfportal/storage';

/**
 * ═══ ONE READER FOR A RUN'S STORED LOG ═══
 *
 * The ingest pipeline and the recompute of an existing run both start from
 * the same place — the bytes behind `run.bundleKey`, verified against the
 * checksum recorded when they were stored — and both have to open a live
 * run's raw log and an uploaded run's archive the same way. Two copies of
 * that would drift into two answers for one run.
 */

export type RunSourceRun = Pick<RunRecord, 'bundleKey' | 'bundleSha256' | 'projectId'>;

export interface RunSourceDeps {
  blobs: BlobStore;
  /**
   * The decompression-bomb guard for an uploaded archive. The caller computes
   * it (a project's own `maxDecompressedBundleBytes`, else the worker's), so
   * this module never needs the database.
   */
  maxTotalBytes: number;
}

/**
 * There is no VERIFIED stored log to read for this run, and none ever will
 * be: either no checksum was ever recorded for one (`bundleSha256 === ''` — a
 * live run closed with no bytes, a stream abandoned before a whole record
 * arrived, or a sweeper that stored the object and crashed before writing its
 * checksum, so the bytes may be there and nothing vouches for them), or the
 * object its row names is no longer in the bucket.
 *
 * Deliberately NOT an `IngestError`. A recompute reads it as "skip this run";
 * the ingest pipeline must not treat a missing log any differently from how
 * it always has, and translates it back (see `PipelineService#ingest`).
 */
export class RawLogMissingError extends Error {
  constructor(
    readonly bundleKey: string,
    readonly reason: 'never_stored' | 'object_missing',
  ) {
    super(
      reason === 'never_stored'
        ? `run has no verified log (bundleSha256 is empty; key ${bundleKey})`
        : `the stored log ${bundleKey} is no longer in the object store`,
    );
    this.name = 'RawLogMissingError';
  }
}

/**
 * A live run's `bundleKey` (Task 9, apps/api/src/ingest/live.service.ts)
 * holds the assembled `simulation.log` AS ITS OWN RAW BYTES —
 * `LiveChunkStore.finalize` (packages/storage/src/live-chunks.ts) writes
 * exactly the concatenated chunk stream, with no tar/gzip wrapping: a live
 * run was never an archive, so there is nothing to wrap. An uploaded run's
 * `bundleKey` (IngestService.accept's `runs/{projectId}/{uuid}.tgz`) is
 * always a real gzipped tar.
 *
 * `openTarGzBundle` assumes the latter unconditionally: it gunzips whatever
 * bytes it is given and throws `BUNDLE_NOT_ARCHIVE` the instant they are not
 * a gzip stream, which every live run's raw log always is. Presenting the
 * raw buffer as a one-file `BundleSource` here — rather than teaching
 * `openTarGzBundle` to detect and skip the unwrap — keeps that function
 * single-purpose (it opens archives; this is not one) and leaves every
 * downstream consumer untouched: `GatlingPlugin.detect`/`parse` only ever
 * call `source.index.files`/`head`/`read`, never anything archive-specific,
 * so a live run's finalized log parses through the exact same plugin code a
 * bundle upload does.
 */
function rawLogBundleSource(buf: Buffer): BundleSource {
  const files = [SIMULATION_LOG];
  return {
    index: {
      files,
      head: async (path, bytes) => {
        if (path !== SIMULATION_LOG) throw new Error(`no such entry: ${path}`);
        return new Uint8Array(buf.subarray(0, bytes));
      },
    },
    read: async (path) => {
      if (path !== SIMULATION_LOG) throw new Error(`no such entry: ${path}`);
      // `buf` (unlike head()'s small slice above) can be the whole
      // 150-250 MB log, so this returns the SAME buffer rather than
      // `new Uint8Array(buf)` -- that constructor form copies every byte,
      // doubling peak memory for no reason: Buffer already IS a Uint8Array
      // (Node's own subclass), so no conversion is needed at all.
      return buf;
    },
  };
}

/**
 * True for a live run's key: `createLive`'s convention ends every live run's
 * `bundleKey` in `/simulation.log`, and no uploaded run's ever does.
 */
export function isRawLogKey(bundleKey: string): boolean {
  return bundleKey.endsWith(`/${SIMULATION_LOG}`);
}

/**
 * Reads the run's stored bytes, verifies them and opens them — with NO
 * missing-log guard in front. This is exactly what the ingest pipeline did
 * before `openRunSource` existed, kept callable so the pipeline can fail a
 * run whose log is missing in precisely the way it always has: the object
 * store's own error for an absent key, and `BUNDLE_CHECKSUM_MISMATCH` for an
 * empty recorded checksum over bytes that are there.
 */
export async function readRunSource(run: RunSourceRun, deps: RunSourceDeps): Promise<BundleSource> {
  const archive = await deps.blobs.get(run.bundleKey);

  // spec §6.2 step 2: verify SHA-256 against what was recorded at upload
  // time. A mismatch here means the object fetched back from the blob
  // store is not the bytes that were durably written — storage-side
  // corruption, not a malformed bundle — so it must not be blamed on the
  // caller the way a parse failure would be.
  const actualSha256 = createHash('sha256').update(archive).digest('hex');
  if (actualSha256 !== run.bundleSha256) {
    throw ingestError('BUNDLE_CHECKSUM_MISMATCH', {
      message:
        `The bundle fetched from object storage does not match the checksum recorded ` +
        `at upload time (expected ${run.bundleSha256}, got ${actualSha256}).`,
      remediation:
        'This is a storage integrity problem, not a malformed upload — re-upload is unlikely ' +
        'to help by itself. Escalate to the platform team to check the object store for ' +
        'corruption or a bad replica before retrying.',
      detail: { expected: run.bundleSha256, actual: actualSha256 },
    });
  }

  // See rawLogBundleSource's docstring: a live run's bundleKey always ends
  // in `/simulation.log` (createLive's convention) and is never a gzip
  // stream; an uploaded run's always ends in `.tgz` and always is one.
  // maxTotalBytes/maxEntryBytes (decompression-bomb guards) do not apply
  // to the live path — there is no compression to bound in the first
  // place, since these are exactly the bytes the platform already
  // received and stored one stream chunk at a time.
  return isRawLogKey(run.bundleKey)
    ? rawLogBundleSource(archive)
    : await openTarGzBundle(archive, { maxTotalBytes: deps.maxTotalBytes });
}

/**
 * Opens a run's stored log for parsing. Refuses with `RawLogMissingError`
 * BEFORE reading anything when there is no log to read — an empty recorded
 * checksum, or an object the bucket no longer holds (a HEAD, not a GET: a
 * live run's log can be a couple of hundred MB) — and otherwise behaves as
 * `readRunSource`: `BUNDLE_CHECKSUM_MISMATCH` for bytes that differ from the
 * recorded checksum, a one-file source for a raw log, an archive otherwise.
 */
export async function openRunSource(run: RunSourceRun, deps: RunSourceDeps): Promise<BundleSource> {
  if (run.bundleSha256 === '') throw new RawLogMissingError(run.bundleKey, 'never_stored');
  if (!(await deps.blobs.exists(run.bundleKey))) {
    throw new RawLogMissingError(run.bundleKey, 'object_missing');
  }
  return readRunSource(run, deps);
}
