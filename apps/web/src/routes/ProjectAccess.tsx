import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  TOKEN_SCOPES,
  type MintedToken,
  type TokenListResponse,
  type TokenScopeName,
  type TokenSummary,
} from '@perfportal/contracts';
import Button from '../components/Button';
import Card from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { CheckIcon, CopyIcon, TokenIcon } from '../components/icons';
import { ProblemError } from '../api/fetch';
import {
  fetchProjectTokens,
  mintProjectToken,
  projectTokensQueryKey,
  revokeProjectToken,
} from '../api/tokens';
import { INPUT, ROW, TABLE, TD, TH, THEAD } from '../components/tableStyles';
import { formatInstant } from './format';
import ProjectShell from './ProjectShell';
import { projectSetupPath } from './paths';

/**
 * Credentials, and nothing else — review M15.
 *
 * This is the token half of the old `ProjectSetup`, moved out whole. Nothing
 * about minting or revoking changed; what changed is that a reader who came
 * here came for a credential, rather than arriving because it was the only
 * page that also happened to explain how to upload a report.
 *
 * Each section still announces its own failure into its own block
 * (`token-mint`, `token-list`) — a page-wide `getByRole('alert')` would ask
 * "did anything fail" instead of "did the mint", which is the trap CLAUDE.md
 * records this page teaching once already.
 */
const DEFAULT_SCOPES: TokenScopeName[] = ['ingest', 'read'];

/**
 * What each scope lets a holder DO, in the reader's words rather than the
 * enum's. `ingest` is first because it is the one the Add results page sends
 * people here for.
 */
const SCOPE_LABELS: Record<TokenScopeName, string> = {
  ingest: 'Completed reports',
  read: 'Read dashboards',
  telemetry: 'Generator telemetry',
  stream: 'Live run stream',
  runner: 'On-prem runner',
};

export default function ProjectAccess() {
  return (
    /* The section is named "API tokens", not "Access" (review 09-13 M18), by
       `ProjectShell`'s own tab table — "Access" promises members and roles;
       this page issues and revokes API tokens and nothing else. The URL stays
       `/access`: a label is not a bookmark, and `paths.ts` already argues
       that case for `/setup`. */
    <ProjectShell
      current="access"
      intro="Credentials for CI, load generators and runner hosts — each carrying only the permissions you give it."
    >
      {({ slug }) => <AccessLoaded key={slug} slug={slug} />}
    </ProjectShell>
  );
}

