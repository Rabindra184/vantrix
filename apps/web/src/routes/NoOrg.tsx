import { useEffect, useRef } from 'react';
import SignOutButton from '../SignOutButton';

/**
 * A valid session that belongs to no organisation — the API's 403 (design
 * §5.1). This is the rejection a naive implementation gets wrong: treating
 * every rejection as "go to /login" gives this user an infinite loop, since
 * their credentials are correct and signing in again will keep succeeding
 * and keep 403-ing, with nothing on screen to explain why.
 *
 * It lives at its own URL (`/no-organisation`) rather than rendering in
 * place at `/login` for two reasons. It is a real page about a real state,
 * reloadable and linkable; and the e2e sign-in helper waits for navigation
 * away from `/login`, so an in-place render would hang the suite for a full
 * timeout instead of failing usefully.
 *
 * The copy is this page's own, not the API's `remediation` echoed back: the
 * 403 arrives during a redirect and its problem document is gone by the time
 * this route renders, so quoting it would mean either passing an error
 * through router state that a reload destroys, or attributing wording to the
 * server that the server did not send here.
 *
 * Deliberately NOT behind AuthGate: the gate is what redirects here.
 */
export default function NoOrg() {
  const heading = useRef<HTMLHeadingElement>(null);

  // §7: focus moves to the heading on redirect — the user did not click
  // anything to get here, so the reason must be the first thing announced.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-6">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
        You are not a member of any organisation
      </h1>
      <p>
        Your sign-in worked — this is not a password problem. This account simply has not been
        added to an organisation yet, and every run in PerfPortal belongs to one.
      </p>
      <p className="text-[var(--color-text-muted)]">
        Ask an administrator to add this account to an organisation, then sign in again.
      </p>
      <div>
        <SignOutButton />
      </div>
    </main>
  );
}
