import { Suspense, useEffect, useRef } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getSession, sessionQueryKey } from './api/session';
import RouteFallback from './components/RouteFallback';
import ProjectRail from './ProjectRail';
import SignOutButton from './SignOutButton';
import ThemeToggle from './components/ThemeToggle';
import { ActivityIcon } from './components/icons';
import { DEFAULT_ROUTE } from './routes/paths';

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
 *   CSS says. `ThemeToggle` is likewise rendered once.
 *
 * The skip link jumps to `#main`, which carries `tabIndex={-1}` so activating
 * it actually moves focus onto `<main>` rather than merely scrolling to it:
 * `<main>` is not natively focusable, and a skip link that scrolls without
 * refocusing leaves a screen-reader user's focus behind at the link.
 */
export default function AppShell() {
  /* ═══ A NEW PAGE STARTS AT ITS OWN TOP ═══
   *
   * The router preserves scroll position across navigations, which is right
   * for a BACK to a list and wrong for a forward move into a different thing.
   * Observed: opening a request from the long chart page landed the reader
   * part-way down the request's own charts, below its heading — so the first
   * thing on screen belonged to a page they had not read the title of.
   *
   * KEYED ON `pathname` ALONE, deliberately. The search string carries the
   * analysis window and the compare selection, and those change as a reader
   * refines ONE view — scrolling them back to the top on every brush drag or
   * checkbox would be its own defect. A different path is a different thing;
   * a different query is the same thing, asked again.
   *
   * The FIRST render is skipped: a deep link should land where the browser
   * puts it, including on a fragment like the decision band's
   * `#simulation-assertions`, which this would otherwise undo.
   */
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

  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
  }, [pathname]);

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
        {/* The brand doubles as the way back to the org-wide list, which is
            why it is a `<Link>` and not a heading: a heading here would
            compete with the `<h1>` every page renders inside `<main>`. */}
        <Link to={DEFAULT_ROUTE} className="flex items-center gap-2.5">
          {/* `text-on-brand`, not `text-white`: the glyph must be ink on the
              orange tile in BOTH themes — white on #f97316 is a 2.8:1
              graphic. See the token's note in tokens.css. */}
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-mark text-on-brand shadow-panel">
            <ActivityIcon className="h-4 w-4" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-primary">PerfPortal</span>
        </Link>

        <div className="ml-auto flex items-center gap-2">
          {/* ═══ WHO IS SIGNED IN ═══
           *
           * The header carried a brand, three theme choices and Sign out, and
           * said nothing about WHO. In a tool where the next click can
           * configure a release gate or launch load against an environment,
           * "which identity am I using" is a question the chrome should answer
           * without being asked.
           *
           * IDENTITY ONLY — no organisation, and that is a limit rather than
           * an omission. `Session` (api/session.ts) carries a user and no org
           * at all, and the review is explicit that multi-tenant UI must not
           * be invented. Showing the tenant needs a field the session does not
           * have.
           *
           * Hidden below `sm`: at 375px the header already holds a brand,
           * three theme buttons and Sign out, and an email is the longest
           * string of the four. The identity is not lost — it is simply not
           * worth the row on a phone, where the reader is reading rather than
           * configuring.
           */}
          {identity !== null && (
            <span
              data-testid="signed-in-as"
              title={identity}
              className="hidden max-w-[22ch] truncate text-[12px] text-muted sm:inline"
            >
              {identity}
            </span>
          )}
          <ThemeToggle />
          <SignOutButton />
        </div>
      </header>

      {/* `min-w-0` on the content column is what stops a wide table — the
          13-column statistics table is the real case — widening the flex item
          past the viewport and giving the whole PAGE a horizontal scrollbar,
          the failure `tableStyles.ts`'s `SCROLLER` exists to contain. */}
      <div className="lg:flex">
        <ProjectRail />
        {/* `p-4` on a phone, `p-6` from `sm` up: a 24px gutter on a 375px
            screen spends 13% of the width on nothing. */}
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none sm:p-6">
          {/* Every route under this shell is a lazy chunk (see App.tsx). This
              boundary is what keeps the header and the project rail on screen
              while one loads: without it the nearest boundary is App's own,
              ABOVE this shell, so a first visit to any page blanks the whole
              window — chrome included — for the length of one request. */}
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
