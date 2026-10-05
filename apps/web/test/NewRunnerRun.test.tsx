// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RunnerStartByPackageRequestSchema,
  type Package,
  type PackageListResponse,
  type RunnerJobListResponse,
  type RunnerStartByPackageRequest,
} from '@perfportal/contracts';
import { ProblemError } from '../src/api/fetch.js';
import { fetchPackages, packagesQueryKey } from '../src/api/packages.js';
import { fetchProjects } from '../src/api/projects.js';
import {
  cancelRunnerJob,
  fetchRunnerJobs,
  retryRunnerJob,
  startRunnerRun,
  startRunnerRunFromPackage,
} from '../src/api/runner.js';
import { fetchProjectTests } from '../src/api/tests.js';
import NewRunnerRun from '../src/routes/NewRunnerRun.js';

/** An element's accessible description, read off `aria-describedby`. This
 *  file does not load jest-dom's matchers, so `toHaveAccessibleDescription`
 *  is an "Invalid Chai property" here rather than an assertion. */
const descriptionOf = (element: Element): string =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

vi.mock('../src/api/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/projects.js')>()),
  fetchProjects: vi.fn(async () => ({
    items: [
      { id: '00000000-0000-4000-8000-0000000000a1', slug: 'alpha', name: 'Alpha', latestRun: null },
      { id: '00000000-0000-4000-8000-0000000000b2', slug: 'beta', name: 'Beta', latestRun: null },
    ],
  })),
}));

vi.mock('../src/api/runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/runner.js')>()),
  fetchRunnerJobs: vi.fn(async () => ({ items: [] })),
  // The jobs table's two actions. Each case that clicks one says what it
  // answers; left unconfigured they resolve to nothing, which no case reads.
  retryRunnerJob: vi.fn(),
  cancelRunnerJob: vi.fn(),
  startRunnerRun: vi.fn(async ({ metadata }) => ({
    artifact: {
      id: '00000000-0000-4000-8000-0000000000c3',
      name: metadata.name,
      filename: 'beta.jar',
      kind: metadata.artifactKind,
      simulationClass: metadata.simulationClass,
      gatlingVersion: null,
      sha256: 'sha',
      bytes: 1,
      createdAt: new Date('2026-08-20T00:00:00.000Z').toISOString(),
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
      javaOptions: null,
      systemProperties: {},
      error: null,
      createdAt: new Date('2026-08-20T00:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-08-20T00:00:00.000Z').toISOString(),
    },
    next: { reportUrl: null, runner: 'queued' },
  })),
  startRunnerRunFromPackage: vi.fn(async (_slug: string, request: RunnerStartByPackageRequest) => ({
    artifact: {
      id: '00000000-0000-4000-8000-0000000000c3',
      name: request.name,
      filename: 'gatling-gradle-plugin-demo-kotlin-main-tests.jar',
      kind: 'gatling_jar',
      simulationClass: request.simulationClass,
      gatlingVersion: '3.15.1',
      sha256: 'sha',
      bytes: 1_887_437,
      createdAt: new Date('2026-08-20T00:00:00.000Z').toISOString(),
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
      createdAt: new Date('2026-08-20T00:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-08-20T00:00:00.000Z').toISOString(),
    },
    next: { reportUrl: null, runner: 'queued' },
  })),
}));

/**
 * The PACKAGE PICKER reads this — a run starts from one of the project's
 * packages, and uploading a jar is the last option rather than the form.
 *
 * Mocked with a default that RETURNS packages, so the form opens in package
 * mode, and every case that types a simulation class or attaches a file says
 * `noPackages()` out loud. Left to fail, the query would error and the form
 * would open on the upload fields: the old cases would pass while testing the
 * fallback instead of the feature, which is the trap the test picker's mock
 * below records. And the default is installed in a top-level `beforeEach`, not
 * in this factory, because a factory is hoisted above every declaration and
 * cannot read the fixtures — and because a case that replaces it must not leak
 * into the next one.
 */
vi.mock('../src/api/packages.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/packages.js')>()),
  fetchPackages: vi.fn(),
}));

/**
 * The test PICKER reads this — review M16 replaced a free-text slug with a
 * choice between this project's existing tests and an explicit "create one".
 *
 * Mocked rather than left to fail, and the difference matters: unmocked, the
 * query errors and the picker DEGRADES to the typed field it replaced, which
 * still carries the `checkout-soak` placeholder the old cases typed into. The
 * suite would have gone on passing while testing the fallback path instead of
 * the control that replaced it — the "malformed fixture exercises the
 * fallback" trap CLAUDE.md records, met from the other direction.
 */
vi.mock('../src/api/tests.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/tests.js')>()),
  fetchProjectTests: vi.fn(async () => ({
    tests: [
      {
        id: '00000000-0000-4000-8000-0000000000e5',
        slug: 'checkout-soak',
        name: 'Checkout soak',
        simulationClass: 'example.AlphaSimulation',
        runs: 4,
        latestRun: null,
      },
    ],
  })),
}));

const CHECKOUT_ID = '00000000-0000-4000-8000-0000000000f1';
const EMPTY_ID = '00000000-0000-4000-8000-0000000000f2';
const SEARCH_ID = '00000000-0000-4000-8000-0000000000f3';

const CHECKOUT_FILE = 'gatling-gradle-plugin-demo-kotlin-main-tests.jar';

/** The line the form draws when `?package=` names a package it cannot offer. */
const IGNORED_LINK =
  'The package in this link has no file to run, or is not in this project. Choose one below.';

function packageOf(id: string, name: string, current: Package['current']): Package {
  return {
    id,
    name,
    kind: 'gatling_jar',
    createdAt: '2026-09-20T08:00:00.000Z',
    updatedAt: '2026-10-01T09:30:00.000Z',
    current,
    usage: { tests: 0, runs: 0, activeJobs: 0 },
  };
}

function versionOf(
  filename: string,
  bytes: number,
  gatlingVersion: string | null,
  simulations: readonly string[] | null,
): NonNullable<Package['current']> {
  return {
    artifactId: '00000000-0000-4000-8000-0000000000a9',
    filename,
    bytes,
    sha256: 'sha',
    gatlingVersion,
    simulations: simulations === null ? null : [...simulations],
    uploadedAt: '2026-10-01T09:30:00.000Z',
  };
}

/** A jar that declares two simulations. 1,887,437 bytes reads `1.8 MB`. */
const CHECKOUT = packageOf(
  CHECKOUT_ID,
  'Checkout',
  versionOf(CHECKOUT_FILE, 1_887_437, '3.15.1', ['example.BasicSimulation', 'example.Other']),
);
/** A package with no file yet: nothing to run, so nothing to offer. */
const EMPTY = packageOf(EMPTY_ID, 'Empty', null);
/** A bundle has no manifest to read, so its simulations are UNKNOWN — never `[]`. */
const SEARCH = packageOf(SEARCH_ID, 'Search', versionOf('search-bundle.zip', 4096, null, null));

const fetchPackagesMock = vi.mocked(fetchPackages);
const fetchProjectsMock = vi.mocked(fetchProjects);
const fetchProjectTestsMock = vi.mocked(fetchProjectTests);
const fetchRunnerJobsMock = vi.mocked(fetchRunnerJobs);
const startRunnerRunMock = vi.mocked(startRunnerRun);
const startRunnerRunFromPackageMock = vi.mocked(startRunnerRunFromPackage);
const retryRunnerJobMock = vi.mocked(retryRunnerJob);
const cancelRunnerJobMock = vi.mocked(cancelRunnerJob);

/** The project's packages for the next mount. */
const servePackages = (...items: readonly Package[]) =>
  fetchPackagesMock.mockImplementation(async () => ({ items: [...items] }));
/** A project with no packages at all: the form opens on the upload fields. */
const noPackages = () => servePackages();

beforeEach(() => {
  // RESET, not just re-install: a `...Once` a case queued and never consumed —
  // which is exactly what a case that FAILS before its call leaves behind —
  // would otherwise answer the NEXT case's first call, and one failure would
  // read as several. `mockReset` puts the factory's own implementation back.
  fetchPackagesMock.mockReset();
  fetchRunnerJobsMock.mockReset();
  startRunnerRunMock.mockReset();
  startRunnerRunFromPackageMock.mockReset();
  retryRunnerJobMock.mockReset();
  cancelRunnerJobMock.mockReset();
  servePackages(CHECKOUT, EMPTY);
});

