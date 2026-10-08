import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ProjectAccess } from '../access/useAccess';
import { linkButtonClasses } from '../components/Button';
import Card from '../components/Card';
import InfoTip from '../components/InfoTip';
import { ChevronRightIcon, PlayIcon, TokenIcon, UploadIcon } from '../components/icons';
import { fetchRunnerJobs, runnerJobsQueryKey } from '../api/runner';
import ProjectShell from './ProjectShell';
import { projectAccessPath, projectNewRunnerRunPath } from './paths';
import { runnerReadiness } from './runnerReadiness';
import RunnerStatusLine from './RunnerStatusLine';
import BundleUpload from './BundleUpload';

/**
 * HOW A RUN GETS INTO THIS PROJECT — review M15.
 *
 * ═══ WHAT THIS PAGE USED TO BE ═══
 *
 * Token minting, token revocation, an import snippet and SLA rules, in one
 * scroll. The review's objection is sharper than "it was long": the ONLY
 * route to importing a completed report was a `curl` sitting inside token
 * management, under a card headed "Create tests". So the first thing a new
 * user needs was reachable only by opening a credentials screen and reading
 * past it, and the most prominent action on the page was "New on-prem run" —
 * useless to somebody who already has a results bundle in their hand.
 *
 * ═══ THREE EXPLICIT CHOICES ═══
 *
 * The three are the three real ways in, named for what the reader is trying
 * to do rather than for the mechanism:
 *
 *   Import results   — a bundle already exists: the picker, or `POST /v1/runs`
 *                      from a terminal.
 *   Run a test       — no bundle yet; the on-prem runner makes one.
 *   Configure CI     — the same import, but from a pipeline, every build.
 *
 * The review asks for a "clear guide and status" rather than burial, and the
 * STATUS half is the part that is easy to fake. Two of these are available
 * because the endpoint exists; the third depends on a machine this instance
 * cannot see, so its status is computed from evidence and says "unknown" when
 * that is the truth. See `runnerReadiness`.
 *
 * ═══ THE CREDENTIAL IS A NAMED PREREQUISITE, NOT A PLACE TO HIDE ═══
 *
 * Posting from a terminal or a pipeline needs a token (the picker does not: a
 * signed-in upload goes through the session). The fix is not to drop the
 * dependency, it is to state it where it applies and link to it — the
 * opposite of the old arrangement, where the import instructions were a
 * paragraph inside the credentials screen.
 */
export default function ProjectSetup() {
  return (
    /* ═══ NO `intro` (review 09-13, "Copy changes to make immediately") ═══
     *
     * This read "Three ways to get a run into this project. Pick the one that
     * matches what you already have." The review's copy table replaces that
     * whole pattern with "`Add results` with short workflow choices", and M04
     * already built the choices: three cards, each a title and its action
     * since clean UI PR 4, under a nav whose current section is called Add
     * results.
     *
     * So the sentence was narrating what the reader could already see — it
     * counted the cards below it and told them to pick one. The section name
     * says what this page is and the cards say what the choices are; a
     * paragraph between them is the over-explanation the same review's N04
     * objects to elsewhere.
     *
     * `ProjectShell` has no `intro` at all since clean UI PR 4 — a section is
     * named by its nav, and `tsc` refuses a page that tries to add one. */
    <ProjectShell current="setup">
      {({ slug, access }) => <AddResults key={slug} slug={slug} access={access} />}
    </ProjectShell>
  );
}

/**
 * ═══ EVERY WAY TO API TOKENS IS A MANAGER'S ═══
 *
 * Three links here lead to API tokens — Import's and CI's "Create one", and
 * the runner card's "Create a runner token" — and that page exists to manage
 * tokens, which is `tokens:manage`. So each is drawn only when the reader may
 * (gate by destination): anyone else would follow it to a page that can only
 * tell them no. The PREREQUISITE stays named either way — a command that
 * needs `PERFPORTAL_TOKEN` still says so — and only the way there goes. Until
 * access is known none of the three is drawn.
 */
