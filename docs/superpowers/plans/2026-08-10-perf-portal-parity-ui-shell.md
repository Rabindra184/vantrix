# Parity UI Application Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an app shell a person can log into with a session cookie, list their org's runs, and open one run's header and assertions — proving the cookie survives a real browser before any chart work depends on it.

**Architecture:** A new `apps/web` Vite + React 18 SPA, served same-origin by the API in production and via a Vite proxy in development. Data flows through one `apiFetch` that validates every response against the Zod schemas `@perfportal/contracts` already exports, wrapped in TanStack Query. Verified end to end with Playwright against the real API, Postgres and worker.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind (CSS custom properties), TanStack Query, Playwright, Vitest.

**Spec:** [`docs/superpowers/specs/2026-08-10-perf-portal-parity-ui-shell-design.md`](../specs/2026-08-10-perf-portal-parity-ui-shell-design.md)

## Global Constraints

- **Same origin.** The API serves the built SPA; dev uses a Vite proxy. Never add CORS, and never relax the session cookie from `sameSite: 'strict'` — that property is currently this platform's entire CSRF defence (session-auth spec §8: no rate limiting, no CSRF token).
- **Mount order is load-bearing.** `/auth/*splat` → SPA static+fallback (excluding `/v1` and `/auth`) → Nest routes. `GET /v1/nonsense` must keep returning RFC 9457 `problem+json`, never `index.html`.
- **Types are imported, never redeclared.** Every response type comes from `@perfportal/contracts`. A hand-written interface mirroring an API shape is a second source of truth that typechecks while drifting.
- **Two error languages stay separate.** `/auth/*` returns Better Auth's native shapes; `/v1` returns RFC 9457 with a required `remediation`. Only the login form parses the former. Never synthesise a `remediation` the server did not send.
- **401 → `/login`. 403 → a real page.** A 403 means a valid session with no `org_member` row; redirecting it to `/login` loops forever.
- **Logout clears the query cache** before redirecting.
- ESM throughout; relative imports end in `.js` in Node-side code. `noUncheckedIndexedAccess` is ON.
- Node ≥22 (`nvm use`; the default shell node is v20).
- Pin every new dependency to an exact version — no carets. Record resolved versions in the task report.
- Accessibility is asserted, not aspired to: real `<table>` semantics, labelled inputs, deliberate focus on redirect, verdict never by colour alone.
- Work on `feat/parity-ui-shell`, branched from `main`. Never commit to `main`.

## Environment

```bash
export DATABASE_URL='postgresql://perfportal:perfportal@localhost:5433/perfportal'
nvm use            # Node 22; default shell node is v20
```

- `pnpm test:integration -- <path>` does **NOT** filter — the argument is swallowed and all 43 files run for the better part of an hour. Use `npx vitest run --config vitest.integration.config.ts <path>`.
- The Bash tool auto-backgrounds anything past 120s. Pass an explicit 600000 ms timeout on every build and test command; never poll a backgrounded run.
- Known load flake, not yours: `apps/api/test/ingest.integration.test.ts > POST /v1/runs > is idempotent` needs ~51s of its 120s budget idle.
- Do **not** run `prisma migrate`; the schema is applied. Do not set `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`.
- Baselines: 176 unit, 336 integration.

---

## File Structure

**Create**
- `apps/web/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`
- `apps/web/src/main.tsx` — mounts React, installs the Query client
- `apps/web/src/api/fetch.ts` — `apiFetch`, `ProblemError`
- `apps/web/src/api/session.ts` — session bootstrap, sign-in, sign-out
- `apps/web/src/routes/Login.tsx`, `RunList.tsx`, `RunDetail.tsx`, `NoOrg.tsx`
- `apps/web/src/styles/tokens.css` — design tokens, both themes
- `apps/api/src/spa.ts` — the static + fallback mount
- `apps/web/e2e/*.spec.ts` — Playwright specs
- `apps/web/e2e/fixtures.ts` — bootstrap admin, mint token, ingest the reference bundle
- `playwright.config.ts` (repo root)

