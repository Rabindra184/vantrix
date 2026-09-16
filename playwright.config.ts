import { defineConfig, devices } from '@playwright/test';

/**
 * Drives the API serving the BUILT SPA (mountSpa, apps/api/src/spa.ts) —
 * deliberately not the Vite dev server on :5173. The dev server proxies
 * `/v1` and `/auth` to the API (see apps/web/vite.config.ts); a harness that
 * only ever exercised that proxy would never notice a broken mountSpa
 * mount, a missing `/v1`/`/auth` exclusion, or a stale `apps/web/dist` —
 * exactly the shape production actually ships in. baseURL and webServer.url
 * below both point at the API's own port, same-origin, on purpose.
 *
 * DATABASE COLLISION: apps/web/e2e/fixtures.ts talks to the SAME
 * DATABASE_URL apps/api/test/support/app.ts's createTestApp() uses, and
 * createTestApp() TRUNCATEs all 15 tables on every call. Never run
 * `pnpm test:integration` and `pnpm test:e2e` concurrently against the same
 * database — the integration suite will wipe whatever this suite just
 * seeded, mid-assertion.
 */
/**
 * 3000 unless told otherwise. `reuseExistingServer` is deliberately false
 * (see below), so ANYTHING already listening on this port fails the whole run
 * before a single spec — including a completely unrelated project of yours,
 * which is exactly how this was met:
 *
 *     Error: http://localhost:3000 is already used, make sure that nothing is
 *     running on the port/url or set reuseExistingServer:true
 *
 * `PERFPORTAL_E2E_PORT=3100 pnpm test:e2e` moves the whole harness — the
 * server's own PORT, the URL Playwright waits on, baseURL, AND
 * `apps/web/e2e/fixtures.ts`, which reads the same variable because it seeds
 * over plain fetch and cannot see `baseURL`. All four or none: moving three of
 * them sent the browser to 3100 and the seeding to 3000, and 214 specs failed
 * with a 404 from whatever else was listening there.
 *
 * It stays same-origin, which is the property the session cookie depends on.
 */
const PORT = process.env.PERFPORTAL_E2E_PORT ?? '3000';
const ORIGIN = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'apps/web/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: ORIGIN,
    /* ═══ TRACE THE ATTEMPT THAT FAILED, NOT THE ONE THAT RECOVERED ═══
     *
     * This was `on-first-retry`, which traces a test RUNNING AS a retry — so
     * for a flake whose retry succeeds it records precisely the attempt with
     * nothing wrong in it. Measured: the one flaky test in the run that
     * diagnosed the navigation stall left exactly one `trace.zip`, under
     * `…-webkit-retry1/`, the attempt that PASSED; the failing attempt left an
     * `error-context.md` and no trace. Two cross-browser runs' worth of
     * evidence for that stall was collected and thrown away this way.
     *
     * `retain-on-first-failure` records every test and keeps the recording
     * only where the FIRST attempt failed, which is the one worth having.
     *
     * IT IS NOT FREE, AND THE NUMBER IS MEASURED RATHER THAN WAVED AT.
     * Interleaved A/B/A/B against the Chromium suite on one machine:
     *
     *   on-first-retry           55.2s, 52.3s   mean 53.8s
     *   retain-on-first-failure  66.0s, 72.0s   mean 69.0s
     *
     * ~28%, because every test is now recorded and most are then discarded.
     * On `e2e-cross-browser` (411 tests at --workers=1, 13.9-15.4 min) that is
     * roughly four minutes a run. The trade is deliberate: a flake nobody can
     * see costs more than four minutes, and this suite spent two full runs
     * proving it. */
    trace: 'retain-on-first-failure',

    /* ═══ A STALLED NAVIGATION MUST NOT EAT THE WHOLE TEST BUDGET ═══
     *
     * Unset, `navigationTimeout` is 0 — so a navigation that never completes
     * is bounded only by `timeout` above, and consumes all sixty seconds
     * before reporting. That is how every cross-browser flake this suite has
     * produced has looked: a 1.0m test, in `signIn`, whose retry four seconds
     * later takes two.
     *
     * MEASURED, so this bound is not a guess. 180 navigations of this app's
     * own `/login` in Firefox and WebKit, each after a deliberate idle gap:
     * median 58-68ms, p95 74-85ms, worst 374ms. Twenty seconds is fifty times
     * the worst ever observed, so nothing legitimate can reach it — while a
     * stall now fails in twenty seconds and says which navigation stalled,
     * instead of surfacing as an unexplained minute somewhere else. */
    navigationTimeout: 20_000,
  },
  /**
   * ═══ CHROMIUM BY DEFAULT, THREE ENGINES ON DEMAND ═══
   *
   * `pnpm test:e2e` stays Chromium-only, and that is not laziness: adding
   * Firefox and WebKit unconditionally would make the documented command fail
   * on every machine that has not run `playwright install firefox webkit`,
   * turning a coverage improvement into a broken quick start.
   *
   * `pnpm test:e2e:cross` sets the variable below and runs all three. The
   * `e2e-cross-browser` CI job runs it on `main` and on demand, which is the
   * cadence that matches what it catches: engine differences in CSS layout,
   * focus behaviour, `Intl` formatting and — the one this product genuinely
   * risks — WebSocket and cookie handling, none of which change between two
   * commits on a feature branch.
   *
   * The whole suite runs on each engine rather than a smoke subset. A subset
   * would need a tagging convention nobody maintains, and the specs that
   * would be OUTSIDE it (the run tables, the charts, the live banner) are
   * exactly where an engine difference would show up.
   */
  projects:
    process.env.PERFPORTAL_E2E_BROWSERS === 'all'
      ? [
          { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
          { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // `pnpm build` (root) compiles every workspace package plus apps/api,
    // apps/worker AND apps/web — the last via the root `build:web` script,
    // which is what puts a real index.html + assets under apps/web/dist for
    // mountSpa to find. That was NOT always true: this command used to build
    // apps/web itself because the root build never touched it, which meant
    // the documented `pnpm build` produced an API that answered GET / with
    // Nest's 404. It is one script now, so an operator following README.md
    // and this harness build the same thing.
    //
    // apps/worker is built even though nothing starts a worker PROCESS:
    // apps/web/e2e/fixtures.ts imports
    // apps/worker/dist/pipeline/pipeline.service.js directly to run the
    // ingest pipeline synchronously against the same database, with no live
    // worker — see fixtures.ts's own comment for why.
    command: `pnpm build && PORT=${PORT} pnpm --filter @perfportal/api start`,
    url: ORIGIN,
    // A full workspace build (tsc -b across every package, plus the api,
    // worker and web builds) comfortably exceeds Playwright's 60s default
    // webServer timeout on a cold cache.
    timeout: 300_000,
    // Deliberately never reused, even locally: `reuseExistingServer: true`
    // would mean that if anything is already answering on :3000, Playwright
    // skips `command` entirely — including its two build steps — and every
    // test runs against whatever `apps/web/dist` happened to be built last,
    // silently. This harness exists so Tasks 5-7 can trust a green run
    // means their CURRENT front-end code passed; a stale-dist false green
    // defeats that.
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