afterEach(() => {
  cleanup();
  fetchPackagesMock.mockClear();
  fetchProjectsMock.mockClear();
  fetchProjectTestsMock.mockClear();
  fetchRunnerJobsMock.mockClear();
  startRunnerRunMock.mockClear();
  startRunnerRunFromPackageMock.mockClear();
});

describe('NewRunnerRun', () => {
  it('does not reuse form or artifact state after project navigation', async () => {
    // Typing a class and attaching a file are UPLOAD-mode acts.
    noPackages();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const router = createMemoryRouter(
      [{ path: '/projects/:slug/run/new', element: <NewRunnerRun /> }],
      { initialEntries: ['/projects/alpha/run/new'] },
    );

    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // The upload fields exist once the packages list has settled, empty.
    await screen.findByLabelText(/artifact file/i);
    const alphaName = screen.getByLabelText(/run name/i);
    fireEvent.change(alphaName, { target: { value: 'alpha metadata' } });
    fireEvent.change(screen.getByLabelText(/simulation class/i), { target: { value: 'example.AlphaSimulation' } });
    fireEvent.change(screen.getByLabelText(/artifact file/i), {
      target: { files: [new File(['alpha'], 'alpha.jar', { type: 'application/java-archive' })] },
    });
    // Once, on the upload control: the Review group that read it back a second
    // time is gone (clean UI PR 4 — the form is its own review).
    expect(screen.getByText(/alpha\.jar/i)).not.toBeNull();

    await act(async () => {
      await router.navigate('/projects/beta/run/new');
    });

    expect(await screen.findByText('Beta')).not.toBeNull();
    // Beta's own packages query has to settle before its fields exist.
    await screen.findByLabelText(/artifact file/i);
    expect((screen.getByLabelText(/run name/i) as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/no artifact selected/i)).not.toBeNull();

    fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: 'beta metadata' } });
    fireEvent.change(screen.getByLabelText(/simulation class/i), { target: { value: 'example.BetaSimulation' } });
    const betaFile = new File(['beta'], 'beta.jar', { type: 'application/java-archive' });
    fireEvent.change(screen.getByLabelText(/artifact file/i), {
      target: { files: [betaFile] },
    });
    fireEvent.click(screen.getByRole('button', { name: /queue run/i }));

    await screen.findByText(/run queued/i);
    expect(startRunnerRunMock).toHaveBeenCalledWith({
      projectSlug: 'beta',
      artifact: betaFile,
      metadata: {
        name: 'beta metadata',
        artifactKind: 'gatling_jar',
        simulationClass: 'example.BetaSimulation',
        systemProperties: {},
      },
    });
  });

  /**
   * ═══ THE FOURTH SUBMIT PATH, NOW CHOSEN RATHER THAN SPELLED ═══
   *
   * `metadata.test` reached the bundle upload, the live open and the Gradle
   * plugin, and missed this form — the one with a UI in front of it. So a
   * simulation started here was stuck grouping by its class while the same
   * simulation submitted another way could be two tests.
   *
   * It was a free-text slug, and review M16's objection is exact: a typo
   * "can silently create a different test when mistyped". No validation can
   * catch that — an unknown slug is how a test is CREATED, so
   * `checkout-soack` is as legal as `checkout-soak` and both succeed. Only
   * the control can, by making picking and creating two different acts.
   *
   * The three cases below are the three things the picker can produce, and
   * the first is still the ordinary one: nothing sent at all.
   */
  function mount(entry = '/projects/alpha/run/new') {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const router = createMemoryRouter(
      [{ path: '/projects/:slug/run/new', element: <NewRunnerRun /> }],
      { initialEntries: [entry] },
    );
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return router;
  }

  /** Everything a queue needs except the test, which each case supplies. UPLOAD
   *  mode: the class is typed and the file attached, so the cases that use it
   *  say `noPackages()` first. Async because those fields exist only once the
   *  packages query has settled. */
  async function fillRequired() {
    await screen.findByLabelText(/artifact file/i);
    fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: 'soak' } });
    fireEvent.change(screen.getByLabelText(/simulation class/i), {
      target: { value: 'example.AlphaSimulation' },
    });
    fireEvent.change(screen.getByLabelText(/artifact file/i), {
      target: { files: [new File(['x'], 'x.jar', { type: 'application/java-archive' })] },
    });
  }

  const queue = () => fireEvent.click(screen.getByRole('button', { name: /queue run/i }));

  it('omits the test entirely when the default grouping is kept', async () => {
    noPackages();
    mount();
    await screen.findByLabelText(/run name/i);
    await fillRequired();
    queue();

    await screen.findByText(/run queued/i);
    // NOT `test: ''`. The server's grammar rejects an empty slug — correctly,
    // it names nothing — so a form that always sent the field would refuse
    // every run where the user simply left it alone.
    //
    // ═══ ASSERTED ON THE WIRE, NOT ON THE OBJECT ═══
    //
    // This read `expect(metadata).not.toHaveProperty('test')`, which is a
    // claim about the object the form BUILDS, as a stand-in for the payload
    // the server RECEIVES. The two are not the same thing: `startRunnerRun`
    // sends `JSON.stringify(metadata)` (`api/runner.ts`), and stringify drops
    // an undefined value — so `{ test: undefined }` and a missing key are
    // byte-identical on the wire, and nothing in that module ever inspects
    // the keys.
    //
    // The distinction stopped being academic when the field moved from
    // `...(x ? { test: x } : {})` to a named `test: x || undefined`, which
    // closes a real hole in type checking (see `eslint.config.js`) and makes
    // the key PRESENT. Serialising here asserts what the server actually
    // gets, which is what the paragraph above is about — and it still fails
    // loudly on the regression it was written for, `test: ''`.
    const sent = JSON.parse(
      JSON.stringify(startRunnerRunMock.mock.calls[0]?.[0]?.metadata ?? {}),
    ) as Record<string, unknown>;
    expect(sent).not.toHaveProperty('test');
  });

  it('sends the slug of an existing test when one is picked', async () => {
    noPackages();
    mount();
    await screen.findByLabelText(/run name/i);
    // The option is named for the reader — the test's NAME — while the value
    // that travels is its slug. A picker that sent the display name would be
    // refused by `DeclaredTestSlugSchema`, which is the point of not
    // slugifying anything here.
    const picker = await screen.findByLabelText('Test');
    fireEvent.change(picker, { target: { value: 'checkout-soak' } });
    await fillRequired();
    queue();

    await screen.findByText(/run queued/i);
    expect(startRunnerRunMock.mock.calls[0]?.[0]?.metadata).toMatchObject({
      test: 'checkout-soak',
    });
  });

  /**
   * CREATING IS A SEPARATE ACT, and the assertion that matters is the one
   * about the field NOT being there until it is chosen. A form that always
   * showed the slug box beside the picker would be the old free-text field
   * with a dropdown next to it.
   */
  it('reveals a slug field only when creating a test, and sends what was typed', async () => {
    noPackages();
    mount();
    const picker = await screen.findByLabelText('Test');
    expect(screen.queryByLabelText(/^new test slug/i)).toBeNull();

    fireEvent.change(picker, { target: { value: '__new__' } });
    const slug = screen.getByLabelText(/^new test slug/i);
    fireEvent.change(slug, { target: { value: 'nightly-smoke' } });

    await fillRequired();
    queue();
    await screen.findByText(/run queued/i);
    expect(startRunnerRunMock.mock.calls[0]?.[0]?.metadata).toMatchObject({
      test: 'nightly-smoke',
    });
  });

  /**
   * FINAL REVIEW, IMPORTANT 2: THE SLUG RULE MOVED BEHIND THE ⓘ, SO THE
   * FIELD CHECKS IT. "Lower case, hyphens, no spaces" was visible under the
   * field; behind the ⓘ, a reader who types "Checkout Soak" learned it only
   * from the server after Queue run. The field checks the shared
   * `DeclaredTestSlugSchema` as it is typed — the treatment System properties
   * got — on both slug fields.
   */
  it('checks a new test slug as it is typed', async () => {
    noPackages();
    mount();
    fireEvent.change(await screen.findByLabelText('Test'), { target: { value: '__new__' } });
    const slug = screen.getByLabelText(/^new test slug/i);

    fireEvent.change(slug, { target: { value: 'Checkout Soak' } });
    expect(descriptionOf(slug)).toMatch(/lower-case letters, digits and single hyphens/);
    expect(slug.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById('runner-test-new-error')?.closest('[hidden]')).toBeNull();

    fireEvent.change(slug, { target: { value: 'checkout-soak' } });
    expect(document.getElementById('runner-test-new-error')).toBeNull();
    expect(slug.hasAttribute('aria-invalid')).toBe(false);
  });

  it('checks the typed slug the same way when the tests list cannot load', async () => {
    noPackages();
    fetchProjectTestsMock.mockRejectedValueOnce(new Error('tests unavailable'));
    mount();
    const typed = await screen.findByPlaceholderText('checkout-soak');

    fireEvent.change(typed, { target: { value: 'Checkout Soak' } });
    expect(descriptionOf(typed)).toMatch(/lower-case letters, digits and single hyphens/);
    expect(typed.getAttribute('aria-invalid')).toBe('true');
    // Empty is the default grouping, not a mistake.
    fireEvent.change(typed, { target: { value: '' } });
    expect(document.getElementById('runner-test-error')).toBeNull();
  });

  /**
   * A LAUNCH FORM MUST NOT BE BLOCKED BY A DROPDOWN IT COULD NOT FILL.
   *
   * When the tests list is unavailable the picker degrades to the typed field
   * it replaced, saying why — and a run still queues. Asserting this keeps the
   * fallback honest: without it the degraded path is code nothing runs, and
   * CLAUDE.md records how easily a fixture ends up exercising a fallback by
   * accident rather than on purpose.
   */
  it('falls back to a typed slug when the tests list cannot be loaded', async () => {
    noPackages();
    fetchProjectTestsMock.mockRejectedValueOnce(new Error('tests unavailable'));
    mount();
    await screen.findByLabelText(/run name/i);

    const typed = await screen.findByPlaceholderText('checkout-soak');
    fireEvent.change(typed, { target: { value: 'checkout-soak' } });
    await fillRequired();
    queue();

    await screen.findByText(/run queued/i);
    expect(startRunnerRunMock.mock.calls[0]?.[0]?.metadata).toMatchObject({
      test: 'checkout-soak',
    });
  });

  /**
   * ═══ A MALFORMED LINE IS FLAGGED UNDER ITS FIELD (clean UI PR 4) ═══
   *
   * The Review group was the only place a `key=value` mistake showed while it
   * could still be fixed cheaply. With the group gone the message is the
   * field's own error line, tied to the textarea, and it goes once the line
   * is fixed. The submit still refuses a malformed set.
   */
  it('flags a malformed property under the field as it is typed, and still refuses it', async () => {
    noPackages();
    mount();
    await fillRequired();
    const field = screen.getByLabelText(/^system properties/i);

    fireEvent.change(field, { target: { value: 'this line has no equals sign' } });
    const message = screen.getByText(/must be key=value/i);
    expect(message.closest('[hidden]')).toBeNull();
    expect(descriptionOf(field)).toMatch(/must be key=value/i);
    expect(field.getAttribute('aria-invalid')).toBe('true');

    queue();
    expect((await screen.findByRole('alert')).textContent).toMatch(/key=value/i);
    expect(startRunnerRunMock).not.toHaveBeenCalled();

    // Fixed, the field's own line goes (the submit's alert stays until the
    // next attempt, as every refusal on this form does).
    fireEvent.change(field, { target: { value: 'a=b' } });
    expect(document.getElementById('runner-system-properties-error')).toBeNull();
    expect(descriptionOf(field)).not.toMatch(/must be key=value/i);
    expect(field.hasAttribute('aria-invalid')).toBe(false);
  });

  /**
   * ═══ THE DEGRADED TEST FIELD SAYS WHY, AND KEEPS ITS RULE BEHIND ITS ⓘ ═══
   *
   * When the tests list cannot load, the notice is the one line a reader must
   * act on — type the slug — so it is visible; the slug's format rule is the
   * hint, behind the ⓘ. Both reach the control's description.
   */
  it('says why the slug is typed when the tests list cannot load', async () => {
    noPackages();
    fetchProjectTestsMock.mockRejectedValueOnce(new Error('tests unavailable'));
    mount();
    const typed = await screen.findByPlaceholderText('checkout-soak');

    const notice = screen.getByText("Tests couldn't be loaded — type the slug.");
    expect(notice.closest('[hidden]')).toBeNull();
    expect(descriptionOf(typed)).toMatch(/Tests couldn't be loaded — type the slug\./);
    expect(descriptionOf(typed)).toMatch(/Lower case, hyphens, no spaces/);
    expect(document.getElementById('runner-test-hint')?.closest('[hidden]')).not.toBeNull();
  });
});