**Modify**
- `apps/api/src/main.ts` — mount the SPA between `/auth` and Nest's routes
- `pnpm-workspace.yaml` needs no change (`apps/*` already matches)
- `package.json` — `dev:web`, `build:web`, `test:e2e` scripts

---

### Task 1: Scaffold `apps/web`

**Files:**
- Create: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/tsconfig.json`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles/tokens.css`

**Interfaces:**
- Produces: a `@perfportal/web` workspace package that builds to `apps/web/dist` and dev-serves on `:5173` with `/v1` and `/auth` proxied to `:3000`.

- [ ] **Step 1: Create the package**

```json
{
  "name": "@perfportal/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  }
}
```

- [ ] **Step 2: Install, pinned exactly**

```bash
pnpm --filter @perfportal/web add react react-dom @tanstack/react-query react-router-dom
pnpm --filter @perfportal/web add -D vite @vitejs/plugin-react typescript @types/react @types/react-dom tailwindcss @tailwindcss/vite
```

Then edit `apps/web/package.json` and **strip every caret** so each version is exact. Record the resolved versions in your report — a later task pins Playwright against this same React.

- [ ] **Step 3: Vite config with the dev proxy**

`apps/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

/**
 * The proxy is what makes dev same-origin. The session cookie is
 * sameSite: 'strict' and the API has no CORS, so hitting :3000 directly from
 * :5173 would send no cookie - a login that appears to succeed and then 401s
 * on every call. Proxying keeps dev and production behaviourally identical.
 */
export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: 'http://localhost:3000', changeOrigin: false },
      '/auth': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
});
```

`changeOrigin: false` is deliberate — rewriting the Host header would change the cookie's origin.

- [ ] **Step 4: Design tokens, both themes**

`apps/web/src/styles/tokens.css`. Define semantic tokens as CSS custom properties under `:root` and `@media (prefers-color-scheme: dark)`, plus a `[data-theme]` override so a future toggle wins in both directions. At minimum: surface, surface-raised, text-primary, text-muted, border, and status colours for `passed` / `failed` / `not_applicable` / `pending`.

**Status colour is never the only signal** — §22 and the spec both require text or shape alongside. The tokens exist so charts inherit them later; they do not license colour-only meaning now.

- [ ] **Step 5: Minimal app that renders**

`src/main.tsx` mounts React with a `QueryClientProvider` and a `BrowserRouter`. `src/App.tsx` renders a single `<h1>PerfPortal</h1>` for now.

- [ ] **Step 6: Verify and commit**

```bash
pnpm --filter @perfportal/web build
```
Expected: a `dist/` containing `index.html` and hashed assets. Commit as `feat(web): scaffold the Vite + React shell`.

---

### Task 2: The API serves the SPA — without swallowing `/v1`

**This is the task with the trap in it.** Get the ordering wrong and unknown `/v1` paths return HTML with a 200 to clients expecting a problem document.

**Files:**
- Create: `apps/api/src/spa.ts`
- Modify: `apps/api/src/main.ts`, `apps/api/test/support/app.ts`
- Create: `apps/api/test/spa.integration.test.ts`, `apps/api/test/fixtures/web-dist/index.html`

**The integration suite must not depend on a web build.** The root `build` script compiles `api` and `worker` only — `apps/web` is never built by `pnpm test:integration`, so `mountSpa` pointed at `apps/web/dist` would find nothing, no-op, and the tests would fail for a reason unrelated to the code under test.

So `mountSpa` takes its directory as a parameter, and the tests pass a committed fixture:

`apps/api/test/fixtures/web-dist/index.html`
```html
<!doctype html><html><head><title>PerfPortal</title></head>
<body><div id="root"></div></body></html>
```

`createTestApp()` mounts that fixture directory. Production passes the real `apps/web/dist`. This keeps the suite fast and deterministic, and the real build is covered by Playwright from Task 3 onward.

**Interfaces:**
- Produces: `mountSpa(instance: express.Express, distDir: string): void`

- [ ] **Step 1: Write the failing tests**

