import { Suspense, useEffect, useRef } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getSession, sessionQueryKey } from './api/session';
import RouteFallback from './components/RouteFallback';
import RouteErrorBoundary from './components/RouteErrorBoundary';
import ProjectRail from './ProjectRail';
import AccountMenu from './AccountMenu';
import { ActivityIcon } from './components/icons';
import { DEFAULT_ROUTE } from './routes/paths';

/**
 * ═══ A ONE-SHOT REVEAL IS RIGHT ONLY ON A PAGE ALREADY LAID OUT ═══
 *
 * `scrollIntoView` places the target where it is THE FRAME IT IS CALLED. On the
 * run Summary that frame is early: the errors table is ready within a few
 * hundred milliseconds, while the headline tiles wait on `/stats` and the two
 * charts on their own queries, and all of them sit ABOVE `#errors`. Measured
 * on the e2e reference run for an old `/errors` link, per animation frame:
 *
 *     1280x720   200ms  scrollY 1447 (the page's own maximum), target top 441,
 *                       document 2167px
 *                275ms  document 2544px, target top 784 of a 720px viewport
 *                       -> the table settles ENTIRELY BELOW THE FOLD
 *     1440x900   reveal at target top 621; settles at top 891 of 900
 *                       -> nine pixels visible, by luck
 *
 * ~377px arrives over ~75ms and pushes the target away from where the reveal
 * put it. `/load-generators` escaped only because the page bottom clamps the
 * scroll (target top 293). A reveal that is correct for an already-settled page
 * was the wrong tool for a page that settles under it.
 *
 * SO IT KEEPS THE TARGET WHERE THE REVEAL PUT IT while the page above settles:
 * a `ResizeObserver` on the document re-runs the same `scrollIntoView` (so
 * `scroll-margin-top` still applies) whenever the target has drifted. The
 * observed boxes are the root element and `<main>`; the target's own position,
 * not their size, decides whether to move, because most growth (a table below
 * the target) changes a height and moves nothing.
 *
 * ═══ AND THE READER ALWAYS WINS ═══
 *
 * Taking the page away from someone who has started scrolling is worse than the
 * defect, so the first `wheel`, `touchstart`, `keydown` or `pointerdown` ends
 * it for good. Programmatic scrolls raise none of those, so our own corrections
 * never cancel us. Otherwise it stops once the layout has been still for
 * `SETTLE_IDLE_MS`, and never runs past `SETTLE_CAP_MS` from the reveal, so a
 * page that keeps changing (a live run) is not held for ever.
 *
 * ═══ A SILENCE IS MEASURED, NEVER ASSUMED ═══
 *
 * "No callback for `SETTLE_IDLE_MS`" is not evidence the page is still when
 * the main thread was blocked for that long. A task that changes the layout and
 * outlasts the idle window leaves the idle timer OVERDUE, and WebKit ran that
 * overdue timer before the rendering step that would have delivered the
 * observer's callback — so a stop that trusted the silence disconnected the
 * observer with the change unreported. Measured on CI WebKit: every response
 * in by +50ms, then a two-second task, and `#errors` left at a viewport ratio
 * of 0.29 with nothing to move it. So both timers MEASURE before they decide
 * (`getBoundingClientRect` forces the layout the blocked task produced): the
 * idle timer corrects a drift and waits again instead of stopping, and the cap
 * makes its one last correction before it does. Neither can see a change made
 * AFTER it has stopped; that is the honest limit of any settle window.
 *
 * Scroll only: focus moved once at the reveal and is not taken back on every
 * correction. No `ResizeObserver` (jsdom) leaves the one-shot reveal exactly as
 * it was. Returns the teardown the effect's cleanup calls.
 */
const SETTLE_IDLE_MS = 1000;
const SETTLE_CAP_MS = 5000;
const READER_INPUTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