/* ======================================================================== *
 * WHAT THE FORM SAYS ABOUT ITS FIELDS, AND THE PANEL THAT REPLACED "NODE POLICY"
 * ======================================================================== */

describe('NewRunnerRun — what the form says about its fields, and what is known about the node', () => {
  function mount() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const router = createMemoryRouter(
      [{ path: '/projects/:slug/run/new', element: <NewRunnerRun /> }],
      { initialEntries: ['/projects/alpha/run/new'] },
    );
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return router;
  }

  /**
   * THE FIELD SAYS WHAT THE PROPERTIES ARE FOR, BEHIND ITS ⓘ (clean UI PR 4).
   *
   * The Review group read the `-D` set back with a sentence saying PerfPortal
   * does not interpret them. The textarea is its own readback; the sentence —
   * this product does not know which properties a simulation reads, and says
   * so — rides behind the field's ⓘ and stays the control's description.
   */
  it('says what the properties are for behind the field’s info', async () => {
    mount();
    await screen.findByLabelText(/run name/i);
    const tip = screen.getByRole('button', { name: 'About System properties' });
    expect(descriptionOf(tip)).toMatch(/does not interpret them/);
    expect(descriptionOf(screen.getByLabelText(/^system properties/i))).toMatch(/does not interpret them/);
  });

  /**
   * THE PANEL THAT REPLACED "NODE POLICY".
   *
   * The old card listed "Concurrency: one active job" — a fact about the
   * product, in the place an engineer looks for a fact about the machine. With
   * no runner-health endpoint to read, the replacement is inferred from this
   * project's jobs and must say so; an empty project knows nothing, and
   * "nothing" must not render as "available".
   */
  it('never claims a runner is available on no evidence', async () => {
    mount();
    // The line carries its testid while it is still "Checking…" too (one
    // element for every state, clean UI PR 4), so wait for the settled words.
    const status = await screen.findByTestId('runner-status');
    await waitFor(() => expect(status.textContent ?? '').not.toMatch(/checking/i));
    // "Runner availability unknown" — review 09-13 M12. The old headline
    // paired with a sentence asking the reader to QUEUE A LOAD TEST to find
    // out whether a node was connected.
    expect(status.textContent ?? '').toMatch(/runner availability unknown/i);
    expect(status.textContent ?? '').not.toMatch(/queue one to find out/i);
    expect(status.textContent ?? '').not.toMatch(/available|online/i);
    // And it says where the claim comes from, so nobody reads it as health —
    // behind the line's ⓘ now, as its description (clean UI PR 4).
    expect(descriptionOf(within(status).getByRole('button', { name: 'About runner status' }))).toMatch(
      /inferred from this project's jobs/i,
    );
  });

  /** The tuning fields are one click away rather than gone, and a value set
   *  there is announced on the closed summary — otherwise a JVM option typed
   *  and forgotten is invisible at the moment of launching. */
  it('collapses the advanced fields but counts what is set in them', async () => {
    mount();
    await screen.findByLabelText(/run name/i);

    const advanced = screen.getByTestId('advanced');
    expect(advanced.textContent ?? '').toMatch(/^Advanced/);
    expect(advanced.textContent ?? '').not.toMatch(/\(\d+ set\)/);

    fireEvent.change(screen.getByLabelText(/jvm options/i), { target: { value: '-Xmx2g' } });
    expect(screen.getByTestId('advanced').textContent ?? '').toMatch(/\(1 set\)/);
  });

  /* ====================================================================== *
   * REVIEW M11 — STAGED LABELS WITHOUT STAGED INTERACTION
   * ====================================================================== */

  /**
   * ═══ THE TASK WAS NAMED FOUR TIMES BEFORE A SINGLE FIELD ═══
   *
   * "New on-prem run" (the `<h1>`), "Queue a run" (the card), "Three steps:
   * what to run, how to run it, and what will be sent" (its description), then
   * "1 · Artifact / 2 · Execution / 3 · Review". One title now.
   *
   * ASSERTED ON THE HEADING OUTLINE, because that is what a repeated title
   * costs: a screen-reader user navigating by heading met the page, then met
   * it again one level down. The `<h2>` went with the card's title — `Card`
   * draws none without one — and that is right rather than incidental: the
   * form is not a second section of this page, it IS the page.
   */
  it('names the task once', async () => {
    noPackages();
    mount();
    await screen.findByLabelText(/artifact file/i);

    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([
      'New on-prem run',
    ]);
    expect(screen.queryByRole('heading', { name: /queue a run/i })).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/three steps/i);
  });

  /**
   * An ordinal promises a flow that gates step 2 behind step 1. This form has
   * always shown all three groups at once and submitted in one go, so the
   * numbers described an interaction that does not exist — the finding's own
   * words, "staged labels without staged interaction".
   *
   * The GROUPING is real and stays: `<fieldset>`/`<legend>` is what tells a
   * screen reader these eleven controls come in three parts, and M16 put them
   * in the order the decisions are made. So this asserts the legends SURVIVE
   * without their numbers, not that they are gone.
   */
  it('groups the fields without claiming they are a sequence', async () => {
    noPackages();
    mount();
    await screen.findByLabelText(/artifact file/i);

    const legends = [...document.querySelectorAll('legend')].map((l) => l.textContent?.trim());
    expect(legends).toEqual(['Package', 'Execution']);
  });

});