`apps/api/test/spa.integration.test.ts`, using `createTestApp()`:

```ts
it('serves index.html at the root', async () => {
  const res = await request(ctx.app.getHttpServer()).get('/').expect(200);
  expect(res.headers['content-type']).toContain('text/html');
  expect(res.text).toContain('<div id="root">');
});

// The regression this task exists to prevent.
it('leaves an unknown /v1 path as an RFC 9457 problem, not index.html', async () => {
  const res = await request(ctx.app.getHttpServer())
    .get('/v1/nonsense')
    .set('Authorization', `Bearer ${ctx.readToken}`)
    .expect(404);
  expect(res.headers['content-type']).toContain('application/problem+json');
  expect(res.body.remediation).toBeTruthy();
  expect(res.text).not.toContain('<div id="root">');
});

it('leaves an unknown /auth path to Better Auth, not index.html', async () => {
  const res = await request(ctx.app.getHttpServer()).get('/auth/nonsense');
  expect(res.text ?? '').not.toContain('<div id="root">');
});

// A deep link must reach the SPA, or refreshing /runs/<id> 404s.
it('falls back to index.html for a client route', async () => {
  const res = await request(ctx.app.getHttpServer()).get('/runs/abc').expect(200);
  expect(res.text).toContain('<div id="root">');
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
npx vitest run --config vitest.integration.config.ts apps/api/test/spa.integration.test.ts
```
Expected: the root and fallback tests fail (404, no SPA mounted). The two negative tests already pass — say so in your report; they are regression guards, not RED evidence.

- [ ] **Step 3: Implement the mount**

`apps/api/src/spa.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';

/**
 * Mounted BEFORE Nest's router, because Nest terminates unmatched requests
 * with its own 404 - static registered after it would never be reached.
 * Being early means this handler must exclude the API prefixes itself.
 *
 * The exclusion is the point: without it, GET /v1/nonsense falls into the SPA
 * fallback and returns index.html with a 200. A client expecting RFC 9457
 * then parses HTML as a problem document, and fails somewhere unrelated.
 *
 * No-op when dist is absent, so `pnpm --filter @perfportal/api dev` works
 * without a web build.
 */
export function mountSpa(instance: express.Express, distDir: string): void {
  if (!existsSync(join(distDir, 'index.html'))) return;
  const assets = express.static(distDir, { index: false });

  instance.use((req, res, next) => {
    if (req.path.startsWith('/v1') || req.path.startsWith('/auth')) return next();
    assets(req, res, () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.sendFile(join(distDir, 'index.html'));
    });
  });
}
```

In `apps/api/src/main.ts`, call it **after** `mountBetterAuth(app)` and **before** `await app.listen(...)`:

```ts
mountSpa(app.getHttpAdapter().getInstance(), resolve(import.meta.dirname, '../../web/dist'));
```

`createTestApp()` in `apps/api/test/support/app.ts` must call it too, or the tests exercise the harness rather than the app — the same reasoning that put `mountBetterAuth` in both.

- [ ] **Step 4: Run and confirm green**

All four pass. Then the whole api integration file set, to prove nothing else moved.

- [ ] **Step 5: Falsification checkpoint**

Delete the `req.path.startsWith('/v1')` clause and re-run.
Expected: **"leaves an unknown /v1 path as an RFC 9457 problem" FAILS** — it will receive `index.html` with a 200. Paste the real output. Restore and confirm green.

If it does not fail, the exclusion is untested and the task is not done — stop and report.

- [ ] **Step 6: Commit**

`feat(api): serve the SPA same-origin, excluding the API prefixes`

---

### Task 3: The Playwright harness, proven before features exist

**Files:**
- Create: `playwright.config.ts`, `apps/web/e2e/fixtures.ts`, `apps/web/e2e/smoke.spec.ts`
- Modify: root `package.json` (`test:e2e`)

**Interfaces — every later task draws from this list, so build it here.**

Produces, all from `apps/web/e2e/fixtures.ts`:

