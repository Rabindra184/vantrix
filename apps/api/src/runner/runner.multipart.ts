import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ingestError } from '@perfportal/core';
import busboy from 'busboy';
import type { Request } from 'express';

export interface RunnerUpload {
  metadataRaw: string;
  filename: string;
  sha256: string;
  bytes: number;
}

export function readRunnerMultipart(
  req: Request,
  targetPath: string,
  maxBytes: number,
): Promise<RunnerUpload> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fields: 20 } });
    } catch {
      reject(
        ingestError('BUNDLE_NOT_ARCHIVE', {
          message: 'The runner request is not a multipart/form-data upload.',
          remediation:
            'POST multipart/form-data with a JSON "metadata" field and a Gatling artifact file part named "artifact".',
        }),
      );
      return;
    }

    let metadataRaw = '';
    let filename = '';
    let bytes = 0;
    const hash = createHash('sha256');
    let fileWritten: Promise<void> | null = null;
    let fileSeen = false;

    bb.on('field', (name, value) => {
      if (name === 'metadata') metadataRaw = value;
    });

    bb.on('file', (name, stream, info) => {
      if (name !== 'artifact') {
        stream.resume();
        return;
      }
      fileSeen = true;
      filename = info.filename;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            callback(
              ingestError('BUNDLE_TOO_LARGE', {
                message: `This runner artifact exceeds the ${maxBytes}-byte upload limit.`,
                remediation:
                  'Upload a smaller runnable Gatling artifact, or raise MAX_RUNNER_ARTIFACT_BYTES for this on-prem node.',
                detail: { maxBytes },
              }),
            );
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      fileWritten = pipeline(stream, meter, createWriteStream(targetPath));
    });

    bb.on('close', () => {
      void (async () => {
        try {
          if (!fileSeen || fileWritten === null) {
            throw ingestError('BUNDLE_EMPTY', {
              message: 'The request contained no "artifact" file part.',
              remediation:
                'Attach the Gatling jar or runnable bundle as a file part named "artifact".',
            });
          }
          await fileWritten;
          resolve({ metadataRaw, filename, sha256: hash.digest('hex'), bytes });
        } catch (err) {
          await unlink(targetPath).catch(() => undefined);
          reject(err);
        }
      })();
    });

    bb.on('error', reject);
    req.pipe(bb);
  });
}
