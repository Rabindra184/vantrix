import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AuthError, signIn } from '../api/session';
import { safeNext } from './paths';

/**
 * The ONLY consumer of Better Auth's own error shape in this app (design §5,
 * deviation D-1). Everything else consumes `ProblemError`. The two are not
 * unified on purpose: collapsing them would mean synthesising a
 * `remediation` Better Auth never sent, i.e. inventing guidance and
 * attributing it to the server.
 *
 * There is no sign-up link, and there must not be one: the first admin comes
 * from `pnpm bootstrap` and there is no self-registration (design §9), so a
 * registration link would be a dead end.
 */
export default function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // §7: focus moves deliberately on redirect. A user arriving here from a
  // deep link was thrown across the app by a redirect they did not ask for;
  // leaving focus on <body> means a screen-reader user hears nothing about
  // it and a keyboard user tabs from the top of the document.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
      // Drop every cached query BEFORE navigating. Two reasons, both
      // load-bearing: AuthGate's own `['session']` result from the visit that
      // redirected here is cached as `null`, and re-rendering the gate
      // against it would bounce straight back to /login — a loop caused
      // purely by stale cache. And on a shared machine the cache may still
      // hold the PREVIOUS user's runs (design §5.1).
      queryClient.clear();
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      // Better Auth's message, verbatim, never a rewrite: it distinguishes
      // cases (unknown account vs wrong password vs unverified email) that
      // this form has no basis to re-draw. Anything that is not an AuthError
      // never reached the server's verdict at all — saying "wrong password"
      // there would be a guess.
      setError(
        err instanceof AuthError
          ? err.message
          : 'Could not reach the server to sign in. Check your connection and try again.',
      );
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <header>
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
          PerfPortal
        </h1>
        <h2 className="text-base text-[var(--color-text-muted)]">Sign in</h2>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          {/* A real <label htmlFor>, not a placeholder or aria-label: the
              Playwright suite selects by label (helpers.ts), so losing the
              association fails a test rather than quietly failing an audit. */}
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
          />
        </div>

        {error !== null && (
          <p role="alert" className="text-[var(--color-status-failed)]">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-[var(--color-text-primary)] px-3 py-2 text-[var(--color-surface)] disabled:opacity-60"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
