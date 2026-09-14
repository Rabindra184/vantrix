import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Login from '../src/routes/Login';
import { AuthError } from '../src/api/session';

const signIn = vi.fn();
/**
 * `AuthError` STAYS REAL, and the first draft of this file did not keep it.
 * `Login` imports the class alongside the function and branches on
 * `err instanceof AuthError` to decide whether it may quote the server
 * verbatim. A mock that replaced the whole module left the class `undefined`,
 * so that `instanceof` threw INSIDE the catch block, the error state was never
 * set, and both refusal cases failed reporting "unable to find role=alert" —
 * pointing at the markup, which was fine.
 *
 * Same shape as the malformed-fixture trap this repo already records, one
 * layer up: a partial module mock silently removes an export the component
 * needs, and the symptom names the wrong thing.
 */
vi.mock('../src/api/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/session')>()),
  signIn: (e: string, p: string) => signIn(e, p),
}));

afterEach(() => {
  cleanup();
  signIn.mockReset();
});

function renderLogin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/login']}>
        <Login />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * The page every signed-out visitor meets, and the only one where a reader has
 * no navigation, no rail and no content to orient by. It had no test of its
 * own — which is also true of the three specs that drive it, because those
 * select by label through `helpers.ts` and would fail for reasons that look
 * like anything but a broken association.
 */
describe('Login — the fields are reachable by their names', () => {
  /**
   * A REAL `<label htmlFor>`, NOT A PLACEHOLDER. A placeholder disappears the
   * moment somebody types, which is exactly when they most need to know which
   * box they are in, and it is not an accessible name at all in some
   * screen-reader and browser pairings.
   *
   * `getByLabelText` resolves through the association, so this fails if the
   * `htmlFor`/`id` pair is broken — quietly the most likely regression here,
   * because the page still LOOKS correct with the label floating free.
   */
  it('associates each label with its own control', () => {
    renderLogin();
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  /**
   * AND A PASSWORD MANAGER HAS TO KNOW WHICH IS WHICH. `username` and
   * `current-password` are what let one fill this form; the failure mode of
   * getting them wrong is not a broken page but a reader who has to type a
   * generated password by hand, which is where they give up and pick a worse
   * one.
   */
  it('tells a password manager what each field holds', () => {
    renderLogin();
    expect(screen.getByLabelText('Email')).toHaveAttribute('autoComplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autoComplete', 'current-password');
  });
});

describe('Login — a refusal', () => {
  /**
   * ANNOUNCED WITHOUT MOVING FOCUS. `role="alert"` reads the refusal out the
   * moment it appears; moving the caret as well would throw a keyboard user
   * out of the field they were about to correct — which on this form is almost
   * always the password, i.e. the field they have just been told is wrong.
   *
   * So the pair is the claim: the message is announced AND focus stays put.
   */
  it('announces the failure and leaves the caret where the reader left it', async () => {
    const user = userEvent.setup();
    signIn.mockRejectedValueOnce(new AuthError('INVALID_EMAIL_OR_PASSWORD', 'Email or password is incorrect.'));
    renderLogin();

    await user.type(screen.getByLabelText('Email'), 'ada@example.test');
    const password = screen.getByLabelText('Password');
    // SUBMITTED FROM THE FIELD, not by clicking the button — a click moves
    // focus to the button itself, so it cannot distinguish "the component left
    // focus alone" from "the component moved it". Enter from the password box
    // is also the keyboard user this claim is about.
    await user.type(password, 'wrong{Enter}');

    const refusal = await screen.findByRole('alert');
    expect(within(refusal).queryByRole('img')).not.toBeInTheDocument();
    expect(refusal).toHaveTextContent('Email or password is incorrect.');
    expect(password).toHaveFocus();
  });

  /**
   * AND THE REFUSAL IS NOT STICKY. A reader who corrects the password and
   * submits again must not still be reading why the last attempt failed.
   */
  it('drops the old refusal on the next attempt', async () => {
    const user = userEvent.setup();
    signIn.mockRejectedValueOnce(new AuthError('INVALID_EMAIL_OR_PASSWORD', 'Email or password is incorrect.'));
    renderLogin();

    await user.type(screen.getByLabelText('Email'), 'ada@example.test');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');

    signIn.mockImplementationOnce(() => new Promise(() => {}));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
