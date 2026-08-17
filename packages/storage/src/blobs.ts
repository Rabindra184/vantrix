import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
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

export interface BlobConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
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
