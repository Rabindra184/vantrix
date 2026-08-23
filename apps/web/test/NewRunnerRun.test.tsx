// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProjects } from '../src/api/projects.js';
import { fetchRunnerJobs, startRunnerRun } from '../src/api/runner.js';
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

const fetchProjectsMock = vi.mocked(fetchProjects);
const fetchRunnerJobsMock = vi.mocked(fetchRunnerJobs);
const startRunnerRunMock = vi.mocked(startRunnerRun);

afterEach(() => {
  cleanup();
  fetchProjectsMock.mockClear();
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
    expect(screen.getByText(/alpha\.jar/i)).not.toBeNull();

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
   * ═══ THE FOURTH SUBMIT PATH ═══
   *
   * `metadata.test` reached the bundle upload, the live open and the Gradle
   * plugin, and missed this form — the one with a UI in front of it. So a
   * simulation started here was stuck grouping by its class while the same
   * simulation submitted another way could be two tests.
   *
   * OMITTED WHEN EMPTY, not sent as `''`. The server's grammar rejects an
   * empty slug (correctly — it names nothing), so a form that always sent the
   * field would refuse every run where the user simply left it blank, which is
   * the ordinary case.
   */
  it('sends a declared test only when one was typed', async () => {
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

    const fill = (test?: string) => {
      fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: 'soak' } });
      fireEvent.change(screen.getByLabelText(/simulation class/i), {
        target: { value: 'example.AlphaSimulation' },
      });
      fireEvent.change(screen.getByLabelText(/artifact file/i), {
        target: { files: [new File(['x'], 'x.jar', { type: 'application/java-archive' })] },
      });
      // BY PLACEHOLDER, not by label. `Field` appends an "optional" marker
      // inside the `<label>`, so this field's accessible name is
      // "Test optional" — and a loose `/test/i` would be satisfied by any
      // future label containing the word. The placeholder is this input's
      // alone and says what the field wants, which is the same reason it is
      // there for a reader.
      if (test !== undefined) {
        fireEvent.change(screen.getByPlaceholderText('checkout-soak'), { target: { value: test } });
      }
      fireEvent.click(screen.getByRole('button', { name: /queue run/i }));
    };

    await screen.findByLabelText(/run name/i);

    // LEFT BLANK: the field must not appear in the body at all. The server's
    // grammar rejects an empty slug — correctly, it names nothing — so a form
    // that always sent it would refuse every run where the user simply left it
    // alone, which is the ordinary case.
    fill();
    await screen.findByText(/run queued/i);
    expect(startRunnerRunMock.mock.calls[0]?.[0]?.metadata).not.toHaveProperty('test');

    startRunnerRunMock.mockClear();
    await act(async () => {
      await router.navigate('/projects/beta/run/new');
    });
    await screen.findByLabelText(/run name/i);

    fill('checkout-soak');
    await screen.findByText(/run queued/i);
    expect(startRunnerRunMock.mock.calls[0]?.[0]?.metadata).toMatchObject({
      test: 'checkout-soak',
    });
  });
});
