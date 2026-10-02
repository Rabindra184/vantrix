import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
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
 *
 * ═══ A 413 MUST REACH THE CLIENT, NOT A RESET ═══
 *
 * `pipeline(req, meter, file)` destroys EVERY stream it was given when one of
 * them fails, and destroying an incomplete IncomingMessage destroys its SOCKET.
 * So the meter's "too large" error used to reach a client that was still
 * sending as EPIPE or ECONNRESET instead of a 413 (measured about one in fifty
 * on loopback, worse over a real network). Two halves, because the cap can be
 * hit two ways:
 *
 *  - EARLY: a Content-Length over the cap is refused before a byte is read.
 *    Nothing has been written, so there is nothing to clean up. Every browser
 *    XHR and curl upload declares its length, so this is the common path.
 *  - MID-STREAM: a chunked body (no length) or a Content-Length that lied.
 *    The meter fails, the partial file is unlinked, and the request is DRAINED
 *    (`unpipe`, then `resume`) rather than destroyed, so the response goes out
 *    on a socket that is still alive. The server's own request timeout still
 *    bounds a client that never finishes sending.
 *
 * `req` is therefore piped by hand and kept OUT of the `pipeline`, which now
 * covers only meter-to-file.
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
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > maxBytes) {
    req.resume();
    throw tooLarge(maxBytes);
  }

  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(tooLarge(maxBytes));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  // What `pipeline(req, …)` would have done for a client that goes away.
  const abandoned = (): void => {
    if (!req.readableEnded) meter.destroy(new Error('The package upload was aborted by the client.'));
  };
  const failed = (err: Error): void => {
    meter.destroy(err);
  };
  req.once('close', abandoned);
  req.once('error', failed);
  const sink = createWriteStream(targetPath);
  req.pipe(meter);
  try {
    await pipeline(meter, sink);
  } catch (err) {
    req.unpipe(meter);
    req.resume();
    // After the file has closed, not before: see whenClosed.
    await whenClosed(sink);
    await unlink(targetPath).catch(() => undefined);
    throw err;
  } finally {
    req.off('close', abandoned);
    req.off('error', failed);
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

function tooLarge(maxBytes: number) {
  return ingestError('BUNDLE_TOO_LARGE', {
    message: `This package file exceeds the ${maxBytes}-byte upload limit.`,
    remediation: 'Upload a smaller artifact, or raise MAX_RUNNER_ARTIFACT_BYTES for this on-prem node.',
    detail: { maxBytes },
  });
}

/**
 * Destroys a write stream and resolves once it has really closed (its file
 * descriptor released) — for one destroyed before it finished opening, that is
 * after the open completes. `createWriteStream` opens lazily, so unlinking its
 * file the moment a size cap trips can run BEFORE the open, find nothing, and
 * leave the file the open then creates: a `.part` left per refused upload.
 */
export function whenClosed(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.closed) {
      resolve();
      return;
    }
    stream.once('close', () => resolve());
    stream.destroy();
  });
}
