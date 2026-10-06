import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ActivityResponse } from '@perfportal/contracts';
import Badge from '../components/Badge';
import { linkButtonClasses } from '../components/Button';
import Card from '../components/Card';
import { EmptyState } from '../components/States';
import { ROW, TABLE, TD, TH, THEAD } from '../components/tableStyles';
import { runName } from '../runNumber';
import { STATUS, VERDICT, type Mark } from '../routes/marks';
import { NEW_PROJECT_ROUTE, projectSetupPath, projectTestPath, runPath } from '../routes/paths';
import useIsCompact from '../useIsCompact';
import Glance from './Glance';
import LastRunCell from './LastRunCell';
import { attentionRowLabel, attentionState, daysAgo, passRateLabel } from './homeFormat';

type AttentionRow = ActivityResponse['attention'][number];

/**
 * ═══ THE CARD THE HOME PAGE EXISTS FOR (docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md) ═══
 *
 * "Which of my tests should I look at?" has four honest answers, and each is a
 * different sentence with a different way out:
 *
 *   filled   a table of the tests whose latest run this week needs attention,
 *            each with the run and the reasons, beside the seven-day glance
 *   clean    runs arrived and none needs attention: say so, with the pass rate
 *   gap      nothing ran this week but something did once: a coverage
 *            question, with the last run and a way to add results
 *   empty    nothing has ever run: a first run, or a first project
 *
 * They are told apart by `attentionState`, so the card holds no opinion about
 * what the numbers mean — only how each answer looks.
 *
 * The attention COUNT rides in the card's header, filled state only. `Card`
 * has no description line (clean UI), and "0 tests" beside "No test needs
 * attention." would say the same thing twice. It is `attentionTotal`, not the
 * rows sent: the list is capped at twenty and a header counting what it was
 * handed would read "20 tests" over thirty-five.
 *
 * NO LINK IN THE HEADER. The "All tests" this card would link to is the table
 * further down the page, and "All runs" belongs to the rail.
 *
 * ═══ A PROJECT NAME IS TEXT HERE, NEVER A LINK ═══
 *
 * The rail names every project and CLAUDE.md records twice what a second link
 * with the same name and a different destination costs a screen-reader user.
 * The test beside it is what the row links to; the project is context.
 *
 * ═══ WHERE THE GLANCE SITS ═══
 *
 * Beside the list on a desktop and below it on a phone, with the list first in
 * the DOM either way so the reading order never changes. "Desktop" is the
 * card's OWN width (a container query), not the viewport's: this card shares
 * the row with the home page's right-hand column, so a viewport that is wide
 * enough for a rail, a column and a table is not necessarily wide enough for
 * a table AND a glance. The viewport still decides table against cards,
 * because that changes what exists in the DOM and only JS can.
 *
 * The glance is drawn in the two states where it says something — filled and
 * clean. In a gap or an empty org it would be seven hatched columns, a figure
 * that restates "no runs" under a sentence already saying it.
 */

/** A badge in the same shape the rest of the product draws, in the words of the
 *  card. Derived from `VERDICT`/`STATUS`, so a recolour there reaches these. */
const CLEAN_WEEK: Mark = { ...VERDICT.passed, label: 'Clean week' };
const COVERAGE_GAP: Mark = { ...STATUS.pending, label: 'Coverage gap' };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const LINK =
  'transition-ui font-medium text-accent wrap-anywhere hover:underline hover:underline-offset-2';

export default function AttentionCard({
  activity,
  projects,
  now,
}: {
  readonly activity: ActivityResponse;
  /** The org's projects, for the empty state's "Add results". Order is the caller's. */
  readonly projects: readonly { readonly slug: string; readonly name: string }[];
  /** Passed in, so "51 days ago" is a function of the inputs and not of the clock. */
  readonly now: Date;
}) {
  const compact = useIsCompact();
  const state = attentionState(activity);

  return (
    <Card
      title="Tests that need attention"
      headingLevel={2}
      actions={
        state === 'filled' ? (
          <span data-testid="attention-count" className="text-[0.75rem] text-muted">
            {plural(activity.attentionTotal, 'test', 'tests')} · last 7 days
          </span>
        ) : undefined
      }
    >
      {state === 'filled' && (
        <WithGlance days={activity.days} compact={compact}>
          {compact ? <AttentionCards rows={activity.attention} /> : <AttentionTable rows={activity.attention} />}
        </WithGlance>
      )}
      {state === 'clean' && (
        <WithGlance days={activity.days} compact={compact}>
          <div className="flex flex-col items-start gap-2">
            <Badge mark={CLEAN_WEEK} />
            <p data-testid="attention-summary" className="text-[0.9375rem] font-semibold text-primary">
              {activity.passRate === null
                ? plural(activity.runCount, 'run', 'runs')
                : `${passRateLabel(activity.passRate)} pass rate · ${plural(activity.runCount, 'run', 'runs')}`}
            </p>
            <p className="text-[0.8125rem] text-muted">No test needs attention.</p>
          </div>
        </WithGlance>
      )}
      {state === 'gap' && activity.lastRun !== null && (
        <Gap lastRun={activity.lastRun} now={now} tz={activity.window.tz} />
      )}
      {state === 'empty' && <Empty firstProject={projects[0]} />}
    </Card>
  );
}

