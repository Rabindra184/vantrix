// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProjects } from '../src/api/projects.js';
import { fetchProjectTokens, mintProjectToken, revokeProjectToken } from '../src/api/tokens.js';
import ProjectSetup from '../src/routes/ProjectSetup.js';

vi.mock('../src/api/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/projects.js')>()),
  fetchProjects: vi.fn(async () => ({
    items: [
      { id: '00000000-0000-4000-8000-0000000000a1', slug: 'alpha', name: 'Alpha', latestRun: null },
    ],
  })),
}));

vi.mock('../src/api/tokens.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/tokens.js')>()),
  fetchProjectTokens: vi.fn(async () => ({
    tokens: [
      {
        prefix: 'pp_existing',
        name: 'Existing CI',
        scopes: ['ingest', 'read'],
        createdAt: '2026-08-20T00:00:00.000Z',
        lastUsedAt: null,
        revokedAt: null,
      },
    ],
  })),
  mintProjectToken: vi.fn(async (_slug, body) => ({
    token: 'pp_abc123_secret456',
    prefix: 'pp_abc123',
    name: body.name,
    scopes: body.scopes,
    createdAt: '2026-08-20T00:00:00.000Z',
  })),
  revokeProjectToken: vi.fn(async () => ({
    prefix: 'pp_existing',
    name: 'Existing CI',
    scopes: ['ingest', 'read'],
    createdAt: '2026-08-20T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: '2026-08-21T00:00:00.000Z',
  })),
}));

const fetchProjectsMock = vi.mocked(fetchProjects);
const fetchProjectTokensMock = vi.mocked(fetchProjectTokens);
const mintProjectTokenMock = vi.mocked(mintProjectToken);
const revokeProjectTokenMock = vi.mocked(revokeProjectToken);

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  fetchProjectsMock.mockClear();
  fetchProjectTokensMock.mockClear();
  mintProjectTokenMock.mockClear();
  revokeProjectTokenMock.mockClear();
});

describe('ProjectSetup', () => {
  function renderSetup() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/projects/alpha/setup']}>
          <Routes>
            <Route path="/projects/:slug/setup" element={<ProjectSetup />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('mints a scoped token and renders the once-only secret with the ingest command', async () => {
    renderSetup();

    expect(await screen.findByRole('heading', { name: 'Project setup' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/token name/i), { target: { value: 'Nightly CI' } });
    fireEvent.click(screen.getByRole('button', { name: /mint token/i }));

    expect(await screen.findByText('pp_abc123_secret456')).toBeInTheDocument();
    expect(screen.getByText(/curl -H/)).toHaveTextContent('pp_abc123_secret456');
    expect(mintProjectTokenMock).toHaveBeenCalledWith('alpha', {
      name: 'Nightly CI',
      scopes: ['ingest', 'read'],
    });
  });

  /**
   * THE ONE ACTION WHERE SILENCE IS DANGEROUS, and the only path the mint
   * side already covered by having its own `role="alert"`.
   *
   * A revoke that fails used to be indistinguishable from one that
   * succeeded: the spinner stopped, the row still read "Active", and nothing
   * was announced. An operator killing a LEAKED credential would conclude it
   * was dead while it was still live — so this asserts the alert exists, is
   * announced, names the token, and carries what the server actually said.
   */
  it('says so when a revoke fails, rather than looking like it worked', async () => {
    revokeProjectTokenMock.mockRejectedValueOnce(new Error('network down'));
    renderSetup();

    expect(await screen.findByText('pp_existing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));

    const alert = await screen.findByRole('alert');
    // Names the token, and does NOT overclaim: a request that failed on the
    // way back may still have succeeded on the server.
    expect(alert).toHaveTextContent('pp_existing');
    expect(alert).toHaveTextContent(/may still be active/i);
    // The server's own words reach the reader.
    expect(alert).toHaveTextContent('network down');
  });

  it('lists existing tokens and revokes by prefix', async () => {
    renderSetup();

    expect(await screen.findByText('Existing CI')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    await waitFor(() => {
      expect(revokeProjectTokenMock).toHaveBeenCalledWith('alpha', 'pp_existing');
    });
  });
});
