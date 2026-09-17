import { RunProcessingSchema, RunResponseSchema } from '@perfportal/contracts';
import { ProblemError } from './fetch';

/** Gzipped tar, which is what the bundle reader requires. */
export const BUNDLE_EXTENSIONS = ['.tgz', '.tar.gz'] as const;

/**
 * The server's own ceiling (`MAX_BUNDLE_BYTES`, 512 MB by default).
 *
 * Checked here as well as there, and the duplication is deliberate: refusing a
 * 900 MB file locally costs nothing, while letting it upload spends minutes of
 * the reader's bandwidth to be told no. The SERVER remains the authority — a
 * deployment may configure a smaller limit, and a 413 is relayed as-is.
 */
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

/**
 * What is wrong with this file, or `null`. Pure, so `uploadBundle.test.ts` can
 * exercise every branch without a DOM or a server.
 */
export function bundleProblem(file: { name: string; size: number }): string | null {
  const name = file.name.toLowerCase();
  if (!BUNDLE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return `${file.name} is not a .tgz or .tar.gz. Archive the Gatling results directory first: tar -czf results.tgz -C target/gatling <run-directory>`;
  }
  // An empty file is a distinct mistake from a wrong format — usually a failed
  // `tar` that still produced a file — and saying "not a gzipped tar" about
  // zero bytes sends the reader to check the wrong thing.
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > MAX_BUNDLE_BYTES) {
    return `${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_BUNDLE_BYTES)}.`;
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit] ?? 'GB'}`;
}

/**
 * POST a bundle to `/v1/projects/:slug/runs` with upload progress.
 *
 * ═══ XHR, NOT `fetch`, AND THAT IS THE WHOLE REASON THIS FILE EXISTS ═══
 *
 * `apiFetch` is the right client for everything else here. It cannot do this
 * one job: `fetch` reports no UPLOAD progress — `ReadableStream` request
 * bodies are the standard answer and need HTTP/2 plus `duplex: 'half'`, which
 * an on-prem instance behind a plain proxy will not reliably have. M05 asks
 * for progress explicitly, and a bundle is the one payload in this product
 * large enough for a reader to need it. `XMLHttpRequest.upload.onprogress` has
 * worked everywhere for fifteen years.
 *
 * The response is still parsed through the real schema, and a problem document
 * is still raised as `ProblemError`, so callers handle failures exactly as they
 * do from `apiFetch`.
 */
export function uploadBundle(
  slug: string,
  file: File,
  options: {
    readonly metadata?: Record<string, unknown>;
    readonly onProgress?: (fraction: number) => void;
    readonly signal?: AbortSignal;
  } = {},
): Promise<{ readonly id: string }> {
  return new Promise<{ readonly id: string }>((resolve, reject) => {
    const form = new FormData();
    /* `waitMs: 0` — the handler otherwise blocks for INGEST_WAIT_MS (25s by
       default) waiting for a terminal verdict, which would stall this request
       and leave the reader watching a finished progress bar. The page polls
       the run itself; that is the "processing state" M05 asks for. */
    form.append('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, ...options.metadata }));
    form.append('bundle', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/v1/projects/${encodeURIComponent(slug)}/runs`);
    xhr.withCredentials = true;
    xhr.responseType = 'text';

    if (options.onProgress) {
      xhr.upload.onprogress = (event) => {
        // `lengthComputable` is false behind some proxies; reporting NaN would
        // render a progress bar at an undefined width.
        if (event.lengthComputable && event.total > 0) {
          options.onProgress?.(event.loaded / event.total);
        }
      };
    }

    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    xhr.onerror = () =>
      reject(new Error('The upload could not reach the server. Check your connection and retry.'));

    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText) as unknown;
      } catch {
        reject(new Error(`The server returned a response this page could not read (HTTP ${String(xhr.status)}).`));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        /* ═══ 202 IS A DIFFERENT SHAPE FROM 200, AND THAT IS THE POINT ═══
         *
         * `respondWithRun` answers 202 with a PROCESSING run — id, status and
         * little else — because nothing has parsed the bundle yet, and 200/422
         * with a complete one only once something has. Parsing every 2xx with
         * `RunResponseSchema` therefore fails on the status this endpoint
         * almost always returns: `waitMs: 0` above guarantees it. The first
         * version of this did exactly that and reported "the server accepted
         * the upload but returned a run this page could not read" over a
         * perfectly good 202.
         *
         * Only the ID is needed — the caller polls `GET /v1/runs/:id` through
         * `useRunTerminal`, which already knows both shapes. Both are still
         * PARSED rather than reached into, so a 2xx body that matches neither
         * is a loud failure instead of `undefined` flowing into a route. */
        const parsed =
          xhr.status === 202 ? RunProcessingSchema.safeParse(body) : RunResponseSchema.safeParse(body);
        if (!parsed.success) {
          reject(new Error('The server accepted the upload but returned a run this page could not read.'));
          return;
        }
        resolve({ id: parsed.data.id });
        return;
      }
      /* Relay the server's own sentence. Every `/v1` failure carries a `detail`
         and a `remediation`, and both are more actionable than anything this
         file could invent — the rule `States.tsx` already follows. */
      const problem = body as { code?: string; detail?: string; remediation?: string };
      reject(
        new ProblemError(xhr.status, {
          code: problem.code ?? 'UPLOAD_FAILED',
          detail: problem.detail ?? `The upload failed (HTTP ${String(xhr.status)}).`,
          remediation: problem.remediation ?? '',
        }),
      );
    };

    xhr.send(form);
  });
}
