import { useEffect, useRef } from 'react';
import SignOutButton from '../SignOutButton';
import { InboxIcon } from '../components/icons';
import useDocumentTitle from '../useDocumentTitle';

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

  useDocumentTitle('No organisation');

  // §7: focus moves to the heading on redirect — the user did not click
  // anything to get here, so the reason must be the first thing announced.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    // `min-h-dvh` for the same reason `Login` uses it: `100vh` on mobile
    // Safari excludes the browser chrome, so a centred block starts partly
    // hidden.
    <main className="flex min-h-dvh flex-col items-center justify-center p-4 sm:p-6">
      <div className="flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border border-default bg-surface p-6 text-center shadow-panel sm:p-8">
        {/* Deliberately NOT the failure colour. This is not an error — the
            sign-in worked — and painting it red is what makes a user retype a
            password that was correct. The neutral treatment matches the
            first sentence's job, which is to say exactly that. */}
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-sunken text-muted">
          <InboxIcon className="h-5 w-5" />
        </span>
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-xl font-semibold tracking-tight outline-none"
        >
          You are not a member of any organisation
        </h1>
        <p className="text-[13px] leading-relaxed">
          Your sign-in worked — this is not a password problem. This account simply has not been
          added to an organisation yet, and every run in PerfPortal belongs to one.
        </p>
        <p className="text-[13px] leading-relaxed text-muted">
          Ask an administrator to add this account to an organisation, then sign in again.
        </p>
        <div className="mt-1">
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
