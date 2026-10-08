import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

function renderStep({ signOutFails = false }: { signOutFails?: boolean } = {}) {
  requested = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    requested.push({ path, method: init?.method ?? 'GET' });
    if (path === '/v1/me/password') return Promise.resolve(new Response(null, { status: 204 }));
    if (path === '/auth/sign-out') {
      return Promise.resolve(
        signOutFails
          ? new Response('{"message":"unavailable"}', { status: 503, headers: { 'Content-Type': 'application/json' } })
          : new Response('{"success":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
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

  /** Sign out is this screen's only way out, so it keeps its word at every
   *  width. `SignOutButton` hides the word below `sm` by default, for the
   *  cramped header slot; this step has room, and an icon alone is not enough
   *  to leave by. jsdom applies no stylesheet, so the case reads the classes
   *  that would hide it — none at all, because "not `sr-only`" alone is
   *  satisfied by `hidden sm:inline`. `SignOutButton.test.tsx` pins the
   *  default. */
  it('labels Sign out in words at every width', () => {
    renderStep();
    const label = within(screen.getByRole('button', { name: 'Sign out' })).getByText('Sign out');
    expect(label).not.toHaveAttribute('class');
  });

  /** `SignOutButton` hands back the button and, on a failure, its alert as
   *  siblings; laid out in a row they squeeze side by side. A column puts the
   *  alert beneath the button it is about, as the no-organisation page does. */
  it('shows a failed sign-out beneath the button, in a column', async () => {
    renderStep({ signOutFails: true });
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Sign out' });
    await user.click(button);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/you may still be signed in/i);
    expect(button.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.parentElement).toBe(button.parentElement);
    expect(alert.parentElement).toHaveClass('flex-col');
    expect(screen.queryByText('login stand-in')).toBeNull();
  });
});
