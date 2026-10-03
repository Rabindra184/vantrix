import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Package } from '@perfportal/contracts';
import { ProblemError } from '../src/api/fetch';
import {
  PACKAGE_ACCEPT,
  createPackage,
  deletePackage,
  packagesQueryKey,
  renamePackage,
  uploadPackageContent,
} from '../src/api/packages';

/**
 * The package client, below the page.
 *
 * `ProjectPackages.test.tsx` mocks all five functions, so everything it proves
 * is about what the page DOES with an answer. What it cannot see is whether the
 * request that earns the answer is the one the route reads: the multipart part
 * names, the raw `PUT` body and its `?filename=`, the one error path. Those are
 * pinned here, and the upload's XHR is a hand-written fake because that is the
 * only seam a progress event can be driven through — node has no
 * `XMLHttpRequest`, and a jsdom one would speak to a network.
 */

const PACKAGE: Package = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Checkout',
  kind: 'gatling_jar',
  createdAt: '2026-09-20T08:00:00.000Z',
  updatedAt: '2026-10-01T09:30:00.000Z',
  current: null,
  usage: { tests: 0, runs: 0, activeJobs: 0 },
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const PROBLEM = {
  type: 'about:blank',
  title: 'Conflict',
  status: 409,
  code: 'PACKAGE_NAME_TAKEN',
  detail: 'This project already has a package called "Checkout".',
  remediation: 'Choose another name.',
};

afterEach(() => vi.unstubAllGlobals());

describe('packagesQueryKey', () => {
  it('is one answer per project, so two projects never share a list', () => {
    expect(packagesQueryKey('checkout')).toEqual(['packages', 'checkout']);
    expect(packagesQueryKey('checkout')).not.toEqual(packagesQueryKey('search'));
  });
});

describe('PACKAGE_ACCEPT', () => {
  it('says what the server accepts for each kind', () => {
    // `extensionFor` in the API: a jar takes `.jar`; a bundle `.zip`, `.tgz` or
    // `.tar.gz`. A drift here is a picker that offers files the server refuses.
    expect(PACKAGE_ACCEPT.gatling_jar).toBe('.jar');
    expect(PACKAGE_ACCEPT.gatling_bundle).toBe('.zip,.tgz,.tar.gz');
  });
});

describe('createPackage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(json(201, PACKAGE)));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('posts multipart with a metadata part and the file as the artifact part', async () => {
    const file = new File(['jar'], 'checkout.jar');
    await createPackage('checkout', { name: 'Checkout', kind: 'gatling_jar' }, file);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/v1/projects/checkout/packages');
    expect(init.method).toBe('POST');
    const body = init.body as FormData;
    expect(JSON.parse(body.get('metadata') as string)).toEqual({ name: 'Checkout', kind: 'gatling_jar' });
    expect((body.get('artifact') as File).name).toBe('checkout.jar');
    // A hand-written Content-Type would lose the multipart boundary.
    expect((init.headers as Record<string, string> | undefined)?.['Content-Type']).toBeUndefined();
  });

  it('OMITS the artifact part when there is no file — an empty package is made by sending none', async () => {
    await createPackage('checkout', { name: 'Checkout', kind: 'gatling_bundle' }, null);

    const body = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(body.has('artifact')).toBe(false);
    expect(JSON.parse(body.get('metadata') as string)).toEqual({ name: 'Checkout', kind: 'gatling_bundle' });
  });

  it('encodes the slug, because it is data', async () => {
    await createPackage('a/b', { name: 'X', kind: 'gatling_jar' }, null);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('/v1/projects/a%2Fb/packages');
  });

  it('raises the server’s own refusal as a ProblemError', async () => {
    fetchMock.mockResolvedValue(json(409, PROBLEM));
    await expect(
      createPackage('checkout', { name: 'Checkout', kind: 'gatling_jar' }, null),
    ).rejects.toMatchObject({ status: 409, code: 'PACKAGE_NAME_TAKEN', detail: PROBLEM.detail });
  });
});

describe('renamePackage', () => {
  it('PATCHes the name as JSON, at the package’s own URL', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(200, { ...PACKAGE, name: 'Checkout v2' })));
    vi.stubGlobal('fetch', fetchMock);

    const renamed = await renamePackage('checkout', PACKAGE.id, 'Checkout v2');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/v1/projects/checkout/packages/${PACKAGE.id}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Checkout v2' });
    expect(renamed.name).toBe('Checkout v2');
  });
});