```ts
seedAdmin(): Promise<{ email: string; password: string; orgId: string }>
seedUserWithoutOrg(): Promise<{ email: string; password: string }>   // Task 5's 403 case
seedAdminForEmptyOrg(): Promise<{ email: string; password: string }>  // Task 6's empty state
seedRunWithData(orgId: string): Promise<string>                       // ingested reference bundle
seedRunWithNaAssertion(orgId: string): Promise<string>                // Task 7
seedPendingRun(orgId: string): Promise<string>                        // status stays 'pending'
seedRunInOtherOrg(): Promise<string>                                  // Task 7's cross-org case
```

and from `apps/web/e2e/helpers.ts`:

```ts
signIn(page: Page, who: { email: string; password: string }): Promise<void>
firstRowId(page: Page): Promise<string>
```

`seedPendingRun` creates the run row without running the pipeline, so it stays `pending` — do not sleep waiting for a worker.

`seedRunWithNaAssertion` needs an SLA rule that cannot be evaluated against the fixture, which is what produces `not_applicable` rather than a pass. Read how `apps/api/test/verdict.integration.test.ts` builds one rather than inventing a rule shape.

- [ ] **Step 1: Install and configure**

```bash
pnpm add -Dw @playwright/test
pnpm exec playwright install chromium
```

`playwright.config.ts` at the repo root: `testDir: 'apps/web/e2e'`, `use.baseURL: 'http://localhost:3000'`, and a `webServer` that builds the web app and starts the API so the SPA is served same-origin — **not** the Vite dev server, because production is what needs proving.

- [ ] **Step 2: Fixtures that reuse the established path**

`apps/web/e2e/fixtures.ts` creates an admin through Better Auth's server API and ingests the real Gatling reference bundle through a minted token — the same approach `apps/api/test/session-auth.integration.test.ts` already uses. Read that file and follow it rather than inventing new plumbing.

**Ingest is expensive (~51s).** Seed once per file in `test.beforeAll`, never per test.

- [ ] **Step 3: A smoke test that can fail**

```ts
test('serves the SPA shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'PerfPortal' })).toBeVisible();
});
```

- [ ] **Step 4: Verify, then falsify the harness itself**

Run it. Then change the expected heading to `'Nonsense'` and confirm the test fails — proving the harness actually drives a browser rather than passing vacuously. Restore.

- [ ] **Step 5: Commit** as `test(web): Playwright harness against the real stack`

---

### Task 4: The data layer

**Files:**
- Create: `apps/web/src/api/fetch.ts`, `apps/web/src/api/session.ts`, `apps/web/test/fetch.test.ts`

**Interfaces:**
- Produces: `apiFetch<T>(schema, path, init?): Promise<T>`; `class ProblemError extends Error { code: string; status: number; detail: string; remediation: string }`; `getSession()`, `signIn(email, password)`, `signOut()`.

- [ ] **Step 1: Write the failing unit tests**

`apps/web/test/fetch.test.ts` — Vitest, `fetch` stubbed at the module boundary (this is the one place mocking is right; there is no browser involved and the subject is parsing):

```ts
it('validates the response against the contract schema', async () => {
  stubFetch(200, { items: [], nextCursor: null });
  await expect(apiFetch(RunListResponseSchema, '/v1/runs')).resolves.toEqual({ items: [], nextCursor: null });
});

it('throws ProblemError carrying the remediation', async () => {
  stubFetch(400, { code: 'PROJECT_REQUIRED', detail: 'x', remediation: 'use a token' },
            'application/problem+json');
  await expect(apiFetch(RunListResponseSchema, '/v1/runs'))
    .rejects.toMatchObject({ code: 'PROJECT_REQUIRED', remediation: 'use a token' });
});

// A response that does not match the contract is a bug, not data.
it('rejects a response the schema does not accept', async () => {
  stubFetch(200, { items: 'not-an-array' });
  await expect(apiFetch(RunListResponseSchema, '/v1/runs')).rejects.toThrow();
});
```

- [ ] **Step 2: Run, confirm they fail** (module not found).

- [ ] **Step 3: Implement**