/* ======================================================================== *
 * STARTING FROM A PACKAGE (backlog #8)
 * ======================================================================== */

describe('NewRunnerRun — starting from a package', () => {
  /** Returns the query client, for the cases that change the list under a form
   *  that is already drawn. */
  function mount(entry = '/projects/alpha/run/new') {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const router = createMemoryRouter(
      [{ path: '/projects/:slug/run/new', element: <NewRunnerRun /> }],
      { initialEntries: [entry] },
    );
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return client;
  }

  /**
   * The Package select, once the packages list has SETTLED.
   *
   * While the query is pending the same control exists, disabled, with one
   * option — so `findByLabelText('Package')` resolves on the loading state and
   * every assertion after it would read a list that has not arrived. The last
   * option is what only a settled list has.
   */
  async function packageSelect(): Promise<HTMLSelectElement> {
    await screen.findByRole('option', { name: 'Upload a new jar…' });
    return screen.getByLabelText('Package') as HTMLSelectElement;
  }

  const optionLabels = (select: HTMLElement) =>
    within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);

  const queue = () => fireEvent.click(screen.getByRole('button', { name: /queue run/i }));
  const advanced = () => screen.getByTestId('advanced').textContent ?? '';

  const attach = (filename: string) =>
    fireEvent.change(screen.getByLabelText(/artifact file/i), {
      target: { files: [new File(['x'], filename, { type: 'application/java-archive' })] },
    });

  /* ---------------------------------------------------------------------- *
   * THE PICKER
   * ---------------------------------------------------------------------- */

  it("offers the project's packages that have a file, and an upload option last", async () => {
    servePackages(CHECKOUT, EMPTY);
    mount();

    expect(optionLabels(await packageSelect())).toEqual([
      'Checkout · gatling-gradle-plugin-demo-kotlin-main-tests.jar · 1.8 MB · Gatling 3.15.1',
      'Upload a new jar…',
    ]);
  });

  /** A bundle's manifest is not read, so it has no Gatling version — and an
   *  option reading "Gatling null" would be the schema read aloud. */
  it('leaves Gatling out of a label when the package carries no version', async () => {
    servePackages(SEARCH);
    mount();

    expect(optionLabels(await packageSelect())).toEqual([
      'Search · search-bundle.zip · 4.0 KB',
      'Upload a new jar…',
    ]);
  });

  it('opens in package mode, on the first package, with no upload fields', async () => {
    servePackages(EMPTY, CHECKOUT, SEARCH);
    mount();
    const select = await packageSelect();

    // The first package WITH A FILE — `Empty` is listed first and is skipped.
    expect(select.value).toBe(CHECKOUT_ID);
    expect(screen.queryByLabelText(/artifact file/i)).toBeNull();
    expect(screen.queryByLabelText('Artifact type')).toBeNull();
    expect(screen.queryByLabelText(/^package name\b/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose an existing package' })).toBeNull();
  });

  it("lists the chosen package's simulations as a dropdown", async () => {
    // The bundle is first, so the form opens on a package whose list is
    // unknown and CHOOSING is what makes the control a dropdown.
    servePackages(SEARCH, CHECKOUT);
    mount();
    const select = await packageSelect();
    expect(screen.getByLabelText(/simulation class/i).tagName).toBe('INPUT');

    fireEvent.change(select, { target: { value: CHECKOUT_ID } });

    const simulation = screen.getByLabelText('Simulation') as HTMLSelectElement;
    expect(simulation.tagName).toBe('SELECT');
    expect(optionLabels(simulation)).toEqual(['example.BasicSimulation', 'example.Other']);
    expect(simulation.value).toBe('example.BasicSimulation');
    expect(screen.queryByLabelText(/simulation class/i)).toBeNull();
  });

  it("selects a package's first simulation again whenever the package changes", async () => {
    servePackages(CHECKOUT, SEARCH);
    mount();
    const select = await packageSelect();
    const simulation = () => screen.getByLabelText('Simulation') as HTMLSelectElement;

    fireEvent.change(simulation(), { target: { value: 'example.Other' } });
    expect(simulation().value).toBe('example.Other');

    // Away and back: `example.Other` was the reader's choice for THAT visit.
    fireEvent.change(select, { target: { value: SEARCH_ID } });
    fireEvent.change(select, { target: { value: CHECKOUT_ID } });
    expect(simulation().value).toBe('example.BasicSimulation');
  });

  it("falls back to typing, and says why, when the package's list is unknown", async () => {
    servePackages(SEARCH);
    mount();
    await packageSelect();

    const simulation = screen.getByLabelText(/simulation class/i);
    expect(simulation.tagName).toBe('INPUT');
    const hint = "This package's simulations aren't known yet — type the class.";
    expect(screen.getByText(hint)).toBeDefined();
    // Tied to the control, so it is announced WITH it rather than read past.
    const describedBy = simulation.getAttribute('aria-describedby');
    expect(describedBy).toBe('runner-simulation-notice');
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe(hint);
  });

  it('preselects ?package=<id>', async () => {
    servePackages(CHECKOUT, SEARCH);
    mount(`/projects/alpha/run/new?package=${SEARCH_ID}`);
    const select = await packageSelect();

    // Not the first package: the default would have been Checkout.
    expect(select.value).toBe(SEARCH_ID);
    expect(screen.getByLabelText(/simulation class/i).tagName).toBe('INPUT');
  });

  /**
   * A LINK IS DATA, AND DATA CAN BE STALE. The Packages page builds
   * `?package=<id>` from a list, and by the time the link is followed the
   * package may have lost its file or gone. Either way the form must open
   * usable, on the first package it can actually run.
   */
  it.each([
    ['a package with no file', EMPTY_ID],
    ['a package this project does not have', '00000000-0000-4000-8000-0000000000ff'],
  ])('ignores ?package= naming %s and preselects the first package with a file', async (_what, id) => {
    servePackages(EMPTY, CHECKOUT, SEARCH);
    mount(`/projects/alpha/run/new?package=${id}`);
    const select = await packageSelect();

    expect(select.value).toBe(CHECKOUT_ID);
    expect(optionLabels(select)).toHaveLength(3);
    // AND SAYS SO. A silent fallback is a form ready to queue a load test of a
    // package the reader did not choose, looking just like the one they did.
    const line = screen.getByText(IGNORED_LINK);
    // Above the select, and tied to it, so it is heard where it matters.
    expect(line.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(select.getAttribute('aria-describedby')).toBe(line.id);
  });

  /** The pair of the case above: the line describes a link the form IGNORED,
   *  so a link it followed, or no link at all, must not draw it. */
  it.each([
    ['names a package the form offers', `?package=${SEARCH_ID}`],
    ['names no package at all', ''],
  ])('says nothing about the link when it %s', async (_what, query) => {
    servePackages(EMPTY, CHECKOUT, SEARCH);
    mount(`/projects/alpha/run/new${query}`);
    const select = await packageSelect();

    expect(screen.queryByText(IGNORED_LINK)).toBeNull();
    expect(select.hasAttribute('aria-describedby')).toBe(false);
  });

  /* ---------------------------------------------------------------------- *
   * THE UPLOAD FIELDS — a choice, and the fallback
   * ---------------------------------------------------------------------- */

  it('opens on the upload fields when the project has no packages', async () => {
    noPackages();
    mount();
    await screen.findByLabelText(/artifact file/i);

    expect(screen.queryByLabelText('Package')).toBeNull();
    expect(screen.getByLabelText('Artifact type')).toBeDefined();
    expect(screen.getByLabelText(/^package name\b/i)).toBeDefined();
    // Nobody to go back to.
    expect(screen.queryByRole('button', { name: 'Choose an existing package' })).toBeNull();
    // The typed field's own placeholder, and none of the package-mode hint.
    expect((screen.getByLabelText(/simulation class/i) as HTMLInputElement).placeholder).toBe(
      'example.BasicSimulation',
    );
    expect(screen.queryByText(/simulations aren't known yet/i)).toBeNull();
  });

  /**
   * THE PLACEHOLDER IS THE DEFAULT, SHOWN. Leaving `Package name` blank files
   * the upload in the package its file's name stem names, so the field says
   * which — and typing anything else is how an upload goes elsewhere, which is
   * the lever a refused upload points at (below). A client COPY of the server's
   * rule: the server's answer is the authority and this is only the preview.
   */
  it.each([
    ['checkout-load.jar', 'checkout-load'],
    ['nightly.tar.gz', 'nightly'],
    ['search-bundle.zip', 'search-bundle'],
    ['v1.2.jar', 'v1.2'],
    [`${'x'.repeat(130)}.jar`, 'x'.repeat(112)],
    // The server stores an upload under its SANITIZED name and takes the stem
    // of that: a stem read off the raw name would preview a package the start
    // never makes. The same row is in apps/api/test/package-files.test.ts.
    ['checkout (1).jar', 'checkout _1_'],
  ])('previews the package an upload of %s is filed under', async (filename, stem) => {
    noPackages();
    mount();
    await screen.findByLabelText(/artifact file/i);
    attach(filename);

    expect((screen.getByLabelText(/^package name\b/i) as HTMLInputElement).placeholder).toBe(stem);
  });

  /** `PackageNameSchema` caps a name at 120 characters and the server refuses a
   *  longer one, so the field stops short of it — as the note's textarea does
   *  for its own cap. */
  it('stops the package name at the 120 characters the server allows', async () => {
    noPackages();
    mount();
    await screen.findByLabelText(/artifact file/i);

    expect((screen.getByLabelText(/^package name\b/i) as HTMLInputElement).maxLength).toBe(120);
  });

  it('switches to the upload fields, and back, with the two controls the form offers', async () => {
    servePackages(CHECKOUT, EMPTY);
    mount();
    const select = await packageSelect();

    fireEvent.change(select, { target: { value: '__upload__' } });
    await screen.findByLabelText(/artifact file/i);
    expect(screen.queryByLabelText('Package')).toBeNull();
    expect(screen.getByLabelText('Artifact type')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Choose an existing package' }));
    expect(((await packageSelect()) as HTMLSelectElement).value).toBe(CHECKOUT_ID);
    expect(screen.queryByLabelText(/artifact file/i)).toBeNull();
  });

  /**
   * A TYPED CLASS BELONGS TO ITS SOURCE. Carrying a class typed for a bundle
   * into the upload field would pre-fill one the NEW jar may not declare — a
   * value the reader never typed for it, refused by the server a moment after a
   * click that looked like it only changed where the file comes from. Both
   * directions, one case each: the handlers are different code.
   */
  it('does not carry a class typed for a package into an upload', async () => {
    servePackages(SEARCH);
    mount();
    const select = await packageSelect();
    fireEvent.change(screen.getByLabelText(/simulation class/i), {
      target: { value: 'example.Typed' },
    });

    fireEvent.change(select, { target: { value: '__upload__' } });

    expect((screen.getByLabelText(/simulation class/i) as HTMLInputElement).value).toBe('');
  });

  it('does not carry a class typed for an upload into a package', async () => {
    servePackages(SEARCH);
    mount();
    fireEvent.change(await packageSelect(), { target: { value: '__upload__' } });
    fireEvent.change(screen.getByLabelText(/simulation class/i), {
      target: { value: 'example.Typed' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Choose an existing package' }));

    expect((screen.getByLabelText(/simulation class/i) as HTMLInputElement).value).toBe('');
  });

  /** The same rule between two packages, where it is the typed class that
   *  could leak: a bundle's class, typed, must not reappear on the bundle
   *  after a visit to a jar whose dropdown never showed it. */
  it('does not carry a typed class from one package to another', async () => {
    servePackages(SEARCH, CHECKOUT);
    mount();
    const select = await packageSelect();
    fireEvent.change(screen.getByLabelText(/simulation class/i), {
      target: { value: 'example.Typed' },
    });

    fireEvent.change(select, { target: { value: CHECKOUT_ID } });
    fireEvent.change(select, { target: { value: SEARCH_ID } });

    expect((screen.getByLabelText(/simulation class/i) as HTMLInputElement).value).toBe('');
  });

  /**
   * FOCUS FOLLOWS THE SWITCH, IN BOTH DIRECTIONS.
   *
   * Package → upload: the select the reader is on is REPLACED by a different
   * control in the same slot, and without a key React reuses the DOM node — so
   * focus stays on it, silently renamed `Artifact type`, while the file input
   * the switch just demanded sits ABOVE it in the tab order. A native select
   * fires `change` on ArrowDown, so a keyboard user reaches this by arrowing
   * past an option.
   *
   * Upload → package: the button the reader just pressed is removed, and focus
   * falls to `<body>`, so the next Tab starts from the top of the page.
   *
   * Each case focuses the control FIRST and asserts it holds focus, so it
   * cannot pass by focus having been nowhere to begin with. The file has no
   * jest-dom matchers; `document.activeElement` is compared directly.
   */
  it('moves focus to the file input when the select switches to uploading', async () => {
    servePackages(CHECKOUT);
    mount();
    const select = await packageSelect();
    select.focus();
    expect(document.activeElement).toBe(select);

    fireEvent.change(select, { target: { value: '__upload__' } });

    expect(document.activeElement).toBe(screen.getByLabelText(/artifact file/i));
  });

  /**
   * THE KEYS, PINNED ON THEIR OWN. The focus effect above would cover for a
   * missing key — it moves focus to the right place whatever node React kept —
   * so the focus cases cannot tell whether the Package select was REPLACED or
   * silently turned into `Artifact type`. A reused node carries everything else
   * with it (its state, its accessible name until the next render, a screen
   * reader's place in it); a replaced one is gone.
   */
  it('replaces the Package select with the upload controls instead of reusing its node', async () => {
    servePackages(CHECKOUT);
    mount();
    const select = await packageSelect();

    fireEvent.change(select, { target: { value: '__upload__' } });

    expect(select.isConnected).toBe(false);
    expect(screen.getByLabelText('Artifact type').isConnected).toBe(true);
  });

  it('moves focus to the Package select when the way back is taken', async () => {
    servePackages(CHECKOUT);
    mount();
    fireEvent.change(await packageSelect(), { target: { value: '__upload__' } });
    const way = screen.getByRole('button', { name: 'Choose an existing package' });
    way.focus();
    expect(document.activeElement).toBe(way);

    fireEvent.click(way);

    expect(document.activeElement).toBe(await packageSelect());
  });

  /** Nothing takes focus on its own: it moves only for a SWITCH the reader made,
   *  never when the list settles under them. */
  it('does not take focus when the form first draws', async () => {
    servePackages(CHECKOUT);
    mount();
    const select = await packageSelect();

    expect(document.activeElement).not.toBe(select);
    expect(document.activeElement).toBe(document.body);
  });

  it('asks for a Gatling version, and counts it under Advanced, only when uploading', async () => {
    servePackages(CHECKOUT);
    mount();
    const select = await packageSelect();

    expect(screen.queryByLabelText(/gatling version/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/jvm options/i), { target: { value: '-Xmx2g' } });
    expect(advanced()).toMatch(/\(1 set\)/);

    fireEvent.change(select, { target: { value: '__upload__' } });
    fireEvent.change(screen.getByLabelText(/gatling version/i), { target: { value: '3.14.0' } });
    expect(advanced()).toMatch(/\(2 set\)/);

    // Back to a package: the version describes a FILE, so it neither shows nor
    // counts — and (checked on the wire below) is not sent.
    fireEvent.click(screen.getByRole('button', { name: 'Choose an existing package' }));
    expect(screen.queryByLabelText(/gatling version/i)).toBeNull();
    expect(advanced()).toMatch(/\(1 set\)/);
  });

  it('groups the fields under the same two legends in either mode', async () => {
    servePackages(CHECKOUT);
    mount();
    const select = await packageSelect();
    const legends = () => [...document.querySelectorAll('legend')].map((l) => l.textContent?.trim());

    expect(legends()).toEqual(['Package', 'Execution']);
    fireEvent.change(select, { target: { value: '__upload__' } });
    expect(legends()).toEqual(['Package', 'Execution']);
  });

  /* ---------------------------------------------------------------------- *
   * THE LIST LOADING, AND THE LIST FAILING
   * ---------------------------------------------------------------------- */

  /**
   * NO FLASH OF UPLOAD MODE. Before the list settles the form cannot know
   * whether to open on a package or on the upload fields, and guessing
   * `upload` — the old form — and switching a moment later would put a file
   * input under a reader's pointer that vanishes as they reach for it. The
   * Package group renders its own loading state instead, the way the test
   * picker does, and a run cannot be queued from it.
   */
  it('shows the Package group loading, and no upload fields, until the list settles', async () => {
    let release: (value: PackageListResponse) => void = () => undefined;
    fetchPackagesMock.mockImplementationOnce(
      () =>
        new Promise<PackageListResponse>((resolve) => {
          release = resolve;
        }),
    );
    mount();

    const loading = (await screen.findByLabelText('Package')) as HTMLSelectElement;
    expect(loading.disabled).toBe(true);
    expect(optionLabels(loading)).toEqual(['Loading packages…']);
    expect(screen.queryByLabelText(/artifact file/i)).toBeNull();
    expect(screen.queryByLabelText(/^package name\b/i)).toBeNull();
    expect((screen.getByRole('button', { name: /queue run/i }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      release({ items: [CHECKOUT] });
    });
    const settled = await packageSelect();
    expect(settled.disabled).toBe(false);
    expect(settled.value).toBe(CHECKOUT_ID);
    expect((screen.getByRole('button', { name: /queue run/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * A LAUNCH FORM MUST NOT BE BLOCKED BY A LIST IT COULD NOT LOAD — the test
   * picker's rule, applied to the new control. The form opens on the upload
   * fields, offers no way back to a list that does not exist, and queues.
   */
  it('opens on the upload fields, with no way back, when the list cannot be loaded', async () => {
    fetchPackagesMock.mockRejectedValueOnce(new Error('packages unavailable'));
    mount();
    await screen.findByLabelText(/artifact file/i);

    expect(screen.queryByLabelText('Package')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose an existing package' })).toBeNull();

    fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: 'soak' } });
    fireEvent.change(screen.getByLabelText(/simulation class/i), {
      target: { value: 'example.AlphaSimulation' },
    });
    attach('alpha.jar');
    queue();

    await screen.findByText(/run queued/i);
    expect(startRunnerRunMock).toHaveBeenCalledTimes(1);
    expect(startRunnerRunFromPackageMock).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------------------- *
   * SUBMIT
   * ---------------------------------------------------------------------- */

  it('sends a JSON start for a package, and never the multipart upload', async () => {
    servePackages(CHECKOUT, EMPTY);
    mount();
    await packageSelect();
    fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: 'nightly' } });
    queue();

    await screen.findByText(/run queued/i);
    expect(startRunnerRunMock).not.toHaveBeenCalled();
    expect(startRunnerRunFromPackageMock).toHaveBeenCalledTimes(1);
    expect(startRunnerRunFromPackageMock).toHaveBeenCalledWith('alpha', {
      packageId: CHECKOUT_ID,
      simulationClass: 'example.BasicSimulation',
      name: 'nightly',
      systemProperties: {},
    });
  });

  /**
   * ASSERTED ON THE WIRE, and against the contract's own STRICT schema. The
   * request names a package, so `artifactKind` and `gatlingVersion` — which
   * describe a FILE — must not be on it, and a strict schema refuses an
   * unknown key where a `toHaveBeenCalledWith` would not notice one.
   */
  it('carries the run metadata, and nothing that describes a file, on a package start', async () => {
    servePackages(CHECKOUT);
    mount();
    const select = await packageSelect();

    // A Gatling version typed for an upload, then abandoned for a package.
    fireEvent.change(select, { target: { value: '__upload__' } });
    fireEvent.change(screen.getByLabelText(/gatling version/i), { target: { value: '3.14.0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose an existing package' }));

    fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: 'nightly' } });
    fireEvent.change(screen.getByLabelText(/^environment\b/i), { target: { value: 'staging' } });
    fireEvent.change(screen.getByLabelText(/^branch\b/i), { target: { value: 'main' } });
    fireEvent.change(screen.getByLabelText(/commit sha/i), { target: { value: 'abc1234' } });
    fireEvent.change(await screen.findByLabelText('Test'), { target: { value: 'checkout-soak' } });
    fireEvent.change(screen.getByLabelText(/jvm options/i), { target: { value: '-Xmx2g' } });
    fireEvent.change(screen.getByLabelText(/^system properties/i), { target: { value: 'users=5' } });
    queue();

    await screen.findByText(/run queued/i);
    const wire = JSON.parse(
      JSON.stringify(startRunnerRunFromPackageMock.mock.calls[0]?.[1] ?? {}),
    ) as Record<string, unknown>;
    expect(wire).toEqual({
      packageId: CHECKOUT_ID,
      simulationClass: 'example.BasicSimulation',
      name: 'nightly',
      environment: 'staging',
      branch: 'main',
      commitSha: 'abc1234',
      test: 'checkout-soak',
      javaOptions: '-Xmx2g',
      systemProperties: { users: '5' },
    });
    expect(RunnerStartByPackageRequestSchema.safeParse(wire).success).toBe(true);
  });

  it('omits every optional field it was not given, rather than sending an empty one', async () => {
    servePackages(CHECKOUT);
    mount();
    await packageSelect();
    fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: 'nightly' } });
    queue();

    await screen.findByText(/run queued/i);
    const wire = JSON.parse(
      JSON.stringify(startRunnerRunFromPackageMock.mock.calls[0]?.[1] ?? {}),
    ) as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual(['name', 'packageId', 'simulationClass', 'systemProperties']);
  });

  it('sends a typed simulation class when the package lists none', async () => {
    servePackages(SEARCH);
    mount();
    await packageSelect();
    fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: 'nightly' } });
    fireEvent.change(screen.getByLabelText(/simulation class/i), {
      target: { value: 'example.Typed' },
    });
    queue();

    await screen.findByText(/run queued/i);
    expect(startRunnerRunFromPackageMock.mock.calls[0]?.[1]).toMatchObject({
      packageId: SEARCH_ID,
      simulationClass: 'example.Typed',
    });
  });

  it('files an upload in the package it names, through the multipart start', async () => {
    servePackages(CHECKOUT, EMPTY);
    mount();
    const select = await packageSelect();
    fireEvent.change(select, { target: { value: '__upload__' } });

    fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: 'soak' } });
    fireEvent.change(screen.getByLabelText(/simulation class/i), {
      target: { value: 'example.AlphaSimulation' },
    });
    attach('alpha.jar');
    fireEvent.change(screen.getByLabelText(/^package name\b/i), { target: { value: 'Nightly jar' } });
    queue();

    await screen.findByText(/run queued/i);
    expect(startRunnerRunFromPackageMock).not.toHaveBeenCalled();
    expect(startRunnerRunMock.mock.calls[0]?.[0]?.metadata).toMatchObject({
      name: 'soak',
      artifactKind: 'gatling_jar',
      simulationClass: 'example.AlphaSimulation',
      package: 'Nightly jar',
    });
  });

  /**
   * AN UPLOAD MAKES A PACKAGE — or adds a version to one — so the list this
   * form drew from is stale the moment a start succeeds. Asserted on the
   * second request, not on what the form does with it: what the form does with
   * a list that changes is the next case, and one claim per case is what lets a
   * failure say which half broke.
   */
  it('asks for the packages again once a run is queued', async () => {
    noPackages();
    mount();
    await screen.findByLabelText(/artifact file/i);
    fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: 'soak' } });
    fireEvent.change(screen.getByLabelText(/simulation class/i), {
      target: { value: 'example.AlphaSimulation' },
    });
    attach('alpha.jar');
    queue();

    await screen.findByText(/run queued/i);
    await waitFor(() => expect(fetchPackagesMock).toHaveBeenCalledTimes(2));
  });

  /**
   * THE FORM MUST NOT MOVE UNDER THE READER WHEN THE LIST CHANGES. The project
   * had no package, so the form opened on the upload fields; a refresh then
   * finds one. If the mode followed the list, the file input would swap for a
   * dropdown mid-sentence. It was decided once: the fields stay, what was typed
   * stays, and the new package is offered through the way back.
   */
  it('keeps the upload fields, and what was typed, when the list gains a package', async () => {
    noPackages();
    const client = mount();
    await screen.findByLabelText(/artifact file/i);
    fireEvent.change(screen.getByLabelText(/simulation class/i), {
      target: { value: 'example.AlphaSimulation' },
    });
    expect(screen.queryByRole('button', { name: 'Choose an existing package' })).toBeNull();

    servePackages(CHECKOUT);
    await act(async () => {
      await client.invalidateQueries({ queryKey: packagesQueryKey('alpha') });
    });

    const way = await screen.findByRole('button', { name: 'Choose an existing package' });
    expect(screen.queryByLabelText('Package')).toBeNull();
    expect((screen.getByLabelText(/simulation class/i) as HTMLInputElement).value).toBe(
      'example.AlphaSimulation',
    );

    fireEvent.click(way);
    expect((await packageSelect()).value).toBe(CHECKOUT_ID);
  });

  it('names no package on an upload that typed none, leaving the stem to the server', async () => {
    noPackages();
    mount();
    await screen.findByLabelText(/artifact file/i);
    fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: 'soak' } });
    fireEvent.change(screen.getByLabelText(/simulation class/i), {
      target: { value: 'example.AlphaSimulation' },
    });
    attach('alpha.jar');
    queue();

    await screen.findByText(/run queued/i);
    const sent = JSON.parse(
      JSON.stringify(startRunnerRunMock.mock.calls[0]?.[0]?.metadata ?? {}),
    ) as Record<string, unknown>;
    expect(sent).not.toHaveProperty('package');
  });

  /**
   * THE WEB LEVER FOR A REFUSAL THE API ALREADY SENDS. `foo.jar` uploaded after
   * `foo.zip` has the same stem, `foo`, and a different KIND, so the API answers
   * 400 `PACKAGE_KIND_MISMATCH` and its remediation names the metadata's
   * `"package"` field — which, on this form, is `Package name`. The form shows
   * the refusal in its own words and the field it points at is right there,
   * already previewing the name that collided.
   */
  it('shows a refused upload in the API’s words, and lets a different name file it elsewhere', async () => {
    noPackages();
    startRunnerRunMock.mockRejectedValueOnce(
      new ProblemError(400, {
        code: 'PACKAGE_KIND_MISMATCH',
        detail: 'Package "foo" holds gatling_bundle; this upload is a gatling_jar.',
        remediation:
          'Name a package that holds gatling_jar files in the metadata\'s "package" field, or a new name to create one.',
      }),
    );
    mount();
    await screen.findByLabelText(/artifact file/i);
    fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: 'soak' } });
    fireEvent.change(screen.getByLabelText(/simulation class/i), {
      target: { value: 'example.AlphaSimulation' },
    });
    attach('foo.jar');
    queue();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Package "foo" holds gatling_bundle; this upload is a gatling_jar.');
    expect(alert.textContent).toContain('"package" field');
    // The control that remediation names is on this form, and it shows the name
    // that collided as the one it would have used.
    const field = screen.getByLabelText(/^package name\b/i) as HTMLInputElement;
    expect(field.placeholder).toBe('foo');

    fireEvent.change(field, { target: { value: 'foo-jar' } });
    queue();
    await screen.findByText(/run queued/i);
    expect(startRunnerRunMock).toHaveBeenCalledTimes(2);
    expect(startRunnerRunMock.mock.calls[1]?.[0]?.metadata).toMatchObject({ package: 'foo-jar' });
  });

  it('shows a refused package start in the API’s words too', async () => {
    startRunnerRunFromPackageMock.mockRejectedValueOnce(
      new ProblemError(404, {
        code: 'NOT_FOUND',
        detail: `No package ${CHECKOUT_ID} in this project.`,
        remediation: 'List this project’s packages with GET /v1/projects/{slug}/packages.',
      }),
    );
    servePackages(CHECKOUT);
    mount();
    await packageSelect();
    fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: 'nightly' } });
    queue();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(`No package ${CHECKOUT_ID} in this project.`);
    expect(alert.textContent).toContain('GET /v1/projects/{slug}/packages');
  });

  it('refuses an upload with no file chosen, and says so', async () => {
    servePackages(CHECKOUT);
    mount();
    const select = await packageSelect();
    fireEvent.change(select, { target: { value: '__upload__' } });
    fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: 'soak' } });
    fireEvent.change(screen.getByLabelText(/simulation class/i), {
      target: { value: 'example.AlphaSimulation' },
    });
    queue();

    expect((await screen.findByRole('alert')).textContent).toMatch(/choose the jar or bundle/i);
    expect(startRunnerRunMock).not.toHaveBeenCalled();
    expect(startRunnerRunFromPackageMock).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------------------- *
   * NO REVIEW GROUP (clean UI PR 4)
   * ---------------------------------------------------------------------- */

  /**
   * The form is its own review. The group that read every field back before
   * the button is gone: the Package select's own option already names the
   * package, its file and its size (`packageOptionLabel`), the upload's default
   * package name is that field's placeholder, and a missing required field is
   * refused where it is. What stays at the end of the form is the error alert
   * and Queue run — outside any group.
   */
  it('has no review group — the form is its own review', async () => {
    servePackages(CHECKOUT, EMPTY);
    mount();
    const select = await packageSelect();

    expect(screen.queryByTestId('review-summary')).toBeNull();
    expect(screen.getByRole('button', { name: /queue run/i }).closest('fieldset')).toBeNull();
    const chosen = select.selectedOptions[0]?.textContent ?? '';
    expect(chosen).toContain('Checkout');
    expect(chosen).toContain(CHECKOUT_FILE);
    expect(chosen).toContain('1.8 MB');
  });
});

