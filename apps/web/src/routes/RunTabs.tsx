import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { runChartsPath, runErrorsPath, runPath, runTelemetryPath, runTrendsPath } from './paths';

/**
 * A run's five sections, as navigation.
 *
 * `NavLink` supplies `aria-current="page"` itself when its `to` matches — and
 * `end` on the Overview link is what stops it matching `/charts` and
 * `/errors` too, since both start with the run's own path.
 *
 * Load generators sits between Charts and Errors: it answers a question about
 * THIS run (which is what the first tabs do), and it is the one a reader turns
 * to when the charts look wrong — so it belongs beside them, not after the
 * failures. Trends stays last for the reason below: it is the only tab that
 * leaves the run.
 *
 * STILL LINKS IN A `<nav>`, NOT AN ARIA TAB PATTERN, and the design pass did
 * not change that. `role="tablist"`/`role="tab"` is what this LOOKS like and
 * would be wrong: each section is a real URL that can be linked, bookmarked
 * and opened in a new tab (`run-detail.spec.ts` asserts exactly that — "each
 * tab is its own URL reachable directly"), and the ARIA tab pattern describes
 * panels swapped in place, brings a roving-tabindex keyboard contract this
 * repo has no test for, and would break middle-click. The underline is a
 * visual convention; the semantics are navigation.
 *
 * The error count is DISTINCT MESSAGES, which only `/errors` knows. The stats
 * row's `koCount` is failed requests — 24 where this is 2 on the reference
 * run — so using it would put a plausible wrong number on screen.
 *
 * `errorCount` is `number | null`, not defaulted to `0` by its caller: `null`
 * means "not yet known" — `errorsQuery` still pending, or failed — and `0`
 * means the run genuinely has no distinct error messages. `RunShell` used to
 * collapse the two with `?? 0`, which read "Errors (0)" for a run whose count
 * had not arrived, and read it forever if the fetch failed outright while the
 * panel beneath it rendered `role="alert"` — a confident zero over a stated
 * failure. `peakUsers` two lines up in `RunHeader` already draws this
 * distinction (`runUsers.ts`'s own "zero is a measurement"); this is the same
 * argument applied to the tab that sits right beside it.
 */
export default function RunTabs({
  runId,
  errorCount,
}: {
  readonly runId: string;
  readonly errorCount: number | null;
}) {
  return (
    // `overflow-x-auto` because three tabs plus a count do not fit 320px once
    // the count reaches four digits, and a tab strip that wraps to two lines
    // stops reading as one control. `-mb-px` pulls the strip's own bottom
    // border onto the container's, so the active tab's underline meets the
    // rule rather than floating a pixel above it.
    <nav
      aria-label="Run sections"
      className="flex gap-1 overflow-x-auto border-b border-default"
    >
      <Tab to={runPath(runId)} end>
        Overview
      </Tab>
      <Tab to={runChartsPath(runId)}>Charts</Tab>
      <Tab to={runTelemetryPath(runId)}>Load generators</Tab>
      <Tab to={runErrorsPath(runId)}>
        {/* One text node, so the tab's accessible name is "Errors (2)" rather
            than a name assembled from two children — `run-detail.spec.ts`
            matches it with `getByRole('link', { name: /Errors/ })`, which
            holds either way, but a count in its own element would also become
            a `getByText('2')` target on a page full of numbers. */}
        {errorCount === null ? 'Errors' : `Errors (${errorCount})`}
      </Tab>
      {/* LAST, AND THE POSITION IS THE ARGUMENT. The first three tabs answer
          questions about THIS run, narrowing as they go — what happened, what
          it looked like, what went wrong. Trends is the only one that leaves
          the run, so it sits at the end rather than beside Charts, which it
          superficially resembles. */}
      <Tab to={runTrendsPath(runId)}>Trends</Tab>
    </nav>
  );
}

/**
 * One tab.
 *
 * THREE SIGNALS FOR THE ACTIVE STATE, not one: the accent underline, the
 * accent text colour, and a heavier weight. Colour alone would fail WCAG
 * 1.4.1 for a reader who cannot distinguish it, and the weight alone shifts
 * the strip's layout as the active tab changes — which is why the inactive
 * state carries `border-transparent` at the same 2px, reserving the space the
 * underline will occupy so nothing moves.
 */
function Tab({
  to,
  end = false,
  children,
}: {
  readonly to: string;
  readonly end?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        [
          'transition-ui -mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px]',
          isActive
            ? 'border-accent font-semibold text-accent'
            : 'border-transparent font-medium text-muted hover:border-default hover:text-primary',
        ].join(' ')
      }
    >
      {children}
    </NavLink>
  );
}
