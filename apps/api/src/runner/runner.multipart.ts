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
    let settled = false;
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fields: 20, fileSize: maxBytes } });
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
    let fileTooLarge = false;

    const tooLargeError = () =>
      ingestError('BUNDLE_TOO_LARGE', {
        message: `This runner artifact exceeds the ${maxBytes}-byte upload limit.`,
        remediation:
          'Upload a smaller runnable Gatling artifact, or raise MAX_RUNNER_ARTIFACT_BYTES for this on-prem node.',
        detail: { maxBytes },
      });

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      req.unpipe(bb);
      req.resume();
      void unlink(targetPath).catch(() => undefined).finally(() => {
        reject(err);
      });
    };

    const complete = (upload: RunnerUpload) => {
      if (settled) return;
      settled = true;
      resolve(upload);
    };

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
      stream.once('limit', () => {
        fileTooLarge = true;
        fail(tooLargeError());
      });
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            callback(tooLargeError());
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      fileWritten = pipeline(stream, meter, createWriteStream(targetPath));
      void fileWritten.catch((err) => fail(err));
    });

    bb.on('close', () => {
      void (async () => {
        try {
          if (settled) return;
          if (!fileSeen || fileWritten === null) {
            throw ingestError('BUNDLE_EMPTY', {
              message: 'The request contained no "artifact" file part.',
              remediation:
                'Attach the Gatling jar or runnable bundle as a file part named "artifact".',
            });
          }
          await fileWritten;
          if (fileTooLarge) throw tooLargeError();
          complete({ metadataRaw, filename, sha256: hash.digest('hex'), bytes });
        } catch (err) {
          fail(err);
        }
      })();
    });

    bb.on('error', fail);
    req.on('aborted', () => fail(new Error('Runner artifact upload was aborted by the client.')));
    req.on('error', fail);
    req.pipe(bb);
  });
}
