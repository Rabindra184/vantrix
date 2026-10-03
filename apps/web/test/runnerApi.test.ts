import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerStartByPackageRequest, RunnerStartResponse } from '@perfportal/contracts';
import { ProblemError } from '../src/api/fetch';
import { startRunnerRunFromPackage } from '../src/api/runner';

/**
 * The package start, below the form.
 *
 * `NewRunnerRun.test.tsx` mocks `startRunnerRunFromPackage`, so everything it
 * proves is about what the form SENDS to it. What it cannot see is whether the
 * request that function makes is the one the route reads: one route takes two
 * shapes, and the `Content-Type` is what chooses between "start from this
 * package" and "here is a file". A body posted without it would be read as a
 * multipart upload and refused with a sentence about a missing boundary — a
 * failure no page test could produce.
 */

const PACKAGE_ID = '00000000-0000-4000-8000-0000000000f1';

const REQUEST: RunnerStartByPackageRequest = {
  packageId: PACKAGE_ID,
  simulationClass: 'example.BasicSimulation',
  name: 'nightly',
  systemProperties: {},
};

const STARTED: RunnerStartResponse = {
  artifact: {
    id: '00000000-0000-4000-8000-0000000000c3',
    name: 'nightly',
    filename: 'checkout.jar',
    kind: 'gatling_jar',
    simulationClass: 'example.BasicSimulation',
    gatlingVersion: '3.15.1',
    sha256: 'sha',
    bytes: 1,
    createdAt: '2026-08-20T00:00:00.000Z',
  },
  job: {
    id: '00000000-0000-4000-8000-0000000000d4',
    artifactId: '00000000-0000-4000-8000-0000000000c3',
    runId: null,
    status: 'queued',
    requestedBy: 'token',
    environment: null,
    branch: null,
    commitSha: null,
    testSlug: null,
    javaOptions: null,
    systemProperties: {},
    error: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  },
  next: { reportUrl: null, runner: 'queued' },
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('startRunnerRunFromPackage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(json(201, STARTED)));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('POSTs the request as JSON to the same route the upload uses, and parses the answer', async () => {
    const started = await startRunnerRunFromPackage('checkout', REQUEST);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/v1/projects/checkout/runner/runs');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    // A string, not a FormData: the route reads `application/json` as "start
    // from this package", and a multipart body as an upload.
    expect(JSON.parse(init.body as string)).toEqual(REQUEST);
    expect(started.job.id).toBe(STARTED.job.id);
  });

  it('encodes the slug, because it is data', async () => {
    await startRunnerRunFromPackage('a/b c', REQUEST);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/projects/a%2Fb%20c/runner/runs');
  });

  it('raises the API’s own refusal as a ProblemError, remediation and all', async () => {
    fetchMock.mockResolvedValueOnce(
      json(404, {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'NOT_FOUND',
        detail: `No package ${PACKAGE_ID} in this project.`,
        remediation: 'List this project’s packages with GET /v1/projects/{slug}/packages.',
      }),
    );

    const failure = await startRunnerRunFromPackage('checkout', REQUEST).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ProblemError);
    expect((failure as ProblemError).detail).toBe(`No package ${PACKAGE_ID} in this project.`);
    expect((failure as ProblemError).remediation).toContain('GET /v1/projects/{slug}/packages');
  });
});
