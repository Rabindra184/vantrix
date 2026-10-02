import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ingestError } from '@perfportal/core';
import busboy from 'busboy';
import type { Request } from 'express';
import { whenClosed } from './raw-upload.js';

export interface RunnerUpload {
  metadataRaw: string;
  filename: string;
  sha256: string;
  bytes: number;
}

/**
 * `fileRequired` is REQUIRED and has no default, because its wrong value is
 * silent: a caller that meant "a file must arrive" and got `false` would accept
 * an empty request as a success. The start route passes `true`; package
 * creation passes `false`, since a package may be created empty and given its
 * first version later. When it is false and no file part arrived, the upload
 * resolves with `filename: ''`, `sha256: ''` and `bytes: 0` — the caller treats
 * `bytes === 0 && filename === ''` as "no file", and removes whatever was
 * written to `targetPath`.
 */
export function readRunnerMultipart(
  req: Request,
  targetPath: string,
  maxBytes: number,
  options: { readonly fileRequired: boolean },
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
    let sink: WriteStream | null = null;
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
      // THE FILE IS REMOVED ONLY AFTER ITS STREAM HAS CLOSED. createWriteStream
      // opens lazily, so an unlink issued the moment the cap trips (the first
      // chunk) can run BEFORE the open, find nothing, and leave the file the
      // open then creates — a `.part` per refused upload. Destroying the sink
      // and waiting for 'close' makes the unlink come after the file exists.
      void (sink === null ? Promise.resolve() : whenClosed(sink))
        .then(() => unlink(targetPath))
        .catch(() => undefined)
        .finally(() => {
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
      // busboy reports `undefined`, whatever its type says, for a part with an
      // application/octet-stream type and an empty or absent filename — which
      // is exactly what a browser sends for a file input left empty. Normalised
      // here so every caller meets a string: "" means "no name was given".
      filename = info.filename ?? '';
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
      sink = createWriteStream(targetPath);
      fileWritten = pipeline(stream, meter, sink);
      void fileWritten.catch((err) => fail(err));
    });

    bb.on('close', () => {
      void (async () => {
        try {
          if (settled) return;
          if (!fileSeen || fileWritten === null) {
            if (!options.fileRequired) {
              complete({ metadataRaw, filename: '', sha256: '', bytes: 0 });
              return;
            }
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
