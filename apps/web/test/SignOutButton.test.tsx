import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

function renderButton(props: { alwaysShowLabel?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const clear = vi.spyOn(client, 'clear');
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/runs']}>
        <SignOutButton {...props} />
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
   * THE NAME IS "Sign out" AT EVERY WIDTH, and the label is `sr-only
   * sm:not-sr-only` by default precisely so the name survives where the word
   * is not drawn.
   *
   * WHAT THIS CANNOT SEE, stated rather than implied: jsdom applies no
   * stylesheet, so it cannot tell `sr-only` from the `hidden sm:inline` the
   * docstring rejects — both leave the text in the DOM here — and no e2e case
   * resolves this button at a phone viewport (the header's Sign out is the
   * account menu's `menuitem` now). The classes below are what guard it. What
   * this case proves is the half no stylesheet affects: the icon contributes
   * nothing to the name.
   */
  it('is named by its word alone, with the icon adding nothing', () => {
    renderButton();
    expect(button()).toHaveAccessibleName('Sign out');
  });

  /**
   * THE DEFAULT IS THE HEADER'S, and the classes are what can be read here: the
   * word is accessibly hidden below `sm` and drawn from `sm` up, so every caller
   * that passes nothing keeps that (the no-organisation page among them).
   */
  it('hides its word below sm by default, keeping it in the name', () => {
    renderButton();
    expect(within(button()).getByText('Sign out')).toHaveClass('sr-only', 'sm:not-sr-only');
  });

  /**
   * A caller with room — the password step, where Sign out is the only way out —
   * keeps the word drawn at every width, so a phone is not left with an
   * unlabelled icon. The name is the same either way.
   *
   * NO CLASS AT ALL, not merely no `sr-only`: "not sr-only" is satisfied by
   * `hidden sm:inline`, which takes the word off a phone and the name with it.
   */
  it('draws its word at every width when asked to', () => {
    renderButton({ alwaysShowLabel: true });
    expect(within(button()).getByText('Sign out')).not.toHaveAttribute('class');
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
