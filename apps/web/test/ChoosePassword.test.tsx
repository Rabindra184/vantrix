import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChoosePassword from '../src/ChoosePassword';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The step a person meets at first sign-in, and after an admin resets their
 * password: the whole screen, with nothing else on it to reach — no rail, no
 * header — because every other `/v1` read would answer 403 until it is done.
 * What `AuthGate` does with it is `AuthGate.test.tsx`'s; this is the screen.
 */
let requested: { path: string; method: string }[] = [];

function renderStep() {
  requested = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    requested.push({ path, method: init?.method ?? 'GET' });
    if (path === '/v1/me/password') return Promise.resolve(new Response(null, { status: 204 }));
    if (path === '/auth/sign-out') {
      return Promise.resolve(
        new Response('{"success":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }
    return Promise.reject(new Error(`unexpected request to ${path}`));
  });
  const onDone = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/runs']}>
        <Routes>
          <Route path="/runs" element={<ChoosePassword onDone={onDone} />} />
          <Route path="/login" element={<p>login stand-in</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onDone };
}

describe('ChoosePassword', () => {
  /** The reader did not ask to be here — the gate put them here — so the
   *  reason is the first thing announced, as on the no-organisation page. */
  it('moves focus to its heading on arrival', async () => {
    renderStep();
    const heading = screen.getByRole('heading', { level: 1, name: 'Choose a new password' });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('is the whole page: a main landmark and no navigation', () => {
    renderStep();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('banner')).toBeNull();
  });

  it('reports done once the new password is set', async () => {
    const { onDone } = renderStep();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Current password'), 'temporary-pass');
    await user.type(screen.getByLabelText('New password'), 'chosen-password');
    await user.type(screen.getByLabelText('Repeat new password'), 'chosen-password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requested).toEqual([{ path: '/v1/me/password', method: 'PUT' }]);
  });

  /** The one way out that is not choosing a password — the existing sign-out
   *  control, which posts, clears the cache and goes to the sign-in page. */
  it('offers Sign out, which signs out and leaves', async () => {
    renderStep();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('login stand-in')).toBeInTheDocument();
    expect(requested).toEqual([{ path: '/auth/sign-out', method: 'POST' }]);
  });
});