function AddResults({ slug, access }: { readonly slug: string; readonly access: ProjectAccess }) {
  const canManageTokens = access.can('tokens:manage');
  /* The instance the reader is already talking to. A hard-coded localhost
     would be wrong for every real deployment, and a relative path is not
     runnable at all: this ended in a bare `/v1/runs` once, so the one command
     this page exists to hand a new user failed with "No host part in the
     request URL". `window.location.origin` is the honest source — the reader
     is being served this page FROM the instance they need to post to, so it
     is right for a custom domain and a port alike. */
  const instanceOrigin = typeof window === 'undefined' ? '' : window.location.origin;

  /* The SAME query the launch form runs, so the status quoted here and the
     panel over there cannot disagree. Polled only while something is in
     flight — a page nobody is launching from should not hold a two-second
     timer open forever. */
  const jobs = useQuery({
    queryKey: runnerJobsQueryKey(slug),
    queryFn: () => fetchRunnerJobs(slug),
    refetchInterval: 15_000,
  });

  /* ONE COLUMN, NOT `xl:grid-cols-2`. Review M04 objects to "the third card
     below the first two" — a 2-up grid leaves the CI path orphaned in a row of
     its own at every width that fits two, which reads as an afterthought
     rather than the third of three equal choices. Collapsed, the three are
     short enough that a column is the right shape: a list of choices. */
  return (
    <div className="flex flex-col gap-4">
        {/* ═══ THE CARD THAT COULD NOT KEEP ITS PROMISE, AND NOW DOES (M05) ═══
         *
         * The finding is a capability mismatch: the card promised an import and
         * then told the reader there is no browser upload, so the one thing its
         * title offered was the one thing it could not do. "Import via API" was
         * the INTERIM the finding itself specifies — label the path honestly
         * until the picker exists.
         *
         * THIS COMMENT USED TO ARGUE THE PICKER COULD NOT BE BUILT FROM HERE,
         * and it was right at the time: `POST /v1/runs` is the only route that
         * accepted a bundle and it REFUSES a browser session by design —
         * `ingest.controller.ts` reads `tenant.projectId` and answers
         * `PROJECT_REQUIRED`, because a session is org-scoped and names no
         * project while a token is minted against exactly one.
         *
         * So the picker was blocked on a route, not on a component. That route
         * exists now: `POST /v1/projects/:slug/runs` resolves the project from
         * the URL within the session's own org, which is the resolution
         * `TokensController` has always used for a session-only project route.
         * The title is the plain one again because the card can now do what it
         * says. */}
      <EntryCard
        title="Import results"
        icon={<UploadIcon className="h-4 w-4" />}
        disclosure={{
          summary: 'Or post it from a terminal',
          children: (
            <>
              {/* THE TOKEN BELONGS HERE, NOT ON THE CARD (clean UI PR 4). The
                  card used to say "Needs a token with the Completed reports
                  permission" over a picker that needs none — a signed-in upload
                  goes through the session. Only this command needs one. */}
              <p className="flex flex-wrap items-center gap-x-1 text-[0.8125rem] text-muted">
                <span>
                  Needs <code className="font-mono text-primary">PERFPORTAL_TOKEN</code> (Completed
                  reports)
                  {canManageTokens && (
                    <>
                      {' · '}
                      <Link to={projectAccessPath(slug)} className="text-accent underline underline-offset-2">
                        Create one
                      </Link>
                    </>
                  )}
                </span>
                <InfoTip label="About posting results">
                  The picker above and this command reach the same ingest pipeline. The bundle is a
                  .tgz of the run directory Gatling wrote, simulation.log included; the response is a
                  202 with the run’s id, and the worker parses it in the background.
                </InfoTip>
              </p>
              <pre
                data-testid="upload-command"
                className="overflow-x-auto rounded-lg border border-default bg-sunken p-3 font-mono text-xs leading-relaxed text-primary"
              >
                {`curl -H "Authorization: Bearer $PERFPORTAL_TOKEN" \\
  -F bundle=@results.tgz \\
  -F 'metadata={"tool":"gatling"}' \\
  ${instanceOrigin}/v1/runs`}
              </pre>
            </>
          ),
        }}
      >
        {/* The picker is the card's action, so it is ON the card rather than
            behind a disclosure (clean UI PR 4). */}
        <BundleUpload slug={slug} />
      </EntryCard>

      <EntryCard title="Run a test" icon={<PlayIcon className="h-4 w-4" />}>
        <RunnerStatusLine query={jobs} />
        {/* ═══ A WAY TO GET A RUNNER, WHEN THERE HAS NEVER BEEN ONE ═══
            The review 09-13 copy table asks for "`Runner availability unknown`
            + a useful connection/setup action". The token is the half this app
            owns — deploying the process is `infra/README.md`'s — so the action
            is the one link a reader can follow in the product (clean UI PR 4:
            a link, where it used to be a three-sentence paragraph).

            `needsSetup` is true for the `unknown` state ALONE. `idle` and
            `stalled` mean a runner HAS been seen, and telling that reader to
            go set one up is wrong advice confidently given — review M12. */}
        {/* Only on a SETTLED list: one still loading, or one that failed, has
            seen nothing either way, and offering setup under "Checking…" or
            "Status unavailable" is the wrong advice M12 was about. */}
        {/* And only for a reader who may create the token (gate by
            destination, above). */}
        {jobs.isSuccess && runnerReadiness(jobs.data.items).needsSetup && canManageTokens && (
          <Link
            to={projectAccessPath(slug)}
            data-testid="runner-setup"
            className="w-fit text-[0.8125rem] text-accent underline underline-offset-2"
          >
            Create a runner token
          </Link>
        )}
        <div>
          <Link to={projectNewRunnerRunPath(slug)} className={linkButtonClasses}>
            <PlayIcon className="h-3.5 w-3.5" />
            New on-prem run
          </Link>
        </div>
      </EntryCard>

      <EntryCard
        title="Configure CI"
        icon={<TokenIcon className="h-4 w-4" />}
        disclosure={{
          summary: 'Show me how',
          children: (
            <>
              <p className="flex flex-wrap items-center gap-x-1 text-[0.8125rem] text-muted">
                <span>
                  Store the token as <code className="font-mono text-primary">PERFPORTAL_TOKEN</code> in
                  your pipeline secrets
                  {canManageTokens && (
                    <>
                      {' · '}
                      <Link to={projectAccessPath(slug)} className="text-accent underline underline-offset-2">
                        Create one
                      </Link>
                    </>
                  )}
                </span>
                <InfoTip label="About the CI step">
                  branch and commitSha let the Compare page tell a regression from a different build;
                  both are optional.
                </InfoTip>
              </p>
              <pre
                data-testid="ci-command"
                className="overflow-x-auto rounded-lg border border-default bg-sunken p-3 font-mono text-xs leading-relaxed text-primary"
              >
                {`# after gradlew gatlingRun
tar -czf results.tgz -C build/reports/gatling .
curl -fsS -H "Authorization: Bearer $PERFPORTAL_TOKEN" \\
  -F bundle=@results.tgz \\
  -F 'metadata={"tool":"gatling","branch":"'"$CI_BRANCH"'","commitSha":"'"$CI_COMMIT"'"}' \\
  ${instanceOrigin}/v1/runs`}
              </pre>
              {/* NO VERSION NUMBER. The Gradle plugin is built from this
                  repository and is not on a public plugin portal, so a
                  coordinate quoted here would be a string this page cannot
                  verify — which is how the plugin's own e2e script came to name
                  a version that had not existed for two releases. */}
              <p className="text-[0.8125rem] text-muted">
                Live view while the build runs: Gradle plugin{' '}
                <code className="font-mono text-primary">dev.vantrix.gatling</code> (
                <code className="font-mono text-primary">clients/gatling-gradle</code>)
              </p>
            </>
          ),
        }}
      />
    </div>
  );
}

