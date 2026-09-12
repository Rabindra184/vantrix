// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProjects } from '../src/api/projects.js';
import { fetchRunnerJobs, startRunnerRun } from '../src/api/runner.js';
import { fetchProjectTests } from '../src/api/tests.js';
import NewRunnerRun from '../src/routes/NewRunnerRun.js';

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

const fetchProjectsMock = vi.mocked(fetchProjects);
const fetchProjectTestsMock = vi.mocked(fetchProjectTests);
const fetchRunnerJobsMock = vi.mocked(fetchRunnerJobs);
const startRunnerRunMock = vi.mocked(startRunnerRun);

afterEach(() => {
  cleanup();
  fetchProjectsMock.mockClear();
  fetchProjectTestsMock.mockClear();
  fetchRunnerJobsMock.mockClear();
  startRunnerRunMock.mockClear();
});

describe('NewRunnerRun', () => {
  it('does not reuse form or artifact state after project navigation', async () => {
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

    const alphaName = await screen.findByLabelText(/run name/i);
    fireEvent.change(alphaName, { target: { value: 'alpha metadata' } });
    fireEvent.change(screen.getByLabelText(/simulation class/i), { target: { value: 'example.AlphaSimulation' } });
    fireEvent.change(screen.getByLabelText(/artifact file/i), {
      target: { files: [new File(['alpha'], 'alpha.jar', { type: 'application/java-archive' })] },
    });
    // TWICE now, deliberately: the upload control names the chosen file and
    // the review group (M16's third section) reads back what will be sent. The
    // assertion names the review, because that is the new claim — an
    // unscoped `getByText` resolves two elements and fails.
    expect(
      within(screen.getByTestId('review-summary')).getByText(/alpha\.jar/i),
    ).not.toBeNull();

    await act(async () => {
      await router.navigate('/projects/beta/run/new');
    });

    expect(await screen.findByText('Beta')).not.toBeNull();
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

  /** Everything a queue needs except the test, which each case supplies. */
  function fillRequired() {
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
    mount();
    await screen.findByLabelText(/run name/i);
    fillRequired();
    queue();

    await screen.findByText(/run queued/i);
    // NOT `test: ''`. The server's grammar rejects an empty slug — correctly,
    // it names nothing — so a form that always sent the field would refuse
    // every run where the user simply left it alone.
    expect(startRunnerRunMock.mock.calls[0]?.[0]?.metadata).not.toHaveProperty('test');
  });

  it('sends the slug of an existing test when one is picked', async () => {
    mount();
    await screen.findByLabelText(/run name/i);
    // The option is named for the reader — the test's NAME — while the value
    // that travels is its slug. A picker that sent the display name would be
    // refused by `DeclaredTestSlugSchema`, which is the point of not
    // slugifying anything here.
    const picker = await screen.findByLabelText('Test');
    fireEvent.change(picker, { target: { value: 'checkout-soak' } });
    fillRequired();
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
    mount();
    const picker = await screen.findByLabelText('Test');
    expect(screen.queryByLabelText(/new test slug/i)).toBeNull();

    fireEvent.change(picker, { target: { value: '__new__' } });
    const slug = screen.getByLabelText(/new test slug/i);
    fireEvent.change(slug, { target: { value: 'nightly-smoke' } });

    fillRequired();
    queue();
    await screen.findByText(/run queued/i);
    expect(startRunnerRunMock.mock.calls[0]?.[0]?.metadata).toMatchObject({
      test: 'nightly-smoke',
    });
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
    fetchProjectTestsMock.mockRejectedValueOnce(new Error('tests unavailable'));
    mount();
    await screen.findByLabelText(/run name/i);

    const typed = await screen.findByPlaceholderText('checkout-soak');
    fireEvent.change(typed, { target: { value: 'checkout-soak' } });
    fillRequired();
    queue();

    await screen.findByText(/run queued/i);
    expect(startRunnerRunMock.mock.calls[0]?.[0]?.metadata).toMatchObject({
      test: 'checkout-soak',
    });
  });
});

/* ======================================================================== *
 * THE REVIEW GROUP, AND THE PANEL THAT REPLACED "NODE POLICY"
 * ======================================================================== */

describe('NewRunnerRun — what will be sent, and what is known about the node', () => {
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
   * THE SUMMARY ECHOES, IT DOES NOT INTERPRET.
   *
   * The review asks to summarise target and load "when the artifact contract
   * exposes them" and not to assume every simulation uses the same properties.
   * A Gatling jar exposes its simulations and its version and nothing about
   * what any of them READS, so there is no honest "target" or "load" to show —
   * what there is, is the exact `-D` set the author typed.
   */
  it('reads back the system properties as they will be passed, without naming them', async () => {
    mount();
    await screen.findByLabelText(/run name/i);
    fireEvent.change(screen.getByLabelText(/system properties/i), {
      target: { value: 'baseUrl=https://svc.internal\nvirtualUsers=250' },
    });

    const summary = screen.getByTestId('review-summary');
    expect(within(summary).getByText('-DbaseUrl=https://svc.internal')).toBeDefined();
    expect(within(summary).getByText('-DvirtualUsers=250')).toBeDefined();
    // Neither is labelled as a target or a load: this product does not know
    // which properties a given simulation reads, and saying so is the point.
    expect(summary.textContent ?? '').not.toMatch(/target|load/i);
    expect(summary.textContent ?? '').toMatch(/does not interpret them/i);
  });

  /** A malformed line is shown where it was typed, before the submit refuses
   *  it — the summary is the only place a `key=value` mistake is visible while
   *  it can still be fixed cheaply. */
  it('says which line is malformed rather than waiting for the submit', async () => {
    mount();
    await screen.findByLabelText(/run name/i);
    fireEvent.change(screen.getByLabelText(/system properties/i), {
      target: { value: 'this line has no equals sign' },
    });
    expect(within(screen.getByTestId('review-summary')).getByText(/must be key=value/i)).toBeDefined();
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
    const status = await screen.findByTestId('runner-status');
    expect(status.textContent ?? '').toMatch(/no runner seen yet/i);
    expect(status.textContent ?? '').not.toMatch(/available|online/i);
    // And it says where the claim comes from, so nobody reads it as health.
    expect(status.textContent ?? '').toMatch(/inferred from the jobs/i);
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
});
