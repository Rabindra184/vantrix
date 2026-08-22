// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/**
 * The rules panel is a third data-dependent section of this page, and this
 * file is not about it — but leaving it unmocked does not leave it silent:
 * its query fails against no server and it announces that, in a `role="alert"`
 * the token tests below then resolved to instead of their own. Mocked to a
 * quiet empty list, the same as projects and tokens above. `ProjectRules.test.tsx`
 * is where the panel's own behaviour is pinned.
 */
vi.mock('../src/api/rules.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/rules.js')>()),
  fetchProjectRules: vi.fn(async () => ({ rules: [] })),
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
  // The two token blocks, so an assertion can name the one it means rather
  // than resolving to whichever of the page's alerts happened to render.
  /** The mint form and the once-only secret it reveals. */
  const mintCard = () => screen.getByTestId('token-mint');
  /** The token table and the revoke alert that sits above it. */
  const tokenList = () => screen.getByTestId('token-list');

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
    // Two clicks, because revoking is now deliberate: arm, then confirm.
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));

    // SCOPED to the token list, not `screen`. This page has several sections
    // that each announce their own failures, so a page-wide alert query
    // silently asks "did ANYTHING go wrong" rather than "did the revoke".
    const alert = await within(tokenList()).findByRole('alert');
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
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => {
      expect(revokeProjectTokenMock).toHaveBeenCalledWith('alpha', 'pp_existing');
    });
  });

  /**
   * THE CONFIRMATION IS THE TEST, not the revoke.
   *
   * This is the app's only destructive control, and it used to fire on one
   * click of a `ghost` button sitting in a dense table row: a misclick
   * revoked a live credential, every CI job using it began failing 401, and
   * there is no undo — only minting a replacement and redistributing it.
   *
   * Asserting the NEGATIVE is the whole point: arming the control must not
   * call the API. A test that only clicked twice and checked the call would
   * pass against the original one-click code.
   */
  it('does not revoke on the first click, and can be cancelled', async () => {
    renderSetup();

    expect(await screen.findByText('Existing CI')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(revokeProjectTokenMock).not.toHaveBeenCalled();

    // Cancel disarms it and puts the original control back, so nothing is
    // left primed in the row.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm revoke' })).toBeNull();
    expect(revokeProjectTokenMock).not.toHaveBeenCalled();
  });

  /**
   * The clipboard is absent on any page that is not a secure context —
   * plain http on anything but localhost, i.e. an ordinary way to reach an
   * on-prem install. The old code optional-chained it, so `await undefined`
   * resolved and the button said "Copied" over a secret that had gone
   * nowhere, shown once and never again.
   */
  it('admits it when the token could not be copied', async () => {
    Object.assign(navigator, { clipboard: undefined });
    renderSetup();

    expect(await screen.findByRole('heading', { name: 'Project setup' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /mint token/i }));
    expect(await screen.findByText('pp_abc123_secret456')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await within(mintCard()).findByRole('alert')).toHaveTextContent(/could not be copied/i);
    // And it must NOT claim success.
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });
});