/**
 * The list on the left and the glance on the right, or stacked.
 *
 * `@container` is on a WRAPPER and the `@2xl:` variants on its child: a
 * container query cannot query the element that declares the context, and a
 * variant on the declaring element silently never matches — the card would
 * stack at every width with nothing saying why (CLAUDE.md, the zoom-reflow
 * entry). On a phone nothing is conditional, so the stacked layout is the
 * only class that is there.
 */
function WithGlance({
  days,
  compact,
  children,
}: {
  readonly days: ActivityResponse['days'];
  readonly compact: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="@container">
      <div
        data-testid="attention-layout"
        className={`flex flex-col gap-6 ${compact ? '' : '@2xl:flex-row @2xl:items-start'}`}
      >
        <div className="min-w-0 flex-1">{children}</div>
        <div className={compact ? '' : '@2xl:w-64 @2xl:shrink-0'}>
          <Glance days={days} />
        </div>
      </div>
    </div>
  );
}

/** Where a row leads: its test, or — a run with none (it never parsed a
 *  header, or its test was deleted) — the run itself. */
function RowLink({ row }: { readonly row: AttentionRow }) {
  const to =
    row.test === null ? runPath(row.run.id) : projectTestPath(row.project.slug, row.test.slug);
  return (
    <Link to={to} className={LINK}>
      {attentionRowLabel(row)}
    </Link>
  );
}

/**
 * The table, named "Needs attention" and not "Tests that need attention":
 * Playwright matches an accessible name as a SUBSTRING, so a name containing
 * the word would also answer a query for the page's own "Tests" table.
 *
 * Cells wrap anywhere (`wrap-anywhere` on the link and the project name): a
 * test is named by whoever wrote it, and an unbroken fully-qualified class
 * would otherwise take the page's width with it.
 */
function AttentionTable({ rows }: { readonly rows: readonly AttentionRow[] }) {
  return (
    <table className={TABLE}>
      <caption className="sr-only">Needs attention</caption>
      <thead className={THEAD}>
        <tr>
          <th scope="col" className={TH}>
            Test
          </th>
          <th scope="col" className={TH}>
            Project
          </th>
          <th scope="col" className={TH}>
            Last run
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.run.id} data-testid="attention-row" className={ROW}>
            <td className={`${TD} align-top`}>
              <RowLink row={row} />
            </td>
            <td data-testid="attention-project" className={`${TD} align-top wrap-anywhere`}>
              {row.project.name}
            </td>
            <td className={`${TD} align-top`}>
              <LastRunCell run={row.run} reasons={row.reasons} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The same rows as cards, below 768px: a list claims to be what it is, and
 *  every field the table row had is here. */
function AttentionCards({ rows }: { readonly rows: readonly AttentionRow[] }) {
  return (
    <ul aria-label="Needs attention" data-testid="attention-cards" className="flex flex-col gap-2">
      {rows.map((row) => (
        <li
          key={row.run.id}
          data-testid="attention-row"
          className="flex flex-col gap-2 rounded-lg border border-default p-3"
        >
          <div className="min-w-0">
            <RowLink row={row} />
            <p data-testid="attention-project" className="text-[0.75rem] text-muted wrap-anywhere">
              {row.project.name}
            </p>
          </div>
          <LastRunCell run={row.run} reasons={row.reasons} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Nothing ran in the window, but something did once.
 *
 * The box names the run the way the rest of the page does: the test (or, for a
 * run with none, its project), its number (or the start of its id), and how long
 * ago it was. "Add results" goes to THAT run's project: it is the project whose
 * results stopped arriving, which is not necessarily the first in the rail.
 *
 * "How long ago" is in CALENDAR days in the window's own zone (`daysAgo`), so a
 * run from before the window reads seven days or more — never "6 days ago"
 * beside "No runs in the last 7 days".
 */
function Gap({
  lastRun,
  now,
  tz,
}: {
  readonly lastRun: NonNullable<ActivityResponse['lastRun']>;
  readonly now: Date;
  /** The zone the window's days were counted in, `window.tz`. */
  readonly tz: string;
}) {
  const parts = [
    lastRun.test?.name ?? lastRun.project.name,
    lastRun.runNumber === null ? `Run ${lastRun.id.slice(0, 8)}` : runName(lastRun.runNumber),
    daysAgo(lastRun.startedAt, now, tz),
  ];
  return (
    <div className="flex flex-col items-start gap-3">
      <Badge mark={COVERAGE_GAP} />
      <p className="text-[0.9375rem] font-semibold text-primary">No runs in the last 7 days</p>
      <p
        data-testid="attention-last-run"
        className="rounded-lg border border-default bg-sunken px-3 py-2 text-[0.8125rem] text-primary wrap-anywhere"
      >
        {parts.join(' · ')}
      </p>
      <Link to={projectSetupPath(lastRun.project.slug)} className={linkButtonClasses}>
        Add results
      </Link>
    </div>
  );
}

/** Nothing has ever run: the two ways to start. With no project there is
 *  nowhere to add results to, so only the way that makes one is offered. */
function Empty({ firstProject }: { readonly firstProject: { readonly slug: string } | undefined }) {
  return (
    <EmptyState
      title="No runs yet"
      action={
        <div className="flex flex-wrap justify-center gap-2">
          {firstProject !== undefined && (
            <Link to={projectSetupPath(firstProject.slug)} className={linkButtonClasses}>
              Add results
            </Link>
          )}
          <Link to={NEW_PROJECT_ROUTE} className={linkButtonClasses}>
            New project
          </Link>
        </div>
      }
    />
  );
}
