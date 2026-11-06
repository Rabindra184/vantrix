import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useOutletContext } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRole, RunNote as RunNoteValue, RunResponse } from '@perfportal/contracts';
import { fetchRun, runQueryKey, type RunDetail as RunDetailBody } from '../src/api/run';
import { useLiveRun } from '../src/api/live';
import RunDetail from '../src/routes/RunDetail';
import type { RunWindowContext } from '../src/routes/useRunWindow';
import { seedAccess } from './support/access';

/**
 * ═══ WHICH PROJECT THE RUN PAGE ASKS ABOUT, AND WHEN ═══
 *
 * `RunShell` is handed its access now, rather than asking for it: the public
 * page has no session and no project list to ask, and passes an access that
 * allows nothing. So the question the shell used to answer for itself — "may
 * this reader act in THIS run's project?" — is `RunDetail`'s, asked once with
 * `useProjectAccess(run.data?.run.project?.slug)` and passed down. These cases
 * were the shell's, and moved with the question.
 *
 * ABOVE THE EARLY RETURNS, and the last case is why: the page renders a
 * loading line before the run arrives and the shell after, and a hook called
 * only on the second render is a different number of hooks on the same
 * component — React throws rather than rendering the run.
 */

vi.mock('../src/api/run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/run.js')>()),
  fetchRun: vi.fn(),
}));
vi.mock('../src/api/live.js', () => ({ useLiveRun: vi.fn() }));
vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));

const fetchRunMock = vi.mocked(fetchRun);
const useLiveRunMock = vi.mocked(useLiveRun);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchRunMock.mockReset();
});

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const NOTE: RunNoteValue = { text: 'flaky environment, ignore', updatedAt: null, updatedBy: null };

const RUN: RunResponse = {
  id: RUN_ID,
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  status: 'complete',
  verdict: 'not_evaluated',
  tool: 'gatling',
  toolVersion: '3.15.1',
  simulation: 'example.ParitySimulation',
  description: null,
  durationMs: 63161,
  startedAt: '2026-08-14T10:43:49.546Z',
  toolStartedAt: '2026-08-07T05:30:02.171Z',
  assertions: [],
  note: NOTE,
};

/** Reads back the access the page handed its sections, through the shell. */
function AccessProbe() {
  const { projectAccess } = useOutletContext<RunWindowContext>();
  return (
    <div
      data-testid="access-probe"
      data-known={String(projectAccess.known)}
      data-tokens={String(projectAccess.can('tokens:manage'))}
    />
  );
}

function mount(
  run: RunResponse | RunDetailBody,
  who: { isAdmin: boolean; roles?: Readonly<Record<string, ProjectRole>> },
  { seedRun = true }: { seedRun?: boolean } = {},
) {
  const body: RunDetailBody = 'state' in run ? run : { state: 'ready', run };
  useLiveRunMock.mockReturnValue({ connected: false, lastDelta: null, unauthorized: false, partial: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedAccess(client, who);
  if (seedRun) {
    fetchRunMock.mockResolvedValue(body);
    client.setQueryData(runQueryKey(RUN_ID), body);
  }
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}`]}>
        <Routes>
          <Route path="/runs/:runId" element={<RunDetail />}>
            <Route index element={<AccessProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RunDetail — the access it hands the shell', () => {
  it('answers for the run’s own project', () => {
    mount(RUN, { isAdmin: false, roles: { checkout: 'manager', search: 'viewer' } });
    const probe = screen.getByTestId('access-probe');
    expect(probe).toHaveAttribute('data-known', 'true');
    expect(probe).toHaveAttribute('data-tokens', 'true');
  });

  it('answers for the run’s project, not for another one the reader manages', () => {
    mount(RUN, { isAdmin: false, roles: { checkout: 'viewer', search: 'manager' } });
    const probe = screen.getByTestId('access-probe');
    expect(probe).toHaveAttribute('data-known', 'true');
    expect(probe).toHaveAttribute('data-tokens', 'false');
  });

  /** A run whose identity names no project yet — a pending run read from an
   *  API that sends only its id — asks about none, which is known for nobody,
   *  an admin included. (A finished run always names its project.) */
  it('knows nothing for a run with no project yet, even for an admin', () => {
    mount(
      { state: 'processing', run: { id: RUN_ID, status: 'pending', statusUrl: `/v1/runs/${RUN_ID}` } },
      { isAdmin: true, roles: {} },
    );
    const probe = screen.getByTestId('access-probe');
    expect(probe).toHaveAttribute('data-known', 'false');
    expect(probe).toHaveAttribute('data-tokens', 'false');
  });
});

describe('RunDetail — the run’s note follows the reader’s role in its project', () => {
  it('offers a member of the run’s project Edit note', () => {
    mount(RUN, { isAdmin: false, roles: { checkout: 'member' } });
    expect(screen.getByRole('button', { name: 'Edit note' })).toBeInTheDocument();
  });

  /** A member elsewhere is still a viewer here. */
  it('shows the note read-only to a viewer of the run’s project who may edit in another', () => {
    mount(RUN, { isAdmin: false, roles: { checkout: 'viewer', search: 'member' } });
    expect(screen.getByTestId('run-note-text')).toHaveTextContent(NOTE.text);
    expect(screen.queryByRole('button', { name: 'Edit note' })).toBeNull();
  });

  /** An admin holding only a Viewer row may do everything. */
  it('offers an admin holding only a Viewer row Edit note', () => {
    mount(RUN, { isAdmin: true, roles: { checkout: 'viewer' } });
    expect(screen.getByRole('button', { name: 'Edit note' })).toBeInTheDocument();
  });
});

describe('RunDetail — the access hook is asked on every render', () => {
  it('renders the run after its loading line without changing how many hooks it calls', async () => {
    let resolve: (body: RunDetailBody) => void = () => {};
    fetchRunMock.mockImplementation(() => new Promise<RunDetailBody>((r) => (resolve = r)));
    mount(RUN, { isAdmin: false, roles: { checkout: 'member' } }, { seedRun: false });
    expect(screen.getByText('Loading run…')).toBeInTheDocument();

    resolve({ state: 'ready', run: RUN });
    expect(await screen.findByRole('button', { name: 'Edit note' })).toBeInTheDocument();
  });
});
