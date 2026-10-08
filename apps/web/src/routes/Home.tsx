import type { ComponentProps, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ActivityResponse } from '@perfportal/contracts';
import { useIsAdmin } from '../access/useAccess';
import { activityQueryOptions, activityRefetchInterval, browserTimeZone } from '../api/activity';
import { ProblemError } from '../api/fetch';
import { fetchProjects, projectsQueryKey } from '../api/projects';
import { getSession, sessionQueryKey } from '../api/session';
import Card from '../components/Card';
import { Skeleton, SkeletonTable } from '../components/Skeleton';
import { ErrorState, LoadingState } from '../components/States';
import AttentionCard from '../home/AttentionCard';
import HomeTests from '../home/HomeTests';
import { greetingName } from '../home/homeFormat';
import useDocumentTitle from '../useDocumentTitle';
import useIsCompact from '../useIsCompact';
import { ALL_RUNS_ROUTE, projectPath } from './paths';

/**
 * ═══ THE PORTFOLIO HOME (docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md) ═══
 *
 * `/`, top to bottom: who you are and what window the page is about; the
 * tests that need attention, with what is running and the busiest projects
 * beside them; then every test in the org. This file COMPOSES — each card is
 * built, and tested, in `home/` — and owns the three decisions that are about
 * the page rather than a card: the order, the layout, and keeping the two
 * reads apart.
 *
 * ═══ TWO READS, AND NEITHER BLANKS THE OTHER ═══
 *
 * `GET /v1/activity` feeds the heading's window, the attention card and the
 * side column; `GET /v1/tests` feeds the table, inside `HomeTests`. A failure
 * of either stays in its own cards: the activity error lands where the
 * attention card was, and the table goes on drawing from its own answer —
 * and the reverse. The activity query is the one `AuthGate` asked on the way
 * in, through the same `activityQueryOptions` — the same key AND the same
 * `staleTime` — so on a cold load this page draws from the gate's answer
 * rather than asking again. (The shared key alone did not do that: with no
 * `staleTime` this page's observer found the gate's answer stale on mount and
 * asked twice, which `Home.test.tsx` now counts.)
 *
 * ONE FAILED REQUEST IS ANNOUNCED ONCE. The attention card's slot carries the
 * `ErrorState` (an alert, in the server's own words); the two side cards say
 * "Could not be loaded." quietly, as text. Three assertive regions for one
 * failed request would interrupt a screen-reader user three times to say one
 * thing.
 *
 * ═══ THE LAST GOOD ANSWER STAYS ON SCREEN ═══
 *
 * Every card in THIS file — the attention card, Running now and Runs by
 * project — reads `data` before `error`. TanStack keeps the last successful
 * answer across a failed refetch, so `isError` and `data` can both hold — the
 * ordinary shape of "loaded, then one poll failed" while something is
 * running. Swapping a good page for an error over one missed poll would throw
 * away what the reader can still act on, and the next poll is thirty seconds
 * away (the rail's projects follow the same rule).
 *
 * The tests table is the exception: it is `HomeTests`', it checks `isError`
 * first, and its query does not poll — so what replaces its rows with the
 * error is a failed refetch on window focus, or a failed page or filter the
 * reader asked for, never a missed poll.
 */
