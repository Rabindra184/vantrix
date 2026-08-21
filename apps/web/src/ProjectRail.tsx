import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ProjectListResponse } from '@perfportal/contracts';
import Badge from './components/Badge';
import { CubeIcon, LayersIcon, PanelCollapseIcon, PanelExpandIcon } from './components/icons';
import { fetchProjects, projectsQueryKey } from './api/projects';
import { cn } from './lib/cn';
import { DEFAULT_ROUTE, projectPath } from './routes/paths';
import { STATUS, VERDICT, type Mark } from './routes/marks';

/**
 * Whether the reader last left the rail collapsed. Same storage discipline as
 * `theme.ts`: reads and writes are both allowed to fail (Safari private mode,
 * blocked-storage iframes), because a layout preference is not worth a crash.
 * Unlike the theme there is no pre-paint script — the rail renders expanded
 * for a first-time visitor and a collapsed one sees one reflow on mount only
 * if storage was unreadable, which those environments accept.
 */
const RAIL_COLLAPSED_KEY = 'perfportal-rail-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function storeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // A rail that does not survive a reload is a smaller failure than one
    // that throws on the click that set it.
  }
}

type ProjectItem = ProjectListResponse['items'][number];

/**
 * What this organisation contains, on every authenticated page.
 *
 * A `<div>`, not an `<aside>`: `aside` carries the `complementary` role,
 * meaning content tangentially related to the page, and a primary navigation
 * rail is not that. The landmark that matters is the `<nav>` below.
 *
 * THE BRAND IS NO LONGER HERE. It moved to the shell's full-width header
 * (`AppShell.tsx`), which is where the design pass merged it with the theme
 * control and Sign out — see that file on why three bands of chrome above the
 * content on a phone became two. It is still a `<Link>` to the org-wide list
 * and still not a heading, for the reason it never was one: a heading there
 * would compete with the `<h1>` every page renders inside `<main>`.
 *
 * Below `lg` the same `<nav>` lays out horizontally and scrolls. Deliberately
 * NOT a drawer: a toggle overlay needs focus management, an escape handler, a
 * scrim and return-focus-on-close to be correct, and this repo runs Playwright
 * with a single `Desktop Chrome` project — so every one of those would ship
 * unverified. A plainer nav that is always in the document cannot trap a
 * keyboard user. `project-rail.spec.ts` pins that shape: it seeds six
 * projects, narrows to 480px and clicks the LAST row, which only passes if
 * the row is in the DOM and reachable by scrolling.
 *
 * NOTHING MAY BE ADDED TO A ROW'S TEXT CONTENT. `ProjectRail.test.tsx`
 * asserts `link.textContent === 'Billing Exports'` exactly, for a project with
 * no runs — that is what proves absence of a badge rather than a neutral one.
 * A run count, an environment chip or a "last run 4h ago" line inside the link
 * would all break it, and each would be a real regression in what the row
 * claims rather than a test being fussy. The icons here are `<svg>` with no
 * `<title>`, whose `textContent` is the empty string, which is exactly why an
 * icon is the one thing that CAN be added.
 */
