import type { ReactNode } from 'react';
import type { RunnerJobListResponse } from '@perfportal/contracts';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { linkButtonClasses } from '../components/Button';
import Card from '../components/Card';
import { PlayIcon, TokenIcon, UploadIcon } from '../components/icons';
import { fetchRunnerJobs, runnerJobsQueryKey } from '../api/runner';
import ProjectShell from './ProjectShell';
import { projectAccessPath, projectNewRunnerRunPath } from './paths';
import { runnerReadiness, type RunnerReadinessKind } from './runnerReadiness';
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
 * ═══ THREE EXPLICIT CHOICES, EACH WITH A STATUS ═══
 *
 * The three are the three real ways in, named for what the reader is trying
 * to do rather than for the mechanism:
 *
 *   Import via API   — a bundle already exists. `POST /v1/runs`.
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
 * Importing still needs a token. The fix is not to drop the dependency, it is
 * to state it and link to it — the opposite of the old arrangement, where the
 * import instructions were a paragraph inside the credentials screen.
 */
export default function ProjectSetup() {
  return (
    /* ═══ NO `intro` (review 09-13, "Copy changes to make immediately") ═══
     *
     * This read "Three ways to get a run into this project. Pick the one that
     * matches what you already have." The review's copy table replaces that
     * whole pattern with "`Add results` with short workflow choices", and M04
     * already built the choices: three collapsed cards, each a title, a status
     * and one sentence, under a nav whose current section is called Add
     * results.
     *
     * So the sentence was narrating what the reader could already see — it
     * counted the cards below it and told them to pick one. The section name
     * says what this page is and the cards say what the choices are; a
     * paragraph between them is the over-explanation the same review's N04
     * objects to elsewhere.
     *
     * `intro` stays on `ProjectShell` — it is optional and `ProjectRulesPage`
     * already passes none, so a section with no intro is the existing shape
     * rather than a new state. */
    <ProjectShell current="setup">{({ slug }) => <AddResults key={slug} slug={slug} />}</ProjectShell>
  );
}

