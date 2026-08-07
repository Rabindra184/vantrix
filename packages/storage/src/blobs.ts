import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ingestError } from '@perfportal/core';

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
    } catch {
      await this.#s3.send(new CreateBucketCommand({ Bucket: this.#bucket }));
    }
  }

  /**
   * Streams the body to object storage, hashing and counting inline. The cap is
   * enforced DURING the stream, so an oversized upload is aborted rather than
   * buffered — this is what makes the in-memory parse of spec §5.1 safe.
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
    const chunks: Buffer[] = [];

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
        chunks.push(chunk);
        cb(null, chunk);
      },
    });

    await pipeline(body, meter);

    await this.#s3.send(
      new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: Buffer.concat(chunks) }),
    );
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
}
