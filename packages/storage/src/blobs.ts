import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { ingestError } from '@perfportal/core';

/**
 * True only for the "bucket does not exist" signal HeadBucket returns (404 /
 * NotFound / NoSuchBucket). Any other failure — a network blip, bad
 * credentials, an IAM policy that denies HeadBucket specifically — must not
 * be treated as "go ahead and create it": on real S3, CreateBucket on a
 * bucket you already own in us-east-1 returns success, which would silently
 * paper over a genuine permissions problem and report the store as healthy.
 */
function isBucketMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = (err as { name?: string }).name;
  if (name === 'NotFound' || name === 'NoSuchBucket') return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404;
}

/**
 * Same shape as {@link isBucketMissing}, for the object-level 404
 * `HeadObjectCommand` returns. A HEAD response carries no body to
 * distinguish error subtypes, so the SDK reports a missing object the same
 * generic way it reports a missing bucket (`name: 'NotFound'`, or a bare 404
 * status) rather than `GetObjectCommand`'s more specific `NoSuchKey`.
 */
function isObjectMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = (err as { name?: string }).name;
  if (name === 'NotFound' || name === 'NoSuchKey') return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404;
}

/**
 * SOCKET-IDLE timeout for every request this client makes, in ms.
 *
 * THE SDK'S OWN DEFAULT IS 0 -- NO TIMEOUT -- and that default was, until
 * this constant existed, the single longest-reaching failure on the live
 * path. `LiveFoldOwner#fold` awaits `LiveChunkStore.readFrom`, which fans
 * out `get()` calls through this client, while holding `#ticking` and
 * `#folding`. A `get` whose socket goes quiet and never returns therefore
 * stalls not just that one run's fold but EVERY owned run's fold and
 * publish for the whole process, indefinitely: the tick's release loop
 * never runs, so a closed run keeps the advisory lock `PipelineService`
 * needs and sits at `parsing` until the sweeper's `parsingStaleAfterMs`
 * (15 minutes) picks it up. The fold watchdog
 * (`LiveFoldOwner#checkWatchdog`) exists to make that visible precisely
 * because nothing could bound it; this bounds it.
 *
 * ═══ `socketTimeout`, NOT `requestTimeout` -- THE OBVIOUS OPTION IS THE
 * WRONG ONE, TWICE OVER ═══
 *
 * `@smithy/node-http-handler` 4.x offers both, and `requestTimeout` is the
 * one that looks right and is not:
 *
 *  1. It is a TOTAL DEADLINE ("the maximum number of milliseconds request &
 *     response should take"), measured from a plain `setTimeout` at request
 *     start. Any value short enough to bound a stall would also abort a
 *     healthy transfer that is simply large -- the live design sizes a run's
 *     assembled log at up to ~250 MB, read back through `assemble` as ONE
 *     `GetObject` body, and `putStream` ships bundle parts of comparable
 *     size. `socketTimeout` is `socket.setTimeout`: it fires only after the
 *     socket has moved NO BYTES for this long, so a slow-but-progressing
 *     transfer is never punished for taking a while, and a black-holed one
 *     is caught within one window regardless of how big the object was.
 *  2. IT DOES NOT EVEN THROW BY DEFAULT. That handler logs
 *     `[WARN] a request has exceeded the configured N ms requestTimeout`
 *     and lets the request keep hanging unless `throwOnRequestTimeout: true`
 *     is also set -- their own compatibility shim for having historically
 *     documented `requestTimeout` as an idle timeout when it was not. So
 *     setting `requestTimeout` alone, the obvious reading of "give the
 *     S3Client a request timeout", buys a log line and changes NOTHING
 *     about the hang. Verified against @smithy/node-http-handler 4.9.13,
 *     and by the black-hole case in `test/blobs.test.ts`, which was written
 *     with `requestTimeout` first and timed out at 30 s while the handler
 *     printed exactly that warning.
 *
 * `socketTimeout` rejects with a `TimeoutError` on its own, no opt-in.
 *
 * ═══ THE VALUE ═══
 *
 * 10 s, matching the `connectionTimeoutMillis` the worker's own pg pool
 * already uses (`apps/worker/src/main.ts`) -- one number for "a round trip
 * this process depends on has stopped making progress", not two. Orders of
 * magnitude above the byte-to-byte gap a healthy S3 or MinIO transfer shows
 * even with the SDK's 50-socket cap saturated, and far below any window in
 * which a stalled worker is still someone's acceptable behaviour.
 *
 * The SDK's standard retry strategy treats the resulting `TimeoutError` as
 * transient and retries it up to `maxAttempts` (3 by default), so one
 * `get()` against a black-holed socket costs up to ~3x this plus backoff
 * before it finally rejects. That is the point: BOUNDED, and it rejects --
 * versus never. `TimeoutError` is also already in the pipeline's own
 * `TRANSIENT_CODES` (`apps/worker/src/pipeline/retry.ts`), so a batch
 * ingest that hits this gets BullMQ's retries rather than a permanent
 * failure, with no further wiring.
 *
 * WHAT REMAINS UNBOUNDED, stated rather than papered over: a peer that
 * dribbles one byte just inside every window keeps a request alive
 * forever. No idle timeout can catch that, and the only thing that could --
 * a total deadline -- is the option rejected above for being unable to tell
 * that case apart from a legitimate 250 MB read. The realistic failure this
 * constant exists for is a socket that goes silent, which is what a dropped
 * connection, a black-holed NAT entry, or a wedged endpoint actually looks
 * like.
 */