function AddResults({ slug }: { readonly slug: string }) {
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
        description="You already have a finished Gatling report. Choose the bundle and PerfPortal parses it."
        steps={
          <>
          <BundleUpload slug={slug} />

          {/* The curl stays, one rung down. CI has no file picker, and
              "Configure CI" below points back at this command — but the reader
              holding a bundle no longer has to read a shell snippet to use it.
              A DISCLOSURE rather than the only way in. */}
          <details className="mt-1">
            <summary className="cursor-pointer text-[0.8125rem] text-muted">
              Or post it from a terminal
            </summary>
          <pre
            data-testid="upload-command"
            className="overflow-x-auto rounded-lg border border-default bg-sunken p-3 font-mono text-xs leading-relaxed text-primary"
          >
  {`curl -H "Authorization: Bearer $PERFPORTAL_TOKEN" \\
    -F bundle=@results.tgz \\
    -F 'metadata={"tool":"gatling"}' \\
    ${instanceOrigin}/v1/runs`}
          </pre>

          {/* This read "There is no browser upload form yet." It was true, it
              was the honest thing to say while that was the case, and it is now
              exactly the kind of stale claim this repo keeps paying for — so it
              goes with the thing it described. What survives is the fact a CI
              author still needs. */}
          <p className="text-[0.75rem] leading-snug text-muted">
            The picker above and this command reach the same ingest pipeline; use whichever suits
            the machine you are on.
          </p>
          <p className="text-[0.75rem] leading-snug text-muted">
            The bundle is a <code className="font-mono">.tgz</code> containing the run directory
            Gatling wrote, <code className="font-mono">simulation.log</code> included. The response is
            a 202 with the run’s id; the worker parses it in the background.
          </p>
          </details>
          </>
        }
      >
        <p className="text-[0.8125rem] leading-relaxed text-muted">
          Needs a token with the <span className="text-primary">Completed reports</span> permission.{' '}
          <Link to={projectAccessPath(slug)} className="text-accent underline underline-offset-2">
            Create one under API tokens
          </Link>
          , then export it as <code className="font-mono text-primary">PERFPORTAL_TOKEN</code>.
        </p>
      </EntryCard>

      <EntryCard
        title="Run a test"
        icon={<PlayIcon className="h-4 w-4" />}
        description="No bundle yet. Upload a Gatling jar or bundle and let an on-prem runner execute it."
        status={runnerStatus(jobs.isPending, jobs.isError, jobs.data?.items ?? [])}
      >
        <p className="text-[0.8125rem] leading-relaxed text-muted">
          The runner streams the log as it is written, so the run’s page is live while the test is
          still going. It executes one job at a time.
        </p>
        {/* ═══ AND A WAY TO GET ONE, WHEN THERE HAS NEVER BEEN ONE ═══
            (review 09-13, "Copy changes to make immediately")

            The row is "No runner seen yet + inference paragraphs" ->
            "`Runner availability unknown` + a useful connection/setup action".
            M12 delivered the headline and removed the affordance that asked
            the reader to QUEUE A LOAD TEST as a connectivity check; what it
            left behind was a state that says what is not known and offers
            nothing to do about it.

            THE TOKEN IS THE HALF THIS APP OWNS. Deploying a runner is a
            process you start beside the API and worker — `infra/README.md`
            has the variables — and no route can own that. What it needs FROM
            here is a credential carrying the On-prem runner permission, which
            is minted on the API tokens page and nowhere else. So the action
            names the deployment and links to the part a reader can actually
            do in the product, rather than linking somewhere plausible and
            leaving them to discover the rest.

            `needsSetup` is true for the `unknown` state ALONE. `idle` and
            `stalled` mean a runner HAS been seen and has stopped claiming —
            telling that reader to go set one up is the wrong advice
            confidently given, which is the shape M12 was about. */}
        {runnerReadiness(jobs.data?.items ?? []).needsSetup && (
          <p className="text-[0.8125rem] leading-relaxed text-muted" data-testid="runner-setup">
            To connect one, deploy the runner process beside this instance and give it a token
            carrying the <span className="text-primary">On-prem runner</span> permission.{' '}
            <Link to={projectAccessPath(slug)} className="text-accent underline underline-offset-2">
              Create one under API tokens
            </Link>
            .
          </p>
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
        description="Send reports from your CI pipeline, so the trend line keeps itself up to date."
        steps={
          <>
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
          <p className="text-[0.75rem] leading-snug text-muted">
            <span className="text-primary">branch</span> and{' '}
            <span className="text-primary">commitSha</span> are what let the Compare page tell a
            regression from a different build, so they are worth wiring up even though both are
            optional.
          </p>
          {/* NO VERSION NUMBER. The Gradle plugin is built from this repository
              and is not on a public plugin portal, so a coordinate quoted here
              would be a string this page cannot verify — which is exactly how
              the plugin's own e2e script came to name a version that had not
              existed for two releases. */}
          <p className="text-[0.75rem] leading-snug text-muted">
            For a LIVE view while the build runs rather than a report afterwards, there is a Gradle
            plugin (<code className="font-mono">dev.vantrix.gatling</code>) that streams the log as
            Gatling writes it. It ships with this repository under{' '}
            <code className="font-mono">clients/gatling-gradle</code>; its README carries the
            coordinates and its JDK 21 requirement.
          </p>
          </>
        }
      >
        <p className="text-[0.8125rem] leading-relaxed text-muted">
          Add one step after your existing Gatling task. The token belongs in the pipeline’s secret
          store, never in the repository.
        </p>
      </EntryCard>
    </div>
  );
}

/* ======================================================================== *
 * STATUS — THE HALF THAT MUST NOT OVERCLAIM
 * ======================================================================== */

type EntryStatus = {
  readonly kind: 'ready' | 'unknown' | 'busy' | 'problem';
  readonly label: string;
  readonly note?: string;
};

/**
 * The runner's own status, phrased for a card that is offering a choice.
 *
 * The query's OWN failure is a status too, and a distinct one: "this page
 * could not ask" is not the same claim as "no runner is there", and rendering
 * the second for the first would send somebody to restart a healthy machine.
 */
function runnerStatus(
  pending: boolean,
  errored: boolean,
  items: RunnerJobListResponse['items'],
): EntryStatus {
  if (pending) return { kind: 'unknown', label: 'Checking…' };
  if (errored) {
    return {
      kind: 'unknown',
      label: 'Status unavailable',
      note: 'The job list could not be loaded, so nothing is known about the runner either way.',
    };
  }
  const readiness = runnerReadiness(items);
  return { kind: STATUS_KIND[readiness.kind], label: readiness.headline, note: readiness.detail };
}

const STATUS_KIND: Record<RunnerReadinessKind, EntryStatus['kind']> = {
  busy: 'busy',
  waiting: 'busy',
  stalled: 'problem',
  // NOT 'ready'. An idle project proves a runner worked once, and nothing at
  // all about now — see `runnerReadiness`'s docstring.
  idle: 'unknown',
  unknown: 'unknown',
};

/* The status tokens are declared on `:root` rather than inside `@theme`, so
   Tailwind generates NO `text-status-*` utility for them — a class here would
   emit nothing and the label would silently inherit the body colour. CLAUDE.md
   records this trap twice; `var()` is how every other consumer reads them. */
const STATUS_COLOR: Record<EntryStatus['kind'], string> = {
  ready: 'var(--color-status-passed)',
  busy: 'var(--color-status-pending)',
  problem: 'var(--color-status-failed)',
  unknown: 'var(--color-status-not-applicable)',
};

function EntryCard({
  title,
  icon,
  description,
  status,
  children,
  steps,
}: {
  readonly title: string;
  readonly icon: ReactNode;
  readonly description: string;
  /* ═══ OPTIONAL, BECAUSE ONLY ONE CARD HAS A STATE (review 09-13 N04) ═══
   *
   * Two of the three read `Available now`, which was true the moment the
   * endpoint existed and could never say anything else — a badge that cannot
   * vary is decoration, and three identical green dots taught the reader to
   * skip the one that matters. The runner's IS a real state (unknown / busy /
   * waiting / stalled / idle, computed from the project's own job history),
   * and it reads as a status again now that it is the only one. */
  readonly status?: EntryStatus;
  readonly children: ReactNode;
  /**
   * The commands and caveats — everything review M04 says must not be on
   * screen for all three paths at once. Optional: a path whose whole content
   * is already one short choice (running a test is a button) has no steps to
   * hide, and wrapping it in a disclosure would bury an action rather than
   * shorten a document.
   */
  readonly steps?: ReactNode;
}) {
  return (
    <Card headingLevel={2} data-testid={`entry-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-muted">{icon}</span>
            <h2 className="text-[0.9375rem] font-semibold tracking-tight text-primary">{title}</h2>
          </div>
          {/* The dot is `aria-hidden` and the WORDS carry the state, so the
              status is not a colour a reader has to have learnt. */}
          {status !== undefined && (
            <span
              className="inline-flex items-center gap-1.5 font-mono text-[0.6875rem] font-medium tracking-[0.06em] uppercase"
              style={{ color: STATUS_COLOR[status.kind] }}
              data-testid="entry-status"
            >
              <span aria-hidden="true">●</span>
              {status.label}
            </span>
          )}
        </div>
        <p className="text-[0.8125rem] leading-relaxed text-muted">{description}</p>
        {status?.note !== undefined && (
          <p className="rounded-lg border border-default bg-sunken p-3 text-[0.75rem] leading-snug text-muted">
            {status.note}
          </p>
        )}
        {children}

        {/* ═══ THE WORKFLOW, BEHIND ONE CLICK — review M04 ═══
         *
         * The finding is that this page "presented documentation as task UI":
         * all three paths showed their explanations, prerequisites, code and
         * implementation caveats at once. What it asks for is three short
         * choices with only the chosen workflow expanded.
         *
         * So the CHOICE stays on screen — icon, title, status and the one
         * sentence saying when this path is the right one — and the commands
         * and caveats move in here.
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
        {steps !== undefined && (
          <details name="add-results" className="group">
            <summary className="w-fit cursor-pointer list-none text-[0.75rem] font-medium text-accent hover:underline hover:underline-offset-2">
              <span className="group-open:hidden">Show me how</span>
              <span className="hidden group-open:inline">Hide the steps</span>
            </summary>
            <div className="mt-3 flex flex-col gap-3">{steps}</div>
          </details>
        )}
      </div>
    </Card>
  );
}