export default function Home() {
  useDocumentTitle('Home');
  const compact = useIsCompact();
  const session = useQuery({ queryKey: sessionQueryKey, queryFn: getSession });
  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  /* The admin flag, by the web's one definition of it — handed with the
     project list to the attention card, whose "Add results" links each ask
     `projectAccess` about their own project. */
  const isAdmin = useIsAdmin();
  // The same zone and options `AuthGate` uses, so the two name one query and
  // agree about how long its answer stays fresh.
  const tz = browserTimeZone();
  const activity = useQuery({
    ...activityQueryOptions(tz),
    // TanStack 5 hands `refetchInterval` the Query, not its data: every thirty
    // seconds while something is running, and not at all otherwise — whatever
    // the `staleTime`, which governs mounts and focus, not the interval.
    refetchInterval: (query) => activityRefetchInterval(query.state.data),
  });

  // `?.` AT EVERY HOP: the session body is cast, not parsed (`getSession`), so
  // a body that is an object without a user is possible, and `AppShell`
  // records what reading `.name` off it cost once. Fields a cast body may lack
  // fall back to empty, and a greeting with no name is plain "Hello" rather
  // than "Hello, ".
  const user = session.data?.user;
  const who =
    user === undefined ? '' : greetingName({ name: user.name ?? '', email: user.email ?? '' });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight wrap-anywhere">
          {who === '' ? 'Hello' : `Hello, ${who}`}
        </h1>
        {activity.data !== undefined ? (
          <p data-testid="home-activity-line" className="text-[0.8125rem] text-muted">
            {activityLine(activity.data.window)}
          </p>
        ) : activity.isPending ? (
          /* The line's own height, so nothing below moves when it arrives. */
          <Skeleton className="h-5 w-72 max-w-full" />
        ) : null}
      </div>

      {/* ═══ BESIDE ON A DESKTOP, BELOW ON A PHONE, ONE READING ORDER ═══

          The side column is AFTER the attention card in the document either
          way, so a screen reader and a phone meet the same order: attention,
          Running now, Runs by project, then the tests.

          "Beside" is a CONTAINER query on a wrapper, not a viewport
          breakpoint, for the reason `RunDecisionBand` and the zoom-reflow
          entry record: the rail appears at `lg` and takes ~270px at exactly
          the width a viewport breakpoint would call wide, and a container
          query's rem threshold scales with the reader's own text size. The
          variant sits on the CHILD, because a container query cannot query
          the element that declares the context. On a phone nothing is
          conditional, so one column is the only layout there is. */}
      <div className="@container">
        <div
          data-testid="home-overview"
          className={
            compact
              ? 'grid gap-6'
              : 'grid gap-6 @4xl:grid-cols-[minmax(0,1fr)_16rem] @4xl:items-start'
          }
        >
          <div data-testid="home-attention" className="min-w-0">
            <AttentionSlot activity={activity} projects={projects.data?.items} isAdmin={isAdmin} />
          </div>
          <div className="flex min-w-0 flex-col gap-6">
            <RunningNow activity={activity} />
            <RunsByProject activity={activity} />
          </div>
        </div>
      </div>

      <HomeTests />
    </div>
  );
}

/**
 * `Activity in the last 7 days (<from> – <to>)`, the attention window's own
 * bounds as dates in the zone the SERVER ANSWERED IN (`window.tz`).
 *
 * Not the viewer's default zone: the two are the same except when the server
 * refused the browser's zone and `fetchActivity` asked again in UTC. Then the
 * window's bounds are UTC midnights, the glance's columns are UTC dates, and a
 * heading printed in the viewer's own zone would name a range a day off the
 * seven columns under it. A zone this browser cannot format either falls back
 * to its default rather than throwing.
 *
 * ONE RANGE, NOT TWO DATES. Formatting each end on its own printed the year
 * twice ("Sep 30, 2026 – Oct 6, 2026"); `formatRange` writes what the two ends
 * share once, as Gatling Enterprise's heading does ("Sep 30 – Oct 6, 2026"),
 * and still spells both years out on a range across New Year.
 *
 * The formatter is built PER CALL, never at module scope: an
 * `Intl.DateTimeFormat` built at import freezes the zone it was built in
 * (CLAUDE.md, the time-window entry), and a test that pins a zone would then
 * be comparing two clocks.
 */
function activityLine(range: ActivityResponse['window']): string {
  // `range`, not `window`: a parameter of that name would shadow the global.
  const day = dayFormat(range.tz);
  return `Activity in the last 7 days (${day.formatRange(new Date(range.from), new Date(range.to))})`;
}

function dayFormat(tz: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: tz });
  } catch {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  }
}

type Activity = UseQueryResult<ActivityResponse>;

/**
 * The attention card, or its placeholder, or its error — always under the
 * card's own heading, so the page's outline does not change shape as the
 * answer arrives.
 *
 * `now` is the window's own END, the server's "now" at the moment it
 * answered: "51 days ago" is then a fact about the answer on screen rather
 * than about whatever the browser's clock says, and a browser running a few
 * minutes fast cannot make a run read a day older than the window it is in.
 */
