import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  TOKEN_SCOPES,
  type MintedToken,
  type TokenListResponse,
  type TokenScopeName,
} from '@perfportal/contracts';
import Button, { linkButtonClasses } from '../components/Button';
import Card from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { CheckIcon, ChevronLeftIcon, CopyIcon, PlayIcon, TokenIcon } from '../components/icons';
import { ProblemError } from '../api/fetch';
import { fetchProjects, projectsQueryKey } from '../api/projects';
import {
  fetchProjectTokens,
  mintProjectToken,
  projectTokensQueryKey,
  revokeProjectToken,
} from '../api/tokens';
import { INPUT, ROW, TABLE, TD, TH, THEAD } from '../components/tableStyles';
import useDocumentTitle from '../useDocumentTitle';
import { projectNewRunnerRunPath, projectPath } from './paths';

const DEFAULT_SCOPES: TokenScopeName[] = ['ingest', 'read'];
const SCOPE_LABELS: Record<TokenScopeName, string> = {
  ingest: 'Completed reports',
  read: 'Read dashboards',
  telemetry: 'Generator telemetry',
  stream: 'Live run stream',
  runner: 'On-prem runner',
};

export default function ProjectSetup() {
  const { slug = '' } = useParams<{ slug: string }>();
  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  const project = projects.data?.items.find((p) => p.slug === slug) ?? null;
  const title = project?.name ? `Setup · ${project.name}` : 'Project setup';
  useDocumentTitle(title);

  if (projects.isPending) return <LoadingState label="Loading project…" />;
  if (projects.isError) {
    const error = projects.error;
    const problem = error instanceof ProblemError ? error : null;
    return (
      <ErrorState
        titleAs="h1"
        title="The project could not be loaded"
        detail={problem?.detail ?? error.message}
        remediation={problem?.remediation}
      />
    );
  }
  if (project === null) {
    return (
      <ErrorState
        titleAs="h1"
        title="Project not found"
        detail={`No project "${slug}" is visible to this session.`}
        action={<BackToProject slug={slug} />}
      />
    );
  }

  return <ProjectSetupLoaded slug={slug} projectName={project.name} />;
}

function ProjectSetupLoaded({
  slug,
  projectName,
}: {
  readonly slug: string;
  readonly projectName: string;
}) {
  const queryClient = useQueryClient();
  const tokens = useQuery({
    queryKey: projectTokensQueryKey(slug),
    queryFn: () => fetchProjectTokens(slug),
  });
  const [tokenName, setTokenName] = useState('CI ingest');
  const [scopes, setScopes] = useState<Set<TokenScopeName>>(() => new Set(DEFAULT_SCOPES));
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const selectedScopes = useMemo(() => TOKEN_SCOPES.filter((scope) => scopes.has(scope)), [scopes]);

  const mintMutation = useMutation({
    mutationFn: () => mintProjectToken(slug, { name: tokenName.trim(), scopes: selectedScopes }),
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
  const revokeProblem =
    revokeMutation.error instanceof ProblemError ? revokeMutation.error : null;
  const commandToken = minted?.token ?? '$PERFPORTAL_TOKEN';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Link to={projectPath(slug)} className="inline-flex items-center gap-1 text-[13px] font-medium text-muted hover:text-primary">
            <ChevronLeftIcon className="h-3.5 w-3.5" />
            {projectName}
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">Project setup</h1>
        </div>
        <Link to={projectNewRunnerRunPath(slug)} className={linkButtonClasses}>
          <PlayIcon className="h-3.5 w-3.5" />
          New on-prem run
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card title="API tokens" description="Issue scoped credentials for CI, agents, and runners.">
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[13px] font-medium text-primary">Token name</span>
              <input className={INPUT} value={tokenName} onChange={(event) => setTokenName(event.target.value)} required />
            </label>

            <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <legend className="mb-1 text-[13px] font-medium text-primary">Scopes</legend>
              {TOKEN_SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-2 rounded-lg border border-default bg-surface px-3 py-2 text-[13px] text-primary">
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

            {mintMutation.isError && (
              <div role="alert" className="rounded-lg border border-default bg-sunken p-3 text-[13px] text-primary">
                {problem?.detail ?? mintMutation.error.message}
                {problem?.remediation && <p className="mt-1 text-muted">{problem.remediation}</p>}
              </div>
            )}

            <Button type="submit" variant="primary" loading={mintMutation.isPending}>
              <TokenIcon className="h-3.5 w-3.5" />
              Mint token
            </Button>
          </form>

          {minted !== null && (
            <div className="rounded-lg border border-default bg-sunken p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-primary">Token shown once</p>
                  <p className="text-[12px] text-muted">Copy it before leaving this page.</p>
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
                <p role="alert" className="mt-2 text-[12px] leading-snug text-muted">
                  The token could not be copied automatically — a browser only
                  allows that on a secure (https) page. Select it above and copy
                  it by hand before you leave.
                </p>
              )}
            </div>
          )}
        </Card>

        <Card title="Create tests" description="Two supported paths into this project.">
          <div className="flex flex-col gap-4 text-[13px]">
            <div className="flex flex-col gap-2">
              <p className="font-medium text-primary">Upload completed reports</p>
              <pre className="overflow-x-auto rounded-lg border border-default bg-sunken p-3 font-mono text-xs leading-relaxed text-primary">
{`curl -H "Authorization: Bearer ${commandToken}" \\
  -F bundle=@results.tgz \\
  -F 'metadata={"tool":"gatling"}' \\
  /v1/runs`}
              </pre>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-medium text-primary">Run from the web</p>
              <Link to={projectNewRunnerRunPath(slug)} className={linkButtonClasses}>
                <PlayIcon className="h-3.5 w-3.5" />
                Queue on-prem run
              </Link>
            </div>
          </div>
        </Card>
      </div>

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
          className="rounded-lg border border-default bg-sunken p-3 text-[13px] text-primary"
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
    return <EmptyState title="No tokens yet" body="Mint a scoped project token when CI, telemetry, or runner hosts need access." />;
  }
  const caption = 'Project API tokens. Plaintext secrets are never listed after minting.';
  return (
    <TableFrame caption={caption} label="Project tokens table">
      <table className={TABLE}>
        <caption className="sr-only">{caption}</caption>
        <thead className={THEAD}>
          <tr>
            <th scope="col" className={TH}>Name</th>
            <th scope="col" className={TH}>Prefix</th>
            <th scope="col" className={TH}>Scopes</th>
            <th scope="col" className={TH}>Created</th>
            <th scope="col" className={TH}>Last used</th>
            <th scope="col" className={TH}>Status</th>
            <th scope="col" className={TH}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {query.data.tokens.map((token) => (
            <tr key={token.prefix} className={ROW}>
              <td className={TD}>{token.name}</td>
              <td className={`${TD} font-mono`}>{token.prefix}</td>
              <td className={TD}>{token.scopes.join(', ')}</td>
              <td className={TD}>{formatDate(token.createdAt)}</td>
              <td className={TD}>{token.lastUsedAt === null ? 'Never' : formatDate(token.lastUsedAt)}</td>
              <td className={TD}>{token.revokedAt === null ? 'Active' : 'Revoked'}</td>
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
                    <p className="text-[12px] leading-snug text-muted">
                      Permanent. Anything still using it starts failing.
                    </p>
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="primary"
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

function BackToProject({ slug }: { readonly slug: string }) {
  return (
    <Link to={projectPath(slug)} className={linkButtonClasses}>
      <ChevronLeftIcon className="h-3.5 w-3.5" />
      Back to project
    </Link>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}
