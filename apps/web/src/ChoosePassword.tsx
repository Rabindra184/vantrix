import { useEffect, useRef } from 'react';
import SignOutButton from './SignOutButton';
import PasswordChangeForm from './components/PasswordChangeForm';
import { ActivityIcon } from './components/icons';
import useDocumentTitle from './useDocumentTitle';

/**
 * The step a person meets before anything else at first sign-in, and again
 * after an admin resets their password: until it is done, every `/v1` route
 * but `PUT /v1/me/password` answers 403 `PASSWORD_CHANGE_REQUIRED`, so there
 * is nothing else the app could show them.
 *
 * `AuthGate` renders it IN PLACE of the app, and that decides its shape. It is
 * the whole screen, the markup the gate's bootstrap screen and the
 * no-organisation page share: no rail and no header, because every link in
 * them leads to a page that would answer 403. The brand mark says which
 * product this is, since nothing else on screen does. The one way out that is
 * not choosing a password is Sign out — the existing control, which posts,
 * clears the query cache and goes to the sign-in page.
 *
 * NO SENTENCE UNDER THE HEADING. The heading says what to do, and the form is
 * the rest of the instruction (the clean-UI text rule).
 *
 * The URL does not change: the reader stays on the address they asked for, and
 * lands on it once the gate lets them through.
 */
export default function ChoosePassword({ onDone }: { readonly onDone: () => void | Promise<void> }) {
  const heading = useRef<HTMLHeadingElement>(null);

  useDocumentTitle('Choose a new password');

  // Focus moves to the heading on arrival, as on the no-organisation page: the
  // reader did not ask to be here, so the reason is the first thing announced.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    // `min-h-dvh` for the reason `Login` gives: `100vh` on mobile Safari
    // excludes the browser chrome, so a centred block starts partly hidden.
    <main className="flex min-h-dvh flex-col items-center justify-center p-4 sm:p-6">
      <div className="flex w-full max-w-sm flex-col gap-5 rounded-xl border border-default bg-surface p-6 shadow-panel sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-mark text-on-brand shadow-raised">
            <ActivityIcon className="h-6 w-6" />
          </span>
          <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
            Choose a new password
          </h1>
        </div>
        <PasswordChangeForm onDone={onDone} />
        <div className="flex justify-center border-t border-default pt-4">
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
