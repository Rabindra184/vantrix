# Public links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Member shares one finished run through an expiring, revocable link. Anyone holding the link reads that run's Summary, Report and Logs without signing in. An org-level switch, off by default, governs the feature.

**Architecture:** The link's secret is a credential. `AuthMiddleware` resolves it into a tenant pinned to the link's run, and `AccessGuard` lets that tenant reach only routes marked `@LinkReadable`, for that run alone. The web mounts the existing `RunShell` and its three tabs under `/share/:token`, inside a `public` presentation context that turns out-of-run links into text and drops the AI card and the baseline.

**Tech Stack:** NestJS 11, Prisma 6 and raw `pg`, zod 4, React 19 with React Router 7 and TanStack Query, Vitest 4 (two projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-public-links-and-custom-report-design.md` (sections 2–8; section 9 is the custom report and is out of scope here).

## Global Constraints

- **Node 22** (`nvm use`). Give a background process the absolute node path: `nvm use 22` inside a backgrounded list resolved Node 20 once.
- **Scratch stores only, never the developer database:**
  - database `perfportal_links`, created and migrated with `prisma migrate deploy`
  - a Redis index that `redis-cli -p 6380 -n <n> DBSIZE` reports empty, flushed through `infra-redis-1` or `-p 6380`, never through `head -1`
  - bucket `perfportal-links`
  - e2e port `3880`; the AI stub takes `3881`
- **Never `prisma db push`.** The schema changes through a migration only, and `infra/test/schema-matches-migrations.sh` must agree.
- **Every task leaves `pnpm typecheck`, `pnpm lint` and `pnpm test:unit` green**, read by each command's own exit code, never through a pipe.
- **Every instant column is `timestamptz(3)`.** A `date` partition key is not involved here.
- **No conditional spread of an object literal** (the eslint rule). An optional field is a named key holding `undefined`.
- **No backticks inside SQL comments** in template-literal SQL.
- **A parameter whose wrong value is silent gets no default.** That covers `RunShell`'s `projectAccess`, `RunHeader`'s `actions`, and `useRunPaths`' callers.
- **Error helpers only.** Use `badRequest`, `conflict`, `notFound`, `accessDenied` and `runNotFound` from `apps/api/src/common/validation.ts`. The remediation guard bans a bare `new XException(`.
- **Exact copy,** verbatim from the spec:
  - Consent (share dialog): "Anyone with this link can read this run's Summary, Report and Logs — its project and test names included — without signing in, until it expires or is revoked."
  - Shown once: "This is the only time the full link is shown."
  - Admin switch sentence: "Anyone with a public link can read that run's Summary, Report and Logs without signing in, until the link expires or is revoked. Turning this off stops every link at once; turning it back on restores the links that have not expired or been revoked."
  - Link-state pages, by code:
    - `LINK_EXPIRED`: "This link expired on <date>."
    - `LINK_REVOKED`: "This link has been revoked."
    - `PUBLIC_LINKS_DISABLED`: "Public links are turned off for this organisation."
    - `LINK_NOT_FOUND`: "This link does not exist."
    - Each page adds: "Ask whoever sent it for a new link."
  - Public header: "Read-only link · expires <date>".
- **Values:**
  - secret `ppl_` plus 43 base64url characters, from 32 random bytes
  - SHA-256 lowercase hex
  - expiry strictly after now plus 60 s, and at most 732 days ahead
  - `last_used_at` touched at most once per 60 s
- **Floors.** Measure `test:unit`, `test:integration` and `test:e2e` (Chromium) before Task 1, on the branch cut from `main` after PR #300 merged. Every task reports its own delta from what it added, counted with `vitest list` or `playwright test --list`.
- **Commits.** Use `git commit -F -` with a quoted heredoc, and add no attribution lines. Implementers commit and never push.

## Review Focus

1. **A signed-in sharer opens their own link in the same browser.** The page must send no cookie and show exactly what a stranger sees: no AI card, no Compare, no edit control. Owned by Task 6 (the `credentials: 'omit'` unit case) and Task 10 (the signed-in context half).
2. **A malformed `Authorization: PublicLink` header** (empty, wrong prefix, 1000 characters, two values) answers 401 `LINK_NOT_FOUND`, never a 500. Owned by Task 5.
3. **History navigation from `/share/...` back into the app in the same tab.** The credential follows the URL on each request, so app reads send the cookie again. Owned by Task 6, which computes the credential per call and has a case that changes the pathname between two calls.
4. **A link revoked or expiring while the page is open.** The next read flips the whole page to the link-state page: it never goes to `/login`, and it never shows a chart's "could not be loaded". Owned by Task 8.
5. **A custom date at the edges:** today, two years from today, beyond. The input bounds stop all three in the browser, and the server bound refuses an out-of-range value anyway. Owned by Task 9 (bounds and end-of-day) and Task 4 (the server refusal).

---

## Before Task 1 (controller)

- [ ] **Cut the branch.** Once `gh pr view 300 --json state` reads `MERGED`:

  ```bash
  git fetch origin
  git checkout -b feat/public-links origin/main
  git log --oneline origin/main..HEAD   # empty
  ```

- [ ] **Prepare the tree:** `nvm use 22 && pnpm install --frozen-lockfile && pnpm --filter @perfportal/persistence exec prisma generate && pnpm build`.
- [ ] **Create the scratch stores** listed in Global Constraints. Confirm `pgrep -f dist/main.js` is empty.
- [ ] **Measure and record the three floors** in the ledger at `.superpowers/sdd/2026-11-06-public-links/progress.md`.

### Task 1: Contracts and the secret

**Files:**
- Create: `packages/contracts/src/public-links.ts`, and export it from `packages/contracts/src/index.ts`
- Create: `packages/core/src/public-link-secret.ts`, and export it from `packages/core/src/index.ts`
- Test: `packages/contracts/test/public-links.test.ts`, `packages/core/test/public-link-secret.test.ts`

**Interfaces:**
- Produces, in `@perfportal/contracts`:
  - `PUBLIC_LINK_SECRET_PATTERN = /^ppl_[A-Za-z0-9_-]{43}$/`
  - `PUBLIC_LINK_MAX_EXPIRY_DAYS = 732`
  - `PUBLIC_LINK_MIN_LEAD_MS = 60_000`
  - `PublicLinkStateSchema`, an enum of `active`, `expired` and `revoked`
  - `PublicLinkSchema`, the spec's 4.1 shape, with every instant `z.string().datetime()`
  - `CreatePublicLinkRequestSchema`: `{ expiresAt }`, `.strict()`
  - `CreatePublicLinkResponseSchema`: `{ link: PublicLinkSchema, secret: string }`
  - `PublicLinkListResponseSchema`: `{ enabled: boolean, items: PublicLink[] }`
  - `PublicLinkResolveResponseSchema`: `{ runId: guid, expiresAt }`
  - `PUBLIC_LINK_REFUSAL_CODES`, the tuple `['LINK_NOT_FOUND', 'LINK_REVOKED', 'PUBLIC_LINKS_DISABLED', 'LINK_EXPIRED']`, and its type `PublicLinkRefusalCode`
  - `publicLinkState(link: { revokedAt: string | null; expiresAt: string }, now: Date): PublicLinkState`
  - `publicLinkExpiryProblem(expiresAt: Date, now: Date): string | null`, which returns the sentence the API puts in its 400, or null
- Produces, in `@perfportal/core`:
  - `mintPublicLinkSecret(): string`
  - `hashPublicLinkSecret(secret: string): string`

- [ ] **Step 1: Write the failing tests.**
  - `publicLinkState`:
    - revoked beats expired: `{ revokedAt: past, expiresAt: past }` gives `'revoked'`
    - expired: `{ revokedAt: null, expiresAt: past }` gives `'expired'`
    - active: an expiry in the future gives `'active'`
    - an expiry exactly `now` reads `'expired'`
  - `publicLinkExpiryProblem`:
    - `now + 59_999` is a problem
    - `now + 60_001` is null
    - `now + 732 days` is null
    - `now + 732 days + 1` is a problem
  - `CreatePublicLinkRequestSchema` refuses `{ expiresAt, extra: 1 }` and a non-datetime value.
  - `PUBLIC_LINK_SECRET_PATTERN` accepts a minted secret and refuses `pp_…`, 42 characters, 44 characters, and `+` or `/` characters.
  - `mintPublicLinkSecret()` matches the pattern, and 1,000 mints are all distinct.
  - `hashPublicLinkSecret('ppl_x')` equals `createHash('sha256').update('ppl_x').digest('hex')`, written out as a literal expectation computed once.
- [ ] **Step 2: Run them and see them fail.** `pnpm vitest run packages/contracts/test/public-links.test.ts packages/core/test/public-link-secret.test.ts` fails with "module not found".
- [ ] **Step 3: Implement both modules.** Use `randomBytes(32).toString('base64url')` and `createHash('sha256')`. A 732-day bound is `732 * 86_400_000` ms.
- [ ] **Step 4: Run the tests, `pnpm typecheck` and `pnpm lint`,** each by its exit code. All pass.
- [ ] **Step 5: Commit** with the message `feat(contracts): public link schemas, states and the secret`.

### Task 2: Persistence

**Files:**
- Modify: `packages/persistence/prisma/schema.prisma`
  - add model `RunPublicLink`, mapped to `run_public_link`, with relations to `Org`, `Project`, `Run` (all cascade), and `User` twice (`created_by` and `revoked_by`, both set null)
  - add `Org.publicLinksEnabled`, mapped to `public_links_enabled` and defaulting to false
- Create: `packages/persistence/prisma/migrations/20261106120000_public_links/migration.sql`
- Create: `packages/persistence/src/repositories/public-link.ts`, exported
- Modify: `packages/persistence/src/repositories/org-settings.ts`
- Test: `packages/persistence/test/public-link.integration.test.ts`

**Interfaces:**
- Produces `PublicLinkRepository`, constructed with a `pg.Pool`, with these methods:
  - `create(input: { orgId; projectId; runId; tokenHash; createdBy: string | null; expiresAt: Date }): Promise<PublicLinkRecord>`
  - `listForRun(scope: { orgId; projectId }, runId: string): Promise<PublicLinkRecord[]>`, newest first
  - `revoke(scope: { orgId; projectId }, runId: string, linkId: string, userId: string): Promise<'revoked' | 'already' | 'not_found'>`
  - `findForCredential(tokenHash: string): Promise<PublicLinkCredential | null>`
  - `touch(linkId: string): Promise<void>`
- `PublicLinkRecord` is `{ id, runId, createdAt: Date, createdByName: string | null, expiresAt: Date, revokedAt: Date | null, revokedByName: string | null, lastUsedAt: Date | null }`.
- `PublicLinkCredential` is `{ linkId, orgId, projectId, runId, expiresAt: Date, revokedAt: Date | null, lastUsedAt: Date | null, publicLinksEnabled: boolean }`.
- `OrgSettingsRepository` gains `publicLinksEnabled(orgId): Promise<boolean>` and `setPublicLinksEnabled(orgId, enabled): Promise<void>`.

- [ ] **Step 1: Write the failing integration tests**, each a separate `it`:
  - `create` round-trips every column, and `token_hash` is unique: a second insert with the same hash throws `23505`.
  - `listForRun` orders by `created_at` descending, scopes by org and project (another org's run gives `[]`), and joins creator and revoker names, which read null after the user is deleted (`ON DELETE SET NULL`).
  - `revoke` answers `'revoked'`, then `'already'` without moving `revoked_at`, and answers `'not_found'` for a link of another run in the same project.
  - `findForCredential` returns the link joined with `org.public_links_enabled`, and null for an unknown hash.
  - `touch` writes `last_used_at` once. A second `touch` inside 60 s leaves it unchanged. The SQL guard is `last_used_at IS NULL OR last_used_at < now() - interval '60 seconds'`, and the case sets the column back 61 s to see it move again.
  - Deleting the run, and separately the project, removes its links (cascade).
  - `setPublicLinksEnabled` round-trips, and a new org reads `false`.
- [ ] **Step 2: Run them and see them fail.** Use `DATABASE_URL=…/perfportal_links pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/public-link.integration.test.ts`. The run fails because the relation does not exist.
- [ ] **Step 3: Write the migration and the schema.** The table follows spec 3.1, with the index `run_public_link_run_id_created_at_idx` on `(run_id, created_at DESC)`, and the migration also adds `ALTER TABLE "org" ADD COLUMN "public_links_enabled" BOOLEAN NOT NULL DEFAULT false`. Apply it with `prisma migrate deploy` against the scratch database, then `prisma generate` and `tsc -b packages/persistence`. Grep the emitted `dist` for the new methods.
- [ ] **Step 4: Implement the repository in raw `pg`**, beside `OrgSettingsRepository`'s style. Selects name the columns, never `*`, and `token_hash` never leaves `findForCredential`.
- [ ] **Step 5: Run the tests, then `bash infra/test/schema-matches-migrations.sh`.** The script prints exit 0, which means the schema and the migrations agree.
- [ ] **Step 6: Run typecheck, lint and unit; commit** with the message `feat(persistence): run_public_link and the org's public-links switch`.

### Task 3: The org switch, end to end

**Files:**
- Modify: `packages/contracts/src/admin.ts`
  - `OrgSettingsSchema` gains `publicLinksEnabled: z.boolean()`
  - `UpdateOrgSettingsRequestSchema` becomes `{ aiEnabled?, publicLinksEnabled? }`, `.strict()`, with a refinement that at least one is present
- Modify: `apps/api/src/admin/admin.controller.ts`: `updateSettings` writes each field present, and `#settings` returns `publicLinksEnabled`
- Modify: `apps/web/src/api/admin.ts`, `apps/web/src/routes/AdminSettings.tsx`
- Test: `packages/contracts/test/admin.test.ts` (or the file holding these schemas' cases), `apps/api/test/admin.integration.test.ts`, `apps/web/test/AdminSettings.test.tsx`

**Interfaces:**
- Produces `updateOrgSettings(body: UpdateOrgSettingsRequest)` in the web client. A switch sends only its own field.

- [ ] **Step 1: Write the failing tests.**
  - Contracts:
    - `{ aiEnabled: true }` parses: the rolling-deploy body from a browser built before this change.
    - `{ publicLinksEnabled: true }` parses.
    - `{}` is refused.
    - `{ aiEnabled: true, other: 1 }` is refused.
  - API:
    - `PUT { publicLinksEnabled: true }` answers with `publicLinksEnabled: true` and leaves `aiEnabled` unchanged.
    - `PUT { aiEnabled: true }` leaves `publicLinksEnabled` unchanged.
    - `{}` answers 400 `INVALID_ORG_SETTINGS`, and its remediation names both fields.
    - A Member answers 403 `ADMIN_REQUIRED`.
  - Web:
    - A second switch named "Public links" renders.
    - The spec's admin sentence is visible text, not behind an ⓘ.
    - Pressing the switch sends `{"publicLinksEnabled":true}` alone.
    - The AI switch still sends `{"aiEnabled":…}` alone.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the change.** The `INVALID_ORG_SETTINGS` remediation becomes: "Send {"aiEnabled": true|false}, {"publicLinksEnabled": true|false}, or both. The AI provider and model are the deployment's environment (AI_PROVIDER, AI_MODEL), not an organisation setting."
- [ ] **Step 4: Run** the three files, then typecheck, lint and unit. All pass.
- [ ] **Step 5: Commit** with the message `feat(admin): an org switch for public links, off by default`.

### Task 4: Managing a run's links

**Files:**
- Modify: `packages/contracts/src/access.ts`. Add `'run:share': { role: 'member', scope: null, label: 'Sharing runs by public link' }` to `AccessAction` and `ACCESS_ACTIONS`.
- Create: `apps/api/src/public-links/public-links.controller.ts`, at `@Controller('/v1/runs/:id')` with `@UseGuards(SessionOnlyGuard)`. It has three handlers, each `@Requires('run:share')`:
  - `@Post('public-links')`, `@HttpCode(201)`
  - `@Get('public-links')`
  - `@Delete('public-links/:linkId')`, `@HttpCode(204)`
- Create: `apps/api/src/public-links/public-links.module.ts`, registered in `AppModule`
- Modify: `apps/api/src/openapi/document.ts` and its schema registry: three operations and the new schemas
- Modify: `apps/api/test/access-routes.integration.test.ts`
  - three `ACCESS_BY_ROUTE` rows
  - a `PROBES` row: `{ action: 'run:share', role: 'member', route: 'GET /v1/runs/:id/public-links' }`
  - `fill()` replaces `:linkId` with a `randomUUID()` constant
- Modify: `apps/api/test/openapi.integration.test.ts` `CREATES_SYNCHRONOUSLY`, adding the POST: it awaits one insert and returns the row it wrote
- Modify: `apps/api/test/session-auth.integration.test.ts` cross-org `endpoints`, adding `public-links` (the derived guard there demands it)
- Test: `apps/api/test/public-links.integration.test.ts`

**Interfaces:**
- Consumes `PublicLinkRepository`, `OrgSettingsRepository` (Task 2) and the contracts (Task 1).
- Produces the three routes. The 201 body is `CreatePublicLinkResponse`, whose `secret` is the only copy.

- [ ] **Step 1: Write the failing integration tests.** Use a real session from `signInAsProjectMember` and a seeded `complete` run.
  - With the switch on:
    - POST answers 201. `secret` matches `PUBLIC_LINK_SECRET_PATTERN`, and `link.state` is `'active'`.
    - The stored `token_hash` equals `hashPublicLinkSecret(secret)`, and no column holds `secret`.
  - With the switch off, POST answers 403 `PUBLIC_LINKS_DISABLED`, and its remediation contains `Administration › Settings`.
  - A run `pending`, `running` or `failed` answers 409 `RUN_NOT_SHAREABLE` (one `it.each`). An `incomplete` run answers 201.
  - These answer 400 `INVALID_PUBLIC_LINK`:
    - an `expiresAt` of now plus 30 s
    - now plus 733 days
    - a body with an extra key
  - GET answers `{ enabled, items }`, newest first.
    - `enabled` follows the switch.
    - The states read `active`, `expired` (a row whose `expires_at` is set to the past) and `revoked`.
    - `createdBy.name` is the creator's.
  - DELETE answers 204, and a second DELETE answers 204 with `revokedAt` unchanged.
  - A link of another run in the same project answers 404 there.
  - A different Member of the project can revoke a link they did not create.
  - A bearer token with every scope answers 403 `FORBIDDEN` on all three routes (`SessionOnlyGuard`).
- [ ] **Step 2: Run them and see them fail** (404, because the routes do not exist yet).
- [ ] **Step 3: Implement the controller.**
  - Read the run with `runs.findById` and refuse by status.
  - Check the switch through `OrgSettingsRepository`.
  - Validate with `publicLinkExpiryProblem`.
  - Mint with Task 1's helpers and map rows to `PublicLink` with `publicLinkState`.
- [ ] **Step 4: Write the OpenAPI entries.**
  - Document the 201, 204, 400, 403 (`ROLE_REQUIRED`, `ADMIN_REQUIRED` and `PUBLIC_LINKS_DISABLED` on the POST), 404 and 409 responses.
  - Security is `cookieAuth` only.
  - The access sentence is generated from `ACCESS_ACTIONS`, as the 45 others are.
- [ ] **Step 5: Run** `public-links`, `access-routes`, `openapi` and `session-auth` integration, then typecheck, lint and unit. All pass.
- [ ] **Step 6: Commit** with the message `feat(api): create, list and revoke a run's public links`.

### Task 5: The link credential, and default-deny

**Files:**
- Create: `apps/api/src/auth/public-link.ts`, holding `authenticatePublicLink`, `PublicLinkRefusal` and `PUBLIC_LINK_TOKEN_ID_PREFIX = 'link:'`
- Modify: `apps/api/src/auth/auth.guard.ts`. `Tenant` gains `publicLink?: { readonly linkId: string; readonly runIds: readonly string[] }`, and `AuthGuard` returns early, before the scope loop, for a tenant carrying `publicLink`.
- Modify: `apps/api/src/auth/auth.middleware.ts`
  - The branch order is the `PublicLink` scheme, then `Bearer `, then the session.
  - A `PublicLinkRefusal` renders 401 with its own `code`, `detail` and `remediation`.
  - On success it sets `Cache-Control: private, no-store`.
- Modify: `apps/api/src/auth/access.decorator.ts`. Add `LINK_READABLE_KEY`, `PUBLIC_LINK_ONLY_KEY`, `LinkReadable()` and `PublicLinkOnly()`.
- Modify: `apps/api/src/auth/access.guard.ts`. Before reading `REQUIRES_KEY`:
  - A tenant carrying `publicLink` is allowed iff (`LINK_READABLE_KEY` and `params.id` is in `runIds`) or `PUBLIC_LINK_ONLY_KEY`. Otherwise it gets `runNotFound(String(params.id ?? ''))`.
  - For any other tenant, `PUBLIC_LINK_ONLY_KEY` gives `notFound(...)`.
- Create: `apps/api/src/public-links/public-link-resolve.controller.ts`: `@Controller('/v1/public-link')`, `@Get()`, `@PublicLinkOnly()`, returning `PublicLinkResolveResponse`
- Modify: `apps/api/test/access-routes.integration.test.ts`
  - `WalkedRoute` gains `linkReadable` and `publicLinkOnly`
  - `Access` gains `'public-link'`, and `markers()` counts `publicLinkOnly`
  - an `ACCESS_BY_ROUTE` row: `'GET /v1/public-link': 'public-link'`
- Test: `apps/api/test/public-link-credential.integration.test.ts`

**Interfaces:**
- Produces `authenticatePublicLink(req: Request, links: PublicLinkRepository): Promise<Tenant>`. The tenant is `{ orgId, projectId, tokenId: 'link:<id>', scopes: [], publicLink: { linkId, runIds: [runId] } }`.
- Produces `PublicLinkRefusal extends Error`, with `readonly code: PublicLinkRefusalCode`, `readonly detail: string` and `readonly remediation: string`.
- Produces `GET /v1/public-link`.

- [ ] **Step 1: Write the failing integration tests.**
  - **Malformed credentials.** Each of these answers 401 `LINK_NOT_FOUND` with a problem+json body, never 500 (one `it.each`):
    - `PublicLink` with no value
    - `PublicLink pp_abc`
    - `PublicLink ` followed by 1,000 characters
    - a valid-looking secret nobody holds
  - **The order is revoked, then disabled, then expired.**
    - A revoked and expired link reads `LINK_REVOKED`.
    - A disabled and expired link reads `PUBLIC_LINKS_DISABLED`.
    - Each detail is the spec's sentence. The expired one carries the date.
  - **Suspend and resume.** Switch off gives `PUBLIC_LINKS_DISABLED`. Switch on again, and the same link answers 200 at `GET /v1/public-link`.
  - **Revoke takes effect on the next request.** 200, revoke through the repository, then 401 `LINK_REVOKED` with no restart.
  - **`GET /v1/public-link`** answers `{ runId, expiresAt }` for the link's run, and carries `Cache-Control: private, no-store`.
  - **Default-deny, before Task 6 adds the markers.** `GET /v1/runs/<its run>` with the link answers 404 `NOT_FOUND`, byte-identical to a missing run's body once `traceId` and the id are masked. The `masked()` helper is copied from `access-routes`.
  - **A session or bearer token on `GET /v1/public-link`** answers 404.
  - **`last_used_at`** moves after the first request.
  - **A `PublicLink` request on a write route** (`PUT /v1/runs/:id/note`) answers 404, not 200.
  - **The live WebSocket** handshake at `/v1/runs/:id/live`, sent with only the `PublicLink` header, is refused with the gateway's own unauthenticated close code (the code `live-gateway.integration.test.ts` asserts).
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the credential, the guards and the resolve endpoint.**
  - `authenticatePublicLink` takes the header value after `PublicLink `, trimmed, and refuses `LINK_NOT_FOUND` unless it matches `PUBLIC_LINK_SECRET_PATTERN`. It looks the hash up, then checks in this order: revoked, disabled, expired.
  - It touches `last_used_at` when stale, swallowing a failure, as `authenticateRequest` does.
  - Remediation for every refusal: "Ask whoever sent this link for a new one."
- [ ] **Step 4: Run the route-walk file.** "exactly one marker" passes with the sixth kind, and `ACCESS_BY_ROUTE` equality passes with the new row.
- [ ] **Step 5: Run** the credential file and `access-routes`, `session-auth`, `auth.integration` and `openapi`, then typecheck, lint and unit. All pass.
- [ ] **Step 6: Commit** with the message `feat(api): a public link is a credential pinned to one run, denied by default`.

### Task 6: The allowlist, redaction, and the link matrix

**Files:**
- Modify: the 15 handlers of spec 5.3, adding `@LinkReadable()` beside their existing `@Requires('project:read')`:
  - `runs.controller.ts` `get`
  - `metrics.controller.ts`: `stats`, `series`, `errors`, `errorSeries`, `telemetry`
  - `parity.controller.ts`: `distribution`, `users`
  - `agent.controller.ts`: all five handlers
  - `run-events.controller.ts`
  - `run-verification.controller.ts`
- Modify: `apps/api/src/runs/runs.service.ts`, or wherever the run response is built. For a tenant carrying `publicLink`, `note.updatedBy` is `null`. Apply this to both identity builders (`toResponse` and the 202), through one helper.
- Modify: `apps/api/src/openapi/document.ts`. Add a security scheme, `publicLinkAuth: { type: 'http', scheme: 'PublicLink' }`. The 15 operations list it as a third alternative, and `GET /v1/public-link` lists it alone.
- Modify: `apps/api/test/access-routes.integration.test.ts`. Add a literal `LINK_READABLE_ROUTES` (15 labels) and the cases below.
- Test: `apps/api/test/public-link-credential.integration.test.ts` (the redaction and cache cases)

- [ ] **Step 1: Write the failing walk cases.**
  - The walked `linkReadable` labels equal `LINK_READABLE_ROUTES`, both ways, naming the missing and the extra.
  - Every `linkReadable` route is `GET` under `/v1/runs/:id` and `requires === 'project:read'`.
  - The walked `publicLinkOnly` set is exactly `['GET /v1/public-link']`.
  - The vacuity floor: more than 10 `linkReadable` routes found.
- [ ] **Step 2: Write the failing link matrix,** in a `describe('a public link')`.
  - **Setup:** two runs in project A, with a link to the first, and one run in project B.
  - **Every walked route** (`ROUTES`, filled by `fill()` with the first run):
    - an allowlisted route PASSES the guard, judged the way the role matrix's `expectPassed` judges it: neither 401 nor 403, and not the masked `runNotFound` body. A seeded run with no stored figures can legitimately answer its own data 404 (`/distribution` with no histogram), so "2xx" would be the wrong claim.
    - every other route answers 404 with the masked `runNotFound` body
    - each request carries a deadline, like `send()`
  - **Every allowlisted route** filled with the second run, and with project B's run, answers 404, the body masked-equal to a missing run's.
  - **The vacuity floor** is on routes probed (`> 60`).
- [ ] **Step 3: Write the failing redaction and cache cases.**
  - A run whose note has an author reads `note.updatedBy: null` through the link, with the same `text`.
  - The same run read with a session still carries the author's name.
  - Every allowlisted response through the link carries `Cache-Control: private, no-store`.
- [ ] **Step 4: Run them and see them fail.**
- [ ] **Step 5: Add the markers, the redaction and the OpenAPI scheme.** Then run the files.
- [ ] **Step 6: Run** `access-routes`, `public-link-credential`, `openapi`, `read.integration` and `session-auth`, then typecheck, lint and unit. All pass.
- [ ] **Step 7: Commit** with the message `feat(api): fifteen run reads a public link may reach, and nothing else`.

### Task 7: Web — the credential, the presentation and the paths

**Files:**
- Modify: `apps/web/src/api/fetch.ts`. Add `publicLinkSecretFromPath(pathname: string): string | null`. `apiFetch` and `apiFetchNoContent` call it per request, with `window.location.pathname`.
  - **With a secret:** `credentials: 'omit'` and `Authorization: PublicLink <secret>`, merged into any caller headers.
  - **Without one:** the request is unchanged.
- Create: `apps/web/src/routes/presentation.tsx`, defining:
  - `type RunPresentation = { kind: 'app' } | { kind: 'public'; secret: string; expiresAt: string }`
  - `RunPresentationProvider`
  - `useRunPresentation()`, whose default is `{ kind: 'app' }`. The app has one run shell and the public page one provider, and Task 10's anchor guard catches a missing provider.
  - `useRunPaths(runId: string): RunPaths`
- Modify: `apps/web/src/routes/paths.ts`. Add `shareSectionPath(secret: string, section: 'summary' | 'report' | 'logs'): string`.
- Modify: `apps/web/src/routes/RunShell.tsx`. It takes a required `projectAccess: ProjectAccess` prop and stops calling `useProjectAccess`.
- Modify: `apps/web/src/routes/RunDetail.tsx`. It calls `useProjectAccess(run.data?.run.project?.slug)` above its early returns and passes the result down.
- Test: `apps/web/test/fetch.publicLink.test.ts`, `apps/web/test/presentation.test.tsx`, and the existing `RunShell.test.tsx`, updated for the prop

**Interfaces:**
- `RunPaths` has these members:
  - `section(name: 'summary' | 'report' | 'logs' | 'trends' | 'compare'): string | null`
  - `request(name: string): string | null`
  - `group(name: string): string | null`
  - `project(slug: string): string | null`
  - `test(slug: string, testSlug: string): string | null`
- `app` returns today's path helpers.
- `public` returns `shareSectionPath` for summary, report and logs, and `null` for everything else.

- [ ] **Step 1: Write the failing tests.**
  - `publicLinkSecretFromPath`:
    - `/share/<valid>` and `/share/<valid>/report` give the secret
    - `/share/<valid>x`, `/runs/x` and `/share/pp_x` give null
  - `apiFetch`:
    - on a `/share/<valid>/logs` pathname it sends `credentials: 'omit'` and the header
    - after `history.pushState(null, '', '/runs/abc')` the next call sends `credentials: 'same-origin'` and no `Authorization` (Review Focus 3)
    - a caller's own headers survive
  - `useRunPaths`:
    - for `app`, `section('report')` equals `runReportPath(id)`
    - for `public`, `section('report')` equals `/share/<secret>/report`, and `section('trends')`, `section('compare')`, `request('x')`, `group('x')`, `project('s')` and `test('s','t')` are all null
  - `RunShell`: tests pass `projectAccess` explicitly, and a case pins that it reads the prop. With `can` returning true for `run:note`, the note's edit control renders without any `/v1/projects` request.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the change.** `tsc` lists every `RunShell` caller once the prop is required; fix each.
- [ ] **Step 4: Run typecheck, lint and unit.** Zero `Errors` lines.
- [ ] **Step 5: Commit** with the message `feat(web): the link credential follows the URL; runs know their presentation`.

### Task 8: Web — the public page

**Files:**
- Create: `apps/web/src/scrollBehaviour.ts`. Move `AppShell`'s scroll-to-top-on-new-path effect and the fragment reveal (`keepInPlace` and the effect that calls it) into `useScrollAndFragment()`. `AppShell` calls it, and `AppShell.test.tsx` passes unchanged.
- Create: `apps/web/src/routes/share/PublicLinkApp.tsx`
  - It owns a `QueryClient` from `createPublicLinkQueryClient(onRefusal)`.
  - Its routes are the index (`RunSummary`), `report` (`RunReport`) and `logs` (`RunLogs`), under `PublicRunPage`.
  - On a refusal it shows `LinkUnavailable`.
  - It calls `useScrollAndFragment()`.
- Create: `apps/web/src/routes/share/PublicRunPage.tsx`
  - It calls `resolvePublicLink()`, then `useRunTerminal(runId)`.
  - It renders the minimal header with the spec's text, then `RunPresentationProvider value={{ kind: 'public', … }}` wrapping `RunShell`. `RunShell` gets `projectAccess = { known: true, can: () => false }`, `live = null`, and `terminal`, `verdict` and so on from the detail, as `RunDetail` passes them.
  - It sets the document title to `<run name> · <test> — PerfPortal`.
- Create: `apps/web/src/routes/share/LinkUnavailable.tsx`, with one sentence per code, verbatim, plus "Ask whoever sent it for a new link."
- Create: `apps/web/src/routes/share/publicQueryClient.ts`, holding `createPublicLinkQueryClient(onRefusal: (code: PublicLinkRefusalCode, detail: string) => void): QueryClient`. Its `QueryCache` and `MutationCache` `onError` call `onRefusal` for a `ProblemError` with status 401 whose `code` is one of `PUBLIC_LINK_REFUSAL_CODES`, and `retry: false`.
- Create: `apps/web/src/api/publicLinks.ts`, holding `resolvePublicLink()`. Task 9 adds the management calls.
- Modify: `apps/web/src/App.tsx`. Add `<Route path="/share/:token/*" element={<PublicLinkApp />} />` beside `/login`, outside `AuthGate`, lazy.
- Modify: `apps/api/src/spa.ts`. A `/share/*` fallback response carries `X-Robots-Tag: noindex`.
- Test: `apps/web/test/PublicLinkApp.test.tsx`, `apps/web/test/LinkUnavailable.test.tsx`, `apps/api/test/security-headers.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - **Each code** renders its page, with the expired date formatted by `formatInstant`, and makes no request to `/auth/*` or `/v1/projects`. The test's `fetch` spy fails on either.
  - **A resolved link** renders the Summary inside the shell:
    - the header reads "Read-only link · expires …"
    - three tabs, whose hrefs start with `/share/<secret>`
    - no `role="navigation"` named "Projects", meaning no rail
  - **A 401 `LINK_REVOKED` from `/stats` after the page rendered** replaces the page with the revoked page (Review Focus 4). It never navigates to `/login`.
  - **A non-link 401** (code `UNAUTHENTICATED`) leaves the page in place. That cannot come from this credential, and it must not end anything.
  - **`security-headers.test.ts`:** `GET /share/x` serves `index.html` with `X-Robots-Tag: noindex`, and `GET /runs/x` does not.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the page.**
- [ ] **Step 4: Run** typecheck, lint and unit.
- [ ] **Step 5: Commit** with the message `feat(web): the public run page under /share/:token`.

### Task 9: Web — public mode in the run components, and the share dialog

**Files:**
- Modify the components, to build every link through `useRunPaths` and render text where it returns `null`:
  - `RunTabs.tsx`: in public mode only summary, report and logs, with logs still only when the run has a runner job
  - `RunHeader.tsx`: the breadcrumb's project and test become text. It also gains a required `actions: ReactNode` prop, rendered beside the `<h1>`.
  - `RunDecisionBand.tsx`: the fragment link becomes `section('summary')`, and the Compare action is hidden when `section('compare')` is null
  - `AssertionBars.tsx`
  - `StatisticsTable.tsx` `detailPathFor`
  - `GroupsList.tsx`
  - `RunStats.tsx`: there is no baseline in public mode
- Modify: `RunSummary.tsx`. In public mode it renders no `AiAnalysisCard` and never enables `trendsQuery`.
- Create: `apps/web/src/routes/share/expiry.ts`
  - `EXPIRY_PRESETS`: `1w`, `2w`, `1m`, `6m`, `1y` and `2y`, labelled "1 week" … "2 years", plus `custom`
  - `expiryFor(preset: ExpiryPreset, now: Date, customDate?: string): Date`, where a month is a calendar month via `Date#setMonth`, and `custom` is the chosen `yyyy-mm-dd` at `23:59:59.999` local
  - `customDateBounds(now: Date): { min: string; max: string }`, with `min` tomorrow and `max` today plus two years, both `yyyy-mm-dd` local
- Create: `apps/web/src/routes/share/ShareRunButton.tsx` and `ShareDialog.tsx`
- Extend: `apps/web/src/api/publicLinks.ts`, adding:
  - `publicLinksQueryKey(runId)`
  - `fetchPublicLinks(runId)`
  - `createPublicLink(runId, expiresAt: string)`
  - `revokePublicLink(runId, linkId)`
- Modify: `RunShell.tsx`. It passes `actions={<ShareRunButton …/>}` when `projectAccess.can('run:share')` and the status is `complete` or `incomplete`; otherwise `actions={null}`. In public mode it always passes `null`.
- Test: `apps/web/test/expiry.test.ts`, `apps/web/test/ShareDialog.test.tsx`, and public-mode cases in `RunTabs.test.tsx`, `RunHeader.test.tsx`, `RunSummary.test.tsx`, `StatisticsTable.test.tsx`, `AssertionBars.test.tsx` and `RunDecisionBand.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - **`expiry`:**
    - `1m` from 31 January is the end of February's calendar overflow, as `setMonth` gives it. Pin the value this produces.
    - `2y` from today is at most 732 days away.
    - `custom` is the end of the chosen day.
    - `customDateBounds` gives min tomorrow and max two years ahead (Review Focus 5).
  - **The dialog:**
    - `enabled: false` shows the admin sentence naming Administration › Settings and draws no form.
    - A preset shows "This link will expire on …".
    - Create sends `{ expiresAt }` from `expiryFor`.
    - The secret URL `${origin}/share/<secret>` is shown once, with the shown-once sentence. Closing and reopening the dialog does not show it again.
    - With no clipboard, a read-only field shows the URL.
    - The list shows each state badge, creator, expiry and last opened time.
    - Revoke needs an inline confirmation, then refetches.
    - A refused create shows the API's own detail.
  - **Public mode, in each component:**
    - `RunTabs` renders exactly three tabs at share paths.
    - The `RunHeader` breadcrumb has no `<a>`.
    - `RunSummary` renders no AI card and requests no `/trends`; the test fails on a `/trends` fetch.
    - `StatisticsTable` and `GroupsList` names are not links.
    - The `RunDecisionBand` fragment link's `href` starts with `/share/`, and the band has no Compare action.
  - **App mode:** each of those components keeps its existing links. The existing cases already cover this; run them.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the change.** The dialog's Revoke button is `variant="secondary"`, never `primary`. There is one primary per screen, and Create is it.
- [ ] **Step 4: Run** typecheck, lint and unit.
- [ ] **Step 5: Commit** with the message `feat(web): share a run from its page; public mode drops what leaves the run`.

### Task 10: e2e

**Files:**
- Create: `apps/web/e2e/public-links.spec.ts`
- Modify: `apps/web/e2e/fixtures.ts`. Add `setPublicLinks(orgId, enabled)` (direct SQL, the way `markEstimated` writes) and `expireLink(linkId)`.

- [ ] **Step 1: Write the spec.** It has five cases.
  1. **Create and read signed out.**
     - Seed with `seedRunWithData`, `setPublicLinks(true)` and a Member.
     - Open the run, press Share, choose 1 week, press Create, and read the URL from the read-only field.
     - In `browser.newContext()`, with no cookies, open the URL.
     - Summary shows its four tiles, and there is no AI card.
     - Report: pick a group in Requests with #300's picker, and the charts narrow (the `requests-group-picker` test id).
     - Logs renders, or is absent when the run has no runner job (`seedRunWithData` has none, so assert the tab is absent).
  2. **The page stays inside its link and reads only the allowlist.**
     - In the signed-out context, visit each tab.
     - Every `a[href]` starts with `/share/<secret>`, or is a fragment. The vacuity floor is on anchors counted.
     - Every request recorded with `page.on('request')` to `/v1/` or `/auth/` is `GET /v1/public-link`, or a `GET /v1/runs/<runId>…` whose suffix is on `LINK_READABLE_ROUTES`' list. The list is copied here as paths, with a comment pointing at the walk.
  3. **A signed-in sharer opening their own link** sees the same page (Review Focus 1). In the Member's own context, open the URL: there is no AI card and no Share button, and the request check from case 2 holds.
  4. **Revoke.** Back on the run page, revoke the link, then reload the signed-out page: it reads "This link has been revoked."
  5. **Suspend.** With `setPublicLinks(false)` the page reads the disabled sentence. With `setPublicLinks(true)` it renders again. Then `expireLink` makes it read "This link expired on …".
- [ ] **Step 2: Run it.** `PERFPORTAL_E2E_PORT=3880 pnpm playwright test apps/web/e2e/public-links.spec.ts` passes. Then, with `PERFPORTAL_E2E_BROWSERS=all`, it passes on Chromium, Firefox and WebKit. WebKit and Firefox have their known Tab and `colorScheme` gaps; neither touches these cases.
- [ ] **Step 3: Red-verify the two derived guards** from a committed checkpoint, asserting each replacement count:
  - make `useRunPaths('public').request` return `runPath(...)`: case 2 fails, naming the anchor
  - remove `RunSummary`'s public guard on `trendsQuery`: case 2 fails, naming `/trends`
  - restore with `git checkout HEAD --`
- [ ] **Step 4: Commit** with the message `test(e2e): a public link read signed out, revoked and suspended`.

---

## After Task 10 (controller)

- [ ] **The whole-branch review,** on Opus, given the spec and this plan.
- [ ] **The full gate, on the final tree,** in this order:

  ```bash
  pnpm build
  pnpm typecheck
  pnpm lint
  pnpm test:unit
  pnpm test:integration
  PERFPORTAL_E2E_PORT=3880 pnpm test:e2e --workers=2
  ```

  - Read each command's own exit code.
  - Integration runs behind the load gate (1-min < 8 and 5-min < 10), alone on its stores.
  - Run e2e after integration, never alongside it.
  - Every total must equal the floor plus each task's measured delta.
- [ ] **The real check,** on a stack of its own (scratch database, Redis index and bucket, and the API on its own port):
  1. Run `ParitySimulation` through the Gradle plugin.
  2. Turn the switch on, and create a link from the browser. The user signs in themselves.
  3. Open it in a private window.
  4. The shared Summary's four tiles and the Report's statistics row for one request must equal the signed-in page's.
  5. Revoke the link, and see the revoked page.
  6. Revoke the token and stop every process by PID.
- [ ] **The CLAUDE.md entry:** the floors, what was red-verified, what was run, the rulings, and known-and-left.
- [ ] **The PR against `main`,** and the push, both wait for the user.
