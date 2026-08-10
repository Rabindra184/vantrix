# PerfPortal Session Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human log into PerfPortal with an email and password so the Parity UI has something to authenticate with, without disturbing the project-scoped bearer tokens CI already uses.

**Architecture:** Better Auth owns identity (`user`, `session`, `account`, `verification`); the existing `org`/`project` tables keep tenancy, joined by a new `org_member`. `AuthMiddleware` on `/v1` gains a session branch beside the bearer branch, both producing a `req.tenant`. A bearer token stays project-scoped; a session is org-scoped, which is why `TenantScope.projectId` becomes optional.

**Tech Stack:** Better Auth **1.6.26** (exact pin), NestJS on Express, Prisma, Postgres, TypeScript ESM, Vitest.

**Spec:** [`docs/superpowers/specs/2026-08-09-perf-portal-session-auth-design.md`](../specs/2026-08-09-perf-portal-session-auth-design.md)
**Spike findings:** `.superpowers/sdd/spike-better-auth-report.md` (branch `spike/better-auth` — throwaway, do not build on it)

## Global Constraints

- **Better Auth pinned to exactly `1.6.26`.** The spike proved this version; do not use a caret range.
- **Do NOT use the community NestJS binding** (`@thallesp/nestjs-better-auth`). Its `engines` requires Node ≥22.22.1, above this repo's 22.19.0 floor. Mount `toNodeHandler` on the raw Express instance instead.
- **Do NOT enable Better Auth's `organization` plugin.** `org`/`project` are the tenancy source of truth; a second org model gives two answers to "what may this caller see?" and the failure mode is a tenancy leak.
- **`basePath: '/auth'` must be set** in the Better Auth config. It defaults to `/api/auth` and **404s silently with an empty body** if you mount at `/auth` without it.
- **Use `fromNodeHeaders(req.headers)`** from `better-auth/node`. Express's plain header object has no `.get()`; `new Headers(req.headers)` almost works but mishandles multi-value (`string[]`) headers.
- **Mount `/auth/*` BEFORE Nest's body parser.** Better Auth needs the raw, unparsed body for sign-up and sign-in.
- `auth.api.getSession()` returns **`null`**, not a throw, for a missing/invalid/expired session.
- ESM: every relative import ends in `.js`. `noUncheckedIndexedAccess` is ON. Node ≥22 (`nvm use`; default shell node is v20).
- `prisma migrate deploy` does NOT regenerate the client — use `pnpm --filter @perfportal/persistence run migrate:deploy`.
- Never edit an applied migration; `_prisma_migrations.checksum` will disagree while `migrate status` still says "up to date".
- RFC 9457 `application/problem+json` with a compile-time-required `remediation` on `/v1`. `/auth/*` keeps Better Auth's native shapes (spec §5 D-1).
- Work on `feat/session-auth`, branched from `main`. Never commit to `main`.

## Spike-proven code

Transcribe these; they ran. From `git diff main spike/better-auth`.