`apiFetch` sends `credentials: 'same-origin'`, parses `problem+json` into `ProblemError` on non-2xx, and parses success bodies through `schema.parse`. A 401 is thrown as a distinguishable `ProblemError` with `status: 401` — **the redirect belongs to the router, not to the fetch layer**, so this module stays testable without a DOM.

`session.ts` wraps `/auth/get-session`, `/auth/sign-in/email` and `/auth/sign-out`. **These do not return `problem+json`** (spec §5) — parse Better Auth's own shape here and nowhere else.

- [ ] **Step 4: Verify and commit** as `feat(web): typed fetch validated against the API contracts`

---

### Task 5: Login, session bootstrap, and the three rejections

**Files:**
- Create: `apps/web/src/routes/Login.tsx`, `apps/web/src/routes/NoOrg.tsx`, `apps/web/src/AuthGate.tsx`
- Create: `apps/web/e2e/auth.spec.ts`

- [ ] **Step 1: Write the failing E2E tests**

```ts
test('signing in lands on the run list', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/runs$/);
});

// The cookie round trip - the reason this sub-project exists.
test('the session survives a full page reload', async ({ page }) => {
  await signIn(page, admin);
  await page.reload();
  await expect(page).toHaveURL(/\/runs$/);
  await expect(page.getByRole('table')).toBeVisible();
});

test('an unauthenticated deep link redirects to login and comes back', async ({ page }) => {
  await page.goto(`/runs/${runId}`);
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, admin);
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
});

test('signing out clears the session', async ({ page }) => {
  await signIn(page, admin);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/runs');
  await expect(page).toHaveURL(/\/login/);
});

// A valid session with no org must NOT bounce to login - that loops forever.
test('a user with no organisation sees an explanation, not a login loop', async ({ page }) => {
  const orphan = await seedUserWithoutOrg();
  await signIn(page, orphan);
  await expect(page.getByText(/not a member of any organisation/i)).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
});
```

- [ ] **Step 2: Run, confirm they fail.**

- [ ] **Step 3: Implement**

`AuthGate` calls `getSession()` once on mount and renders a loading state, `/login`, `NoOrg`, or the children. The router handles `ProblemError` with `status: 401` by navigating to `/login` with the intended path in state; `status: 403` renders `NoOrg`.

The login form is the **only** consumer of Better Auth's error shape. No sign-up link — there is no self-registration.

Accessibility: inputs carry real `<label>`s (the tests select by label, so a missing one fails the test), and focus moves to the heading on redirect.

- [ ] **Step 4: Verify green.**

- [ ] **Step 5: Falsification checkpoint**

Change the 403 branch to redirect to `/login` like a 401, and re-run.
Expected: **"a user with no organisation sees an explanation" FAILS.** Paste the output. Restore.

This is the assertion protecting a user from an infinite login loop; prove it can fail.

- [ ] **Step 6: Commit** as `feat(web): session login, bootstrap, and the no-organisation state`

---

### Task 6: The run list

**Files:**
- Create: `apps/web/src/routes/RunList.tsx`, `apps/web/e2e/run-list.spec.ts`

- [ ] **Step 1: Write the failing E2E tests**

```ts
test('lists the org runs in a real table', async ({ page }) => {
  await signIn(page, admin);
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(seeded.length + 1);   // + header
});

// Sort and display must agree, or the list reads as mis-sorted.
test('orders by the same value it displays', async ({ page }) => {
  await signIn(page, admin);
  const shown = await page.getByRole('cell', { name: /started/i }).allInnerTexts();
  expect([...shown]).toEqual([...shown].sort().reverse());
});

test('follows the cursor to the next page', async ({ page }) => {
  await signIn(page, admin);
  const first = await firstRowId(page);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(firstRowId(page)).resolves.not.toBe(first);
});

test('an empty org says so instead of showing an empty table', async ({ page }) => {
  await signIn(page, emptyOrgAdmin);
  await expect(page.getByText(/no runs yet/i)).toBeVisible();
});
```

- [ ] **Step 2: Run, confirm they fail.**

