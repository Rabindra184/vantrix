import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
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
