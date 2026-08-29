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
export default defineConfig({
  testDir: 'apps/web/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
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
    command: 'pnpm build && pnpm --filter @perfportal/api start',
    url: 'http://localhost:3000',
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
