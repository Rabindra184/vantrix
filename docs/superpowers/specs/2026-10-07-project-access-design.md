# Project access: admins, project members and roles — design

2026-10-07. Today every signed-in person can see and change every project.
`org_member.role` is written (always `'admin'`) and never read, there is no
way to add a teammate except the bootstrap CLI, there is no password reset,
and Better Auth's `/auth/sign-up/email` is open to anyone who can reach the
instance. This is gap 01 of the roadmap: the first wall any team evaluating
PerfPortal hits.

Decisions settled in brainstorming:

1. **Access attaches to the project.** A project is the team, as in
   ReportPortal. No separate team object; groups can come later purely as a
   way to assign many people at once.
2. **Three project roles: Manager, Member, Viewer.** Plus the install-wide
   **admin**.
3. **Only an admin creates accounts**, typing a temporary password the person
   must change at first sign-in. No invite links and no email.
4. **Only an admin manages membership**, for every project. A Manager runs
   their project but does not add or remove people.
5. **Approach A.** Better Auth's admin plugin handles the account lifecycle,
   called server-side from PerfPortal's own `/v1/admin` routes. PerfPortal's
   own `project_member` table and one permission guard handle access.
6. **Admins see every project** without being a member of it.
7. **Upgrading keeps everyone's access**: every existing member becomes an
   admin.
8. **Three PRs**: enforcement first with no visible change, then the
   Administration pages and account flows, then the Members section and
   role-aware controls.

## How comparable tools do it

Measured from each product's documentation, 2026-10-07.

| tool | who creates projects | unit of access | roles |
| --- | --- | --- | --- |
| ReportPortal | instance Administrator only | the project | instance: Administrator, regular user. Per project: Project Manager, Member, Operator, Customer. A Project Manager manages members up to their own role. Administrators see every project, assigned or not. New users join by an emailed invite link valid 24 h, or are assigned if they already exist. |
| Gatling Enterprise | Leader and above | the team (owns packages, simulations, tokens, reports) | organisation: Administrator, Leader, Tester, Contributor, Viewer; the same five scoped to one team |
| SonarQube | holders of the global "Create Projects" permission | the project, with groups and permission templates | global permissions plus per-project permissions |

PerfPortal takes ReportPortal's shape (instance admin, project = team,
admins see everything) with fewer roles, and departs from it on joining (an
admin-set password rather than an emailed invite) and on who manages members
(admins only).

## Scope

**In:** the admin flag; project membership with three roles; one permission
table enforced on every session route; filtering every org-wide list to the
caller's projects; admin account management (create with a typed password,
reset password, disable, enable, remove, make or remove admin); a forced
password change; closing open sign-up; the Administration pages; a Members
section per project; role-aware controls; the upgrade migration.

**Out, each its own later piece:** SSO (OIDC, SAML), SMTP and emailed
invites or resets, an audit log (the `/v1/admin` routes are designed as its
single recording point), teams or groups, project rename and delete, a
project settings page, impersonation, per-user API tokens.

## 1. Model

### Who is an admin

Better Auth's admin plugin adds `role` to `user`. **`user.role = 'admin'` is
the one admin flag**; every other account is `'user'`. There can be several
admins. **The last active admin cannot be demoted, disabled or removed**
(`409 LAST_ADMIN`), so an install cannot lock itself out.

`org_member` stays: an install has one org, and the row is what says "this
person belongs to this install" (a user with none still sees the existing
no-organisation page). Its `role` column, never read, is **dropped**, so the
admin flag lives in one place.

### Project membership

```
project_member
  project_id  uuid  → project.id   ON DELETE CASCADE
  user_id     text  → user.id      ON DELETE CASCADE
  role        text  CHECK (role IN ('manager','member','viewer'))
  created_at  timestamptz  DEFAULT now()
  added_by    text  → user.id      ON DELETE SET NULL
  PRIMARY KEY (project_id, user_id)
  INDEX (user_id)
```

An admin has access to every project and needs no row. An admin who also has
a row keeps admin rights; the row matters only if they are later demoted.

### Account flags

- `user."mustChangePassword" boolean NOT NULL DEFAULT false`, a Better Auth
  additional field not settable through its public endpoints. Camel-cased
  like every other column of Better Auth's `user` table. It arrives in PR 2
  with the gate that reads it, never as a column nothing reads.
- `user.banned`, `ban_reason`, `ban_expires` and `session.impersonated_by`:
  the admin plugin's own columns. `banned` is "disabled".

### Upgrade migration

Every `org_member` row is `'admin'` today (bootstrap and the fixtures both
write it), so every user with a membership gets `user.role = 'admin'`.
Nobody loses access; `project_member` starts empty; the admin demotes and
assigns people afterwards. Users with no `org_member` row get `'user'`.

## 2. Permissions

### The table

One table in `packages/contracts` maps each action to its lowest project role
**and** to the token scope a bearer credential needs for it, so the two
credential types cannot drift apart:

| action | lowest role | token scope | routes |
| --- | --- | --- | --- |
| `project:read` | viewer | `read` | `GET /v1/runs/:id` and every `GET` under it; every `GET` under `/v1/projects/:slug/` not listed in another row |
| `rules:read` | viewer | (session only) | `GET …/rules` |
| `members:read` | viewer | (session only) | `GET …/members` |
| `run:note` | member | (session only) | `PUT /v1/runs/:id/note` |
| `run:upload` | member | `ingest` | `POST /v1/projects/:slug/runs` (session); bearer keeps `POST /v1/runs` |
| `runner:run` | member | `runner` | `POST …/runner/runs`, `…/cancel`, `…/retry` |
| `packages:manage` | member | `runner` | `POST`, `PUT …/content`, `PATCH` on packages |
| `packages:delete` | member | (session only, as today) | `DELETE` on packages |
| `rules:edit` | member | (session only) | `POST`, `PATCH`, `DELETE` on rules |
| `tests:manage` | manager | (session only) | `PATCH`, `DELETE …/tests/:testSlug` |
| `tokens:manage` | manager | (session only) | `GET`, `POST`, `DELETE …/tokens` |
| `members:manage` | admin | (session only) | `POST`, `PATCH`, `DELETE …/members` |
| `projects:create` | admin | (session only) | `POST /v1/projects` |
| `users:manage` | admin | (session only) | everything under `/v1/admin` |

Routes that are not per project (`GET /v1/projects`, `GET /v1/runs`,
`GET /v1/tests`, `GET /v1/activity`) take no action. They are filtered
(below).

Bearer-only routes (`POST /v1/runs`, `POST /v1/runs/live`,
`…/stream`, `…/close`, `POST /v1/telemetry`) keep their scope check and are
marked `@BearerOnly`. A session cannot reach them today (`PROJECT_REQUIRED`)
and still cannot, so they take no role.

### The guard

- Every session-reachable route declares its action with
  `@Requires('<action>')`. The existing `AuthGuard` and `@Scopes` are folded
  into it: for a bearer credential the guard checks the table's token scope,
  exactly as `@Scopes` does today; for a session it checks the role.
- The project comes from `:slug`, or from the run for `/v1/runs/:id` routes,
  resolved by the same queries that already enforce org isolation.
- **A test walks every registered route** through Nest's metadata (the
  mechanism `openapi.integration.test.ts` already uses) and fails any route
  carrying none of `@Requires`, `@BearerOnly`, `@NotProjectScoped` or
  `@Public` (the health probes). A route cannot ship unprotected.
- Admins pass every role check.

### Answers

- A project the caller is not a member of: **404**, the same answer another
  org's project gets today, so existence is not revealed.