describe('deletePackage', () => {
  it('resolves on a 204, which has no body to parse', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deletePackage('checkout', PACKAGE.id)).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/v1/projects/checkout/packages/${PACKAGE.id}`);
    expect(init.method).toBe('DELETE');
  });

  it('raises the 409 a run still in flight earns, in the server’s own words', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json(409, { ...PROBLEM, code: 'PACKAGE_IN_USE', detail: '2 runs of this package are queued or running.' }),
        ),
      ),
    );
    await expect(deletePackage('checkout', PACKAGE.id)).rejects.toMatchObject({
      status: 409,
      code: 'PACKAGE_IN_USE',
      detail: '2 runs of this package are queued or running.',
    });
  });
});

/**
 * The browser's upload event, in the one shape the client reads.
 *
 * Hand-written rather than a library's: the client touches exactly `open`,
 * `setRequestHeader`, `send`, `upload.onprogress`, `upload.onload`, `onload`
 * and `onerror`, and a fake that offers only those fails the day the client
 * starts depending on a seventh without the test hearing about it.
 */
class FakeXhr {
  static last: FakeXhr;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  withCredentials = false;
  responseType = '';
  status = 0;
  responseText = '';
  sent: unknown = undefined;
  upload: {
    onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
    onload: (() => void) | null;
  } = { onprogress: null, onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(body: unknown): void {
    this.sent = body;
  }
  /** The server answers. */
  answer(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

describe('uploadPackageContent', () => {
  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });

  it('PUTs the raw file, with its name in the query and an octet-stream type', () => {
    const file = new File(['jar'], 'a b&c.jar');
    void uploadPackageContent('checkout', PACKAGE.id, file);

    const xhr = FakeXhr.last;
    expect(xhr.method).toBe('PUT');
    // The name is what the File column shows afterwards; without it the server
    // invents `<package>.jar`. Encoded, because a filename is data.
    expect(xhr.url).toBe(`/v1/projects/checkout/packages/${PACKAGE.id}/content?filename=a%20b%26c.jar`);
    expect(xhr.headers['Content-Type']).toBe('application/octet-stream');
    expect(xhr.sent).toBe(file);
    expect(xhr.withCredentials).toBe(true);
  });

  it('reports progress as a fraction, ignores a total the browser cannot compute, and says when all the bytes are sent', () => {
    const onProgress = vi.fn();
    void uploadPackageContent('checkout', PACKAGE.id, new File(['jar'], 'x.jar'), onProgress);
    const { upload } = FakeXhr.last;

    upload.onprogress?.({ lengthComputable: true, loaded: 42, total: 100 });
    // Behind some proxies `lengthComputable` is false; reporting NaN would
    // render a percentage of nothing.
    upload.onprogress?.({ lengthComputable: false, loaded: 50, total: 0 });
    expect(onProgress.mock.calls).toEqual([[0.42]]);

    // "All sent" is a fact the browser always has, computable total or not, and
    // it is what moves a caller from Uploading to Processing.
    upload.onload?.();
    expect(onProgress).toHaveBeenLastCalledWith(1);
  });

  it('attaches no progress listeners when nobody asked for them', () => {
    void uploadPackageContent('checkout', PACKAGE.id, new File(['jar'], 'x.jar'));
    expect(FakeXhr.last.upload.onprogress).toBeNull();
    expect(FakeXhr.last.upload.onload).toBeNull();
  });

  it('resolves with the package the 200 carries, parsed against the contract', async () => {
    const promise = uploadPackageContent('checkout', PACKAGE.id, new File(['jar'], 'x.jar'));
    FakeXhr.last.answer(200, JSON.stringify(PACKAGE));
    await expect(promise).resolves.toEqual(PACKAGE);
  });

  it('refuses a 200 that is not a package, loudly, rather than handing undefined to a row', async () => {
    const promise = uploadPackageContent('checkout', PACKAGE.id, new File(['jar'], 'x.jar'));
    FakeXhr.last.answer(200, JSON.stringify({ id: 'not-a-package' }));
    await expect(promise).rejects.toThrow(/could not read/);
  });

  it('raises the API’s problem document as a ProblemError, as apiFetch does', async () => {
    const promise = uploadPackageContent('checkout', PACKAGE.id, new File(['jar'], 'x.jar'));
    FakeXhr.last.answer(409, JSON.stringify(PROBLEM));
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect(error).toMatchObject({ status: 409, code: 'PACKAGE_NAME_TAKEN', remediation: 'Choose another name.' });
  });

  it('turns a proxy’s HTML error page into a ProblemError too — the one reader, never a second', async () => {
    // A reverse proxy's own 413 is not the API's problem document, and is what
    // an over-size upload meets before the API ever sees it.
    const promise = uploadPackageContent('checkout', PACKAGE.id, new File(['jar'], 'x.jar'));
    FakeXhr.last.answer(413, '<html><body>Request Entity Too Large</body></html>');
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect(error).toMatchObject({ status: 413, code: 'CLIENT_UNREADABLE_ERROR' });
  });

  it('says so, in a sentence, when the request never reached the server', async () => {
    const promise = uploadPackageContent('checkout', PACKAGE.id, new File(['jar'], 'x.jar'));
    FakeXhr.last.onerror?.();
    await expect(promise).rejects.toThrow(/could not reach the server/);
  });
});
