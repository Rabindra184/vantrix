# Project access PR 2: administration and the password gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin manages accounts and project membership from inside PerfPortal. A person created or reset by an admin must choose a new password before they can do anything else.

**Architecture:**
- **Admin routes.** New `/v1/admin` and `/v1/projects/:slug/members` routes call Better Auth's admin plugin server-side with the admin's own request headers. Membership is written to PR 1's `project_member` table.
- **The gate.** A third global guard, between `AuthGuard` and `AccessGuard`, refuses any session whose `user.mustChangePassword` is set, except on routes marked to stay reachable.
- **Web.** The app gains a full-screen password step, a Change password page, and an Administration area (Users, Projects) reachable from the account menu.

**Tech Stack:**
- API and data: NestJS 11, Better Auth 1.6.26 (admin plugin), Prisma 6 + raw SQL, zod contracts.
- Web: React 18, TanStack Query, Radix.
- Tests: Vitest 4 and Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-project-access-design.md`. Sections 1 (account flags), 2 (table rows `members:*`, `users:manage`), 3 (account flows) and 4 (Administration, Choose a new password) are this PR. Section 6 item 2 is the build order. The Members section, role-aware controls and the no-projects state are PR 3 and are NOT built here.

## Global Constraints

- Node 22 (`.nvmrc`). Run every suite on `perfportal_access` and Redis db 12 — never the `perfportal` database. e2e runs on `PERFPORTAL_E2E_PORT=3700`.
- The bearer path is untouched: `AuthGuard`, `@Scopes`, `SessionOnlyGuard`, `authenticateRequest`. Every new route is session-only, through `SessionOnlyGuard` on the controller class.
- Every new route declares how it is reached, and is written into `ACCESS_BY_ROUTE` in `apps/api/test/access-routes.integration.test.ts`. A new action gets a `PROBES` row carrying the spec's role.
- Passwords are 8 to 128 characters (Better Auth's defaults). `auth.api.createUser` does not check this, so our request schemas must.
- Errors are problem+json through the helpers in `apps/api/src/common/validation.ts`, and every remediation names a route that exists.
- Copy follows the clean-UI rule:
  - labels are noun phrases;
  - no description line under a card or section title;
  - sentences only where the reader must act;
  - one `primary` button per screen;
  - destructive actions are confirmed inline in two steps (the `ProjectRules` pattern), not in dialogs.
- No backticks inside SQL comments in template literals. Stage files by name, never `git add -A`. Commit messages explain WHY, with no attribution lines.

## Review Focus

1. **A session that must change its password reaches nothing.** Every `/v1` route answers `403 PASSWORD_CHANGE_REQUIRED` except `PUT /v1/me/password`. The live WebSocket refuses it, and the web's sign-in probe must not read that 403 as "no organisation". Tests: Task 3 (API, WebSocket) and Task 6 (web).
2. **Two admins removing each other's admin at the same moment.** Exactly one succeeds and the other gets `409 LAST_ADMIN`. A disabled admin does not count as active. Test: Task 4.
3. **An admin in org A naming a user from org B**, or a user in no org, on any `/v1/admin/users/:userId` or members route gets a 404, and nothing changes. Tests: Tasks 4 and 5.
4. **A create that fails after the account exists** leaves no account, and retrying with the same email in any letter case succeeds. Test: Task 4.
5. **A reset or a disable ends the person's sessions now.** Their existing cookie answers 401 on its next request, and a banned user is refused even if a session row survived. Tests: Tasks 3 and 4.

---

### Task 1: Contracts for admin, members and own password

**Files:**
- Create: `packages/contracts/src/admin.ts`, `packages/contracts/src/members.ts`, `packages/contracts/src/me.ts`
- Modify: `packages/contracts/src/index.ts`, `apps/api/src/openapi/schemas.ts` (register every new schema)
- Test: `packages/contracts/test/admin.test.ts`, `members.test.ts`, `me.test.ts`

**Interfaces — Produces:**
- `PASSWORD_MIN_LENGTH = 8`, `PASSWORD_MAX_LENGTH = 128`; `PasswordSchema` (string within those bounds).
- `admin.ts`:
  - `AdminUserSchema`: `{ id: string; name: string; email: string; isAdmin: boolean; disabled: boolean; mustChangePassword: boolean; memberships: { projectSlug: string; projectName: string; role: ProjectRole }[]; createdAt: string }`
  - `AdminUserListResponseSchema = { users: AdminUser[] }`
  - `CreateUserRequestSchema` (strict): `{ email; name 1–120 trimmed; password: PasswordSchema; isAdmin: boolean default false; projects: { projectSlug; role: ProjectRole }[] default [] }`. Duplicate `projectSlug` is refused.
  - `UpdateUserRequestSchema` (strict): `{ name?; isAdmin?; disabled? }`, at least one field required.
  - `SetPasswordRequestSchema = { password: PasswordSchema }`
  - `AdminProjectSchema = { slug; name; memberCount: number; createdAt: string }`; `AdminProjectListResponseSchema = { projects }`
- `members.ts`:
  - `ProjectMemberSchema = { userId; name; email; role: ProjectRole; addedAt: string }`
  - `MemberListResponseSchema = { members }`
  - `AddMemberRequestSchema` (strict) `{ userId: string min 1; role }`
  - `UpdateMemberRequestSchema` (strict) `{ role }`
- `me.ts`: `ChangePasswordRequestSchema` (strict) `{ currentPassword: string min 1; newPassword: PasswordSchema }`. A refinement refuses `newPassword === currentPassword` with the message `The new password is the same as the current one.`

- [ ] **Step 1: Write the failing tests.** Cover:
  - the bounds at 7, 8, 128 and 129 characters;
  - strictness: an extra field is refused;
  - `projects` and `isAdmin` defaults;
  - duplicate `projectSlug` refused;
  - `UpdateUserRequestSchema` refusing `{}`;
  - the same-password refinement;
  - each role field accepting exactly `PROJECT_ROLES`.
- [ ] **Step 2: Run** `pnpm vitest run packages/contracts/test/admin.test.ts packages/contracts/test/members.test.ts packages/contracts/test/me.test.ts`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** the three modules, export them, and register the schemas in `schemas.ts` (the OpenAPI document reads them from there).
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `pnpm --filter @perfportal/contracts exec tsc -b` and grep the emitted `dist` for `PASSWORD_MAX_LENGTH`.
- [ ] **Step 5: Commit.**

---

### Task 2: The flag, the user queries, and bootstrap

**Files:**
- Create: `packages/persistence/prisma/migrations/20261008120000_must_change_password/migration.sql`, `packages/persistence/src/repositories/user.ts`
- Modify:
  - `packages/persistence/prisma/schema.prisma` (`User.mustChangePassword Boolean @default(false)`, camelCase like its neighbours)
  - `packages/persistence/src/auth.ts` (`user.additionalFields.mustChangePassword = { type: 'boolean', defaultValue: false, input: false }`)
  - `packages/persistence/src/repositories/project-member.ts`
  - `packages/persistence/scripts/bootstrap.ts`
  - `packages/persistence/src/index.ts`, `.github/workflows/ci.yml` (the `test-residue` bootstrap steps)
- Test: `packages/persistence/test/user.integration.test.ts`, additions to `project-member.integration.test.ts`, `auth-cookies.test.ts`, and `apps/api/test/session-auth.integration.test.ts`

**Interfaces:**
- Consumes: `ProjectRole`, `PASSWORD_MIN_LENGTH`, `PASSWORD_MAX_LENGTH` (Task 1).
- Produces:
  - `UserRepository`:
    - `listInOrg(orgId): Promise<OrgUserRow[]>`. `OrgUserRow = { id; name; email; role: string | null; banned: boolean; mustChangePassword: boolean; createdAt: Date; memberships: { projectId; projectSlug; projectName; role: ProjectRole }[] }`. Only users with an `org_member` row in `orgId`, sorted by name.
    - `findInOrg(orgId, userId): Promise<OrgUserRow | null>`
    - `findByEmail(email): Promise<{ id: string } | null>`, matched case-insensitively.
    - `countActiveAdmins(orgId): Promise<number>`: `role = 'admin'` AND `banned IS NOT TRUE`, members of `orgId`.
    - `withAdminLock<T>(orgId, fn: () => Promise<T>): Promise<T>`: an interactive transaction that takes `pg_advisory_xact_lock` on a key derived from `orgId` and `'admins'`, runs `fn` and releases on commit, with `LOCK_WAITING_TX = { maxWait: 10_000, timeout: 30_000 }`.
    - `setMustChangePassword(userId, value: boolean): Promise<void>`
    - `deleteUser(userId): Promise<void>`, used only for create's compensation; cascades remove its sessions, accounts and memberships.
  - `ProjectMemberRepository` gains:
    - `listForProject(projectId): Promise<{ userId; name; email; role: ProjectRole; addedAt: Date }[]>` (by name)
    - `setRole(projectId, userId, role): Promise<boolean>` (false when no row)
    - `memberCounts(projectIds: string[]): Promise<Map<string, number>>`
    - `add` writes its four named fields rather than passing `data: input` through.

- [ ] **Step 1: Write the failing tests:**
  - `listInOrg` returns only this org's users, with memberships.
  - `findInOrg` returns null for another org's user and for a user in no org.
  - `countActiveAdmins` excludes a banned admin and another org's admin.
  - `withAdminLock`: hold the same advisory lock on a raw connection, start a call, and observe it waiting with `pg_blocking_pids` (never a sleep); release, and the call completes. This is the PR 1 four-way-upload pattern.
  - `memberCounts` gives 0 for a project with no rows.
  - Session-auth (integration): `GET /auth/get-session` carries `user.mustChangePassword: false`. A `POST /auth/update-user` with `{ mustChangePassword: true }` is refused `FIELD_NOT_ALLOWED`. One with `{ mustChangePassword: false }` on a flagged user leaves the flag `true`.
  - `auth-cookies.test.ts`: `(await auth.$context).password.config` equals `{ minPasswordLength: PASSWORD_MIN_LENGTH, maxPasswordLength: PASSWORD_MAX_LENGTH }`, so the contracts bounds cannot drift from Better Auth's.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement** the migration (`ALTER TABLE "user" ADD COLUMN "mustChangePassword" boolean NOT NULL DEFAULT false`), the schema field, the additional field, the repository methods, and the `add` cleanup.
- [ ] **Step 4: Bootstrap's rule.** An account bootstrap creates gets `mustChangePassword: true` (through `createUser`'s `data`) when its password is the published default or one bootstrap generated. When the operator set `PERFPORTAL_ADMIN_PASSWORD`, they chose it, so it gets `false`.
  - In `ci.yml`, extend the existing bootstrap steps: the default-seeded admin's flag reads `true`, and the chosen-password step's reads `false`.
  - Replay both steps locally, and red-check by inverting the rule.
- [ ] **Step 5: Run** the tests, `infra/test/schema-matches-migrations.sh` against a freshly migrated scratch database, and `pnpm typecheck`. Expected: PASS and "agree".
- [ ] **Step 6: Commit.**

---

### Task 3: The password gate and `PUT /v1/me/password`

**Files:**
- Create: `apps/api/src/me/me.controller.ts`, `apps/api/src/me/me.module.ts`, `apps/api/src/auth/password-change.guard.ts`
- Modify:
  - `apps/api/src/auth/access.decorator.ts` (two decorators)
  - `apps/api/src/auth/auth.guard.ts` (`Tenant.mustChangePassword?: boolean`)
  - `apps/api/src/auth/auth.middleware.ts`
  - `apps/api/src/auth/auth.module.ts` (guard order)
  - `apps/api/src/live/live.gateway.ts`, `apps/api/src/app.module.ts`, `apps/api/src/openapi/document.ts`
- Test: `apps/api/test/password-gate.integration.test.ts`, `apps/api/test/me.integration.test.ts`, additions to `access-routes.integration.test.ts`, `access-guard.integration.test.ts`, `live-gateway.integration.test.ts`

**Interfaces:**
- Consumes: `ChangePasswordRequestSchema` (Task 1); `UserRepository.setMustChangePassword` (Task 2).
- Produces:
  - `OwnAccount()`, a fifth route marker meaning "acts only on the caller's own account". The route walk accepts it beside the other four and requires every `@OwnAccount` route to carry `SessionOnlyGuard`. Write `'PUT /v1/me/password': 'own-account'` into `ACCESS_BY_ROUTE`.
  - `AllowedBeforePasswordChange()`, the gate's allow-list. The route walk pins the set of routes carrying it to exactly `['PUT /v1/me/password']`.
  - `PasswordChangeGuard`, registered as an `APP_GUARD` AFTER `AuthGuard` and BEFORE `AccessGuard`. A guard rather than path matching in the middleware, because PR 1 measured path matching being bypassed.
  - `PUT /v1/me/password` → `204`.

- [ ] **Step 1: Write the failing tests.**
  - Gate:
    - A session whose flag is set gets `403` with code `PASSWORD_CHANGE_REQUIRED`, detail `Choose a new password before doing anything else.` and remediation `Change it with PUT /v1/me/password.` Test it on one route of each kind: a `@Requires` project route, a `@NotProjectScoped` list, and `GET /v1/admin/users` once Task 4 exists (until then, `POST /v1/projects`).
    - A bearer token is unaffected.
    - `PUT /v1/me/password` is reachable.
    - An unflagged session is unaffected.
    - Guard order: `access-guard.integration.test.ts`'s `getGlobalGuards()` assertion becomes `[AuthGuard, PasswordChangeGuard, AccessGuard]`.
  - Own password:
    - The right current password and a new one gives `204`; the flag reads `false` afterwards.
    - The person's other session's cookie answers 401, and this session's cookie still works.
    - A wrong current password gives `400 INVALID_CURRENT_PASSWORD`, detail `The current password is not correct.`, remediation `Type the password you signed in with.`
    - A new password equal to the current one gives `400 PASSWORD_UNCHANGED` (detail from the schema, remediation `Choose a different password.`).
    - Bounds give `400 INVALID_PASSWORD_REQUEST`.
    - A bearer token gets `403` (`SessionOnlyGuard`).
  - Disabled: a user whose `banned` is set directly in the database, so their session row survives, gets 401 from the middleware. This is Review Focus 5's second half; Better Auth's `getSession` does not check `banned`.
  - WebSocket: a flagged session opening a run's live feed is closed `4401` with no frames, the same as an unknown run.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
  - `authenticateSession` copies `session.user.mustChangePassword` onto the tenant, and refuses a `banned === true` user with the existing 401 path.
  - The guard refuses a session tenant with the flag unless the handler carries `@AllowedBeforePasswordChange`.
  - The gateway refuses a flagged or banned session where it refuses an unknown run.
  - `me.controller.ts`: `@Controller('/v1/me')`, `@UseGuards(SessionOnlyGuard)`, `@Put('password') @HttpCode(204) @OwnAccount() @AllowedBeforePasswordChange()`.
    1. Parse the body.
    2. Call `auth.api.changePassword({ body: { currentPassword, newPassword, revokeOtherSessions: false }, headers })`, mapping Better Auth's `INVALID_PASSWORD` to `INVALID_CURRENT_PASSWORD`.
    3. End the person's OTHER sessions, keeping the current one: `auth.api.revokeOtherSessions({ headers })` if Better Auth 1.6.26 has it (check its source). Otherwise delete the user's sessions except `session.session.id` through the internal adapter.
    4. Clear the flag.
  - OpenAPI: add `setOwnPassword`, and add `PASSWORD_CHANGE_REQUIRED` to the shared `Forbidden` and `SessionRequired` descriptions.
- [ ] **Step 4: Run** the new files and `access-routes.integration.test.ts`, `openapi.integration.test.ts`, `session-auth.integration.test.ts`. Expected: PASS.
- [ ] **Step 5: Red-verify,** asserting each replacement count and restoring from git after each:
  - remove the guard's allow-list check: `PUT /v1/me/password` itself is refused;
  - drop `@AllowedBeforePasswordChange` from the handler: the walk's pinned set fails;
  - remove the gateway check: the WebSocket case fails.
- [ ] **Step 6: Commit.**

---

### Task 4: `/v1/admin` — users and projects

**Files:**
- Create: `apps/api/src/admin/admin.controller.ts`, `apps/api/src/admin/admin.module.ts`, `apps/api/src/admin/admin-users.service.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/openapi/document.ts`, `apps/api/test/access-routes.integration.test.ts`
- Test: `apps/api/test/admin.integration.test.ts`

**Interfaces:**
- Consumes: Task 1's admin schemas; `UserRepository`, `ProjectMemberRepository.memberCounts` and `add` (Task 2); `OrgMemberRepository.add`; `ProjectRepository.findBySlugInOrg` and `listForOrg`.
- Produces:
  - `@Controller('/v1/admin')`, `@UseGuards(SessionOnlyGuard)`, every handler `@Requires('users:manage')`:
    - `GET users` → 200 `AdminUserListResponse`
    - `POST users` → 201 `AdminUser`
    - `PATCH users/:userId` → 200 `AdminUser`
    - `PUT users/:userId/password` → 204
    - `DELETE users/:userId` → 204
    - `GET projects` → 200 `AdminProjectListResponse`
  - `ACCESS_BY_ROUTE` gains all six rows as `users:manage`.
  - `PROBES` gains `{ action: 'users:manage', role: 'admin', route: 'GET /v1/admin/users' }`.
  - The probe filler learns `:userId`.

Behaviour, in the order the handler checks it:
- **Every `:userId`:** `findInOrg(tenant.orgId, userId)`. Null gives `404` with detail `No user ${userId} in this organisation.` and remediation `List the users with GET /v1/admin/users.`
- **Create:**
  1. Parse the body (`400 INVALID_USER_REQUEST`).
  2. Resolve every `projectSlug` in the org. Unknown gives `400 UNKNOWN_PROJECT`, naming the slug.
  3. `findByEmail` gives `409 EMAIL_TAKEN`: `An account with ${email} already exists.` / `Use another email, or find the account with GET /v1/admin/users.`
  4. `auth.api.createUser({ body: { email, name, password, role: isAdmin ? 'admin' : 'user', data: { mustChangePassword: true } }, headers })`. Better Auth's `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` maps to the same 409.
  5. In one transaction: `OrgMemberRepository.add`, then each `ProjectMemberRepository.add` with `addedBy` set to the admin's id.
  6. If step 5 throws, `UserRepository.deleteUser` (compensation) and rethrow.
- **PATCH:**
  - Refuse `disabled: true` on yourself with `400 CANNOT_DISABLE_SELF`.
  - Inside `withAdminLock`: if the change takes an active admin out (`isAdmin: false`, or `disabled: true` on an admin), and `countActiveAdmins` is 1, answer `409 LAST_ADMIN`: `This is the last active admin, so the install would have none.` / `Make someone else an admin first.`
  - Then apply `name` (`auth.api.adminUpdateUser`, or the internal adapter's `updateUser` if absent), `isAdmin` (`setRole`), and `disabled` (`banUser` / `unbanUser`; `banUser` ends their sessions).
- **Password reset:**
  - Yourself: `400 CANNOT_RESET_OWN_PASSWORD`, remediation `Change your own password with PUT /v1/me/password.`
  - Otherwise: `setUserPassword`, then `setMustChangePassword(true)`, then `revokeUserSessions`.
- **DELETE:**
  - Yourself: `400 CANNOT_REMOVE_SELF`.
  - Otherwise the last-admin rule inside `withAdminLock`, then `removeUser`. Their run notes keep their text and lose the name (`ON DELETE SET NULL`, already there).
- **Projects:** every project in the org, by name, with `memberCounts`.

- [ ] **Step 1: Write the failing tests:**
  - Each route's happy path, checked through the database and `GET /auth/get-session`: a created user has `role`, `mustChangePassword: true`, the org row and the memberships.
  - Created user's sign-in: they can sign in, and every `/v1` route answers them `PASSWORD_CHANGE_REQUIRED` until `PUT /v1/me/password`.
  - Errors: `EMAIL_TAKEN`, including a differently-cased email; `UNKNOWN_PROJECT`, with no account left behind; `LAST_ADMIN` for demote, disable and remove.
  - Self refusals.
  - Reset: the person's old cookie answers 401, and their flag reads `true`.
  - Disable: their old cookie answers 401, and sign-in answers 403 `BANNED_USER`. Enable reverses both.
  - Remove: a run note they wrote keeps its text with `updatedBy` null.
  - Org scoping, Review Focus 3: every `:userId` route given another org's user, and a user in no org, answers 404, and that user's row is unchanged afterwards.
  - Compensation, Review Focus 4: make the membership insert throw once (spy on `ProjectMemberRepository.prototype.add`). Assert no `user` row for that email, and that an immediate retry with the email upper-cased answers 201.
  - Concurrency, Review Focus 2: two active admins A and B. Hold `withAdminLock`'s advisory key on a raw connection, send A demoting B and B demoting A, and observe both waiting with `pg_blocking_pids`. Release, then assert exactly one 200 and one `409 LAST_ADMIN`, and that `countActiveAdmins` is 1.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement** the controller (parse, scope, map errors), the service (the Better Auth calls and the lock), the module, and the OpenAPI operations with every status they return.
- [ ] **Step 4: Run** `admin.integration.test.ts`, `access-routes`, `openapi`, `password-gate`. Expected: PASS.
- [ ] **Step 5: Red-verify,** asserting the replacement count each time:
  - drop the org check in `findInOrg`: the org-scoping cases fail;
  - remove the lock: the concurrency case reports two 200s;
  - remove the compensation: the retry case gets `EMAIL_TAKEN`;
  - skip `revokeUserSessions`: the reset case's old cookie still works.
- [ ] **Step 6: Commit.**

---

### Task 5: Project members API

**Files:**
- Create: `apps/api/src/members/members.controller.ts`, `apps/api/src/members/members.module.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/openapi/document.ts`, `apps/api/test/access-routes.integration.test.ts`
- Test: `apps/api/test/members.integration.test.ts`

**Interfaces:**
- Consumes: Task 1's members schemas; `ProjectMemberRepository.listForProject`, `add`, `setRole`, `remove`; `UserRepository.findInOrg` (Task 2).
- Produces: `@Controller('/v1/projects/:slug/members')`, `@UseGuards(SessionOnlyGuard)`:
  - `GET` (`members:read`) → 200 `MemberListResponse`
  - `POST` (`members:manage`) → 201 `ProjectMember`
  - `PATCH :userId` (`members:manage`) → 200 `ProjectMember`
  - `DELETE :userId` (`members:manage`) → 204

  `ACCESS_BY_ROUTE` gets four rows. `PROBES` gains `{ action: 'members:read', role: 'viewer', route: 'GET /v1/projects/:slug/members' }` and `{ action: 'members:manage', role: 'admin', route: 'POST /v1/projects/:slug/members', body: {} }`.

Behaviour:
- **Guard:** `members:manage` is an admin action on a `:slug` route. `AccessGuard` refuses a non-admin with `ADMIN_REQUIRED` before any lookup, so a missing slug and an invisible one get the same answer. The matrix's outsider rows for this action therefore expect `ADMIN_REQUIRED`, as PR 1's Ruling 2 did for `projects:create`.
- **Project:** resolved with `projectNotFound` (an admin reaches the controller).
- **POST:**
  - The `userId` must belong to the org: `findInOrg`, else 404 as in Task 4.
  - An existing row gives `409 MEMBER_EXISTS`: `${name} is already a member of this project.` / `Change their role with PATCH /v1/projects/{slug}/members/{userId}.`
  - `addedBy` is the admin.
- **PATCH and DELETE** of someone who is not a member: 404, `No member ${userId} in project "${slug}".` / `List the members with GET /v1/projects/{slug}/members.`

- [ ] **Step 1: Write the failing tests:**
  - A viewer lists the members (name, email, role).
  - A manager is refused `POST` with `ADMIN_REQUIRED`.
  - An admin adds, changes and removes a member, and the change shows on that person's next request:
    - `GET /v1/projects` gains or loses the project, with its `role`;
    - their `ROLE_REQUIRED` answers follow the new role.
  - `MEMBER_EXISTS`.
  - Another org's user and a non-member give 404.
  - Removing the last membership leaves the account, and its next `GET /v1/projects` is empty.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement** the controller, module and OpenAPI operations.
- [ ] **Step 4: Run** `members`, `access-routes`, `openapi`, `visibility`. Expected: PASS.
- [ ] **Step 5: Red-verify:** change `members:manage`'s probe role to `manager` in `PROBES`, and the matrix fails on its manager row.
- [ ] **Step 6: Commit.**

---

### Task 6: Web — the password step, Change password, and the account menu

**Files:**
- Create:
  - `apps/web/src/api/me.ts` (`changeOwnPassword(body)`)
  - `apps/web/src/components/PasswordChangeForm.tsx`
  - `apps/web/src/ChoosePassword.tsx` (the full-screen step)
  - `apps/web/src/routes/AccountPassword.tsx`
- Modify:
  - `apps/web/src/api/session.ts` (`Session['user']` gains `role?: string | null` and `mustChangePassword?: boolean`; correct the stale "no plugins" comment)
  - `apps/web/src/AuthGate.tsx`, `apps/web/src/AccountMenu.tsx`, `apps/web/src/AppShell.tsx` (pass the session's admin flag to the menu)
  - `apps/web/src/routes/paths.ts` (`ACCOUNT_PASSWORD_ROUTE = '/account/password'`, `ADMIN_USERS_ROUTE = '/admin/users'`, `ADMIN_PROJECTS_ROUTE = '/admin/projects'`)
  - `apps/web/src/App.tsx`
- Test: `apps/web/test/ChoosePassword.test.tsx`, `PasswordChangeForm.test.tsx`, additions to `AuthGate.test.tsx`, `AccountMenu.test.tsx`, `paths.test.ts`

**Interfaces — Produces:**
- `PasswordChangeForm({ onDone }: { onDone: () => void })`:
  - fields `Current password`, `New password`, `Repeat new password`, all `autoComplete` set correctly;
  - submit `Change password` (primary);
  - a mismatch is refused client-side under the repeat field;
  - a `ProblemError` shows its detail and remediation in the `role="alert"` block `NewProject` uses.
- `AccountMenu({ identity, isAdmin }: { identity: string | null; isAdmin: boolean })`.

- [ ] **Step 1: Write the failing tests:**
  - `AuthGate`, given `user.mustChangePassword: true`: it renders the `Choose a new password` step and no outlet. It never fetches `/v1/activity`; assert the stub saw no such request. That probe would get the gate's 403 and land on the no-organisation page (Review Focus 1).
  - After a successful change it refetches the session and renders the outlet.
  - The step offers `Sign out`.
  - `AccountMenu`: `Change password` links to `/account/password` for everyone; `Administration` links to `/admin/users` only when `isAdmin`.
  - `PasswordChangeForm`: the mismatch case; the server's `INVALID_CURRENT_PASSWORD` shown as an alert; one primary button.
  - `paths.test.ts`: the three routes are declared in `App.tsx`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
  - `AuthGate` checks the flag after the session loads and before its probe; the probe is `enabled` only when the flag is false.
  - `ChoosePassword` uses the full-screen markup `Bootstrapping` and `NoOrg` share, with `<h1>` `Choose a new password`, focused on mount.
  - `AccountPassword` renders the form under `<h1>` `Change password` inside `AppShell`, and navigates home on success.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS with zero `Errors` lines.
- [ ] **Step 5: Commit.**

---

### Task 7: Web — Administration: Users list, Add user, Projects

**Files:**
- Create:
  - `apps/web/src/api/admin.ts`: `fetchAdminUsers`, `createUser`, `updateUser`, `resetUserPassword`, `removeUser`, `fetchAdminProjects`; query keys `adminUsersQueryKey = ['admin-users']`, `adminProjectsQueryKey = ['admin-projects']`.
  - `apps/web/src/api/members.ts`: `addMember`, `updateMember`, `removeMember`; the Task 8 edit panel uses them.
  - `apps/web/src/routes/AdminShell.tsx`: `<h1>` `Administration` and a two-tab strip `Users` / `Projects`, the `ProjectShell` pattern.
  - `apps/web/src/routes/AdminUsers.tsx`, `apps/web/src/routes/AdminProjects.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/AdminUsers.test.tsx`, `AdminProjects.test.tsx`

**Interfaces:**
- Consumes: Task 1's admin and members schemas; `ADMIN_USERS_ROUTE`, `ADMIN_PROJECTS_ROUTE` (Task 6).
- Produces: `AdminUsers` renders `UsersTable({ users, currentUserId })`. Task 8 adds the row menu to it.

Screens, copy as written here:
- **Users table** (`TableFrame name="Users"`):
  - columns `Name`, `Email`, `Projects`, `Status`;
  - an `Admin` badge after the name;
  - `Projects` shows a count, with the project names in an `InfoTip`;
  - `Status` is one of `Active`, `Disabled`, `Must change password`.
- **Add user:** a `<details>` "Add user" above the table, as `ProjectRules`' "New rule".
  - Fields: `Email`, `Name`, `Temporary password`, an `Admin` checkbox, and project rows each with `Project` (a select over the admin projects list) and `Role`, plus `Add project` and `Remove`.
  - Submit `Create user` (primary). It is validated with `CreateUserRequestSchema` before sending.
  - On success: invalidate `adminUsersQueryKey`, collapse the form, and show the new row.
- **Projects table:** `Name`, `Members`, and the existing New project form as a link (`NEW_PROJECT_ROUTE`) labelled `New project`.
- **Not an admin:** visiting either page shows the API's `ADMIN_REQUIRED` problem in an `ErrorState`.

- [ ] **Step 1: Write the failing tests:**
  - the table's rows and statuses from a fixture;
  - the Add user form posting the parsed body, with project rows and the Admin checkbox;
  - a `409 EMAIL_TAKEN` shown in the form's alert;
  - client-side refusal of a 7-character password;
  - the Projects page's counts and New project link;
  - an `ADMIN_REQUIRED` response rendering the `ErrorState`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 8: Web — the Users row menu

**Files:**
- Modify: `apps/web/src/routes/AdminUsers.tsx`
- Test: additions to `apps/web/test/AdminUsers.test.tsx`

**Interfaces:**
- Consumes: Task 7's `api/admin.ts` and `api/members.ts`.

Row menu (`DropdownMenu modal={false}`, trigger named `${name}: more actions`):
- **`Edit projects and roles`** opens an inline panel under the row, listing that user's memberships:
  - each with a `Role` select (saves with `updateMember`) and `Remove from project` (`removeMember`);
  - `Add to project` (project select, role select, `Add`, through `addMember`).
- **`Reset password`** arms an inline block: a `Temporary password` field and `Reset password`. A one-sentence line: `They must choose a new password at next sign-in, and are signed out everywhere.`
- **`Disable`** / **`Enable`**, and **`Make admin`** / **`Remove admin`**. Each is applied at once, except Disable, which is confirmed inline: `Disable ${name}? They are signed out everywhere.`
- **`Remove`**, confirmed inline: `Remove ${name}? Their run notes keep their text.`
- **The current user's own row** omits `Disable`, `Reset password` and `Remove`, which the API refuses for yourself.
- **`409 LAST_ADMIN`** shows its detail and remediation inline in that row.
- Only one row is armed at a time (the `confirming` state of `ProjectRules`).

- [ ] **Step 1: Write the failing tests:**
  - each item calls its API function with that row's id;
  - the own-row omissions;
  - `LAST_ADMIN` shown inline in the right row;
  - Remove needs its confirm;
  - the edit panel's role change and removal call the members API and refresh `adminUsersQueryKey`;
  - one armed row at a time;
  - the trigger names are unique per row.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 9: The browser journey, the docs, and the record

**Files:**
- Create: `apps/web/e2e/administration.spec.ts`
- Modify:
  - `DEPLOYMENT.md` ("Adding a teammate" now goes through Administration; bootstrap's flag rule)
  - `infra/README.md`
  - `docs/api.md` (the new routes; `PASSWORD_CHANGE_REQUIRED`, `LAST_ADMIN`, `EMAIL_TAKEN`)
  - `CLAUDE.md` (the entry and the floors)

- [ ] **Step 1: The e2e journey** (spec section 5). `seedAdmin` signs in, then:
  1. Under Administration › Users, create a person as Member of `checkout`, with a temporary password.
  2. Sign out. The person signs in, sees `Choose a new password` and nothing else, and changes it.
  3. They see only `checkout` in the rail.
  4. They upload the reference bundle through the project's Add results picker, and see it in the run list.
  5. The admin resets their password; the person's open page answers 401 on its next request.

  Assert the full-screen step by its heading and the absence of the rail.

  The spec's last clause, "a Viewer cannot edit rules", is PR 3's: it is about hiding controls by role, which this PR does not build. The API's refusal of a Viewer is already pinned by PR 1's matrix, and by Step 3 here.
- [ ] **Step 2: Predict the floors** from the source (unit from 220 / 3420, integration from 203 / 3058, e2e from 197), then run the gates in order, each exit code read from its own file:

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && PERFPORTAL_E2E_PORT=3700 pnpm test:e2e --workers=2
```

  Expected: every total equals the prediction.
- [ ] **Step 3: The real-run check.** Use a `pg_dump` copy of the developer database migrated with this branch, the API and worker from this checkout on a free port, a fresh Redis index and a scratch bucket. Through the real routes:
  1. An admin (a copied account, made reachable by a script-set password on the COPY only) creates a Member and a Viewer.
  2. Each signs in and is gated until they change their password.
  3. The Member uploads the Gatling reference bundle (895 requests). The Viewer reads it and is refused the upload with `ROLE_REQUIRED`.
  4. The admin disables the Viewer, whose cookie then answers 401.

  Drop the copy, the bucket and the Redis index afterwards, and stop the processes by PID.
- [ ] **Step 4: Write the docs and the CLAUDE.md entry:**
  - what the branch added and the measured floors;
  - the red-verifies;
  - the rulings;
  - KNOWN AND LEFT: the PR 3 items, and Better Auth's own `/auth/change-password` staying reachable (it changes a password without clearing the flag).
- [ ] **Step 5: Commit.**