export default function ProjectRail() {
  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  const items = projects.data?.items ?? [];

  // DESKTOP-ONLY STATE. Below `lg` the rail is a horizontal strip and every
  // `collapsed` CLASS below is `lg:`-scoped, so on a phone the strip never
  // collapses — which is what keeps `project-rail.spec.ts`'s 480px
  // click-the-last-row case meaningful. (The one non-class treatment, the
  // row `title`, is documented at its own site below.)
  // Initialised from storage the same way `ThemeToggle` reads its choice: in
  // the `useState` initialiser, never an effect, so the first render already
  // agrees with the stored preference.
  const [collapsed, setCollapsed] = useState(() =>
    typeof document === 'undefined' ? false : readCollapsed(),
  );

  // The storage write lives in the EVENT HANDLER, not the state updater:
  // React requires updater functions to be pure — StrictMode double-invokes
  // them and concurrent renders may replay them, so a side effect there runs
  // an unpredictable number of times. Computing `next` from the rendered
  // value is safe here because this is the only place that sets it.
  function toggleCollapsed() {
    const next = !collapsed;
    storeCollapsed(next);
    setCollapsed(next);
  }

  // TanStack Query keeps the last-known-good `data` across a failed refetch,
  // so `isError` and a non-empty `items` can both be true at once — the
  // ordinary shape of "loaded fine, then a later refetch failed". Blanking
  // the rows in that case would throw away information the reader can still
  // act on, so the rows stay and the message names what actually happened
  // rather than claiming nothing loaded (the same overclaim the D-14
  // sentence fix corrected on the run page, one level up in the tree).
  const message = projects.isError
    ? items.length > 0
      ? 'Projects may be out of date.'
      : 'Projects could not be loaded.'
    : projects.isSuccess && items.length === 0
      ? 'No projects yet.'
      : null;

  return (
    // STICKY BENEATH THE HEADER, not from the top of the viewport: the shell's
    // header is a 56px sticky bar above both columns, so `top-0` here would
    // slide the rail's first row under it. `h-[calc(100dvh-3.5rem)]` is the
    // matching height — `dvh` rather than `vh` because on mobile Safari `100vh`
    // is the viewport WITHOUT browser chrome, which would make the rail taller
    // than the screen and hide its last project behind the address bar.
    <div
      className={cn(
        'z-30 flex shrink-0 flex-col border-b border-default bg-sidebar lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)] lg:border-b-0 lg:border-r',
        // NO width transition, deliberately, though the reference design has
        // one: this repo's motion rule (`tokens.css`'s `transition-ui`) is
        // colour-ish properties only — width is laid out on the main thread
        // and drops frames on a page already drawing eight ECharts instances.
        collapsed ? 'lg:w-14' : 'lg:w-[17rem]',
      )}
    >
      {/* An overline, not a heading: the `<nav>` below is already named
          "Projects" for assistive tech by its own `aria-label`, and a real
          <h2> here would put a heading above every page's <h1> in the
          document's heading order.

          `uppercase` is safe HERE and is not on a column heading or a section
          heading, because nothing queries a `<p>` by accessible name — see
          `tableStyles.ts`'s `TH` for the case where it is not safe.

          The whole row is hidden below `lg`, where the rail is a horizontal
          strip and a section label (or a collapse control for a strip that
          cannot collapse) would cost a whole row. */}
      <div
        className={cn(
          'hidden items-center pt-3 pb-1.5 lg:flex',
          collapsed ? 'justify-center px-0' : 'justify-between pl-4 pr-2',
        )}
      >
        {!collapsed && (
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Projects
          </p>
        )}
        {/* A hand-rolled 28px icon button in `ThemeToggle`'s segment style,
            not `Button`: 28px square is the right size beside a 10px
            overline, and `Button`'s smallest height is 32px. The name flips
            with the state so a screen reader always hears what the NEXT
            activation does — there is no visible label to contradict. */}
        <button
          type="button"
          aria-label={collapsed ? 'Expand the projects rail' : 'Collapse the projects rail'}
          title={collapsed ? 'Expand the projects rail' : 'Collapse the projects rail'}
          onClick={toggleCollapsed}
          className="transition-ui flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-primary"
        >
          {collapsed ? (
            <PanelExpandIcon className="h-4 w-4" />
          ) : (
            <PanelCollapseIcon className="h-4 w-4" />
          )}
        </button>
      </div>

      <nav
        aria-label="Projects"
        className="flex gap-1 overflow-x-auto px-2 pb-2 lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:pb-4"
      >
        {/* `end` is load-bearing: without it React Router marks this active
            for /runs/:runId too, so the rail would claim the reader is on the
            org-wide list while they are reading one run.

            EVERY `collapsed` CLASS TREATMENT BELOW IS CSS-ONLY AND `lg:`-SCOPED.
            The label spans go `lg:sr-only` rather than unmounting, so a
            collapsed row keeps its accessible name (an icon-only link with no
            name is a WCAG failure, and `title` alone is not a name in every
            AT) and the row's textContent — which `ProjectRail.test.tsx` pins
            verbatim — is identical in both states. */}
        {/* `title` moves UP to the link while collapsed — the name span is
            `sr-only` then, and a 1px clipped element cannot be hovered — and
            the span's own `title` moves OFF at the same moment, so a row
            never carries two nested tooltip sources. An attribute cannot be
            media-scoped, so this is the one collapse treatment that is not
            `lg:`-scoped: below `lg` with a stored collapsed preference the
            strip's rows carry a tooltip that merely repeats their visible
            label — redundancy, accepted, where the nesting was not. */}
        <NavLink
          to={DEFAULT_ROUTE}
          end
          title={collapsed ? 'All runs' : undefined}
          className={({ isActive }) => rowClasses(collapsed, isActive)}
        >
          <LayersIcon className="h-4 w-4 shrink-0 opacity-70" />
          <span className={cn(collapsed && 'lg:sr-only')}>All runs</span>
        </NavLink>

        {items.map((project) => (
          <NavLink
            key={project.id}
            to={projectPath(project.slug)}
            title={collapsed ? project.name : undefined}
            className={({ isActive }) => rowClasses(collapsed, isActive)}
          >
            <CubeIcon className="h-4 w-4 shrink-0 opacity-70" />
            {/* Truncated, not wrapped: a rail whose rows are two lines tall
                holds half as many projects, and the full name is on the page
                this links to. `title` is for the sighted, truncated case
                specifically — a screen reader already gets the whole name,
                since truncation is CSS-only and the accessible name is the
                untouched `project.name`. */}
            <span
              className={cn('truncate', collapsed && 'lg:sr-only')}
              title={collapsed ? undefined : project.name}
            >
              {project.name}
            </span>
            {/* The badge is the FIXED element and the name is the flexible
                one. Without `shrink-0 whitespace-nowrap` the badge is just
                another shrinkable flex item, so a long label — `no verdict
                yet` and `ingest failed` are the only two that reach this —
                breaks across two lines and its row grows 20px taller than
                its neighbours (measured: 62px against 42px). That is the
                two-line row the comment above says the rail cannot afford,
                arriving through the badge instead of through the name.

                Wrapped here rather than fixed in `Badge` itself, for the
                same reason `RAIL_INGEST_FAILED` is rail-local: `Badge` is
                shared with the run list and the run header, where it sits
                in a table cell with room to spare and nothing to fix.
                (`Badge` has since grown `whitespace-nowrap` of its own for
                unrelated reasons; this stays because `shrink-0` is the half
                that actually holds the row's height, and because a shared
                component is free to drop a class this row depends on.)

                `lg:hidden` when collapsed, not `sr-only` like the name: the
                name is the link's identity and must survive as its accessible
                name, while the badge is supplementary state a collapsed rail
                legitimately does not carry — the expanded rail and the page
                the row links to both still do. */}
            <span className={cn('ml-auto shrink-0 whitespace-nowrap', collapsed && 'lg:hidden')}>
              {badgeFor(project.latestRun)}
            </span>
          </NavLink>
        ))}

        {/* INSIDE <nav>, not outside it. <nav> is flow content and may hold
            a <p> — nothing in HTML or ARIA restricts it to links. Outside,
            a screen-reader user who landed on the *Projects* landmark heard
            "All runs" and nothing else, and a keyboard user tabbing forward
            went straight to Sign out without ever meeting the message.
            The wrapper is rendered unconditionally and carries the
            `aria-live` region, so it is registered before its content ever
            changes — a transition into or out of an error, or from "out of
            date" back to normal, gets announced, not just whatever state
            happened to be present at first paint. */}
        <div aria-live="polite" className="shrink-0">
          {message != null && (
            // `lg:sr-only` when collapsed, never `hidden`: `display: none`
            // silences a live region, and a projects-failed announcement is
            // exactly the kind of transition the wrapper above exists to
            // announce whatever state the rail is drawn in.
            <p className={cn('px-3 py-2 text-[12px] leading-snug text-muted', collapsed && 'lg:sr-only')}>
              {message}
            </p>
          )}
        </div>
      </nav>
    </div>
  );
}

