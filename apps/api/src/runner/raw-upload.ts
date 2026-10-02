import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ingestError } from '@perfportal/core';
import type { Request } from 'express';
import { badRequest } from '../common/validation.js';

/**
 * Streams a raw request body to `targetPath`, hashing as it goes — the shape of
 * Gatling Enterprise's `PUT …/content`. Never buffers the body: a package is up
 * to MAX_RUNNER_ARTIFACT_BYTES (512 MB by default).
 *
 * A body a parser already drained is REFUSED, not waited on: Express's global
 * json()/urlencoded() consume a matching Content-Type before any handler runs,
 * and waiting for an 'end' that already fired leaks the socket for ever
 * (CLAUDE.md, readRawBody).
 */
export async function readRawUpload(
  req: Request,
  targetPath: string,
  maxBytes: number,
): Promise<{ sha256: string; bytes: number }> {
  if (req.readableEnded) {
    throw badRequest(
      'STREAM_BODY_CONSUMED',
      `The package file's body was already consumed by a body parser, which happens when Content-Type is one Express parses ("${req.headers['content-type'] ?? '(none)'}" here).`,
      'Send the file with "Content-Type: application/octet-stream" and the raw bytes as the body.',
    );
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(
          ingestError('BUNDLE_TOO_LARGE', {
            message: `This package file exceeds the ${maxBytes}-byte upload limit.`,
            remediation: 'Upload a smaller artifact, or raise MAX_RUNNER_ARTIFACT_BYTES for this on-prem node.',
            detail: { maxBytes },
          }),
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, createWriteStream(targetPath));
  } catch (err) {
    await unlink(targetPath).catch(() => undefined);
    throw err;
  }
  if (bytes === 0) {
    await unlink(targetPath).catch(() => undefined);
    throw ingestError('BUNDLE_EMPTY', {
      message: 'The request carried no file.',
      remediation: 'Send the package file as the raw request body.',
    });
  }
  return { sha256: hash.digest('hex'), bytes };
}