function AccessLoaded({ slug }: { readonly slug: string }) {
  const queryClient = useQueryClient();
  const tokens = useQuery({
    queryKey: projectTokensQueryKey(slug),
    queryFn: () => fetchProjectTokens(slug),
  });
  const [tokenName, setTokenName] = useState('CI ingest');
  const [scopes, setScopes] = useState<Set<TokenScopeName>>(() => new Set(DEFAULT_SCOPES));
  /* ═══ EXPIRY IS A CHOICE WITH NO DEFAULT (review 09-13 M18) ═══
   *
   * `null` is "never", and it is the initial value. The finding asks for token
   * expiry to be ASSESSED as a product requirement, not for a policy to be
   * invented here — a default TTL would impose one on every project on the
   * next deploy, including CI that has run untouched for a year.
   *
   * DURATIONS, NOT A DATE PICKER. "90 days" is the unit a token is actually
   * issued in, and it sidesteps the question a date control cannot avoid:
   * midnight in WHOSE zone. The absolute instant is computed once, at submit,
   * from the reader's own clock. */
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const selectedScopes = useMemo(() => TOKEN_SCOPES.filter((scope) => scopes.has(scope)), [scopes]);

  const mintMutation = useMutation({
    mutationFn: () =>
      mintProjectToken(slug, {
        name: tokenName.trim(),
        scopes: selectedScopes,
        /* Computed at SUBMIT, not at render: a form left open over a long
           lunch would otherwise mint a token counted from when the page
           loaded. Omitted entirely for "never", because the field is optional
           and `undefined` is what the schema reads as "no expiry". */
        ...(expiresInDays === null
          ? {}
          : { expiresAt: new Date(Date.now() + expiresInDays * 86_400_000).toISOString() }),
      }),
    onSuccess: (token) => {
      setMinted(token);
      setCopied(false);
      void queryClient.invalidateQueries({ queryKey: projectTokensQueryKey(slug) });
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (prefix: string) => revokeProjectToken(slug, prefix),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectTokensQueryKey(slug) });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    mintMutation.mutate();
  };

  /**
   * NEVER CLAIM A COPY THAT DID NOT HAPPEN, which the optional chain used to
   * do. `await navigator.clipboard?.writeText(token)` evaluates to
   * `await undefined` wherever the Clipboard API is absent — any page not in
   * a secure context, i.e. plain http on anything but localhost, which is an
   * ordinary way to reach an on-prem install. That resolves, `setCopied(true)`
   * runs, the button says "Copied" with a tick, and the reader navigates away
   * from a secret they will never be shown again.
   *
   * The explicit guard turns the absent API into the same branch as a
   * rejected write (permission denied, or a document that is not focused),
   * so both surface as one honest failure with a real alternative: the token
   * is on screen in a <pre>, so selecting it by hand always works.
   */
  const copyToken = async () => {
    if (minted === null) return;
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        throw new Error('The clipboard is not available on this page.');
      }
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      // The message is the same either way, so the reason is not worth
      // surfacing: what the reader needs is "it did not copy, select it
      // yourself", not a DOMException name.
      setCopyFailed(true);
      setCopied(false);
    }
  };

  const problem = mintMutation.error instanceof ProblemError ? mintMutation.error : null;
  const revokeProblem = revokeMutation.error instanceof ProblemError ? revokeMutation.error : null;

  return (
    <div className="flex flex-col gap-6">
      {/* `data-testid` so a test can scope a query to THIS block. The page
          holds two independently-failing sections that each announce their own
          failure, so a bare page-wide `getByRole('alert')` asks "did anything
          go wrong" rather than "did the mint". */}
      <Card
        headingLevel={2}
        title="Create a token"
        description="Name it after whatever will use it, and tick only what that needs. The secret is shown once and never again."
        data-testid="token-mint"
      >
        <form className="flex max-w-2xl flex-col gap-4" onSubmit={submit}>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium text-primary">Token name</span>
            <input
              className={INPUT}
              value={tokenName}
              onChange={(event) => setTokenName(event.target.value)}
              required
            />
          </label>

          <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {/* "Permissions", not "Scopes" — the word a reader brings with them
                  rather than the one the schema uses. */}
            <legend className="mb-1 text-[0.8125rem] font-medium text-primary">Permissions</legend>
            {TOKEN_SCOPES.map((scope) => (
              <label
                key={scope}
                className="flex items-center gap-2 rounded-lg border border-default bg-surface px-3 py-2 text-[0.8125rem] text-primary"
              >
                <input
                  type="checkbox"
                  checked={scopes.has(scope)}
                  onChange={(event) => {
                    setScopes((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(scope);
                      else next.delete(scope);
                      return next;
                    });
                  }}
                />
                <span>{SCOPE_LABELS[scope]}</span>
              </label>
            ))}
          </fieldset>

          <label className="flex max-w-xs min-w-0 flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium text-primary">Expires</span>
            <select
              data-testid="token-expiry"
              className={INPUT}
              value={expiresInDays === null ? '' : String(expiresInDays)}
              onChange={(event) =>
                setExpiresInDays(event.target.value === '' ? null : Number(event.target.value))
              }
            >
              {/* "Never" first and selected: it is what this page did before
                  this control existed, so a reader who ignores the field gets
                  exactly the behaviour they had. */}
              <option value="">Never</option>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
            </select>
            <span className="text-[0.75rem] text-muted">
              An expired token stops authenticating; it is not deleted, and the list still says it
              existed.
            </span>
          </label>

          {mintMutation.isError && (
            <div
              role="alert"
              className="rounded-lg border border-default bg-sunken p-3 text-[0.8125rem] text-primary"
            >
              {problem?.detail ?? mintMutation.error.message}
              {problem?.remediation && <p className="mt-1 text-muted">{problem.remediation}</p>}
            </div>
          )}

          <div>
            <Button type="submit" variant="primary" loading={mintMutation.isPending}>
              <TokenIcon className="h-3.5 w-3.5" />
              Create token
            </Button>
          </div>
        </form>

        {minted !== null && (
          <div className="rounded-lg border border-default bg-sunken p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[0.8125rem] font-semibold text-primary">Token shown once</p>
                <p className="text-[0.75rem] text-muted">Copy it before leaving this page.</p>
              </div>
              <Button size="sm" onClick={copyToken}>
                {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <pre className="mt-3 overflow-x-auto rounded-md border border-default bg-surface p-3 font-mono text-xs text-primary">
              {minted.token}
            </pre>
            {/* Announced, because the reader may already be reaching for the
                next thing — and this is their one chance at the secret. It
                points at the `<pre>` above rather than apologising: the
                token is on screen and selectable whatever the clipboard
                does. */}
            {copyFailed && (
              <p role="alert" className="mt-2 text-[0.75rem] leading-snug text-muted">
                The token could not be copied automatically — a browser only allows that on a secure
                (https) page. Select it above and copy it by hand before you leave.
              </p>
            )}

            {/* ═══ THE FLOW THE SPLIT WOULD OTHERWISE HAVE COST ═══
             *
             * The old page pasted the minted secret straight into the import
             * `curl`, so mint-then-copy handed you a runnable command. That
             * convenience is exactly what tied importing to the credentials
             * screen (review M15), so the command moved and now names an
             * environment variable instead.
             *
             * This link is the convenience without the coupling: the reader
             * who came here to get started is pointed at the thing they came
             * to do, and the reader who came only to rotate a credential can
             * ignore it. */}
            <p className="mt-3 text-[0.75rem] leading-snug text-muted">
              Next:{' '}
              <Link to={projectSetupPath(slug)} className="text-accent underline underline-offset-2">
                use it to add results
              </Link>
              .
            </p>
          </div>
        )}
      </Card>

      {/* Grouped, and at a TIGHTER gap than the page's own: the alert below
          is about a row in the table below it, and the comment on it says as
          much. The grouping is also the scope a test names to reach the
          revoke alert rather than whichever alert the page happens to hold —
          see `token-mint` above. */}
      <div className="flex flex-col gap-3" data-testid="token-list">
        {/* A FAILED REVOKE HAS TO SAY SO, and this is the one action where
            silence is dangerous rather than merely unhelpful. Without it the
            spinner simply stopped: the row still read "Active", nothing was
            announced, and an operator revoking a LEAKED credential could not
            tell that from success — the failure mode being "the attacker keeps
            the token and you stop looking".

            The wording does not claim the token is still live, because a
            request that failed on the way back may well have succeeded on the
            server. "May still be active" is what is actually known, and the
            reload is how the reader finds out which it was. `role="alert"` so
            it is announced when it appears, and it sits directly above the
            table whose row the reader just acted on. */}
        {revokeMutation.isError && (
          <div
            role="alert"
            className="rounded-lg border border-default bg-sunken p-3 text-[0.8125rem] text-primary"
          >
            <p className="font-medium">
              {revokeMutation.variables === undefined
                ? 'That token may still be active — revoking it did not complete.'
                : `Token ${revokeMutation.variables} may still be active — revoking it did not complete.`}
            </p>
            <p className="mt-1 text-muted">{revokeProblem?.detail ?? revokeMutation.error.message}</p>
            <p className="mt-1 text-muted">
              {revokeProblem?.remediation ?? 'Reload the page to see its current state, then try again.'}
            </p>
          </div>
        )}

        <TokenTable
          query={tokens}
          revoking={revokeMutation.isPending ? revokeMutation.variables ?? null : null}
          onRevoke={(prefix) => revokeMutation.mutate(prefix)}
        />
      </div>
    </div>
  );
}