function AttentionSlot({
  activity,
  projects,
  isAdmin,
}: {
  readonly activity: Activity;
  /** `undefined` while the list has no data — "not answered" is not "no projects". */
  readonly projects: ComponentProps<typeof AttentionCard>['projects'];
  readonly isAdmin: boolean | undefined;
}) {
  if (activity.data !== undefined) {
    return (
      <AttentionCard
        activity={activity.data}
        projects={projects}
        isAdmin={isAdmin}
        now={new Date(activity.data.window.to)}
      />
    );
  }
  const problem = activity.error instanceof ProblemError ? activity.error : null;
  return (
    <Card title="Tests that need attention" headingLevel={2}>
      {activity.isError ? (
        <ErrorState
          title="The activity could not be loaded"
          detail={problem?.detail ?? activity.error.message}
          remediation={problem?.remediation}
        />
      ) : (
        <LoadingState label="Loading activity…">
          {/* The filled card's three columns, so the rows land where the
              placeholder was. */}
          <SkeletonTable columns={3} rows={4} />
        </LoadingState>
      )}
    </Card>
  );
}

const LINK =
  'transition-ui font-medium text-accent wrap-anywhere hover:underline hover:underline-offset-2';

/** What a side card says when the read it shares with the attention card failed. */
function Unavailable() {
  return <p className="text-[0.8125rem] text-muted">Could not be loaded.</p>;
}

/**
 * How many runs are streaming now, linked to the run list filtered to
 * exactly those — `running` counts `status = 'running'` alone, the one value
 * the run list's status filter takes, so the list a reader lands on holds the
 * runs this card counted and no others.
 *
 * A link even at zero: "0 running" is still a true count, and the list it
 * opens is the honest answer to "show me".
 */
function RunningNow({ activity }: { readonly activity: Activity }) {
  return (
    <Card title="Running now" headingLevel={2}>
      {activity.data !== undefined ? (
        <Link
          to={`${ALL_RUNS_ROUTE}?status=running`}
          className={`${LINK} text-[1.5rem] leading-tight font-semibold tracking-tight`}
        >
          {activity.data.running} running
        </Link>
      ) : activity.isError ? (
        <Unavailable />
      ) : (
        <Skeleton className="h-7 w-28" />
      )}
    </Card>
  );
}

/**
 * The five busiest projects over the glance days, each with its count and a
 * bar against the busiest.
 *
 * ═══ THE ONE PLACE A PROJECT NAME IS A LINK ON THIS PAGE ═══
 *
 * Everywhere else here a project name is text, because the rail names every
 * project and a second link with the same name and a DIFFERENT destination is
 * the collision CLAUDE.md records twice. These go where the rail's row of the
 * same name goes — `projectPath(slug)` — so the name and the place agree.
 *
 * The count is text — the number, with "runs" for a screen reader, since the
 * card's heading already says it to a sighted one. The bar is `aria-hidden`:
 * a picture of the number beside it, and the number is what is read. Its
 * width is the project's share of the BUSIEST project's runs — the maximum,
 * not the first row: the server sends them busiest first today, and a bar
 * that read `rows[0]` would quietly draw past 100% the day it did not. An org
 * whose counts are all zero gets empty bars, never `NaN%` from 0 ÷ 0.
 */
function RunsByProject({ activity }: { readonly activity: Activity }) {
  let body: ReactNode;
  if (activity.data !== undefined) {
    const rows = activity.data.byProject;
    const top = Math.max(0, ...rows.map((row) => row.runs));
    body =
      rows.length === 0 ? (
        <p className="text-[0.8125rem] text-muted">No runs in the last 7 days.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map(({ project, runs }) => (
            <li key={`by-project:${project.slug}`} data-testid="by-project-row" className="flex flex-col gap-1">
              <div className="flex min-w-0 items-baseline justify-between gap-3 text-[0.8125rem]">
                <Link to={projectPath(project.slug)} className={`${LINK} min-w-0`}>
                  {project.name}
                </Link>
                <span data-testid="by-project-runs" className="shrink-0 tabular-nums text-primary">
                  {runs}
                  <span className="sr-only">{runs === 1 ? ' run' : ' runs'}</span>
                </span>
              </div>
              <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-sunken">
                <div
                  data-testid="by-project-bar"
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${top === 0 ? 0 : (runs / top) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      );
  } else if (activity.isError) {
    body = <Unavailable />;
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={`by-project-skeleton:${i}`} className="h-8" />
        ))}
      </div>
    );
  }
  return (
    <Card title="Runs by project" headingLevel={2}>
      {body}
    </Card>
  );
}
