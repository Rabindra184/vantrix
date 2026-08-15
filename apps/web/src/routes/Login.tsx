import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import Button from '../components/Button';
import { ActivityIcon, AlertIcon } from '../components/icons';
import { INPUT } from '../components/tableStyles';
import { AuthError, signIn } from '../api/session';
import { safeNext } from './paths';
import useDocumentTitle from '../useDocumentTitle';

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

  useDocumentTitle('Sign in');

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
    // ONLY the sign-in call is guarded, and the boundary is exactly here on
    // purpose. Everything after it runs with the session cookie already set,
    // so a throw from it is not a failure to sign in — and reporting one as
    // "could not reach the server" would tell a user who IS now signed in
    // the opposite of what happened. (That miscategorisation is not
    // hypothetical: react-router's replaceState path throws a SecurityError
    // for a cross-origin destination, and a wider `try` swallowed it into
    // this form's network-error branch.)
    try {
      await signIn(email, password);
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
      return;
    }

    // Drop every cached query BEFORE navigating. Two reasons, both
    // load-bearing: AuthGate's own session result from the visit that
    // redirected here is cached as `null`, and re-rendering the gate against
    // it would bounce straight back to /login — a loop caused purely by
    // stale cache. And on a shared machine the cache may still hold the
    // PREVIOUS user's runs (design §5.1).
    queryClient.clear();
    navigate(safeNext(params.get('next')), { replace: true });
  }

  return (
    // The one page in the app with no rail and no header, so it centres its
    // own card. `min-h-dvh`, not `min-h-screen`: `100vh` on mobile Safari is
    // the viewport WITHOUT the browser chrome, so a vertically-centred card
    // sits partly under the address bar until the user scrolls. `dvh` is the
    // dynamic height that accounts for it.
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4 sm:p-6">
      <div className="w-full max-w-sm">
        <header className="mb-6 flex flex-col items-center gap-3 text-center">
          {/* The brand mark, at the one moment the product has to introduce
              itself. Same tile as the rail's, so the page a user lands on and
              the app they land in are visibly the same product. */}
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-mark text-white shadow-raised">
            <ActivityIcon className="h-6 w-6" />
          </span>
          <div className="flex flex-col gap-1">
            <h1
              ref={heading}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight outline-none"
            >
              PerfPortal
            </h1>
            {/* Still an `<h2>`, not a styled `<p>`: the form below is a
                section of this page and this names it, which is what a
                screen-reader user navigating by heading needs. */}
            <h2 className="text-[13px] text-muted">Sign in to your organisation</h2>
          </div>
        </header>

        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 rounded-xl border border-default bg-surface p-5 shadow-panel sm:p-6"
        >
          <div className="flex flex-col gap-1.5">
            {/* A real <label htmlFor>, not a placeholder or aria-label: the
                Playwright suite selects by label (helpers.ts), so losing the
                association fails a test rather than quietly failing an audit. */}
            <label htmlFor="email" className="text-[13px] font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`${INPUT} h-10`}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-[13px] font-medium">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${INPUT} h-10`}
            />
          </div>

          {error !== null && (
            // Below the fields and above the submit button — the reading order
            // a reader who just pressed Sign in follows back up. `role="alert"`
            // announces it without moving focus, so a keyboard user is not
            // thrown out of the field they were about to correct.
            <p
              role="alert"
              className="tint flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] text-[color:var(--color-status-failed)]"
            >
              <AlertIcon className="mt-px h-4 w-4 shrink-0" />
              {error}
            </p>
          )}

          {/* The one primary action on the page. `loading` disables it AND
              says so with `aria-busy`, which is what stops a second submit
              racing the first. */}
          <Button type="submit" variant="primary" loading={submitting} className="mt-1 w-full">
            Sign in
          </Button>
        </form>
      </div>
    </main>
  );
}