/**
 * The token list, and the app's ONLY destructive control.
 *
 * REVOKING TAKES TWO DELIBERATE CLICKS, and the reason it is a two-step
 * button rather than a modal is the same one `ProjectRail` gives for not
 * being a drawer: a dialog needs focus capture, an escape handler, a scrim
 * and return-focus-on-close to be correct, and this repo runs Playwright with
 * a single Desktop Chrome project — so every one of those would ship
 * unverified. A button that changes its own label needs none of it, is
 * reachable by keyboard for free, and announces the change because the
 * accessible name really is different.
 *
 * `window.confirm` was the other candidate and is worse: it blocks the event
 * loop, cannot be styled, and reads as a browser malfunction rather than as
 * part of the page.
 */
function TokenTable({
  query,
  revoking,
  onRevoke,
}: {
  readonly query: UseQueryResult<TokenListResponse, Error>;
  readonly revoking: string | null;
  readonly onRevoke: (prefix: string) => void;
}) {
  // The prefix awaiting confirmation, or null. ONE at a time: arming a second
  // row disarms the first, so there is never more than one primed destructive
  // control on screen to mis-click.
  const [confirming, setConfirming] = useState<string | null>(null);

  if (query.isPending) return <LoadingState label="Loading tokens…" />;
  if (query.isError) {
    const problem = query.error instanceof ProblemError ? query.error : null;
    return (
      <ErrorState
        title="Tokens could not be loaded"
        detail={problem?.detail ?? query.error.message}
        remediation={problem?.remediation}
      />
    );
  }
  if (query.data.tokens.length === 0) {
    return (
      <EmptyState
        title="No tokens yet"
        /* WHAT A TOKEN IS FOR, not a second copy of the intro above — which
           already names the three consumers, and is on screen at the same time
           as this. A browser session carries `read`, `ingest` and `runner`
           itself (`auth.middleware.ts`), so the honest distinction is not
           "nothing can post without a token": it is that a token is how a
           MACHINE gets in without one. */
        body="Create one above. A token is how a machine reaches this project without a browser session."
      />
    );
  }
  const caption =
    'Every API token in this project. The secret is shown once when the token is created and ' +
    'never again — the Prefix column is what identifies it afterwards. To rotate one, create ' +
    'its replacement first and revoke the old token once the new one is in use: nothing here ' +
    'edits a token in place, because the secret cannot be re-read to hand over.';
  return (
    <TableFrame caption={caption} label="Project tokens table">
      <table className={TABLE}>
        <caption className="sr-only">{caption}</caption>
        <thead className={THEAD}>
          <tr>
            <th scope="col" className={TH}>Name</th>
            <th scope="col" className={TH}>Prefix</th>
            <th scope="col" className={TH}>Permissions</th>
            <th scope="col" className={TH}>Created</th>
            <th scope="col" className={TH}>Last used</th>
            <th scope="col" className={TH}>Expires</th>
            <th scope="col" className={TH}>Status</th>
            <th scope="col" className={TH}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {query.data.tokens.map((token) => (
            <tr key={token.prefix} className={ROW}>
              <td className={TD}>{token.name}</td>
              <td className={`${TD} font-mono`}>{token.prefix}</td>
                            {/* THE SAME WORDS THE FORM USED. This printed the raw enum —
                  `ingest, read` — beside a form whose checkboxes said
                  "Completed reports" and "Read dashboards", so the thing you
                  created and the thing you are looking at did not share a
                  vocabulary. An unknown scope falls back to its own name
                  rather than disappearing. */}
              <td className={TD}>
                {token.scopes
                  .map((scope) => (SCOPE_LABELS as Record<string, string | undefined>)[scope] ?? scope)
                  .join(', ')}
              </td>
              <td className={TD}>{formatInstant(token.createdAt)}</td>
              <td className={TD}>
                {token.lastUsedAt === null ? 'Never' : formatInstant(token.lastUsedAt)}
              </td>
              <td className={TD}>
                {token.expiresAt === null || token.expiresAt === undefined
                  ? 'Never'
                  : formatInstant(token.expiresAt)}
              </td>
              {/* THREE STATES, NOT TWO (review 09-13 M18). See `tokenStatus`. */}
              <td className={TD}>{tokenStatus(token)}</td>
              <td className={TD}>
                {confirming === token.prefix ? (
                  // ARMED. The accessible name changes from "Revoke" to
                  // "Confirm revoke", so a screen reader announces that the
                  // control now does something different — which is the whole
                  // point of the step, and something a modal would have had
                  // to arrange by hand.
                  <div className="flex flex-col gap-1.5">
                    {/* THE CONSEQUENCE AS VISIBLE TEXT, and never as a
                        `title` on the button. A tooltip is hover-only, so a
                        touch user never sees it — and putting one on a
                        control that already has a label makes the ACCESSIBLE
                        NAME ambiguous: with both present, Chromium's
                        accessibility tree reported this button as
                        "Revoking is permanent…" rather than "Revoke", while
                        jsdom kept reading the text content, so the unit suite
                        saw nothing wrong. That is the exact class of defect
                        CLAUDE.md records as visible only in a browser.
                        Sibling text carries the warning without touching any
                        button's name. */}
                    <p className="text-[0.75rem] leading-snug text-muted">
                      Permanent. Anything still using it starts failing.
                    </p>
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        /* NOT `primary` — review.md 20, "one primary action per task".
                           `Button`'s own docstring states that rule ("exactly ONE `primary`
                           per screen"), and an armed confirmation broke it: this sat beside
                           the page's own primary, so the most prominent control on screen
                           became the destructive one.
                        
                           `secondary`, not a new `danger` variant: `Button.tsx` records that
                           the red one would need cannot be written as a utility, because
                           status colour is deliberately kept out of `@theme`. Demoting costs
                           nothing — this button lives inside a block the reader armed on
                           purpose, under a sentence saying what it does, beside a Cancel. */
                        loading={revoking === token.prefix}
                        onClick={() => {
                          setConfirming(null);
                          onRevoke(token.prefix);
                        }}
                      >
                        Confirm revoke
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={revoking === token.prefix}
                    disabled={token.revokedAt !== null}
                    // NO `title` here — see the armed branch above for why a
                    // tooltip on a labelled control is not a free addition.
                    onClick={() => setConfirming(token.prefix)}
                  >
                    Revoke
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}

/**
 * Active / Expired / Revoked (review 09-13 M18).
 *
 * REVOKED WINS OVER EXPIRED, and the order is the whole function. A token can
 * be both — revoked last month, expiry passed since — and only one of the two
 * explains why it stopped working. "Revoked" says somebody killed it, which is
 * actionable; "Expired" would say it ran out, which is true and misleading.
 *
 * `undefined` is an API pod that predates the field, not a token without an
 * expiry, and it reads as Active because that is exactly what such a pod
 * reported before this column existed.
 */
function tokenStatus(token: TokenSummary): 'Active' | 'Expired' | 'Revoked' {
  if (token.revokedAt !== null) return 'Revoked';
  if (token.expiresAt != null && Date.parse(token.expiresAt) <= Date.now()) return 'Expired';
  return 'Active';
}