/**
 * One rail row, in both orientations.
 *
 * A function rather than a constant because `NavLink` supplies `isActive`, and
 * the active row is the only place the accent appears in the rail. The active
 * treatment is THREE signals, not one: a tinted fill, a heavier weight, and
 * the accent as text colour — so it survives a monochrome print-out and a
 * forced-colours theme, the same rule `marks.tsx` follows for status.
 *
 * `h-9` fixes the row height explicitly. It is what makes
 * `project-rail.spec.ts`'s equal-height assertion structural rather than
 * incidental: with a fixed height a badge that wrapped would overflow
 * visibly instead of silently growing its row, so the failure mode is one
 * somebody notices.
 */
function rowClasses(collapsed: boolean, isActive: boolean) {
  return cn(
    'transition-ui flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-[13px]',
    // `whitespace-nowrap` on the row, not just the badge: below `lg` this is a
    // horizontal strip and "All runs" breaking after "All" is what it looks
    // like without it.
    'whitespace-nowrap',
    // A collapsed row is its icon, centred — the label is `sr-only` and the
    // badge `hidden`, both of which leave flex layout, so with the padding
    // gone the icon sits in the middle of the 56px column. `lg:`-scoped like
    // every other collapsed treatment; the phone strip never collapses.
    collapsed && 'lg:justify-center lg:px-0',
    isActive
      ? 'bg-accent/10 font-semibold text-accent'
      : 'font-medium text-muted hover:bg-sunken hover:text-primary',
  );
}