export const BLOB_SOCKET_TIMEOUT_MS = 10_000;

/**
 * How long to wait for the TCP/TLS connection itself, in ms. Separate from
 * {@link BLOB_SOCKET_TIMEOUT_MS} because it bounds a different failure --
 * an endpoint that accepts nothing (a wrong host, a dead load balancer)
 * rather than one that accepts and then goes quiet -- and because there is
 * no legitimate reason for establishing a connection to a store in the same
 * network to take anywhere near as long as a large body takes to move.
 */
export const BLOB_CONNECTION_TIMEOUT_MS = 5_000;

export interface BlobConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  /**
   * Overrides {@link BLOB_SOCKET_TIMEOUT_MS} for this store only.
   *
   * Exists so a test can prove the timeout is WIRED without waiting the
   * production value out (`test/blobs.test.ts` points a store at a socket
   * that accepts and never answers), and so an operator on a genuinely
   * slower link can raise it without a code change. Nothing in this
   * repository sets it in production.
   */
  socketTimeoutMs?: number;
}

export class BlobStore {
  readonly #s3: S3Client;
  readonly #bucket: string;

  constructor(cfg: BlobConfig) {
    this.#bucket = cfg.bucket;
    this.#s3 = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle ?? true,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // A plain options object, not a constructed NodeHttpHandler: the SDK
      // hands it to `NodeHttpHandler.create`, which is what keeps the
      // handler's own agent/keep-alive defaults intact instead of this file
      // having to restate them.
      requestHandler: {
        socketTimeout: cfg.socketTimeoutMs ?? BLOB_SOCKET_TIMEOUT_MS,
        connectionTimeout: BLOB_CONNECTION_TIMEOUT_MS,
      },
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.#s3.send(new HeadBucketCommand({ Bucket: this.#bucket }));
    } catch (err) {
      if (!isBucketMissing(err)) throw err;
      await this.#s3.send(new CreateBucketCommand({ Bucket: this.#bucket }));
    }
  }

  /**
   * Streams the body to object storage as a genuine streaming multipart
   * upload, hashing and counting bytes inline as they pass through. The body
   * is never buffered in full: `Upload` (from @aws-sdk/lib-storage) reads
   * the metered stream directly and ships it to S3 part by part (falling
   * back to a single PutObject when the whole body fits in one part).
   *
   * The cap is enforced DURING the stream: once the running byte count
   * exceeds maxBytes, the metering Transform errors out instead of emitting
   * more data. `pipeline` propagates that error back through the source and
   * `Upload` observes the same error while reading the metered stream, so
   * both settle with the original `IngestError` — its `code` and
   * `remediation` reach the caller unwrapped, not an opaque SDK error.
   *
   * The bundle is durable before any row references it (spec §6.1 step order).
   */
  async putStream(
    key: string,
    body: Readable,
    maxBytes: number,
  ): Promise<{ sha256: string; bytes: number }> {
    const hash = createHash('sha256');
    let bytes = 0;

    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          cb(
            ingestError('BUNDLE_TOO_LARGE', {
              message: `Bundle exceeds the ${maxBytes}-byte limit for this project.`,
              remediation:
                'Archive only the Gatling results directory, without the bundled js/ and style/ vendor assets, or raise the limit in project settings.',
              detail: { maxBytes },
            }),
          );
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });

    // Both sides run concurrently: `pipeline` feeds `body` into `meter`
    // while `Upload` drains `meter`'s readable side as it uploads. Neither
    // is awaited before the other starts — that concurrency is what
    // prevents the stall the unmetered pipeline used to hit once the
    // readable side's buffer filled up.
    const upload = new Upload({
      client: this.#s3,
      params: { Bucket: this.#bucket, Key: key, Body: meter },
    });
    try {
      await Promise.all([pipeline(body, meter), upload.done()]);
    } catch (err) {
      // Best-effort: an abort failure must not mask the original error (the
      // caller needs the IngestError's code/remediation intact), it can only
      // leave behind the same incomplete-upload debris we were trying to
      // avoid, for a lifecycle rule to reap later.
      try {
        await upload.abort();
      } catch (abortErr) {
        console.error('failed to abort incomplete multipart upload', key, abortErr);
      }
      throw err;
    }

    return { sha256: hash.digest('hex'), bytes };
  }

  /**
   * Enumerates every object key under `prefix`, in the lexicographic order
   * S3 (and MinIO) returns for a general-purpose bucket.
   *
   * This exists for one caller: `LiveChunkStore.assemble`, which must read
   * back every chunk a live run wrote, in the order their zero-padded
   * offsets sort. `ListObjectsV2` — the only S3 operation that can discover
   * those keys without a second source of truth for where each chunk
   * landed — hands back at most 1000 keys per call and says so only through
   * `IsTruncated` / `NextContinuationToken`; nothing about a single call
   * signals that more exist. At 64 KB chunks a live run crosses that
   * boundary at roughly 64 MB, well inside an ordinary soak test, so
   * treating page one as the whole prefix is not a rare-edge-case bug, it is
   * the common case for any run of real length.
   *
   * The consequence of getting this wrong is worse than a short list: the
   * assembled log would be silently truncated mid-stream, and the plugin's
   * decoder keeps a back-referencing string cache built while replaying the
   * log — so every record after the cut point decodes as garbage or throws,
   * arbitrarily far (in bytes and in wall-clock debugging time) from the
   * object that was actually dropped. There is no way to detect the
   * truncation from the assembled bytes alone. So: loop until `IsTruncated`
   * is false. Never return after the first page on the assumption that 1000
   * keys is "probably enough".
   */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const res = await this.#s3.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    return keys;
  }

  /**
   * True if `key` already exists in the bucket.
   *
   * Backed by `HeadObjectCommand`, not `get`: this exists for callers that
   * need to know whether an object is already there before deciding whether
   * to write it — `LiveChunkStore.finalize` is the first — and a live run's
   * assembled log can be on the order of a couple hundred MB. Answering
   * "does it exist" with a full `get()` would transfer the whole body just
   * to throw it away; HEAD fetches metadata only.
   */
  async exists(key: string): Promise<boolean> {
    try {
      await this.#s3.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      return true;
    } catch (err) {
      if (isObjectMissing(err)) return false;
      throw err;
    }
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.#s3.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    const body = res.Body as Readable | undefined;
    if (!body) throw new Error(`empty body for ${key}`);
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks);
  }

  /**
   * Removes a bundle that no row will ever reference — e.g. the loser of a
   * concurrent idempotent-create race, which already finished uploading
   * before losing the unique-constraint race in Postgres.
   */
  async delete(key: string): Promise<void> {
    await this.#s3.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}
