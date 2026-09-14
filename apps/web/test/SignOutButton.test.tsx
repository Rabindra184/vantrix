import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SignOutButton from '../src/SignOutButton';

const signOut = vi.fn();
vi.mock('../src/api/session', () => ({ signOut: () => signOut() }));

afterEach(() => {
  cleanup();
  signOut.mockReset();
});

function renderButton() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const clear = vi.spyOn(client, 'clear');
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/runs']}>
        <SignOutButton />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, clear };
}

/**
 * NO `exact: true`, and the first draft had one. `getByRole(role, { name })` is
 * already EXACT in Testing Library and a case-insensitive SUBSTRING in
 * Playwright — the same call, two meanings, which CLAUDE.md records — so the
 * option is the e2e suite's spelling copied into a jsdom file, where it is not
 * merely redundant but not a `ByRoleOptions` member at all.
 *
 * `pnpm test:unit` passed it 4 of 4. Vitest does not typecheck; `tsc` rejected
 * it with TS2769.
 */
const button = () => screen.getByRole('button', { name: 'Sign out' });

describe('SignOutButton — what it is called', () => {
  /**
   * THE NAME IS THE CONTRACT. Three e2e specs resolve this control by
   * `getByRole('button', { name: 'Sign out', exact: true })`, and the label is
   * `sr-only sm:not-sr-only` precisely so that name survives the one cramped
   * phone slot where the word is not drawn.
   *
   * WHAT THIS CANNOT SEE, stated rather than implied: jsdom applies no
   * stylesheet, so it cannot tell `sr-only` from the `hidden sm:inline` the
   * docstring rejects — both leave the text in the DOM here. The browser-level
   * guard is the e2e suite resolving this button by name at a phone viewport.
   * What this CAN prove is the other half, which no stylesheet affects: the
   * icon contributes nothing to the name.
   */
  it('is named by its word alone, with the icon adding nothing', () => {
    renderButton();
    expect(button()).toHaveAccessibleName('Sign out');
  });
});

describe('SignOutButton — when it fails', () => {
  /**
   * A FAILED SIGN-OUT MUST NOT REDIRECT. The cookie may well still be valid,
   * and sending somebody to /login while they are in fact still signed in
   * tells them the opposite of the truth — on the one control whose whole
   * purpose is to be believed.
   *
   * The cache assertion is the half with teeth. `queryClient.clear()` is what
   * stops the previous user's runs being one back-button away on a shared
   * machine, and it must NOT run on the failure path either: clearing while
   * the session survives would leave a signed-in reader looking at an empty
   * application and no explanation.
   */
  it('says so, keeps the reader where they are, and does not clear the cache', async () => {
    const user = userEvent.setup();
    signOut.mockRejectedValueOnce(new Error('network'));
    const { clear } = renderButton();

    await user.click(button());

    // `role="alert"` and not `status`: the reader pressed a button and is owed
    // an interruption, because they are about to walk away believing it worked.
    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent(/you may still be signed in/i);
    expect(clear).not.toHaveBeenCalled();
    expect(button()).toBeInTheDocument();
  });

  /**
   * AND IT RECOVERS. The message is cleared at the start of the next attempt,
   * so a reader who retries successfully is not left reading a stale failure
   * about a sign-out that has since worked.
   */
  it('clears the old failure when the reader tries again', async () => {
    const user = userEvent.setup();
    signOut.mockRejectedValueOnce(new Error('network'));
    renderButton();

    await user.click(button());
    await screen.findByRole('alert');

    signOut.mockResolvedValueOnce(undefined);
    await user.click(button());
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

describe('SignOutButton — when it works', () => {
  /**
   * THE ORDER IS THE DESIGN: post, then clear the cache, then leave. The cache
   * holds the previous user's runs in memory, and the next render would paint
   * from it before any request was made — a leak with no server-side component
   * at all.
   */
  it('clears the cached data of the reader who just left', async () => {
    const user = userEvent.setup();
    signOut.mockResolvedValueOnce(undefined);
    const { clear } = renderButton();

    await user.click(button());
    await waitFor(() => expect(clear).toHaveBeenCalled());
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