/**
 * A rail-local override of `STATUS.failed`, for this component only.
 *
 * `STATUS.failed` and `VERDICT.failed` (`routes/marks.tsx`) are identical in
 * glyph, label and colour — deliberately: `RunList` and `RunHeader` render
 * status and verdict in separate columns/chips, so the column header (or
 * `NamedBadge`'s accessible name) disambiguates "could not be ingested" from
 * "ingested and failed its SLA" wherever those live. The rail renders ONE
 * badge with no column header, so nothing here disambiguates them — exactly
 * the conflation `marks.tsx`'s own docstring calls the worst class of UI bug,
 * because nothing looks broken. This reintroduces that conflation on the one
 * surface now visible from every page, unless the rail says something
 * different for the two cases.
 *
 * Do not "fix" this by editing `STATUS.failed` in `marks.tsx`: that label is
 * correct for the two-column contexts that use it, and changing it there
 * would relabel the run list and the run header too. This is a rail-local
 * rendering of the SAME underlying fact (`status: 'failed'` — the bundle
 * never parsed), not a change to the shared vocabulary.
 *
 * `pending` and `parsing` need no such override: neither's word or glyph
 * collides with anything `VERDICT` renders, so their shared marks already
 * read unambiguously here.
 */
const RAIL_INGEST_FAILED: Mark = {
  glyph: STATUS.failed.glyph,
  label: 'ingest failed',
  colour: STATUS.failed.colour,
};

/**
 * Status first, verdict second — and the contract carries both fields
 * precisely so this decision can be made here.
 *
 * A pending run has `verdict: null`, so reading `VERDICT[verdict ?? 'none']`
 * unconditionally would render "no verdict yet" for a run nobody has measured
 * — the same overclaim the D-14 sentence fix corrected on the run page.
 *
 * A project with no runs gets NO badge rather than a neutral one: absence is
 * the honest rendering of "nothing has been ingested here".
 *
 * `status === 'failed'` renders `RAIL_INGEST_FAILED`, not `STATUS.failed`
 * itself — see that constant's docstring for why the rail cannot reuse the
 * shared mark here, the way it safely does for `pending`/`parsing`/`complete`.
 */
function badgeFor(latestRun: ProjectItem['latestRun']) {
  if (latestRun === null) return null;
  if (latestRun.status !== 'complete') {
    const mark = latestRun.status === 'failed' ? RAIL_INGEST_FAILED : STATUS[latestRun.status];
    return <Badge mark={mark} />;
  }
  return <Badge mark={VERDICT[latestRun.verdict ?? 'none']} />;
}
