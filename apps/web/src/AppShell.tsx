import { Suspense } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useIsAdmin } from './access/useAccess';
import { getSession, sessionQueryKey } from './api/session';
import RouteFallback from './components/RouteFallback';
import RouteErrorBoundary from './components/RouteErrorBoundary';
import ProjectRail from './ProjectRail';
import AccountMenu from './AccountMenu';
import SearchTrigger from './palette/SearchTrigger';
import { ActivityIcon } from './components/icons';
import { HOME_ROUTE } from './routes/paths';
import { useScrollAndFragment } from './scrollBehaviour';

/**
 * The chrome around every authenticated page: rendered only inside
 * `AuthGate`, so its presence on screen is itself the proof that a session
 * survived — which is what the reload test asserts.
 *
 * THE ORDER IS SKIP LINK → HEADER → RAIL → MAIN, in the DOM and on screen,
 * with no CSS reordering anywhere: a screen reader and a sighted reader
 * traverse the same sequence. It was rail → header → main, with the header a
 * strip inside the content column holding one button; the header is now a
 * full-width bar above both columns, carrying the brand as well.
 *
 * That is not a rearrangement for its own sake. Stacked below `lg` the old
 * order produced THREE bands of chrome before any content — a brand row, the
 * project strip, and then a 56px bar containing nothing but two controls
 * pushed to the right — which is 164px of a 812px phone screen, a fifth of
 * the viewport, spent on furniture. Merging the brand into the control bar
 * removes one band outright at every width, and above `lg` it also gives the
 * rail its full height back for projects instead of spending the top of it on
 * a wordmark.
 *
 * WHAT THE MOVE MUST NOT BREAK, all of it pinned by `project-rail.spec.ts`:
 *
 *   The skip link stays the FIRST focusable node. That spec focuses `<body>`,
 *   presses Tab exactly once, and asserts this link has focus. Anything
 *   focusable inserted above it fails — which is the point of the test.
 *
 *   The rail still sits left of `<main>` above `lg`: the spec compares
 *   bounding boxes and requires `rail.x + rail.width <= main.x`. A full-width
 *   header above the pair does not affect that, because the two columns are
 *   still a flex row beneath it.
 *
 *   Exactly one Sign out control in the document. A second copy hidden by a
 *   `lg:` class is still in the DOM, so `getByRole('button', { name: 'Sign
 *   out' })` would resolve to two nodes and throw under strict mode — and two
 *   identical controls sharing one accessible name is a defect whatever the
 *   CSS says. The same holds for the theme control.
 *
 *   Both now live inside `AccountMenu`, which UNMOUNTS its panel when shut —
 *   so the count is one while the menu is open and zero while it is closed,
 *   and every assertion about them opens the menu first. That is the claim
 *   those tests were always making; only where it holds has moved.
 *
 * The skip link jumps to `#main`, which carries `tabIndex={-1}` so activating
 * it actually moves focus onto `<main>` rather than merely scrolling to it:
 * `<main>` is not natively focusable, and a skip link that scrolls without
 * refocusing leaves a screen-reader user's focus behind at the link.
 */