- A visible project where the role is too low: **403 `ROLE_REQUIRED`**, its
  detail naming the role needed ("Editing SLA rules needs the Member role in
  this project.") and its remediation "Ask an admin to change your role."
- An admin-only action by a non-admin: **403 `ADMIN_REQUIRED`**.

### Filtered lists

The auth middleware computes, once per request, the caller's visible
projects: `'all'` for an admin, otherwise the set from `project_member`, plus
a `Map<projectId, role>`. Every org-wide query applies the visible set
through the existing tenant filter, so no endpoint carries its own copy:
`GET /v1/projects`, `GET /v1/runs`, `GET /v1/tests`, `GET /v1/activity` (and
so Home, All runs, the tests catalogue, ⌘K and the rail).

Roles are read on every request and never cached in the session, so removing
someone takes effect on their next request.

`GET /v1/projects` gains `role: 'manager' | 'member' | 'viewer' | null` per
project (`null` for an admin with no row), so the UI can show and hide
controls. The UI checks the admin flag first: an admin's own row never
limits what they see. `.nullable().optional()`, for the rolling-deploy reason the
contracts package already records.

### API tokens

Unchanged: project-scoped, with their own scopes. Creating, listing and
revoking them needs Manager. A token belongs to the project, not to the
person who created it, so removing that person does not revoke CI's token.

## 3. Account flows

All admin operations go through `/v1/admin`, which calls Better Auth's admin
plugin server-side with the admin's own request headers, keeping `/v1`'s
problem+json errors, its OpenAPI entries, and one place a future audit log
records from. **Better Auth's own `/auth/admin/*` routes are refused (404)**
by a middleware mounted ahead of the Better Auth handler.

| route | does |
| --- | --- |
| `GET /v1/admin/users` | every account in the install: name, email, admin, disabled, must change password, project count |
| `POST /v1/admin/users` | create: email, name, temporary password, admin, and `[{ projectSlug, role }]` |
| `PATCH /v1/admin/users/:id` | name, admin on or off, disabled on or off |
| `PUT /v1/admin/users/:id/password` | reset to a typed temporary password |
| `DELETE /v1/admin/users/:id` | remove |
| `GET /v1/projects/:slug/members` | the project's members and roles (Viewer and above) |
| `POST /v1/projects/:slug/members` | add an existing user with a role (admin) |
| `PATCH /v1/projects/:slug/members/:userId` | change role (admin) |
| `DELETE /v1/projects/:slug/members/:userId` | remove from project (admin) |
| `PUT /v1/me/password` | change your own password; clears the flag |

- **Create:** creates the account, links it to the install, adds the
  memberships and sets `must_change_password`. If a later step fails, the
  half-created account is removed, so a retry with the same email works.
  An email already in use answers `409 EMAIL_TAKEN`. The password follows
  Better Auth's rules (8 to 128 characters).
- **First sign-in:** until the password is changed, every `/v1` route
  answers **403 `PASSWORD_CHANGE_REQUIRED`** except `PUT /v1/me/password`
  and reading the session. The web app shows a full-screen "Choose a new
  password" step and nothing else. The new password must differ from the
  current one.
- **Reset:** sets a typed temporary password, sets the flag again, and ends
  all that person's sessions.
- **Disable / enable:** disable refuses sign-in and ends existing sessions;
  enable reverses it.
- **Remove:** deletes the account and its memberships. Run notes they wrote
  keep their text and lose the name (`run.note_updated_by` is already
  `ON DELETE SET NULL`).
- **Make / remove admin:** guarded by the last-admin rule.
- **Own password:** `PUT /v1/me/password`, used by the existing account menu
  and by the first-sign-in step.
- **Sign-up closed:** `emailAndPassword.disableSignUp: true`. Bootstrap, the
  e2e fixtures and the integration session helper create accounts through
  the admin plugin's server-side create call instead.

## 4. Screens

Copy follows the clean-UI text rule (`2026-10-04-clean-ui-design.md`).

- **Administration** (admins only; account menu → Administration):
  - **Users:** table of name, email, Admin badge, projects, status (Active,
    Disabled, Must change password). **Add user**: email, name, temporary
    password, Admin switch, project and role rows. Row menu: Edit projects
    and roles, Reset password, Disable / Enable, Make admin / Remove admin,
    Remove.
  - **Projects:** every project with its member count, and **New project**
    (the existing form, now admin-only).
- **Members**, a new section in the project shell beside Runs, Packages,
  SLA rules and API tokens: name, email, role. Everyone in the project sees
  it; only admins see Add member, the role selector and Remove.
- **Rail and Home:** only the caller's projects. A person with no projects
  sees "You're not on any project yet. Ask an admin to add you."
- **Role-aware controls:** a Viewer sees no Add rule, upload, New on-prem
  run, package actions or note editing; a Member sees no API tokens or
  rename / delete test. The API is the authority; hiding is for clarity.
- **Choose a new password:** full screen, at first sign-in and after a
  reset.

## 5. Testing

- **Unit:** the permission table (every action has a role and a scope
  entry); the guard's decisions; each screen hiding controls by role.
- **Integration, real API:**
  - A role × action matrix generated from the permission table: for each
    action, the lowest role passes and the role below is refused.
  - The route-walk guard: an undeclared session route fails, red-verified by
    deleting one `@Requires`.
  - Visibility in every filtered list for a member of one project of two.
  - 404 for a project you're not in, 403 `ROLE_REQUIRED` for too low a role.
  - The password-change gate, last-admin protection, sign-up closed,
    `/auth/admin/*` refused, create's compensation on failure.
  - The upgrade migration on a database holding pre-migration rows.
- **e2e:** an admin creates a person as Member of one project; that person
  signs in, is forced to change the password, sees only that project, and
  uploads a run; a Viewer cannot edit rules.
- **Real-run check:** a Member uploads a real Gatling bundle and a Viewer
  reads it.
- **Fixtures:** every helper that signs a user up moves to the admin create
  call; sessions made by the helpers are admins unless a test asks for a
  role, so existing tests keep their meaning.

## 6. Build order

1. **PR 1, enforcement:** schema and migration, Better Auth admin plugin,
   sign-up closed and `/auth/admin/*` refused, bootstrap and fixtures moved,
   the permission table, the guard and its route walk, list filtering,
   `role` on `GET /v1/projects`, the live feed's membership check. Everyone
   is an admin after the migration, so nothing changes on screen.
2. **PR 2, administration:** the `/v1/admin` and `/members` routes, the
   Administration pages, the password-change gate together with
   `PUT /v1/me/password` and the first-sign-in step. The gate waits for its
   route: its remediation names `PUT /v1/me/password`, and a remediation
   naming a route that does not exist yet is the defect the
   remediations-name-a-real-lever branch removed.
3. **PR 3, project experience:** the Members section, role-aware controls,
   the no-projects state, New project admin-only in the UI.

## Open points for the plan

- **Settled while planning: Better Auth 1.6.26's server-side create call
  needs no session.** Its `/admin/create-user` handler throws `UNAUTHORIZED`
  only when there is no session AND the call carries a request or headers
  (`plugins/admin/routes.mjs`), so `auth.api.createUser({ body })` from a
  script creates the first admin with nobody signed in.
- **The WebSocket live feed authenticates on its own.** An upgrade never
  passes through Nest's guards, so `LiveGateway` gets the same membership
  check as the guard, or it would be a way around it.
- **Confirm the admin plugin's columns** against `prisma migrate diff`, so
  `schema.prisma` and the migration agree (the schema-matches-migrations
  guard enforces it).
- **Confirm `must_change_password` reaches `/auth/get-session`** as an
  additional field the web app can read, or expose it on a small
  `GET /v1/me`.
