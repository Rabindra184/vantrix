/**
 * One setting, and the reason it exists is an inconsistency rather than a
 * preference.
 *
 * ═══ `testTimeout` IS 30s AND `findBy*` GAVE UP AT 1s ═══
 *
 * `vitest.config.ts` allows a test 30 seconds. Testing Library's async
 * queries — `findByRole`, `findByText`, `waitFor` — default to ONE, and that
 * default is what decides whether a `findBy*` sees a render that is merely
 * slow. So the suite was willing to wait thirty times longer for a test than
 * for the query inside it.
 *
 * That gap is a flake generator on a loaded machine, and it produced one:
 * `ProjectRail.test.tsx`'s "lists every project as a link to its own page"
 * failed 3 of 4 full `test:unit` runs and passed alone every time, reporting
 * `Unable to find role="link" and name /Checkout Flow/`. Its fetch stub
 * resolves with `Promise.resolve` — there is no I/O to be slow — so the only
 * thing that can exceed a second there is the machine failing to schedule a
 * React render and a TanStack Query resolution within one, which is exactly
 * what happens when the Docker VM is saturated beside it.
 *
 * ═══ THIS CANNOT HIDE A REAL FAILURE, ONLY DELAY ONE ═══
 *
 * `findBy*` retries until its timeout and then throws. A component that never
 * renders the element still fails, with the identical message; it simply takes
 * five seconds to say so instead of one. What changes is only the verdict on a
 * render that WOULD have succeeded given a moment more — and calling that a
 * failure is the bug being fixed.
 *
 * Five seconds, not thirty: a genuinely broken assertion should still report
 * quickly, and matching `testTimeout` exactly would mean one such failure
 * consumes the whole per-test budget and reports as a timeout rather than as
 * the missing element it is.
 *
 * ═══ WHY THIS FILE LIVES UNDER `apps/web/test` ═══
 *
 * `configure` comes from Testing Library, which is a dependency of `apps/web`
 * and NOT of the workspace root — so a setup file at the root cannot resolve
 * it ("Failed to resolve import"). Vite resolves a setup file's imports
 * relative to that file, so living beside the suites that need it makes the
 * import work for every suite, including the node-environment ones in
 * `packages/*` that never touch it.
 *
 * It is `setup.ts`, not `*.test.ts`, so the config's own `include` globs do
 * not collect it as a suite.
 *
 * ═══ WHAT IS DELIBERATELY NOT HERE ═══
 *
 * `afterEach(cleanup)`. `vitest.config.ts` sets no `globals`, so Testing
 * Library's automatic cleanup never registers and every `.tsx` file calls
 * `afterEach(cleanup)` itself — a discipline CLAUDE.md records after four
 * files that did not caused a genuinely unreproducible flake. Adding cleanup
 * here would work, and would silently make 28 explicit calls redundant while
 * leaving the next reader unable to tell which files rely on which. If that
 * changes, it should change as its own deliberate edit, not as a side effect
 * of a timeout.
 */
import { configure } from '@testing-library/react';

// Guarded: this file runs for every suite the config includes, and the
// node-environment `.ts` suites have no DOM and never call an async query.
// Configuring there is harmless but pointless, and the guard says which
// suites this is actually for.
if (typeof document !== 'undefined') {
  configure({ asyncUtilTimeout: 5_000 });
}
