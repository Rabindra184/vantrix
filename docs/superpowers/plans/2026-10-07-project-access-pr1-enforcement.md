# Project access, PR 1 (enforcement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce project membership and three project roles on every session route, with an install-wide admin, without changing anything on screen.

**Architecture:** A permission table in `@perfportal/contracts` maps each action to a lowest role and a token scope. The session middleware loads the caller's admin flag and project roles; one global `AccessGuard` applies the table to sessions only, leaving the bearer path byte-for-byte as it is. Org-wide reads filter to the caller's visible projects through one shared clause. Better Auth's admin plugin supplies the `user.role` column and server-side account creation; open sign-up closes.

**Tech Stack:** NestJS 11 on Express 5, Better Auth 1.6.26 (admin plugin), Prisma 6 + raw SQL on PostgreSQL 16, zod, Vitest 4, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-project-access-design.md` (sections 1, 2 and 6; PR 1 only).

## Global Constraints

- Node 22 (`nvm use` in every shell call; on Node 20 the jsdom half of `test:unit` silently does not load). pnpm 9.15.0. No new dependencies: the admin plugin ships inside `better-auth`.
- Project roles are exactly `'manager' | 'member' | 'viewer'`, ranked viewer < member < manager. The admin flag is exactly `user.role === 'admin'`; every other account is `'user'`.
- Error codes are exactly `ROLE_REQUIRED` (403) and `ADMIN_REQUIRED` (403). `PASSWORD_CHANGE_REQUIRED` is PR 2, not here.
- A project or run the caller cannot see answers the **same 404 body** as one that does not exist (traceId aside): one `projectNotFound(slug)` and one `runNotFound(id)` produce both.
- The bearer-token path does not change: `AuthGuard`, `@Scopes` and `SessionOnlyGuard` stay exactly as they are. `AccessGuard` returns `true` for any non-session tenant.
- Better Auth's tables keep their camelCase, unmapped columns (`"role"`, `"banned"`, `"banReason"`, `"banExpires"`, `"impersonatedBy"`).
- Schema changes go through a migration applied with `prisma migrate deploy`; never `prisma db push`. `schema.prisma` must match the migrations (`infra/test/schema-matches-migrations.sh`).
- A parameter whose wrong value is silent takes no default.
- Integration and e2e run against a scratch database and a scratch Redis index, never the developer database.
- Commit messages explain why; stage files by name, never `git add -A`.
- Nothing in `apps/web/src` changes in this PR; `apps/web/e2e/fixtures.ts` does.

## Review Focus

1. **A session that belongs to no project** must see nothing in `GET /v1/projects`, `/v1/runs`, `/v1/tests` and `/v1/activity`, never everything. `projectIds: []` and `projectIds: undefined` mean opposite things. Test owned by Task 7.
2. **A run id from another project** must answer a 404 whose body equals the nonexistent-run body, so membership cannot be probed. Test owned by Task 6.
3. **A membership removed mid-session** must take effect on the next request; roles are read per request, never cached on the session. Test owned by Task 7.
4. **The live WebSocket feed** is outside Nest's guards; a member of project A must not stream a run of project B. Test owned by Task 4.
5. **Re-running bootstrap** (compose does it on every `up`) must never re-promote an account an admin has demoted. Test owned by Task 3.

---

### Task 1: The permission table

**Files:**
- Create: `packages/contracts/src/access.ts`
- Modify: `packages/contracts/src/index.ts` (export it), `packages/contracts/src/project.ts` (`ProjectSummarySchema.role`)
- Test: `packages/contracts/test/access.test.ts`

**Interfaces:**
- Produces:
  - `PROJECT_ROLES = ['viewer', 'member', 'manager'] as const`; `type ProjectRole`
  - `type AccessRole = ProjectRole | 'admin'`
  - `type AccessAction` (the 14 names below)
  - `ACCESS_ACTIONS: Readonly<Record<AccessAction, { role: AccessRole; scope: TokenScopeName | null; label: string }>>` (`TokenScopeName` already exists in `tokens.ts`)
  - `roleSatisfies(held: ProjectRole, required: ProjectRole): boolean`
  - `ProjectSummarySchema` gains `role: z.enum(PROJECT_ROLES).nullable().optional()`

The table's values, copied exactly (`scope: null` means session only):

| action | role | scope | label |
| --- | --- | --- | --- |
| `project:read` | viewer | `read` | Reading this project |
| `rules:read` | viewer | null | Viewing SLA rules |
| `members:read` | viewer | null | Viewing members |
| `run:note` | member | null | Editing run notes |
| `run:upload` | member | null | Uploading runs |
| `runner:run` | member | `runner` | Starting, cancelling and retrying runs |
| `packages:manage` | member | `runner` | Managing packages |
| `packages:delete` | member | null | Deleting packages |
| `rules:edit` | member | null | Editing SLA rules |
| `tests:manage` | manager | null | Renaming and deleting tests |
| `tokens:manage` | manager | null | Managing API tokens |
| `members:manage` | admin | null | Managing members |
| `projects:create` | admin | null | Creating projects |
| `users:manage` | admin | null | Managing users |

- [ ] **Step 1: Write the failing tests**

```ts
it('ranks viewer below member below manager', () => {
  expect(roleSatisfies('member', 'viewer')).toBe(true);
  expect(roleSatisfies('viewer', 'member')).toBe(false);
  expect(roleSatisfies('manager', 'manager')).toBe(true);
  expect(roleSatisfies('member', 'manager')).toBe(false);
});
it('gives every action a role, a label and a known scope', () => {
  for (const [name, a] of Object.entries(ACCESS_ACTIONS)) {
    expect([...PROJECT_ROLES, 'admin'], name).toContain(a.role);
    expect(a.label.length, name).toBeGreaterThan(0);
    if (a.scope !== null) expect(TOKEN_SCOPES, name).toContain(a.scope);
  }
  expect(Object.keys(ACCESS_ACTIONS)).toHaveLength(14);
});
it('lets no token perform an admin action', () => {
  for (const a of Object.values(ACCESS_ACTIONS)) if (a.role === 'admin') expect(a.scope).toBeNull();
});
it('reads a project summary with a role, a null role, and none at all', () => {
  // build a valid summary fixture; parse succeeds with role 'member', null, and the key absent;
  // parse fails with role 'owner'
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run packages/contracts/test/access.test.ts`
Expected: FAIL, `access.ts` does not exist.

- [ ] **Step 3: Implement `access.ts` and the schema field** with the values above.

- [ ] **Step 4: Run them to see them pass**, plus `pnpm vitest run packages/contracts/test`. Expected: PASS.

- [ ] **Step 5: Commit** `packages/contracts/src/access.ts`, `index.ts`, `project.ts`, the test.

---

### Task 2: Schema, migration and membership repositories

**Files:**
- Modify: `packages/persistence/prisma/schema.prisma`
- Create: `packages/persistence/prisma/migrations/20261007120000_project_access/migration.sql`
- Create: `packages/persistence/src/repositories/project-member.ts`
- Modify: `packages/persistence/src/repositories/membership.ts`, `packages/persistence/src/repositories/tenant.ts`, the repositories' index export, `infra/test/residue-seed.sql`
- Modify: every caller of `OrgMemberRepository.add` (drop the third argument; `pnpm typecheck` lists them: bootstrap, `apps/web/e2e/fixtures.ts`, `apps/api/test/support/session.ts`, the worker integration tests)
- Test: `packages/persistence/test/project-member.integration.test.ts`, `packages/persistence/test/access-backfill.integration.test.ts`, `packages/persistence/test/tenant.test.ts`, update `packages/persistence/test/membership.integration.test.ts`

**Interfaces:**
- Consumes: `ProjectRole`, `PROJECT_ROLES` (Task 1)
- Produces:
  - `ProjectMemberRepository` (constructed with the Prisma client like its siblings): `rolesForUser(userId: string): Promise<Map<string, ProjectRole>>`, `add(input: { projectId: string; userId: string; role: ProjectRole; addedBy: string | null }): Promise<void>`, `remove(projectId: string, userId: string): Promise<void>`
  - `OrgMemberRepository.add(userId: string, orgId: string): Promise<void>`; `findOrgForUser(userId: string): Promise<{ orgId: string } | null>`
  - `TenantScope.projectIds?: readonly string[]`: present only for a non-admin session; the projects it may see
  - `visibilityClause(scope: TenantScope, column: string, params: unknown[]): string | null` in `tenant.ts`: `null` when `projectIds` is absent; otherwise pushes the array onto `params` and returns `` `${column} = ANY($${params.length}::uuid[])` ``

Schema: `User` gains `role String? @default("user")`, `banned Boolean? @default(false)`, `banReason String?`, `banExpires DateTime?` and a `projectMembers` relation; `Session` gains `impersonatedBy String?`; `OrgMember` loses `role`; new model `ProjectMember` mapped to `project_member` with `project_id uuid`, `user_id text`, `role text`, `created_at timestamptz DEFAULT now()`, `added_by text?`, `@@id([projectId, userId])`, `@@index([userId])`, cascade from project and user, `SET NULL` from `added_by`. Add `CHECK (role IN ('manager','member','viewer'))` in the SQL.

Migration order: generate with `prisma migrate diff --from-migrations … --to-schema-datamodel … --script`, then hand-place, between the lines `-- ADMINS: begin` and `-- ADMINS: end`, after the new columns and BEFORE `org_member.role` is dropped:

```sql
UPDATE "user" SET "role" = 'admin' WHERE "id" IN (SELECT "user_id" FROM "org_member");
```

- [ ] **Step 1: Write the failing tests**
  - `tenant.test.ts`: `visibilityClause` returns `null` and pushes nothing for `{ orgId }`; returns `'p.project_id = ANY($2::uuid[])'` and pushes `['a']` for `{ orgId, projectIds: ['a'] }` with `params = [orgId]`; **for `projectIds: []` it still returns a clause** (matches nothing, never everything).
  - `project-member.integration.test.ts`: `add` then `rolesForUser` returns `Map { projectId => 'member' }`; a second `add` for the same pair throws; `remove` then `rolesForUser` is empty; deleting the project removes the row; a role outside the three is refused by the database.
  - `access-backfill.integration.test.ts`: following `package-backfill.integration.test.ts`'s pattern, read the statements between the markers out of the migration file, seed one user with an `org_member` row and one without (both `role = 'user'`), run the block, assert the first is `'admin'` and the second still `'user'`; assert the block is non-empty (vacuity guard).
  - `membership.integration.test.ts`: `findOrgForUser` returns `{ orgId }` with no `role` key.

- [ ] **Step 2: Run them to see them fail.** `pnpm vitest run packages/persistence/test/tenant.test.ts` (unit); the integration files with `vitest run --config vitest.integration.config.ts <files>` against a scratch database. Expected: FAIL on missing symbols / table.

- [ ] **Step 3: Implement the schema, migration, repositories and caller changes**; drop `role` from `infra/test/residue-seed.sql`'s `org_member` insert.

- [ ] **Step 4: Verify.** `prisma migrate deploy` on the scratch database; `infra/test/schema-matches-migrations.sh` exits 0; the tests above PASS; `pnpm build && pnpm typecheck` exit 0.

- [ ] **Step 5: Commit** the schema, migration, repositories, residue seed, caller changes and tests.

---

### Task 3: Better Auth admin plugin, closed sign-up, bootstrap and fixtures

**Files:**
- Modify: `packages/persistence/src/auth.ts`, `apps/api/src/auth/mount-better-auth.ts`, `packages/persistence/scripts/bootstrap.ts`, `apps/api/test/support/session.ts`, `apps/web/e2e/fixtures.ts`, `.github/workflows/ci.yml` (the test-residue step that runs bootstrap twice)
- Modify: every integration test that called the old session helpers (`pnpm typecheck` lists them)
- Test: `apps/api/test/session-auth.integration.test.ts` (rewrite its `/auth/*` sign-up case)

**Interfaces:**
- Consumes: `ProjectMemberRepository.add`, `OrgMemberRepository.add` (Task 2)
- Produces, in `apps/api/test/support/session.ts` (the old `signUp`, `signUpAndLogin` and `signUpAsOrgMember` are removed):
  - `signInWithoutOrg(app: INestApplication, email: string): Promise<string>`: an account with no `org_member` row
  - `signInAsAdmin(ctx: TestContext, email: string): Promise<{ cookie: string; userId: string }>`: an admin of `ctx.orgId`; what every existing caller of `signUpAsOrgMember` becomes, so its meaning (full access) is unchanged
  - `signInAsProjectMember(ctx: TestContext, email: string, projects: ReadonlyArray<{ projectId: string; role: ProjectRole }>): Promise<{ cookie: string; userId: string }>`: a non-admin org member with exactly those memberships (an empty array is a member of nothing)
  - All three create the account with the app's own `auth.api.createUser({ body: { email, password, name, role } })` (no headers: the handler then needs no session) and sign in with `POST /auth/sign-in/email`.

Config: `plugins: [admin({ defaultRole: 'user', adminRoles: ['admin'] })]` and `emailAndPassword: { enabled: true, disableSignUp: true }`. In `mount-better-auth.ts`, register `/auth/admin/*splat` answering 404 **before** the Better Auth handler. Bootstrap creates a new admin with `auth.api.createUser({ body: { …, role: 'admin' } })`; its reuse path for an existing account writes nothing to `role`.

- [ ] **Step 1: Write the failing tests** in `session-auth.integration.test.ts`:
  - `POST /auth/sign-up/email` answers a non-2xx status and creates no `user` row.
  - An account from `signInAsAdmin` gets a session cookie, and `GET /auth/get-session` reports `user.role === 'admin'`.
  - `POST /auth/admin/list-users` with that admin's cookie answers 404.
  - An account from `signInAsProjectMember(ctx, e, [])` reports `user.role === 'user'`.

- [ ] **Step 2: Run them to see them fail** (sign-up still succeeds; `role` absent). Expected: FAIL.

- [ ] **Step 3: Implement** the config, the mount guard, bootstrap, the three helpers, the e2e fixtures (`seedAdmin` and `seedAdminForEmptyOrg` create `role: 'admin'`; `seedUserWithoutOrg` creates `role: 'user'`), and migrate every caller.

- [ ] **Step 4: Extend the CI bootstrap step**: after the second run's existing assertions, `UPDATE "user" SET "role" = 'user'` for the bootstrap admin, run bootstrap a third time, and fail unless the role is still `'user'`. Replay the step locally under `bash -eo pipefail`, including a red check: temporarily make the reuse path write `role: 'admin'` and confirm the step fails.

- [ ] **Step 5: Verify.** The tests above PASS; `pnpm typecheck` exits 0; `pnpm test:integration` collects every file and passes; `pnpm test:e2e` passes on a scratch stack (its fixtures now create users through the admin call).

- [ ] **Step 6: Commit.**

---

### Task 4: The session tenant, and the live feed's membership check

**Files:**
- Modify: `apps/api/src/auth/auth.guard.ts` (`Tenant`), `apps/api/src/auth/auth.middleware.ts`, `apps/api/src/auth/auth.module.ts`, `apps/api/src/live/live.gateway.ts`, `apps/api/src/live/live.module.ts`
- Create: `apps/api/src/auth/access.ts`
- Test: `apps/api/test/access.test.ts`, a new case in `apps/api/test/live-gateway.integration.test.ts`

**Interfaces:**
- Consumes: `ProjectMemberRepository.rolesForUser` (Task 2); `session.user.role` (Task 3)
- Produces:
  - `Tenant` gains three optional fields, set by `authenticateSession` and never by `authenticateRequest`: `isAdmin?: boolean` (always set for a session), `projectRoles?: ReadonlyMap<string, ProjectRole>` (always set for a session; empty for an admin, who skips the query), `projectIds?: readonly string[]` (set for a non-admin session only, `[]` when they belong to nothing)
  - In `access.ts`: `listScope(tenant: Tenant): TenantScope` (`{ orgId, projectId, projectIds }`), `canSeeProject(tenant: Tenant, projectId: string): boolean` (true for bearer tenants whose `projectId` matches, for admins, and for sessions holding a role there)

- [ ] **Step 1: Write the failing tests**
  - `access.test.ts`: `listScope` copies `projectIds` for a non-admin session and omits it for an admin and for a bearer tenant; `canSeeProject` is false for a session with roles only in another project, true for an admin with none.
  - `live-gateway.integration.test.ts`: a project member of A connecting to a run in B is closed with `CLOSE_UNAUTHORIZED` (4401), the same as an unknown run id; a member of B connecting to that run is accepted. Seed accounts with `signInAsProjectMember`.

- [ ] **Step 2: Run them to see them fail.** Expected: FAIL (`listScope` missing; the gateway accepts the member of A).

- [ ] **Step 3: Implement.** `authenticateSession` sets `isAdmin` from `session.user.role === 'admin'` and loads roles only for non-admins; the gateway, after its existing run lookup, closes 4401 unless `isAdmin` or the user's roles include `run.projectId` (one `rolesForUser` call).

- [ ] **Step 4: Run them to see them pass.**

- [ ] **Step 5: Commit.**

---

### Task 5: The access guard and the shared 404s

**Files:**
- Create: `apps/api/src/auth/access.decorator.ts`, `apps/api/src/auth/access.guard.ts`
- Modify: `apps/api/src/auth/access.ts`, `apps/api/src/auth/auth.module.ts` (register `AccessGuard` as an `APP_GUARD` **after** `AuthGuard`), `apps/api/src/common/validation.ts`, `packages/persistence/src/repositories/run.ts`
- Modify: the controllers that spell a project or run 404 literally (`runner`, `project-ingest`, `tests`, `rules`, `tokens`, `runs`, `metrics`, `parity`, `live`, `run-events`) to call the shared helpers
- Test: `apps/api/test/access.test.ts`

**Interfaces:**
- Consumes: `ACCESS_ACTIONS`, `roleSatisfies` (Task 1); `Tenant` fields (Task 4)
- Produces:
  - `Requires(action: AccessAction)`, `BearerOnly()`, `NotProjectScoped()` with metadata keys `REQUIRES_KEY`, `BEARER_ONLY_KEY`, `NOT_PROJECT_SCOPED_KEY`
  - `accessDecision(input: { required: AccessRole; isAdmin: boolean; role: ProjectRole | null }): 'allow' | 'not-found' | 'role-required' | 'admin-required'` in `access.ts`
  - `projectNotFound(slug: string): NotFoundException` (`No project "${slug}" in this organisation.`, remediation `Check the slug, or list the projects this credential can reach with GET /v1/projects.`); `runNotFound(id: string): NotFoundException` (`No run ${id} in this project.`, the existing two-sentence remediation); `accessDenied(code: 'ROLE_REQUIRED' | 'ADMIN_REQUIRED', message: string, remediation: string): ForbiddenException`
  - `RunRepository.projectIdOf(orgId: string, runId: string): Promise<string | null>`

Guard, for a session tenant on a `@Requires` route (anything else returns `true`):
1. `role: 'admin'` action: allow if `isAdmin`, else `ADMIN_REQUIRED`, detail `` `${label} needs an admin.` ``, remediation `Ask an admin to do this.`
2. Resolve the project: `:slug` via `ProjectRepository.findBySlugInOrg`, else `:id` under `/v1/runs` via `projectIdOf`. Not found: return `true` (the controller answers its own 404, as today).
3. `accessDecision`; `not-found` throws `projectNotFound(slug)` or `runNotFound(id)`; `role-required` throws `ROLE_REQUIRED`, detail `` `${label} needs the ${Role} role in this project.` `` (`Role` capitalised), remediation `Ask an admin to change your role.`
4. A `@Requires` route with neither `:slug` nor `/v1/runs/:id` and a non-admin action throws an `Error` naming the route (a 500). Task 6's route walk makes it unreachable.

- [ ] **Step 1: Write the failing tests** in `access.test.ts` for `accessDecision`: admin passes everything; a `viewer` meets `viewer` and fails `member` (`role-required`); `null` role is `not-found` for any project action; a non-admin on an admin action is `admin-required` even holding `manager`.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement** the decorators, `accessDecision`, the guard, the helpers and `projectIdOf`, and switch the literal 404s to the helpers (the wording does not change).

- [ ] **Step 4: Verify.** The unit tests PASS; `pnpm test:integration` still passes in full: no route carries `@Requires` yet, so the guard allows everything. That is the point of this task boundary.

- [ ] **Step 5: Commit.**

---

### Task 6: Every route declares its access

**Files:**
- Modify: every controller under `apps/api/src` (decorators only), `apps/api/src/openapi/document.ts` (the shared `Forbidden` response's description names `ROLE_REQUIRED` and `ADMIN_REQUIRED`)
- Test: `apps/api/test/access-routes.integration.test.ts`

**Interfaces:**
- Consumes: the decorators and guard (Task 5); `signInAsAdmin`, `signInAsProjectMember` (Task 3)

Annotations, by route:

| routes | decorator |
| --- | --- |
| `GET /v1/runs/:id` and every `GET /v1/runs/:id/…` (stats, series, errors, errors/series, telemetry, distribution, users, scatter, trends, events) | `@Requires('project:read')` |
| `GET` on `/v1/projects/:slug/{tests, tests/:testSlug, packages, runner/runs, runner/runs/:jobId/logs}` | `@Requires('project:read')` |
| `GET /v1/projects/:slug/rules` | `@Requires('rules:read')` |
| `PUT /v1/runs/:id/note` | `@Requires('run:note')` |
| `POST /v1/projects/:slug/runs` | `@Requires('run:upload')` |
| `POST …/runner/runs`, `…/:jobId/cancel`, `…/:jobId/retry` | `@Requires('runner:run')` |
| `POST`, `PUT …/content`, `PATCH` on packages | `@Requires('packages:manage')` |
| `DELETE` on packages | `@Requires('packages:delete')` |
| `POST`, `PATCH`, `DELETE` on rules | `@Requires('rules:edit')` |
| `PATCH`, `DELETE` on `…/tests/:testSlug` | `@Requires('tests:manage')` |
| `GET`, `POST`, `DELETE` on tokens | `@Requires('tokens:manage')` |
| `POST /v1/projects` | `@Requires('projects:create')` |
| `GET /v1/projects`, `GET /v1/runs`, `GET /v1/tests`, `GET /v1/activity` | `@NotProjectScoped()` |
| `POST /v1/runs`, `POST /v1/runs/live`, `…/stream`, `…/close`, `POST /v1/telemetry`, `GET /v1/projects/:slug/runs` | `@BearerOnly()` |
| `/healthz`, `/readyz` | `@Public()` (already) |

- [ ] **Step 1: Write the failing tests** in `access-routes.integration.test.ts`, walking `AppModule` the way `openapi.integration.test.ts`'s `registeredRoutes()` does:
  - **Every route declares how it is reached:** each has exactly one of `@Requires`, `@BearerOnly`, `@NotProjectScoped`, `@Public`; failure names the routes. Vacuity: more than 40 routes collected.
  - **Each route's token scope agrees with its action:** for `@Requires` with a non-null table scope, the route's `@Scopes` is exactly `[scope]`; with a null scope, the route or its class carries `SessionOnlyGuard`.
  - **A project action sits on a route that names its project:** a non-admin action's path contains `:slug` or starts with `/v1/runs/:id`.
  - **The role matrix:** two projects A and B in `ctx.orgId`, each with a run. For each action some route declares, one representative request (table below). The action's lowest role in A passes the guard: status is not 403 and the body is not `projectNotFound('a')`. The role below gets `403 ROLE_REQUIRED` naming the needed role. A member of B only gets a 404 whose body, traceId removed, equals the body for a nonexistent project, or for a nonexistent run id on run routes (Review Focus 2). An admin with no row passes. A vacuity check: the matrix covers every action the walk found on a route.
  - **Bearer tokens unchanged:** a read token for A still gets 200 on `GET /v1/projects/a/tests` and `GET /v1/runs/:aRun`.

  Representative requests (an invalid body is enough wherever the guard runs before validation; the role that passes then sees the controller's 400):
  `project:read` GET `/v1/projects/a/tests` · `rules:read` GET `/v1/projects/a/rules` · `run:note` PUT `/v1/runs/:aRun/note` · `run:upload` POST `/v1/projects/a/runs` (no body) · `runner:run` POST `/v1/projects/a/runner/runs` (no body) · `packages:manage` POST `/v1/projects/a/packages` (no body) · `packages:delete` DELETE `/v1/projects/a/packages/<random uuid>` · `rules:edit` POST `/v1/projects/a/rules` `{}` · `tests:manage` PATCH `/v1/projects/a/tests/missing` `{}` · `tokens:manage` GET `/v1/projects/a/tokens` · `projects:create` POST `/v1/projects` `{}`

- [ ] **Step 2: Run them to see them fail** (no route is annotated). Expected: FAIL listing every route.

- [ ] **Step 3: Annotate every controller** per the table and update the `Forbidden` response description.

- [ ] **Step 4: Verify.** The new file PASSES. `openapi.integration.test.ts` still passes, since its session-only pairing reads `SessionOnlyGuard`, which is unchanged. Red-verify, with the replacement count asserted before each run:
  - Delete one `@Requires`: the walk names that route.
  - Change `rules:edit`'s role to `viewer` in the table: the matrix fails on the viewer row.
  - Make `accessDecision` return `allow` for a null role: the Review Focus 2 rows fail.

- [ ] **Step 5: Commit.**

---

### Task 7: Lists show only your projects

**Files:**
- Modify: `packages/persistence/src/repositories/project.ts` (`listForOrg(scope: TenantScope)`), `run.ts` (`list`), `test.ts` (`listOrg`), `activity.ts` (its local `tenantFilter`)
- Modify: `apps/api/src/projects/projects.controller.ts`, `apps/api/src/runs/runs.controller.ts`, `apps/api/src/tests/org-tests.controller.ts`, `apps/api/src/activity/activity.controller.ts`
- Test: `apps/api/test/visibility.integration.test.ts`

**Interfaces:**
- Consumes: `visibilityClause` (Task 2), `listScope`, `canSeeProject` (Task 4), `projectNotFound` (Task 5)
- Produces: `GET /v1/projects` items carry `role`: the caller's role in that project, or `null` (an admin with no row, or a bearer token)

Each of the four repository reads appends `visibilityClause(scope, '<alias>.project_id', params)` when non-null. `GET /v1/runs?project=<slug>` naming a project `canSeeProject` refuses throws `projectNotFound(slug)`.

- [ ] **Step 1: Write the failing tests** with projects A and B in one org, a run in each:
  - A viewer of A: `GET /v1/projects` lists only A, with `role: 'viewer'`; `GET /v1/runs` lists only A's run; `GET /v1/tests` only A's test; `GET /v1/activity` counts only A's run.
  - The same viewer: `GET /v1/runs?project=b` answers a 404 equal, traceId removed, to `?project=missing`.
  - **A member of nothing** (`signInAsProjectMember(ctx, e, [])`): all four lists are empty (Review Focus 1).
  - An admin with no rows sees A and B, each with `role: null`.
  - **Removal mid-session:** the viewer of A is removed with `ProjectMemberRepository.remove`; the same cookie's next `GET /v1/projects` lists nothing (Review Focus 3).

- [ ] **Step 2: Run them to see them fail** (everything is visible). Expected: FAIL.

- [ ] **Step 3: Implement** the four clauses and the controller changes.

- [ ] **Step 4: Verify.** The file PASSES. The existing EXPLAIN-based plan guards in `repositories.integration.test.ts` and the activity tests still pass (an absent `projectIds` adds nothing to any statement). Red-verify: make `visibilityClause` return `null` for an empty array, and the member-of-nothing case fails.

- [ ] **Step 5: Commit.**

---

### Task 8: Gates, a real run, and the record

**Files:**
- Modify: `CLAUDE.md` (a new entry at the top of Verification, with the measured floors)

- [ ] **Step 1: Predict the floors** by counting new files and cases from the source: unit from 216 / 3350, integration from 194 / 2865, e2e unchanged at 197.

- [ ] **Step 2: Run the gates in order** on a scratch database, a scratch Redis index and a free e2e port, reading each command's own exit code:

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e --workers=2
```

Expected: every total equals the prediction, zero `Errors` lines in the unit run.

- [ ] **Step 3: The real-run check**, against a copy of the developer database migrated with this branch, the API from this checkout on a free port with `BETTER_AUTH_URL` set to it, and a worker on a fresh Redis index:
  - With a throwaway Node script using `auth.api.createUser` and `ProjectMemberRepository.add`, create a Member and a Viewer of one project and a user with no projects. Keep their passwords in a 0600 scratch file.
  - Sign each in with `curl` against `POST /auth/sign-in/email`.
  - As the Member, upload the Gatling reference bundle through `POST /v1/projects/<slug>/runs`; it reaches `complete` with 895 requests.
  - As the Viewer, `GET /v1/runs/<id>` answers 200, and the same upload answers `403 ROLE_REQUIRED`.
  - As the user with no projects, `GET /v1/runs/<id>` answers the nonexistent-run 404 and `GET /v1/projects` is empty.
  - Afterwards, delete the three accounts and the scratch file, and stop the processes by PID.

- [ ] **Step 4: Write the CLAUDE.md entry**: what the branch added, the measured floors, the red-verifies from Tasks 2, 3, 6 and 7, and the real-run result.

- [ ] **Step 5: Commit** `CLAUDE.md`.