/* ======================================================================== *
 * THE JOBS TABLE
 * ======================================================================== */

describe('NewRunnerRun — the jobs table names each job’s package', () => {
  const createdAt = '2026-08-20T00:00:00.000Z';

  function jobRow(
    id: string,
    package_: { readonly packageId?: string | null; readonly packageName?: string | null },
  ): RunnerJobListResponse['items'][number] {
    return {
      artifact: {
        id: '00000000-0000-4000-8000-0000000000c3',
        name: 'nightly',
        filename: 'checkout.jar',
        kind: 'gatling_jar',
        simulationClass: 'example.BasicSimulation',
        gatlingVersion: null,
        sha256: 'sha',
        bytes: 1,
        createdAt,
      },
      job: {
        id,
        artifactId: '00000000-0000-4000-8000-0000000000c3',
        runId: null,
        status: 'complete',
        requestedBy: 'token',
        environment: null,
        branch: null,
        commitSha: null,
        testSlug: null,
        javaOptions: null,
        systemProperties: {},
        error: null,
        createdAt,
        updatedAt: createdAt,
        ...package_,
      },
    };
  }

  /**
   * THREE ANSWERS, AND TWO OF THEM LOOK ALIKE. A job's package is its name; or
   * NULL once the package was deleted (the job stays, the package does not),
   * which is a fact worth saying; or ABSENT when the API is a pod that predates
   * packages, which says nothing and must not claim a deletion.
   */
  it('reads the package’s name, or that it was deleted, or nothing when the API did not say', async () => {
    fetchRunnerJobsMock.mockResolvedValueOnce({
      items: [
        jobRow('00000000-0000-4000-8000-000000000d01', { packageId: CHECKOUT_ID, packageName: 'Checkout' }),
        jobRow('00000000-0000-4000-8000-000000000d02', { packageId: null, packageName: null }),
        jobRow('00000000-0000-4000-8000-000000000d03', {}),
      ],
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const router = createMemoryRouter(
      [{ path: '/projects/:slug/run/new', element: <NewRunnerRun /> }],
      { initialEntries: ['/projects/alpha/run/new'] },
    );
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Created',
      'Package',
      'Artifact',
      'Simulation',
      'Status',
      'Report',
      'Actions',
    ]);
    const [, ...rows] = within(table).getAllByRole('row');
    const packageCells = rows.map((row) => within(row).getAllByRole('cell')[1]?.textContent);
    expect(packageCells).toEqual(['Checkout', 'Package deleted', '—']);
    // The artifact column keeps the filename.
    expect(within(rows[0] as HTMLElement).getAllByRole('cell')[2]?.textContent).toBe('checkout.jar');
  });

  /** `jobRow` with a status of its own — the actions a row offers follow it. */
  function jobIn(
    status: RunnerJobListResponse['items'][number]['job']['status'],
    id: string,
    package_: { readonly packageId?: string | null; readonly packageName?: string | null },
  ): RunnerJobListResponse['items'][number] {
    const row = jobRow(id, package_);
    return { ...row, job: { ...row.job, status } };
  }

  /** Draws the page with `items` as the jobs list — persistently, not once: an
   *  active job makes the table poll, and a second answer of "no jobs" would
   *  take the row, and anything drawn in it, off the screen mid-case. */
  async function mountJobs(items: RunnerJobListResponse['items']): Promise<HTMLElement[]> {
    fetchRunnerJobsMock.mockResolvedValue({ items });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const router = createMemoryRouter(
      [{ path: '/projects/:slug/run/new', element: <NewRunnerRun /> }],
      { initialEntries: ['/projects/alpha/run/new'] },
    );
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const table = await screen.findByRole('table');
    const [, ...rows] = within(table).getAllByRole('row');
    return rows;
  }

  const ACTIONS = 6;
  const actionsOf = (row: HTMLElement): HTMLElement => {
    const cell = within(row).getAllByRole('cell')[ACTIONS];
    if (cell === undefined) throw new Error('the row has no Actions cell');
    return cell;
  };

  /**
   * ═══ RETRY ON A JOB WHOSE PACKAGE WAS DELETED COULD ONLY BE REFUSED ═══
   *
   * The server answers 409 PACKAGE_DELETED for it, every time, and the row
   * already says why one column over. So the button is not drawn — and only for
   * a STRICT null: a job from a pod that predates packages carries no
   * `packageId` at all, which says nothing about a deletion, and keeps its
   * Retry. Three rows, so a loose `!= null` (which would take that third Retry
   * too) fails here as surely as an unconditional button does.
   */
  it('offers no Retry for a job whose package was deleted, and keeps it otherwise', async () => {
    const rows = await mountJobs([
      jobIn('failed', '00000000-0000-4000-8000-000000000e01', { packageId: null, packageName: null }),
      jobIn('failed', '00000000-0000-4000-8000-000000000e02', { packageId: CHECKOUT_ID, packageName: 'Checkout' }),
      jobIn('cancelled', '00000000-0000-4000-8000-000000000e03', {}),
    ]);

    const [deleted, kept, older] = rows.map(actionsOf);
    expect(within(rows[0] as HTMLElement).getAllByRole('cell')[1]?.textContent).toBe('Package deleted');
    expect(within(deleted as HTMLElement).queryByRole('button', { name: /retry/i })).toBeNull();
    // Still a row with an action: its logs are as readable as any other's.
    expect(within(deleted as HTMLElement).getByRole('button', { name: 'Logs' })).toBeDefined();
    expect(within(kept as HTMLElement).getByRole('button', { name: /retry/i })).toBeDefined();
    expect(within(older as HTMLElement).getByRole('button', { name: /retry/i })).toBeDefined();
    // Nothing has been refused, so nothing is announced: a table of N jobs
    // carries no live region until there is something to say.
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('shows a refused retry in the API’s words, on the row it was asked for', async () => {
    retryRunnerJobMock.mockRejectedValue(
      new ProblemError(409, {
        code: 'PACKAGE_DELETED',
        detail: 'The package this job ran was deleted, so it cannot run again.',
        remediation: 'Start a new run from a package with POST /v1/projects/{slug}/runner/runs.',
      }),
    );
    const rows = await mountJobs([
      jobIn('failed', '00000000-0000-4000-8000-000000000e11', { packageId: CHECKOUT_ID, packageName: 'Checkout' }),
      jobIn('failed', '00000000-0000-4000-8000-000000000e12', { packageId: SEARCH_ID, packageName: 'Search' }),
    ]);
    const [first, second] = rows.map(actionsOf) as [HTMLElement, HTMLElement];

    fireEvent.click(within(second).getByRole('button', { name: /retry/i }));

    const alert = await within(second).findByRole('alert');
    expect(retryRunnerJobMock).toHaveBeenCalledWith('alpha', '00000000-0000-4000-8000-000000000e12');
    expect(alert.textContent).toContain('This job could not be retried.');
    expect(alert.textContent).toContain('The package this job ran was deleted, so it cannot run again.');
    expect(alert.textContent).toContain('Start a new run from a package with POST /v1/projects/{slug}/runner/runs.');
    // On the row that asked, and no other: one refusal, one alert.
    expect(within(first).queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('shows a refused cancel in the API’s words, on the row it was asked for', async () => {
    cancelRunnerJobMock.mockRejectedValue(
      new ProblemError(404, {
        code: 'NOT_FOUND',
        detail: 'No cancellable runner job 00000000-0000-4000-8000-000000000e22 in this project.',
        remediation:
          'Only a queued or running job can be cancelled. GET /v1/projects/{slug}/runner/runs lists this project’s jobs with their status.',
      }),
    );
    const rows = await mountJobs([
      jobIn('running', '00000000-0000-4000-8000-000000000e21', { packageId: CHECKOUT_ID, packageName: 'Checkout' }),
      jobIn('queued', '00000000-0000-4000-8000-000000000e22', { packageId: CHECKOUT_ID, packageName: 'Checkout' }),
    ]);
    const [first, second] = rows.map(actionsOf) as [HTMLElement, HTMLElement];

    fireEvent.click(within(second).getByRole('button', { name: /cancel/i }));

    const alert = await within(second).findByRole('alert');
    expect(cancelRunnerJobMock).toHaveBeenCalledWith('alpha', '00000000-0000-4000-8000-000000000e22');
    expect(alert.textContent).toContain('This job could not be cancelled.');
    expect(alert.textContent).toContain('No cancellable runner job 00000000-0000-4000-8000-000000000e22 in this project.');
    expect(alert.textContent).toContain('Only a queued or running job can be cancelled.');
    expect(within(first).queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