function keepInPlace(target: HTMLElement): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};

  let top = target.getBoundingClientRect().top;
  let idle = 0;
  let cap = 0;
  let observer: ResizeObserver | null = null;

  const stop = (): void => {
    window.clearTimeout(idle);
    window.clearTimeout(cap);
    observer?.disconnect();
    observer = null;
    // The same options the listeners were added with: `capture` is part of a
    // listener's identity, and a mismatch removes nothing.
    for (const type of READER_INPUTS) document.removeEventListener(type, stop, { capture: true });
  };

  /** Puts the target back if it has moved; says whether it had to. */
  const correct = (): boolean => {
    // Sub-pixel noise is not drift; a real shift is tens of pixels.
    if (Math.abs(target.getBoundingClientRect().top - top) < 1) return false;
    target.scrollIntoView({ block: 'start' });
    // Re-read rather than assume: a clamped scroll lands short of the margin,
    // and the NEXT drift is measured from where the target actually is.
    top = target.getBoundingClientRect().top;
    return true;
  };
  // The idle window's end: a drift found now means the page was still moving
  // (behind a blocked thread), so wait again rather than stop.
  const settle = (): void => {
    if (correct()) idle = window.setTimeout(settle, SETTLE_IDLE_MS);
    else stop();
  };

  observer = new ResizeObserver(() => {
    window.clearTimeout(idle);
    idle = window.setTimeout(settle, SETTLE_IDLE_MS);
    correct();
  });
  observer.observe(document.documentElement);
  const main = document.getElementById('main');
  if (main !== null) observer.observe(main);

  // `capture` so a handler that stops propagation cannot hide the reader's
  // input from us; `passive` because we never cancel it.
  for (const type of READER_INPUTS) document.addEventListener(type, stop, { capture: true, passive: true });
  idle = window.setTimeout(settle, SETTLE_IDLE_MS);
  // The cap is final, but it too decides on a fresh measurement.
  cap = window.setTimeout(() => {
    correct();
    stop();
  }, SETTLE_CAP_MS);
  return stop;
}

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
   *
   * AND A FRAGMENT GOING AWAY IS NOT A NEW PAGE. `useSearchParams`' setter
   * navigates to `"?" + params`, which DROPS the hash — so a reader who landed
   * on `/runs/:id#errors` (the old `/errors` redirect, or the band's
   * `#simulation-assertions` link) and then changed the Investigate select, or
   * sorted a table, produced a same-path navigation with an empty hash. The
   * effect used to read that as "no fragment, so scroll to the top" and threw
   * them ~1,500px away from the table they were filtering. The decision is
   * the path's alone: the previous one is held in a ref, and only a DIFFERENT
   * pathname scrolls. The effect still depends on `hash` because it reads it
   * for the new-path-with-a-fragment case below.
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

  const { pathname, hash } = useLocation();
  /* `null` until the first render has run, which is also how the first render
     is told apart: nothing has been navigated FROM yet. (A strict-mode second
     run of the effect sees the same path and falls out at the next check, where
     the old `first` flag would have scrolled.) */
  const lastPathname = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastPathname.current;
    lastPathname.current = pathname;
    if (previous === null) return;
    // Same path: the SAME page asked again — a query refined, or a fragment
    // dropped by a setter. Never a reason to move the reader.
    if (previous === pathname) return;
    // A fragment on a NEW path is a move within it, and the effect below takes
    // it. Scrolling to the top first would undo it.
    if (hash !== '') return;
    window.scrollTo({ top: 0 });
  }, [pathname, hash]);

  /* ═══ A FRAGMENT LINK HAS TO BE HONOURED BY US (review 09-13 C04) ═══
   *
   * The decision band's "See the failed simulation assertion" is a `<Link>`
   * to `/runs/:id#simulation-assertions` (keeping the reader's query) — the
   * SAME path the reader is already
   * on. React Router answers that with `pushState`, and **a browser does not
   * scroll to a fragment on `pushState`**; native fragment scrolling happens
   * on a real hash navigation or a document load. So the URL gained the
   * fragment and nothing moved: measured at scrollY 82 with the target 1482px
   * below the viewport. The primary investigation shortcut on the run page
   * changed the address bar and nothing else.
   *
   * ═══ WHY IT RETRIES ═══
   *
   * The same URL typed fresh is worse, not better: the target belongs to a
   * lazy route child behind a query, so at first paint there is no element to
   * scroll to and the browser's own attempt finds nothing either. A bounded
   * retry across animation frames covers the chunk and the fetch without
   * spinning forever — it gives up rather than waiting on an id that will
   * never exist, which is what a typo'd fragment is.
   *
   * ═══ AND IT MOVES FOCUS, NOT ONLY THE VIEWPORT ═══
   *
   * The same argument the skip link below makes: scrolling without refocusing
   * leaves a keyboard or screen-reader user exactly where they were, reading
   * the link they just followed. The target is a `<section>` and not natively
   * focusable, so it is made focusable for the move; `preventScroll` keeps
   * `scrollIntoView`'s own placement, which is the one that honours the
   * section's `scroll-margin-top` under the sticky header.
   */
  useEffect(() => {
    if (hash === '') return;
    const id = decodeURIComponent(hash.slice(1));
    let cancelled = false;
    let frame = 0;
    let stopKeeping = (): void => {};

    const reveal = (attemptsLeft: number): void => {
      if (cancelled) return;
      const target = document.getElementById(id);
      if (target === null) {
        if (attemptsLeft > 0) frame = requestAnimationFrame(() => reveal(attemptsLeft - 1));
        return;
      }
      target.scrollIntoView({ block: 'start' });
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      // After the focus, and only once: a correction is a scroll, never a
      // second focus move.
      stopKeeping = keepInPlace(target);
    };

    // ~60 frames is about a second at 60Hz: long enough for a lazy chunk and
    // its query, short enough that a fragment naming nothing stops quietly.
    reveal(60);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stopKeeping();
    };
  }, [pathname, hash]);

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
          <span className="text-[0.9375rem] font-semibold tracking-tight text-primary">PerfPortal</span>
        </Link>

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
          <AccountMenu identity={identity} />
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
