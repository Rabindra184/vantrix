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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // `pnpm build` (root) compiles every workspace package plus apps/api
    // and apps/worker — but NOT apps/web (see progress.md's Task 2
    // pre-flight note: the root `build` script never touches it). Building
    // apps/web explicitly is what puts a real index.html + assets under
    // apps/web/dist for mountSpa to find; skip it and GET / 404s instead of
    // exercising the production same-origin path this harness exists to
    // prove. apps/worker is still built here even though nothing starts a
    // worker PROCESS: apps/web/e2e/fixtures.ts imports
    // apps/worker/dist/pipeline/pipeline.service.js directly to run the
    // ingest pipeline synchronously against the same database, with no live
    // worker — see fixtures.ts's own comment for why.
    command: 'pnpm build && pnpm --filter @perfportal/web build && pnpm --filter @perfportal/api start',
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
