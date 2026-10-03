import {
  PackageListResponseSchema,
  PackageSchema,
  type CreatePackageRequest,
  type Package,
  type PackageKind,
  type PackageListResponse,
} from '@perfportal/contracts';
import { apiFetch, problemFrom } from './fetch';

/**
 * Packages — a project's named, reusable Gatling artifacts
 * (backlog #8, docs/superpowers/specs/2026-10-02-packages-design.md).
 *
 * The key is parameterised by project for the reason `projectRulesQueryKey`
 * is: two projects' package lists are different answers, and a shared key
 * would serve one as the other the moment a reader moved between them.
 */
export const packagesQueryKey = (slug: string) => ['packages', slug] as const;

const packagesPath = (slug: string): string => `/v1/projects/${encodeURIComponent(slug)}/packages`;

/**
 * The extensions each kind of package takes, in the `accept` syntax a file
 * input reads.
 *
 * THE SERVER'S RULE, WRITTEN OUT ON THE CONTROL. `extensionFor`
 * (`apps/api/src/runner/package-files.ts`) accepts `.jar` for a jar and
 * `.zip`, `.tgz` or `.tar.gz` for a bundle, and refuses the rest with
 * `PACKAGE_KIND_MISMATCH` — after the body has been read. Expressing it as
 * `accept` means the OS picker greys out the wrong files before anything is
 * chosen, which is cheaper than the server's refusal and is the same reason
 * `BundleUpload` does it. The server stays the authority: `accept` is a hint a
 * reader can override with "All files".
 */
export const PACKAGE_ACCEPT: Readonly<Record<PackageKind, string>> = {
  gatling_jar: '.jar',
  gatling_bundle: '.zip,.tgz,.tar.gz',
};

/** `GET /v1/projects/:slug/packages` — newest upload first, as the API orders it. */
export function fetchPackages(slug: string): Promise<PackageListResponse> {
  return apiFetch(PackageListResponseSchema, packagesPath(slug));
}

/**
 * Creates a package, with its first file when there is one.
 *
 * MULTIPART, NOT JSON: the route reads a `metadata` part and an optional
 * `artifact` part, and a JSON body is refused with a sentence saying so. The
 * file part is OMITTED rather than sent empty when there is no file — a
 * package with no version yet is a legitimate thing to create, and "no part"
 * is how the route is told.
 *
 * No `Content-Type` is set: `fetch` derives it from the `FormData` and adds the
 * boundary, which a hand-written header would lose.
 */
export function createPackage(
  slug: string,
  request: CreatePackageRequest,
  file: File | null,
): Promise<Package> {
  const body = new FormData();
  body.set('metadata', JSON.stringify(request));
  if (file !== null) body.set('artifact', file);
  return apiFetch(PackageSchema, packagesPath(slug), { method: 'POST', body });
}

/**
 * Uploads a new version to an existing package, with upload progress.
 *
 * ═══ XHR, NOT `fetch`, FOR THE REASON `uploadBundle` IS ═══
 *
 * `fetch` reports no UPLOAD progress — `ReadableStream` request bodies need
 * HTTP/2 and `duplex: 'half'`, which an on-prem instance behind a plain proxy
 * will not reliably have — and a jar is the one payload here large enough for a
 * reader to need a bar. `XMLHttpRequest.upload.onprogress` has worked
 * everywhere for fifteen years. Everything else about the call is the shared
 * path: a failure is still a `ProblemError`, read by the same `problemFrom`.
 *
 * THE BODY IS THE FILE ITSELF, with its name in `?filename=`. The route reads a
 * raw `application/octet-stream` body (so a 500 MB jar is streamed to disk and
 * hashed on the way, never buffered), and a raw body has nowhere to carry a
 * name. Without one the server invents `<package name>.jar`, which would lose
 * the one thing a reader looks for in the File column.
 *
 * `onProgress(1)` IS ALSO CALLED WHEN THE BYTES HAVE ALL BEEN SENT, from
 * `upload.onload`, and that is not redundant with the last `onprogress`:
 * `lengthComputable` is false behind some proxies, so a caller that only ever
 * heard `onprogress` would be told nothing at all and sit on "Uploading…" while
 * the server read the jar's manifest. "All sent" is a fact the browser always
 * has, whatever it knows about the total.
 */
export function uploadPackageContent(
  slug: string,
  packageId: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<Package> {
  return new Promise<Package>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      'PUT',
      `${packagesPath(slug)}/${encodeURIComponent(packageId)}/content?filename=${encodeURIComponent(file.name)}`,
    );
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        // `lengthComputable` is false behind some proxies; reporting NaN would
        // render a progress label at an undefined percentage.
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
      };
      xhr.upload.onload = () => onProgress(1);
    }

    xhr.onerror = () =>
      reject(new Error('The upload could not reach the server. Check your connection and retry.'));

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let body: unknown;
        try {
          body = JSON.parse(xhr.responseText) as unknown;
        } catch {
          reject(new Error(`The server returned a response this page could not read (HTTP ${String(xhr.status)}).`));
          return;
        }
        // 200 with the package, parsed rather than reached into: a 2xx body
        // that is not a package is a loud failure instead of `undefined`
        // flowing into a row.
        const parsed = PackageSchema.safeParse(body);
        if (!parsed.success) {
          reject(new Error('The upload went through, but the server returned a package this page could not read.'));
          return;
        }
        resolve(parsed.data);
        return;
      }
      // The ONE error reader. A non-2xx here may be a proxy's HTML 413 rather
      // than the API's problem document, and `problemFrom` is what turns either
      // into a `ProblemError` — it never throws, so this cannot be the call
      // that fails.
      void problemFrom(new Response(xhr.responseText, { status: xhr.status })).then(reject);
    };

    xhr.send(file);
  });
}

/** Renames a package. 409 `PACKAGE_NAME_TAKEN` when the name is another's, ignoring case. */
export function renamePackage(slug: string, packageId: string, name: string): Promise<Package> {
  return apiFetch(PackageSchema, `${packagesPath(slug)}/${encodeURIComponent(packageId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

/**
 * Deletes a package. 204 and no body, so this cannot go through `apiFetch`,
 * which parses every success against a schema.
 *
 * 409 `PACKAGE_IN_USE` while a run of it is queued or running — the page
 * already says so in the menu, but the list it drew that from may be seconds
 * old, so the server's answer is relayed as it is.
 */
export async function deletePackage(slug: string, packageId: string): Promise<void> {
  const res = await fetch(`${packagesPath(slug)}/${encodeURIComponent(packageId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!res.ok) throw await problemFrom(res);
}