**Mount** (`apps/api/src/main.ts`, before Nest's body parser):
```ts
import { toNodeHandler } from 'better-auth/node';
app.getHttpAdapter().getInstance().all('/auth/*splat', toNodeHandler(auth));
```
Note `'/auth/*splat'` — Express 5 named-wildcard syntax, not `'/auth/*'`.

**Session resolution** (inside `AuthMiddleware`):
```ts
const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
if (!session) throw new UnauthorizedException('No valid session cookie.');
```

## The tenancy change is narrower than it looks

`TenantScope.projectId` becoming optional sounds like it touches all thirteen files that mention `projectId`. It does not, and the plan depends on knowing why.

Every metric endpoint resolves the **run** first (`MetricsController.#run` → `RunRepository.findById`), then passes `run.orgId` / `run.projectId` — the run row's own values — to the reader. The tenant's `projectId` is used as a *filter* in only two places: `RunRepository.findById` and `RunRepository.list`. Ingest is the third, and it genuinely needs a project.

So: make those two methods filter on `project_id` only when the scope carries one. Everything downstream keeps using the run's own project and needs no change.

---

## File Structure

**Create**
- `apps/api/src/auth/better-auth.instance.ts` — the configured `auth` singleton. One responsibility: construct it.
- `packages/persistence/src/repositories/membership.ts` — `OrgMemberRepository`.
- `apps/api/test/session-auth.integration.test.ts` — login, cookie, dual-credential and isolation tests.

**Modify**
- `packages/persistence/prisma/schema.prisma` + a generated migration
- `packages/persistence/src/repositories/tenant.ts` — `TenantScope.projectId` optional
- `packages/persistence/src/repositories/run.ts` — conditional predicate in `findById`/`list`
- `packages/persistence/src/client.ts` — `SCHEMA_TABLES`
- `apps/api/src/main.ts`, `apps/api/src/auth/auth.middleware.ts`, `apps/api/src/auth/auth.guard.ts`
- `apps/api/test/support/app.ts`, `apps/worker/test/pipeline.integration.test.ts` — truncation lists
- `packages/persistence/scripts/bootstrap.ts` — `--admin-email`
- `README.md`

---

### Task 1: Better Auth instance, schema, migration

**Files:**
- Create: `apps/api/src/auth/better-auth.instance.ts`
- Modify: `packages/persistence/prisma/schema.prisma`, `apps/api/package.json`
- Create: `packages/persistence/prisma/migrations/<ts>_session_auth/migration.sql` (generated)

**Interfaces:**
- Produces: `export const auth` — the Better Auth instance, with `basePath: '/auth'` and email/password enabled.

- [ ] **Step 1: Add the dependency, pinned**

```bash
pnpm --filter @perfportal/api add better-auth@1.6.26
```
Verify `apps/api/package.json` records `"better-auth": "1.6.26"` with no caret.

- [ ] **Step 2: Create the instance**

Create `apps/api/src/auth/better-auth.instance.ts`:

```ts
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * basePath is '/auth', NOT Better Auth's default '/api/auth'. With the default
 * left in place while the handler is mounted at /auth/*, every request 404s
 * with an EMPTY BODY and no error - a silent failure that costs an afternoon.
 *
 * The organization plugin is deliberately absent: `org` and `project` are the
 * tenancy source of truth (spec §3). Two org models would give two answers to
 * "what may this caller see?", and that disagreement is a tenancy leak.
 */
export const auth = betterAuth({
  basePath: '/auth',
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: { enabled: true },
  session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
  advanced: { defaultCookieAttributes: { httpOnly: true, sameSite: 'strict', secure: true } },
});
```

- [ ] **Step 3: Add the models to the Prisma schema**

Run `pnpm --filter @perfportal/api exec npx @better-auth/cli generate --config src/auth/better-auth.instance.ts` and merge its output into `packages/persistence/prisma/schema.prisma`, OR transcribe the models the spike produced (`git show spike/better-auth:packages/persistence/prisma/schema.prisma`). Then add `org_member` by hand:

```prisma
model OrgMember {
  userId    String   @map("user_id")
  orgId     String   @map("org_id") @db.Uuid
  /// Written, and deliberately unread until M6's RBAC. This project otherwise
  /// treats a write-only column as a defect (run_indicator.failed was deleted
  /// for exactly that). Admitted here because it is part of the tenancy key's
  /// shape and adding it later means migrating live membership rows.
  role      String
  createdAt DateTime @default(now()) @map("created_at")

  org Org @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@id([userId, orgId])
  @@map("org_member")
}
```
Add the matching `orgMembers OrgMember[]` relation field to `model Org`.

- [ ] **Step 4: Generate and apply**

```bash
pnpm --filter @perfportal/persistence exec prisma migrate dev --name session_auth --schema prisma/schema.prisma
pnpm --filter @perfportal/persistence run migrate:deploy
```

- [ ] **Step 5: Verify the partitioned tables are undisturbed**

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U perfportal -d perfportal -c "\d+ run_series_bucket" -c "\d+ run_user_bucket" -c "\d org_member"
```
Expected: both bucket tables still report `Partition key: RANGE (run_started_on)` with 12 partitions each; `org_member` exists with a composite PK. Then `prisma migrate status` → "Database schema is up to date!"

- [ ] **Step 6: Update the truncation lists**

Add every new table (`user`, `session`, `account`, `verification`, `org_member` — use the real generated names) to `SCHEMA_TABLES` in `packages/persistence/src/client.ts`, and to the hardcoded lists in `apps/api/test/support/app.ts` and `apps/worker/test/pipeline.integration.test.ts`. A stale list here broke every persistence integration test during the parity backend and was found only by accident.

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:integration
```
Expected: all green, counts unchanged from the 176 unit / 310 integration baseline.
(310, not 311: the Task 1 implementer A/B-tested the untouched pre-task tree with
`git stash push -u` and got 310/310 there too. The 311 figure was stale.)

```bash
git add -A && git commit -m "feat(auth): Better Auth instance, schema and migration

Pinned to 1.6.26, the version the spike proved. basePath is '/auth', not the
default '/api/auth' - left at the default while mounted at /auth/*, every
request 404s with an empty body and no error.

The organization plugin is deliberately unused: org and project are the
tenancy source of truth, and a second org model would give two answers to
'what may this caller see?'"
```

---

### Task 2: `OrgMemberRepository`

**Files:**
- Create: `packages/persistence/src/repositories/membership.ts`
- Modify: `packages/persistence/src/index.ts`
- Create: `packages/persistence/test/membership.integration.test.ts`

**Interfaces:**
- Produces: `class OrgMemberRepository { constructor(prisma: PrismaClient); findOrgForUser(userId: string): Promise<{ orgId: string; role: string } | null>; add(userId: string, orgId: string, role: string): Promise<void> }`

- [ ] **Step 1: Write the failing test**

Create `packages/persistence/test/membership.integration.test.ts`, following the setup used by `packages/persistence/test/metrics.integration.test.ts`:

```ts
it('returns null for a user with no membership', async () => {
  const repo = new OrgMemberRepository(prisma);
  expect(await repo.findOrgForUser('nobody')).toBeNull();
});

it('returns the org for a member', async () => {
  const repo = new OrgMemberRepository(prisma);
  await repo.add('u1', orgId, 'admin');
  expect(await repo.findOrgForUser('u1')).toEqual({ orgId, role: 'admin' });
});
```

- [ ] **Step 2: Run it and confirm it fails**

`pnpm test:integration -- packages/persistence/test/membership.integration.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import type { PrismaClient } from '@prisma/client';

/**
 * A user belongs to at most one org for now. RBAC and multi-org membership are
 * M6; `findOrgForUser` returns a single row deliberately rather than a list, so
 * a caller cannot silently pick the wrong one.
 */
export class OrgMemberRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findOrgForUser(userId: string): Promise<{ orgId: string; role: string } | null> {
    const row = await this.prisma.orgMember.findFirst({
      where: { userId },
      select: { orgId: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
    return row ?? null;
  }

  async add(userId: string, orgId: string, role: string): Promise<void> {
    await this.prisma.orgMember.create({ data: { userId, orgId, role } });
  }
}
```

- [ ] **Step 4: Export, verify, commit**

Add `export * from './repositories/membership.js';` to `packages/persistence/src/index.ts`. Run the test file → PASS. Commit as `feat(persistence): OrgMemberRepository`.

---

### Task 3: `TenantScope.projectId` becomes optional

**The highest-risk task in this plan.** It moves a tenancy predicate on the read path, where a mistake is a security bug rather than a wrong number.

**Files:**
- Modify: `packages/persistence/src/repositories/tenant.ts`, `packages/persistence/src/repositories/run.ts`
- Modify: `packages/persistence/test/run.integration.test.ts`

**Interfaces:**
- Produces: `TenantScope = { orgId: string; projectId?: string }`. `RunRepository.findById(scope, id)` and `.list(scope, …)` filter on `project_id` **only when `scope.projectId` is present**; they always filter on `org_id`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/persistence/test/run.integration.test.ts`:

```ts
it('scoped to a project, finds only that project\'s run', async () => {
  const repo = new RunRepository(prisma);
  expect(await repo.findById({ orgId, projectId: projectA }, runInA)).not.toBeNull();
  expect(await repo.findById({ orgId, projectId: projectA }, runInB)).toBeNull();
});

// A session is org-scoped: it may read any run in its org.
it('scoped to an org only, finds runs in every project of that org', async () => {
  const repo = new RunRepository(prisma);
  expect(await repo.findById({ orgId }, runInA)).not.toBeNull();
  expect(await repo.findById({ orgId }, runInB)).not.toBeNull();
});

// The assertion whose failure is a security bug.
it('never crosses an org boundary, with or without a project', async () => {
  const repo = new RunRepository(prisma);
  expect(await repo.findById({ orgId: otherOrgId }, runInA)).toBeNull();
  expect(await repo.findById({ orgId: otherOrgId, projectId: projectA }, runInA)).toBeNull();
});
```

The fixture needs two projects in one org and a run in each, plus a second org — extend the file's setup rather than weakening the assertions.

- [ ] **Step 2: Run and confirm the org-only case fails**

`pnpm test:integration -- packages/persistence/test/run.integration.test.ts`
Expected: the org-only test FAILS (it currently requires `projectId`).

- [ ] **Step 3: Make `projectId` optional**

In `packages/persistence/src/repositories/tenant.ts`:

```ts
export interface TenantScope {
  orgId: string;
  /**
   * Present for a bearer token, which is minted against one project. ABSENT for
   * a user session, which is org-scoped: a human may read any run in their org.
   * When absent, callers filter on org_id alone - never on a guessed project.
   */
  projectId?: string;
}
```

In `packages/persistence/src/repositories/run.ts`, make the predicate conditional in `findById` and `list`:

```ts
      where: {
        id,
        orgId: scope.orgId,
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
      },
```

Apply the same spread to `list`. **Change nothing else** — every metric endpoint resolves the run first and then passes the run row's own `orgId`/`projectId` downstream, so no reader predicate moves.

- [ ] **Step 4: Verify**

`pnpm typecheck && pnpm test:integration` → all green, and the three new cases pass.

- [ ] **Step 5: Falsification checkpoint**

Delete `orgId: scope.orgId,` from `findById` and re-run.
Expected: "never crosses an org boundary" FAILS. Restore and confirm green.

This is the assertion that matters; prove it can fail.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(persistence): TenantScope.projectId becomes optional

A bearer token is minted against one project and stays restricted to it. A
user session is org-scoped - there is no defined project for a logged-in
human, and the spike's findFirst was a guess wearing a function call.

Only findById and list filter on the tenant's projectId; every metric
endpoint resolves the run first and then uses the run row's own project, so
no reader predicate moves."
```

---

### Task 4: Mount the Better Auth handler

**Files:**
- Modify: `apps/api/src/main.ts`, `apps/api/test/support/app.ts`
- Create: `apps/api/test/session-auth.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/session-auth.integration.test.ts` using `createTestApp()` from `apps/api/test/support/app.ts`:

```ts
it('serves /auth/* without a session', async () => {
  const res = await request(app.getHttpServer())
    .post('/auth/sign-up/email')
    .send({ email: 'a@example.test', password: 'correct-horse-battery', name: 'A' });
  expect(res.status).toBeLessThan(500);
  expect(res.body).not.toEqual({});          // an empty body means basePath is wrong
});
```

- [ ] **Step 2: Run and confirm it fails** — 404.

- [ ] **Step 3: Mount it**

In `apps/api/src/main.ts`, before Nest's body parser runs:

```ts
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth/better-auth.instance.js';

// Mounted on the raw Express instance, outside /v1, and BEFORE Nest's body
// parser: Better Auth needs the raw, unparsed body for sign-up and sign-in.
// '/auth/*splat' is Express 5's named-wildcard syntax; '/auth/*' does not match.
app.getHttpAdapter().getInstance().all('/auth/*splat', toNodeHandler(auth));
```

`createTestApp()` must do the same, or the test app will not serve `/auth/*`.

- [ ] **Step 4: Verify and commit**

Test passes. Commit as `feat(api): mount the Better Auth handler at /auth/*`.

---

### Task 5: The session branch in `AuthMiddleware`

**Files:**
- Modify: `apps/api/src/auth/auth.middleware.ts`, `apps/api/src/auth/auth.guard.ts`
- Modify: `apps/api/test/session-auth.integration.test.ts`

**Interfaces:**
- Consumes: `OrgMemberRepository.findOrgForUser` (Task 2), `TenantScope.projectId?` (Task 3).

- [ ] **Step 1: Write the failing tests**

```ts
it('accepts a session cookie on /v1', async () => {
  const cookie = await signUpAndLogin(app, 'b@example.test');
  await request(app.getHttpServer()).get(`/v1/runs/${runId}`).set('Cookie', cookie).expect(200);
});

// The regression that would break CI ingest.
it('still accepts a bearer token, unchanged', async () => {
  await request(app.getHttpServer())
    .get(`/v1/runs/${runId}`).set('Authorization', `Bearer ${token}`).expect(200);
});

it('401s with no credential at all', async () => {
  await request(app.getHttpServer()).get(`/v1/runs/${runId}`).expect(401);
});

it('401s a stale cookie after logout', async () => {
  const cookie = await signUpAndLogin(app, 'd@example.test');
  await request(app.getHttpServer()).get(`/v1/runs/${runId}`).set('Cookie', cookie).expect(200);
  await request(app.getHttpServer()).post('/auth/sign-out').set('Cookie', cookie).expect(200);
  // The same cookie string, now revoked server-side. A session store that only
  // expires by time would still accept this.
  await request(app.getHttpServer()).get(`/v1/runs/${runId}`).set('Cookie', cookie).expect(401);
});

it('401s a user with no org membership', async () => {
  const cookie = await signUpAndLogin(app, 'orphan@example.test');   // no org_member row
  await request(app.getHttpServer()).get(`/v1/runs/${runId}`).set('Cookie', cookie).expect(401);
});
```

- [ ] **Step 2: Run and confirm the session cases fail** — 401.

- [ ] **Step 3: Add the branch**

In `apps/api/src/auth/auth.middleware.ts`:

```ts
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from './better-auth.instance.js';

/**
 * Express exposes req.headers as a plain object with string | string[] values;
 * Better Auth's server API needs a real Headers instance and calls .get() on it.
 * fromNodeHeaders does the conversion - `new Headers(req.headers)` almost works
 * but mishandles multi-value headers, which the Cookie path can produce.
 *
 * getSession() returns null (it does not throw) for a missing, invalid or
 * expired session; that maps to 401, exactly as an unrecognised bearer token does.
 */
async function authenticateSession(req: Request, members: OrgMemberRepository): Promise<Tenant> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) throw new UnauthorizedException('No valid session cookie.');

  const membership = await members.findOrgForUser(session.user.id);
  if (!membership) throw new UnauthorizedException('This user belongs to no organization.');

  // No projectId: a session is org-scoped (spec §4.1). Scopes are full within
  // the org; RBAC is M6.
  return {
    orgId: membership.orgId,
    tokenId: `session:${session.session.id}`,
    scopes: ['read', 'ingest'],
  };
}
```

Dispatch on the credential present: `Authorization: Bearer …` → existing path, unchanged; otherwise attempt the session; neither → 401. Keep the existing catch that turns anything not an `HttpException` into a fixed 500 via `internalProblem` — this middleware once leaked a database host and port to unauthenticated callers.

`Tenant` in `auth.guard.ts` must make `projectId` optional to match.

- [ ] **Step 4: Verify and commit**

All four cases pass; the full suite stays green. Commit as `feat(api): authenticate a session cookie beside the bearer token`.

---

### Task 6: Ingest still requires a project

**Files:**
- Modify: `apps/api/src/ingest/ingest.controller.ts`
- Modify: `apps/api/test/session-auth.integration.test.ts`

A session carries no `projectId`, but `POST /v1/runs` must write a run to *some* project. Left unhandled this is a runtime crash or, worse, a run written to a guessed project.

- [ ] **Step 1: Write the failing test**

```ts
it('refuses to ingest with a session, naming the fix', async () => {
  const cookie = await signUpAndLogin(app, 'c@example.test');
  const res = await request(app.getHttpServer())
    .post('/v1/runs').set('Cookie', cookie).attach('bundle', fixturePath).expect(400);
  expect(res.body.code).toBe('PROJECT_REQUIRED');
  expect(res.body.remediation).toMatch(/token/i);
});
```

- [ ] **Step 2: Run and confirm it fails** (currently 500 or a wrong-project write).

- [ ] **Step 3: Guard it**

At the top of the ingest handler:

```ts
    // A session is org-scoped and names no project, but a run must belong to
    // one. Rather than guess, refuse and say what to use instead.
    if (!req.tenant?.projectId) {
      throw badRequest('PROJECT_REQUIRED', {
        message: 'Ingest requires a project-scoped credential.',
        remediation: 'Post runs with a project API token rather than a browser session.',
      });
    }
```

Match the exact `badRequest` helper signature already used in `apps/api/src/metrics/metrics.controller.ts` for `PROJECT_SETTINGS_INVALID`.

- [ ] **Step 4: Verify and commit** — test passes, suite green. Commit as `feat(api): refuse session-authenticated ingest with an actionable 400`.

---

### Task 7: Cross-org isolation across every session-reachable endpoint

The assertion whose failure is a security bug. Task 3 proved the repository; this proves the HTTP surface.

**Files:**
- Modify: `apps/api/test/session-auth.integration.test.ts`

- [ ] **Step 1: Enumerate and assert**

For a session in org A and a run in org B, every one of these must 404 — not 200, and not 500:

```ts
const endpoints = (id: string) => [
  `/v1/runs/${id}`,
  `/v1/runs/${id}/stats`,
  `/v1/runs/${id}/series?scope=run&name=`,
  `/v1/runs/${id}/errors`,
  `/v1/runs/${id}/distribution?scope=run&name=&family=response_time`,
  `/v1/runs/${id}/users`,
  `/v1/runs/${id}/scatter?name=List%20Products`,
];

it.each(endpoints('PLACEHOLDER'))('%s is not readable across orgs', async () => { /* … */ });
```

Write it as a real loop over `endpoints(runInOtherOrg)`, asserting 404 for each with the org-A session cookie. Do not collapse it to one endpoint — the list is the point, and a future endpoint added without a tenancy filter is exactly what this catches.

- [ ] **Step 2: Also assert a session and a token agree**

```ts
it('a session and a project token see identical data for the same run', async () => {
  const viaToken = await request(app.getHttpServer())
    .get(`/v1/runs/${runId}/stats`).set('Authorization', `Bearer ${token}`).expect(200);
  const viaSession = await request(app.getHttpServer())
    .get(`/v1/runs/${runId}/stats`).set('Cookie', cookie).expect(200);
  expect(viaSession.body).toEqual(viaToken.body);
});
```

Two credential systems that disagree about the same run is the drift this catches.

- [ ] **Step 3: Falsification**

Remove `orgId: scope.orgId` from `RunRepository.findById` and re-run.
Expected: every cross-org case FAILS. Restore.

- [ ] **Step 4: Commit** as `test(api): cross-org isolation on every session-reachable endpoint`.

---

### Task 8: Bootstrap an admin user, and document

**Files:**
- Modify: `packages/persistence/scripts/bootstrap.ts`, `README.md`

- [ ] **Step 1: Extend bootstrap**

Add `--admin-email <email>`. Create the user through **Better Auth's server API** (`auth.api.signUpEmail`), never raw SQL, so the password hashing matches what login verifies. Then `OrgMemberRepository.add(userId, orgId, 'admin')`.

Generate a random password and print it **to stdout only — never to a file, never to a log.** The existing token mint carries the same constraint; match its wording.

- [ ] **Step 2: Verify by hand**

```bash
pnpm bootstrap --admin-email you@example.test
```
Then log in with the printed password via `POST /auth/sign-in/email` and use the cookie on `GET /v1/runs`. Paste the real output.

- [ ] **Step 3: Set the Better Auth base URL**

*Added during execution, after Task 4 surfaced a `[better-auth] Base URL is not set` warning on every test run and every server start. Human-ruled: optional config with a default, folded into this task rather than made a task of its own.*

Better Auth derives `trustedOrigins` — its CSRF origin check — from `baseURL`. Unset, it infers one from request headers. Exposure today is low because the session cookie is `sameSite: 'strict'` (a cross-site request carries no cookie at all) and no social/OIDC callbacks exist yet, but it becomes load-bearing at M6's SSO.

In `apps/api/src/config.ts`, add to `AppConfig` and `loadConfig`:

```ts
  betterAuthUrl: string;
```
```ts
    betterAuthUrl: env.BETTER_AUTH_URL ?? `http://localhost:${Number(env.PORT ?? 3000)}`,
```

**Optional with a default, never `required()`.** M0's exit criterion is that a stranger deploys a running instance and authenticates; a new mandatory environment variable breaks that.

In `apps/api/src/auth/better-auth.instance.ts`:

```ts
const config = loadConfig();
export const auth = betterAuth({
  baseURL: config.betterAuthUrl,
  trustedOrigins: [config.betterAuthUrl],
  basePath: '/auth',
  // ...unchanged
});
```

Note `loadConfig()` is already called at import time in this file — reuse the one call rather than adding a second.

Verify the warning is gone: run `npx vitest run --config vitest.integration.config.ts apps/api/test/session-auth.integration.test.ts` and confirm `Base URL is not set` appears nowhere in the output. Paste the real output.

- [ ] **Step 4: Update the README**

Document `/auth/*`, the two credential types and which is for what (tokens for CI, sessions for humans), and that ingest requires a token. Note the D-1 deviation: `/auth/*` returns Better Auth's error shapes, `/v1` returns RFC 9457. Document `BETTER_AUTH_URL` alongside the other environment variables, including that it defaults to `http://localhost:<PORT>` and should be set to the public origin in any real deployment.

- [ ] **Step 5: Full verification and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
```

---

## Verification

**Definition of done:** a human logs in with an email and password and reads `/v1` with the resulting cookie; CI's bearer token works exactly as before; a session cannot read another org's data on any endpoint; and ingest with a session fails with an actionable 400 rather than guessing a project.

**Out of scope, and must not appear in any diff:** RBAC enforcement, OIDC, SAML, invitations, password reset, email verification, 2FA, passkeys, rate limiting (spec §8), and any frontend code.

**Known write-only column:** `org_member.role` is written and read by nothing until M6. This is recorded in spec §3 and is expected — a reviewer should not file it as a finding.