- [ ] **Step 3: Implement**

Columns: started (the coalesced value — `toolStartedAt ?? startedAt`, labelled so the fallback is visible when they differ), tool, status, verdict, and a link to the run. Cursor paging via `nextCursor`; **no offset paging exists**.

Verdict and status render as text plus shape, never colour alone.

- [ ] **Step 4: Verify green.**

- [ ] **Step 5: Falsification checkpoint**

Change the displayed timestamp to `startedAt` unconditionally, and seed a run whose `toolStartedAt` disagrees with its `startedAt`.
Expected: **"orders by the same value it displays" FAILS.** Paste the output. Restore.

- [ ] **Step 6: Commit** as `feat(web): the org run list`

---

### Task 7: Run detail — header and assertions

**Files:**
- Create: `apps/web/src/routes/RunDetail.tsx`, `apps/web/e2e/run-detail.spec.ts`

- [ ] **Step 1: Write the failing E2E tests**

```ts
test('shows the run header', async ({ page }) => {
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole('heading', { name: /ParitySimulation/ })).toBeVisible();
  await expect(page.getByText(/^\d+s$/)).toBeVisible();          // whole seconds, per Gatling
});

// not_applicable must never read as a pass.
test('renders a not_applicable assertion distinctly from a pass', async ({ page }) => {
  await signIn(page, admin);
  await page.goto(`/runs/${runWithNaAssertion}`);
  const row = page.getByRole('row', { name: /not applicable/i });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText(/passed/i);
});

test('a pending run says so rather than showing zeros', async ({ page }) => {
  await signIn(page, admin);
  await page.goto(`/runs/${pendingRunId}`);
  await expect(page.getByText(/still processing/i)).toBeVisible();
});

test('another org run is not readable', async ({ page }) => {
  await signIn(page, admin);
  await page.goto(`/runs/${otherOrgRunId}`);
  await expect(page.getByText(/not found/i)).toBeVisible();
});
```

- [ ] **Step 2: Run, confirm they fail.**

- [ ] **Step 3: Implement**

Header: simulation, description, tool and version, started, duration to **whole seconds**, status, verdict. Assertions in a real table with an outcome column where `not_applicable` has its own label and shape.

Polling: `refetchInterval` while `status === 'pending'`, disabled once it settles. A run that never settles must not poll forever — cap it and surface a message.

- [ ] **Step 4: Verify green.**

- [ ] **Step 5: Falsification checkpoint**

Render `not_applicable` with the same treatment as `passed`, and re-run.
Expected: **"renders a not_applicable assertion distinctly from a pass" FAILS.** Paste the output. Restore.

This is the assertion the ingest spine introduced the outcome for; a UI that flattens it undoes that decision silently.

- [ ] **Step 6: Full verification and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:e2e
```
Commit as `feat(web): run detail with header and assertions`.

---

## Verification

**Definition of done:** a person signs in with an email and password in a real browser, sees their org's runs, opens one, and reads its header and assertions — with the session surviving a page reload. `pnpm typecheck`, `pnpm lint`, the unit suite, the integration suite and the Playwright suite are all green.

**The four falsification checkpoints are the point of this plan.** Each names a mutation and the test that must go red:

| Task | Break this | This must fail |
|---|---|---|
| 2 | the `/v1` exclusion in `mountSpa` | unknown `/v1` returns a problem document |
| 5 | the 403 branch, redirecting like a 401 | the no-organisation page |
| 6 | display `startedAt` unconditionally | sort and display agree |
| 7 | render `not_applicable` as a pass | `not_applicable` is distinct |

A checkpoint that stays green is a finding, not a formality. The previous sub-project shipped four assertions that could not fail; every one was caught by breaking the code and watching.

**Out of scope, and must not appear in any diff:** charts of any kind, request/group/scenario detail pages, i18n mechanics, personalization, saved views, custom dashboards, live monitoring, self-registration, invitations, password reset, and any RBAC affordance — `org_member.role` is write-only until M6, and a UI reading it would invent an authorization model the backend does not enforce.
