import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
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
 */
export default function SignOutButton() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);

  async function onSignOut(): Promise<void> {
    try {
      await signOut();
    } catch {
      setFailed(true);
      return;
    }
    queryClient.clear();
    navigate('/login', { replace: true });
  }

  return (
    <>
      <button
        type="button"
        onClick={onSignOut}
        className="rounded border border-default px-3 py-1"
      >
        Sign out
      </button>
      {failed && (
        <p role="alert" className="text-[color:var(--color-status-failed)]">
          Sign out did not complete — you may still be signed in. Try again.
        </p>
      )}
    </>
  );
}
