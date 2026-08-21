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
 * THE LABEL IS VISIBLE FROM `sm` UP, and accessibly hidden below it. The
 * smallest phone width cannot hold the brand, three-way theme control and the
 * full "Sign out" label without pushing the page sideways; the icon is enough
 * visually in that one cramped slot, while the `sr-only sm:not-sr-only` text
 * preserves the exact accessible name the e2e suite resolves by
 * (`getByRole('button', { name: 'Sign out', exact: true })`). `hidden
 * sm:inline` would be wrong here: it removes the name below `sm`.
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
        <span className="sr-only sm:not-sr-only">Sign out</span>
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
