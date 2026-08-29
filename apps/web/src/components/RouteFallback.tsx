/**
 * What a lazy route chunk shows while it arrives.
 *
 * ═══ DELIBERATELY CARRIES NO `role` ═══
 *
 * Not `status`, not `alert`, not `progressbar`. This element appears and
 * disappears on route transitions, and a live region that comes and goes
 * under the reader is worse than none: a page-wide `getByRole('status')` or
 * `getByRole('alert')` silently changes meaning the moment a second thing on
 * the page can answer it, and this repository has been bitten by exactly that
 * twice — once by `ChartActions`' always-mounted copy-feedback region, once by
 * `ProjectRules`' load failure answering `ProjectSetup`'s token assertions.
 *
 * Nothing is lost by staying quiet: the route that follows announces itself
 * with its own `<h1>` and its own `useDocumentTitle`, which is what a screen
 * reader is waiting for anyway.
 *
 * Three boundaries render this — `App` (for `Login`/`NoOrg` and the shell
 * itself), `AppShell` (so the header and rail survive a page chunk) and
 * `RunShell` (so the run header survives a tab chunk). One component so all
 * three read identically.
 */
export default function RouteFallback() {
  return <p className="p-6 text-sm text-muted">Loading…</p>;
}
