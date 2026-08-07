import type { Readable } from 'node:stream';
import { ingestError } from '@perfportal/core';
import busboy from 'busboy';
import type { Request } from 'express';

export interface MultipartUpload {
  metadataRaw: string;
  bundle: Readable;
  filename: string;
}

/**
 * Streams the request. The bundle part is handed on as a stream and is never
 * buffered in this process — the API must not hold a multi-hundred-megabyte
 * body in memory while the worker is the component sized for that.
 *
 * Resolves as soon as the bundle part arrives, so the caller can pipe it
 * onward while the request is still being received. `metadata` must therefore
 * be sent BEFORE `bundle`, which is what supertest's .field().attach() order
 * produces and what the OpenAPI description states.
 */
export function readMultipart(req: Request): Promise<MultipartUpload> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fields: 10 } });
    } catch {
      reject(
        ingestError('BUNDLE_NOT_ARCHIVE', {
          message: 'The request is not a multipart/form-data upload.',
          remediation:
            'POST multipart/form-data with a JSON "metadata" field followed by a "bundle" file part.',
        }),
      );
      return;
    }

    let metadataRaw = '';
    let settled = false;

    bb.on('field', (name, value) => {
      if (name === 'metadata') metadataRaw = value;
    });

    bb.on('file', (name, stream, info) => {
      if (name !== 'bundle') {
        stream.resume();
        return;
      }
      settled = true;
      resolve({ metadataRaw, bundle: stream, filename: info.filename });
    });

    bb.on('close', () => {
      if (!settled) {
        reject(
          ingestError('BUNDLE_EMPTY', {
            message: 'The request contained no "bundle" file part.',
            remediation:
              'Attach the gzipped Gatling results directory as a file part named "bundle", after the "metadata" field.',
          }),
        );
      }
    });

    bb.on('error', reject);
    req.pipe(bb);
  });
}
