import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import Button from './components/Button';
import { AlertIcon, SignOutIcon } from './components/icons';
import { signOut } from './api/session';

/**
 * Sign out is three steps in a fixed order (design §5.1): post to
 * `/auth/sign-out`, **clear the query cache**, then redirect.
 *
 * The middle step is the one with teeth. The cache holds the previous user's
 * runs in memory; on a shared machine, skipping it leaves that data one
 * back-button away with no server-side component to the leak, because the
 * next render would paint from cache before any request is made.
 *
 * A failed sign-out does NOT redirect. The cookie may well still be valid,
 * and sending the user to /login while they are in fact still signed in
 * tells them the opposite of the truth.
 *
 * THE LABEL IS TEXT AT EVERY WIDTH, and the icon is decoration beside it. An
 * icon-only sign-out is the classic discoverability failure — but the reason
 * it is not even hidden below `sm` here is narrower and harder: the e2e suite
 * resolves this control by `getByRole('button', { name: 'Sign out', exact:
 * true })`, and a label hidden with `sr-only` keeps that name while a label
 * hidden with `hidden sm:inline` silently changes it to whatever the icon
 * contributes. Text that is always present cannot get that wrong.
 *
 * `submitting` guards the double-click. Two sign-out posts race, the second
 * one 401s against the cookie the first already cleared, and this component
 * would show its failure message to a user whose sign-out actually worked.
 */
export default function SignOutButton() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSignOut(): Promise<void> {
    setFailed(false);
    setSubmitting(true);
    try {
      await signOut();
    } catch {
      setFailed(true);
      setSubmitting(false);
      return;
    }
    queryClient.clear();
    navigate('/login', { replace: true });
  }

  return (
    <>
      <Button size="sm" onClick={onSignOut} loading={submitting}>
        {/* Hidden from the accessible name, not from the layout: the word
            "Sign out" beside it is the name, and an icon that contributed its
            own would append to it. */}
        {!submitting && <SignOutIcon className="h-3.5 w-3.5" />}
        Sign out
      </Button>
      {failed && (
        // `role="alert"` is announced the moment it appears. The icon is
        // decorative; the sentence carries the whole message, including what
        // to do about it.
        <p
          role="alert"
          className="tint flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] text-[color:var(--color-status-failed)]"
        >
          <AlertIcon className="h-3.5 w-3.5 shrink-0" />
          Sign out did not complete — you may still be signed in. Try again.
        </p>
      )}
    </>
  );
}