/* ======================================================================== *
 * THE CARD — A TITLE AND ITS ACTION
 * ======================================================================== */

function EntryCard({
  title,
  icon,
  children,
  disclosure,
}: {
  readonly title: string;
  readonly icon: ReactNode;
  /* No description prop (clean UI PR 4): each card is a title and then its
     action, and a sentence under the title restated what the action shows.
     No status prop: only the runner has a state, and its card draws it as
     its first child (`RunnerStatusLine`, clean UI PR 4). Review 09-13 N04
     removed the badges that could not vary; three identical green dots
     taught the reader to skip the one that matters. */
  readonly children?: ReactNode;
  /**
   * The commands — everything review M04 says must not be on screen for all
   * three paths at once — behind a summary the caller names ("Or post it
   * from a terminal", "Show me how"). Optional: a path whose whole content is
   * already one short choice (running a test is a button) has nothing to
   * hide, and wrapping it in a disclosure would bury an action rather than
   * shorten a document.
   */
  readonly disclosure?: { readonly summary: string; readonly children: ReactNode };
}) {
  return (
    <Card headingLevel={2} data-testid={`entry-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-muted">{icon}</span>
            {/* `text-base`, the `<h2>` rung. These three cards are SECTIONS of
                the page — `project-tests.spec.ts` and `ProjectSetup.test.tsx`
                both query them by `level: 2` — and this drew them at the card
                rung's 15px. review.md 20, "consistent heading sizes". */}
            <h2 className="text-base font-semibold tracking-tight text-primary">{title}</h2>
          </div>
        </div>
        {children}

        {/* ═══ THE WORKFLOW, BEHIND ONE CLICK — review M04 ═══
         *
         * The finding is that this page "presented documentation as task UI":
         * all three paths showed their explanations, prerequisites, code and
         * implementation caveats at once. What it asks for is three short
         * choices with only the chosen workflow expanded.
         *
         * So the CHOICE stays on screen — icon, title and the card's action
         * (since clean UI PR 4) — and the commands and caveats move in here.
         *
         * `name` MAKES IT AN ACCORDION WITH NO JAVASCRIPT. Browsers close the
         * other `<details>` sharing a name, which is exactly "expand only the
         * chosen workflow"; where that is unsupported they simply open
         * independently, which is the old behaviour and not a defect.
         *
         * THE `<h2>` STAYS OUTSIDE THE `<summary>`. A heading inside one is
         * valid HTML and a trap: a `<summary>`'s descendants are presentational
         * in the accessibility tree, so the page's entire heading outline would
         * vanish — and `project-tests.spec.ts` and `ProjectSetup.test.tsx` both
         * query these three by `level: 2`. The same shape as the `aria-hidden`
         * TableFrame defect this repo already paid for: markup that looks
         * tidier and quietly removes something only a screen reader uses. */}
        {disclosure !== undefined && (
          <details name="add-results" className="group">
            {/* THE CHEVRON SAYS OPEN OR CLOSED (PR 4 cleanup). The summary's
                words are the same either way — they used to swap "Show me
                how" / "Hide the steps" — so a turning chevron carries the
                state. `aria-hidden`: a screen reader already hears
                expanded or collapsed on the summary itself. */}
            <summary className="inline-flex w-fit cursor-pointer list-none items-center gap-1 text-[0.75rem] font-medium text-accent hover:underline hover:underline-offset-2">
              {disclosure.summary}
              <ChevronRightIcon
                className="h-3 w-3 transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
            </summary>
            <div className="mt-3 flex flex-col gap-3">{disclosure.children}</div>
          </details>
        )}
      </div>
    </Card>
  );
}