export default function AppShell() {
  /* The SAME query `AuthGate` already made, under the same key — this shell
     only renders inside a resolved session, so it is a cache read rather than
     a request. `name` before `email`: a person recognises their own name
     faster, and the email is the fallback for an account that has none. */
  const session = useQuery({ queryKey: sessionQueryKey, queryFn: getSession });
  /* OPTIONAL AT EVERY HOP. `data?.user.name` reads as safe and is not: the
     `?.` short-circuits only on a nullish `data`, so a session body that is an
     object WITHOUT a user throws on `.name` — and this is the app's chrome, so
     it takes every page down with it. `AppShell.test.tsx`'s "renders the page
     even when the rail cannot load its projects" caught exactly that. */
  const identity = session.data?.user?.name || session.data?.user?.email || null;
  /* The admin flag by the web's ONE definition of it (`useIsAdmin`): the admin
     plugin's role, optional at every hop for the reason above, `undefined`
     while the session has not answered. Read once here and handed to the
     three things in the chrome that turn on it — the account menu's
     Administration item, the rail's no-projects sentence and the palette's
     New project — rather than each asking the session again. The palette
     especially: it mounts on every open, and an observer of its own would ask
     `/auth/get-session` every time. */
  const isAdmin = useIsAdmin();

  // Scroll to the top on a new path, and reveal a fragment: see `scrollBehaviour.ts`.
  useScrollAndFragment();

  return (
    <div className="min-h-screen">
      {/* EVERY VISUAL UTILITY HERE IS `focus:`-PREFIXED, INCLUDING THE
          PADDING, and that is not stylistic tidiness. `not-sr-only` sets
          `padding: 0` as part of undoing `sr-only`, and a `focus:`-variant
          utility sorts after an unprefixed one — so a bare `px-3 py-2`
          alongside `focus:not-sr-only` is silently overridden and the revealed
          link is a 100×20px sliver of colour with the text touching its edges.
          Measured, in the browser: `padding` computed to `0px`. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-on-accent focus:shadow-raised"
      >
        Skip to content
      </a>

      {/* `sticky` so the theme control and Sign out stay reachable from the
          bottom of a long chart page, and `backdrop-blur` so content scrolling
          under a translucent bar stays legible rather than showing through it.
          `z-40` clears the rail (`z-30`) — the two overlap at the top-left
          corner once the rail is sticky too — while staying below ECharts'
          own tooltips, which it portals at a far higher index. */}
      <header className="sticky top-0 z-40 flex h-header items-center gap-3 border-b border-default bg-surface/85 px-4 backdrop-blur-md sm:px-6">
        {/* The brand doubles as the way back to the home page, which is why it
            is a `<Link>` and not a heading: a heading here would compete with
            the `<h1>` every page renders inside `<main>`. It went to the run
            list until the home page took `/`.

            Its accessible name is the product's, "PerfPortal" — never "Home".
            The rail's row is the one link by that name on every authenticated
            page, and the suites reach it as such: a brand also called "Home"
            would make every strict-mode query for it resolve two elements. */}
        <Link to={HOME_ROUTE} className="flex items-center gap-2.5">
          {/* `text-on-brand`, not `text-white`: the glyph must be ink on the
              orange tile in BOTH themes — white on #f97316 is a 2.8:1
              graphic. See the token's note in tokens.css. */}
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-mark text-on-brand shadow-panel">
            <ActivityIcon className="h-4 w-4" />
          </span>
          <span className="text-[0.9375rem] font-semibold tracking-tight text-primary">PerfPortal</span>
        </Link>

        {/* The palette's one entry point, and the owner of its ⌘K shortcut:
            mounted here, once, so the shortcut exists on every authenticated
            page and a page can neither forget it nor add a second. */}
        <SearchTrigger isAdmin={isAdmin} />

        {/* ═══ ONE CONTROL, NOT THREE (review 09-13 N03) ═══
         *
         * This held a truncated email, a three-segment theme control and Sign
         * out, side by side at equal weight. The review's point is that the
         * two least-used controls in the product were holding permanent
         * chrome while the question the chrome should answer — which identity
         * am I using — was a 12px span that vanished below `sm`.
         *
         * Identity is the control now and the two settings live inside it;
         * see `AccountMenu` for why it is a real `role="menu"` rather than the
         * disclosure it was first built as. The full address is legible in the
         * panel at every width, which the old header could not manage at any.
         *
         * THAT SENTENCE READ THE OTHER WAY ROUND UNTIL 7cda62c REBUILT THE
         * MENU, and it survived the rebuild pointing a reader at reasoning
         * that file had already reversed. A cross-reference to another
         * module's DESIGN has no compiler and no type — the same rot this repo
         * has now paid for with a `Cnt/s` hint naming a deleted tile and "Mint
         * one under Access" naming a renamed page. When a module changes what
         * it IS, grep for whoever says what it is.
         */}
        <div className="ml-auto flex items-center gap-2">
          {/* `=== true`: the menu takes a settled answer, and a pending
              session offers no Administration — hidden until known. */}
          <AccountMenu identity={identity} isAdmin={isAdmin === true} />
        </div>
      </header>

      {/* `min-w-0` on the content column is what stops a wide table — the
          13-column statistics table is the real case — widening the flex item
          past the viewport and giving the whole PAGE a horizontal scrollbar,
          the failure `tableStyles.ts`'s `SCROLLER` exists to contain. */}
      <div className="lg:flex">
        <ProjectRail isAdmin={isAdmin} />
        {/* `p-4` on a phone, `p-6` from `sm` up: a 24px gutter on a 375px
            screen spends 13% of the width on nothing. */}
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none sm:p-6">
          {/* Every route under this shell is a lazy chunk (see App.tsx). This
              boundary is what keeps the header and the project rail on screen
              while one loads: without it the nearest boundary is App's own,
              ABOVE this shell, so a first visit to any page blanks the whole
              window — chrome included — for the length of one request. */}
          {/* Inside the shell, so a failed PAGE chunk keeps the header and
              the rail — the reader can still navigate somewhere that works,
              which is the difference between a broken page and a broken app.
              The outer boundary in `App` is the last resort behind it. */}
          <RouteErrorBoundary>
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
          </RouteErrorBoundary>
        </main>
      </div>
    </div>
  );
}
