# Project access PR 3: the project experience — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everyone sees the project the way their role lets them use it: a Members section, controls hidden by role, a no-projects state, New project for admins only. Alongside that, every operation in the API document says which role it needs, and a session that ends mid-page goes to sign-in.

**Architecture:**
- **One rule, two sides.** `canPerform(action, { isAdmin, role })` and `accessRefusal(action)` move into `@perfportal/contracts` beside `ACCESS_ACTIONS`. The API's guard words its 403s with `accessRefusal`, and a parity test pins `canPerform` against the API's `accessDecision`.
- **Access on the web.** A hook `useProjectAccess(slug)` reads two cached queries, the session (admin flag) and `GET /v1/projects` (the caller's role per project). Every gated control asks it, and a gated control is hidden until access is known.
- **Session end.** A `QueryCache`/`MutationCache` handler turns any 401 into "no session", which `AuthGate` already answers with a redirect to sign-in.

**Tech Stack:**
- API: NestJS 11, zod contracts.
- Web: React 18, TanStack Query 5, Radix.
- Tests: Vitest 4 and Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-project-access-design.md`
- Section 4 ("Members", "Rail and Home", "Role-aware controls", New project admin-only) and section 6 item 3 are this PR.
- Two items deferred to PR 3 by the earlier PRs (CLAUDE.md, PR 1 and PR 2 entries) are in scope by the user's choice: role sentences per OpenAPI operation, and a 401 from any query ending the session.

## Global Constraints

- Node 22 (`.nvmrc`); in a worktree put `$HOME/.nvm/versions/node/v22.19.0/bin` first on PATH in every shell call. Integration and e2e run on the scratch database `perfportal_access` and Redis db 12, never `perfportal`; e2e on `PERFPORTAL_E2E_PORT=3700`.
- **The API is the authority; hiding is for clarity.** No server behaviour changes in this PR except:
  - the guard's 403 wording now comes from `accessRefusal` (byte-identical to today's);
  - the OpenAPI descriptions.
- **Admin first.** An admin may do everything, whatever `role` says. `GET /v1/projects` gives an admin their membership row's role, or `null`; read the role only for a non-admin.
- **Hidden until known.**
  - A control gated on access renders only when access is KNOWN and allows it. Known means the session has loaded, and for a non-admin, `GET /v1/projects` has data.
  - A "you cannot do this" state (`NoAccess`) renders only when access is known and refuses; never while pending.
- **Gate by destination.** A link whose page exists to take an action is drawn only when the reader may take it:
  - `projectSetupPath` → `run:upload`
  - `projectAccessPath` → `tokens:manage`
  - `projectNewRunnerRunPath` → `runner:run`
  - `NEW_PROJECT_ROUTE` → admin
  - `ADMIN_*` routes → admin (already true through the account menu)
- **Refusal copy is the API's own.**
  - Role: `${label} needs the ${Role} role in this project.` / `Ask an admin to change your role.`
  - Admin: `${label} needs an admin.` / `Ask an admin to do this.`
  - `label` is `ACCESS_ACTIONS[action].label`. Both sides build it with `accessRefusal`.
- **Role selectors are pick-then-Save (user decision).** The select only stages a choice. A `Save` button appears when the staged role differs from the current one. This applies to Members and to Administration's Edit projects and roles panel.
- **Own-row Remove admin is confirmed inline (user decision):**
  - question `Remove your admin rights? You lose Administration at once.`
  - confirm button `Remove admin`, plus `Cancel`
  - other rows stay one click
- **No-projects copy (spec):** `You're not on any project yet. Ask an admin to add you.`
- **Copy follows the clean-UI rule:**
  - labels are noun phrases;
  - no description line under a card or section title;
  - sentences only where the reader must act;
  - one `primary` button per screen;
  - destructive actions are confirmed inline in two steps, not in dialogs.
- **Accessible names stay unique.**
  - Repeated per-row controls carry a screen-reader qualifier (`RowField`'s pattern).
  - A display name shared by two rows adds the email (PR 2's W6 rule; Task 7 exports it as `nameWithEmailIfShared`).
  - The rail's vocabulary ("Home", "All runs", project names) is reserved.
- **Housekeeping.** Every 204 goes through `apiFetchNoContent`. Stage files by name, never `git add -A`. Commit messages explain WHY, with no attribution lines. No backticks inside SQL comments in template literals.

## Review Focus

1. **An admin with no membership row** (`role: null`), and an admin holding only a Viewer row, sees every control on every project page. Every existing e2e spec signs in as such an admin. Tests: Task 3 (hook), Tasks 8-10 (each page's admin case).
2. **Unknown is not refused.** While the session or `GET /v1/projects` is pending, or after `GET /v1/projects` failed with no data, no gated control shows and no `NoAccess` sentence shows. Test: Task 3.
3. **A role that changes under an open page** (an admin demotes the person) hides the control when `GET /v1/projects` next answers. A form already open answers with the API's own refusal inline, never silently. Tests: Tasks 3 and 8.
4. **A 401 from any query or mutation** sends the reader to sign-in once, keeping where they were (`?next=`). It never loops, and never fires for `/auth/*` errors. Test: Task 4.
5. **Two members with one display name**, or two projects with one name, never give two controls one accessible name on the Members page. Test: Task 7.

---

### Task 1: One access rule and one refusal sentence, in contracts

**Files:**
- Modify: `packages/contracts/src/access.ts`, `apps/api/src/auth/access.guard.ts`
- Test: `packages/contracts/test/access.test.ts`, `apps/api/test/access.test.ts`

**Interfaces — Produces:**
- `canPerform(action: AccessAction, who: { isAdmin: boolean; role: ProjectRole | null | undefined }): boolean`:
  - admin → true;
  - required `'admin'` → false;
  - `role` null or undefined → false;
  - otherwise `roleSatisfies(role, required)`.
- `accessRefusal(action: AccessAction): { code: 'ROLE_REQUIRED' | 'ADMIN_REQUIRED'; detail: string; remediation: string }`, with the exact strings in Global Constraints. The `Role` word is the role capitalised (`Member`, `Manager`, `Viewer`).

- [ ] **Step 1: Write the failing tests.**
  - Contracts:
    - `canPerform` over every action × `{admin, viewer, member, manager, null, undefined}`, with expectations computed from `ACCESS_ACTIONS` rows;
    - `accessRefusal('run:upload')` equals `{ code: 'ROLE_REQUIRED', detail: 'Uploading runs needs the Member role in this project.', remediation: 'Ask an admin to change your role.' }`;
    - `accessRefusal('projects:create')` equals `{ code: 'ADMIN_REQUIRED', detail: 'Creating projects needs an admin.', remediation: 'Ask an admin to do this.' }`.
  - API (`apps/api/test/access.test.ts`), "agrees with accessDecision": for every action and every `{isAdmin, role}`, `canPerform(...)` equals `accessDecision({ required: ACCESS_ACTIONS[a].role, isAdmin, role }) === 'allow'`. Treat `role` undefined as `null` on the API side.
- [ ] **Step 2: Run** `pnpm vitest run packages/contracts/test/access.test.ts apps/api/test/access.test.ts`. Expected: FAIL (`canPerform` and `accessRefusal` missing).
- [ ] **Step 3: Implement** both in `access.ts`. Then have `AccessGuard` throw `accessDenied(r.code, r.detail, r.remediation)` from `accessRefusal(action)` at both refusal sites (today :79 and :112-116), leaving its control flow alone. Rebuild contracts (`tsc -b packages/contracts`) and grep the emitted `dist` for `accessRefusal`.
- [ ] **Step 4: Run** the two files, plus `apps/api/test/access-routes.integration.test.ts` and `apps/api/test/password-gate.integration.test.ts`. They pin the wire wording, which must be unchanged. Expected: PASS.
- [ ] **Step 5: Red-verify.** Make `canPerform` ignore `isAdmin`: the parity case fails. Change one word of the role detail: the access-routes refusal rows fail. Restore from git after each.
- [ ] **Step 6: Commit.**

---

### Task 2: Every guarded operation says which role it needs

**Files:**
- Create: `apps/api/src/openapi/access-sentence.ts`
- Modify: `apps/api/src/openapi/document.ts`, `docs/api.md`
- Test: additions to `apps/api/test/access-routes.integration.test.ts`

**Interfaces:**
- Consumes: `ACCESS_ACTIONS` (contracts).
- Produces: `sessionAccessSentence(action: AccessAction): string`:
  - `'admin'` → `A signed-in session needs an admin account.`
  - `'viewer'` → `A signed-in session needs any role in this project, or an admin account.`
  - otherwise → `A signed-in session needs the ${Role} role or above in this project, or an admin account.`

- [ ] **Step 1: Write the failing test** in the existing describe "the document names the refusals the guard sends". For every walked route with `requires`, the matching operation's `description` starts with `sessionAccessSentence(route.requires)`, and contains it exactly once. The vacuity counter counts the routes FOUND with `requires` (more than 40), never the ones that match.
- [ ] **Step 2: Run it.** Expected: FAIL, naming every operation without the sentence.
- [ ] **Step 3: Implement.**
  - Each `@Requires` operation's description in `document.ts` begins `sessionAccessSentence('<action>') + ' ' + …`.
  - The eleven hand-written openers ("Requires a signed-in session whose account is an admin…", "…holding any role in the project, or an admin's…") are REPLACED by the generated sentence. Their bearer-token sentences stay.
  - `docs/api.md`'s role prose agrees.
- [ ] **Step 4: Run** `access-routes.integration.test.ts` and `openapi.integration.test.ts`. Expected: PASS.
- [ ] **Step 5: Red-verify.** Give one operation the wrong action's sentence (e.g. `rules:read` on `createRule`): the case fails naming it. Restore.
- [ ] **Step 6: Commit.**

---

### Task 3: The web asks one question — may I?

**Files:**
- Create:
  - `apps/web/src/access/useAccess.ts`
  - `apps/web/src/access/NoAccess.tsx`
  - `apps/web/test/support/access.ts`
- Test: `apps/web/test/useAccess.test.tsx`, `apps/web/test/NoAccess.test.tsx`

**Interfaces — Produces:**
- `useIsAdmin(): boolean | undefined` — `undefined` while the session is pending; reads `sessionQueryKey`/`getSession`.
- `useProjectAccess(slug: string | undefined): { readonly known: boolean; can(action: AccessAction): boolean }`:
  - `known` is true when the session has data and either the caller is an admin, or `projectsQueryKey` has data (data kept from a failed refetch counts);
  - `can` is `known && canPerform(action, { isAdmin, role })`, where `role` is the matching project's `role`, or `null` if the slug is absent;
  - `slug` undefined → `known` false.
- `useAdminAccess(): { readonly known: boolean; isAdmin: boolean }` for actions on no project (New project).
- `NoAccess({ action }: { action: AccessAction })`: the existing `ErrorState` look, with `accessRefusal(action)`'s detail as its message and the remediation under it. It renders a plain status, not `role="alert"`: it is the page's answer, not an interruption.
- Test support:
  - `seedAccess(client: QueryClient, who: { isAdmin: boolean; roles?: Record<string, ProjectRole> }): void` writes a session body (`user.role` `'admin'` or `'user'`, `mustChangePassword: false`) and a `GET /v1/projects` body (one item per `roles` entry, with that role, valid against `ProjectListResponseSchema`) into the cache;
  - it also sets `setQueryDefaults(key, { staleTime: Infinity })` on both keys, so no test refetches them.

- [ ] **Step 1: Write the failing tests.**
  - admin with `role: null` → every action allowed;
  - admin holding a `viewer` row → every action allowed;
  - member → `rules:edit` yes, `tokens:manage` no, `members:manage` no;
  - project absent → nothing;
  - session pending → `known` false and nothing allowed;
  - projects pending for a non-admin → `known` false;
  - projects refetch failed with data kept → still known;
  - a role changed in the cache (`setQueryData`) → `can` follows on the next render;
  - `NoAccess` shows the exact two sentences for `tokens:manage`, and has no `role="alert"`.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/test/useAccess.test.tsx apps/web/test/NoAccess.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** The hooks are `useQuery` calls on the existing keys and fetchers, so they share the cache with AppShell, AuthGate and the rail.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 4: A 401 from any request ends the session

**Files:**
- Create: `apps/web/src/queryClient.ts`
- Modify: `apps/web/src/main.tsx`
- Test: `apps/web/test/queryClient.test.tsx`

**Interfaces — Produces:** `createQueryClient(): QueryClient`. It keeps today's `retry: false` and adds `queryCache: new QueryCache({ onError })` and `mutationCache: new MutationCache({ onError })`. `onError` runs on a `ProblemError` with `status === 401` only, and does `client.setQueryData(sessionQueryKey, null)`. `AuthGate` already turns `session.data === null` into `<Navigate to={loginPathFor(intended)} replace />`, ahead of its latch. An `AuthError` from `/auth/*`, and every other status, are left alone.

- [ ] **Step 1: Write the failing tests.** Render `AuthGate` with a child page under `createQueryClient()`, then cover:
  - a child query rejecting `ProblemError(401)` → the route lands on `/login?next=<the page>`, and the child's query ran exactly once;
  - the same from a `useMutation` → `/login`;
  - a 403 → no redirect;
  - a `getSession` `AuthError` → untouched (AuthGate's outage page, as today);
  - a second 401 arriving after the redirect does not navigate again.
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Implement.** `main.tsx` uses `createQueryClient()`. The uploads are XHR (`BundleUpload`, package upload) and stay outside this handler; say so in the module docstring.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS with zero `Errors` lines.
- [ ] **Step 5: Red-verify.** Drop the `status === 401` check: the 403 case fails. Restore.
- [ ] **Step 6: Commit.**

---

### Task 5: The project shell — Members, and tabs by role

**Files:**
- Modify:
  - `apps/web/src/routes/ProjectShell.tsx`
  - `apps/web/src/routes/paths.ts` (`projectMembersPath(slug)` → `/projects/${encodeURIComponent(slug)}/members`)
  - `apps/web/src/palette/destinations.ts`, `apps/web/src/palette/usePaletteSearch.ts`
- Test: `apps/web/test/ProjectShell.test.tsx`, `apps/web/test/paletteDestinations.test.ts`, `apps/web/test/paths.test.ts`

**Interfaces:**
- Consumes: `useProjectAccess` (Task 3).
- Produces:
  - `ProjectSection` gains `'members'`.
  - `SECTIONS` order and visibility:

    | section | label | shown when |
    | --- | --- | --- |
    | tests | Tests | always |
    | runs | Runs | always |
    | packages | Packages | always |
    | setup | Add results | `can('run:upload')` |
    | rules | SLA rules | always |
    | members | Members | always |
    | access | API tokens | `can('tokens:manage')` |

  - Each row carries `requires?: AccessAction`.
  - `visibleSections(access): readonly Section[]` is exported and used by both the shell and the palette.
  - The header's `New on-prem run` is drawn only when `can('runner:run')`.

- [ ] **Step 1: Write the failing tests.**
  - admin: seven tabs in the order above;
  - viewer: five (no Add results, no API tokens), and no New on-prem run;
  - member: six (no API tokens);
  - manager: seven;
  - while pending: the five always-shown tabs, and no New on-prem run (this replaces today's "every section before the lookup settles" case);
  - the palette offers a project's pages filtered by the same rule, and its order still matches the shell's (the existing source-scan case is updated to read `requires`).
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
  - The tab links to `projectMembersPath`.
  - The route arrives in Task 7; until then the catch-all sends it home (as PR 2's Ruling 1).
  - `paths.test.ts` asserts `projectMembersPath`'s shape only.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 6: Role changes — pick, then Save; and a confirm before removing your own admin

**Files:**
- Modify: `apps/web/src/routes/AdminFields.tsx` (add `RoleChange`), `apps/web/src/routes/AdminUserActions.tsx`
- Test: `apps/web/test/AdminFields.test.tsx` (new), `apps/web/test/AdminUsers.test.tsx`

**Interfaces — Produces:** `RoleChange({ id, qualifier, current, pending, onSave }: { id: string; qualifier: string; current: ProjectRole; pending: boolean; onSave(role: ProjectRole): void })`.
- A `Role` select (accessible name `Role ${qualifier}`) staging a choice.
- A `Save` button (accessible name `Save role ${qualifier}`, variant `secondary`), present only while the staged role differs from `current`.
- The staged value resets to `current` when `current` changes.

- [ ] **Step 1: Write the failing tests.**
  - `RoleChange`:
    - changing the select calls nothing;
    - Save calls `onSave` once with the staged role;
    - no Save when staged equals current;
    - Save disabled while `pending`;
    - ArrowDown through three roles then Save sends ONE request.
  - AdminUsers panel:
    - a role change goes through Save, as one PATCH.
  - AdminUsers own row:
    - `Remove admin` arms `Remove your admin rights? You lose Administration at once.`;
    - nothing is sent before `Remove admin` is pressed;
    - `Cancel` closes it;
    - another admin's row still removes admin in one click.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
  - The panel's save-on-change select becomes `RoleChange`.
  - The own-row confirm joins the table's single armed-block state (PR 2's W15).
  - On success it keeps W17: everything is invalidated on your own admin change.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 7: The Members page

**Files:**
- Create: `apps/web/src/routes/ProjectMembers.tsx`
- Modify:
  - `apps/web/src/routes/AdminFields.tsx` and `apps/web/src/routes/AdminUsers.tsx` (the naming rule, below)
  - `apps/web/src/api/members.ts` (`projectMembersQueryKey = (slug: string) => ['project-members', slug] as const`; `fetchProjectMembers(slug): Promise<MemberListResponse>`)
  - `apps/web/src/App.tsx` (lazy route `/projects/:slug/members`)
- Test: `apps/web/test/ProjectMembers.test.tsx`, `apps/web/test/paths.test.ts` (the route is declared)

**Interfaces:**
- Consumes:
  - `useProjectAccess`, `useIsAdmin` (Task 3);
  - `RoleChange` (Task 6);
  - `addMember`, `updateMember`, `removeMember`;
  - `fetchAdminUsers`, `adminUsersQueryKey`, `adminProjectsQueryKey`;
  - `ROLE_LABEL` and `RowField` (AdminFields.tsx).
- Produces: PR 2's per-row naming rule is a closure today (`whoOf`, inside `UsersTable` in AdminUsers.tsx). Lift it into `AdminFields.tsx` as `nameWithEmailIfShared(person: { name: string; email: string }, everyone: readonly { name: string }[]): string`, and use it from both `UsersTable` and this page. Below, `who` means its result.

Screen, inside `ProjectShell current="members"`:
- **Table** (`TableFrame name="Members"`): `Name`, `Email`, `Role`, by name.
  - Everyone with `members:read` sees it read-only.
  - For an admin:
    - `Name` gains the `Admin` badge and a `Disabled` marker, joined from `fetchAdminUsers` on `userId === AdminUser.id`;
    - `Role` is `RoleChange` (qualifier `for ${who}`);
    - an `Actions` column holds `Remove from project` (qualifier `${who}`, one click, as in the Administration panel).
- **Add member** (admin only): a `<details>` "Add member" above the table, open when the list is empty.
  - `Person` select over admin users not already members, option text `${name} (${email})`, with ` — disabled` appended for a disabled account. It defaults to the first.
  - `Role` select, defaulting to Viewer.
  - `Add`, the page's one primary button.
  - The add control is disabled with the line `Everyone is already a member.` when no candidate is left.
- **Errors:** a refusal (`MEMBER_EXISTS`, `ADMIN_REQUIRED`, …) shows detail and remediation inline: in the form for Add, in the row for row actions.
- **Success invalidates:**
  - `projectMembersQueryKey(slug)`;
  - `adminUsersQueryKey` and `adminProjectsQueryKey`;
  - `projectsQueryKey`, when the person changed is the caller.
- **Empty list:** `EmptyState` "No members yet" (non-admins see only that).
- **States:**
  - loading follows the existing skeleton pattern;
  - a ProblemError from the list query renders `ErrorState` with its detail;
  - a failed refetch keeps the table (PR 2's W14).

- [ ] **Step 1: Write the failing tests.**
  - viewer: the table read-only, with no select, no Remove, no Add member;
  - admin: Add member posts `{ userId, role: 'viewer' }` to the right slug, and the list refetches;
  - a role change through Save sends one PATCH;
  - Remove from project sends one DELETE for that row's id;
  - `MEMBER_EXISTS` is shown in the form;
  - two members named "Sam Lee" get distinct control names (Review Focus 5);
  - a disabled admin user is marked in both the table and the picker;
  - the candidate list excludes current members.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 8: Hide what a role cannot do — rules, tests and tokens

**Files:**
- Modify:
  - `apps/web/src/routes/ProjectRules.tsx`
  - `apps/web/src/routes/TestRuns.tsx`
  - `apps/web/src/routes/ProjectAccess.tsx`
  - every caller of `projectAccessPath` (today `ProjectSetup.tsx` ×3, `RunTelemetry.tsx`)
- Test: the four components' test files

**Interfaces:** Consumes `useProjectAccess`, `NoAccess` (Task 3), and `seedAccess` in tests.

- **Rules:** with `can('rules:edit')` false, `ProjectRules` (both on the SLA rules page and on a test's page) draws:
  - no "New rule" disclosure;
  - no Enable/Disable;
  - no row menu;
  - no `Actions` column.

  The list stays.
- **Tests:** with `can('tests:manage')` false, `TestRuns` draws no `Rename` and no `Delete test`.
- **Tokens:**
  - with `can('tokens:manage')` false and access known, `ProjectAccess` renders `<NoAccess action="tokens:manage" />` and never fetches `GET …/tokens` (its query is `enabled` on the permission);
  - every link to `projectAccessPath` is drawn only with `can('tokens:manage')`.
- Existing cases in these files seed an admin (`seedAccess(client, { isAdmin: true })`) so their claims hold; new cases seed the roles.

- [ ] **Step 1: Write the failing tests.**
  - a viewer sees the rules table without its controls, and a member sees them;
  - a member on a test's page sees no Rename or Delete test, and a manager sees both;
  - a member on API tokens sees `Managing API tokens needs the Manager role in this project.`, and the stub saw no `GET …/tokens`;
  - a viewer on Add results sees none of the three token links;
  - the role-changed case: rules controls vanish when the cached role drops to viewer;
  - pending access shows no controls and no `NoAccess` (Review Focus 2).
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 9: Hide what a role cannot do — upload, runner, packages and notes

**Files:**
- Modify:
  - `apps/web/src/routes/ProjectSetup.tsx`
  - `apps/web/src/routes/NewRunnerRun.tsx`
  - `apps/web/src/routes/ProjectPackages.tsx`
  - `apps/web/src/routes/RunShell.tsx` and `apps/web/src/routes/RunNote.tsx`
  - every caller of `projectSetupPath` and `projectNewRunnerRunPath` (find them with grep; today they include `ProjectTests.tsx`, `ProjectRuns.tsx`, `home/AttentionCard.tsx`, `ProjectPackages.tsx`)
- Test: the components' test files

- **Upload.** On Add results:
  - the Import results card's upload is drawn only with `can('run:upload')`;
  - the Run a test card's New on-prem run only with `can('runner:run')`;
  - a reader with neither (a viewer reaching the URL) sees `<NoAccess action="run:upload" />` in place of the cards.
- **Runner.** `NewRunnerRun`:
  - with `can('runner:run')` false and access known, the form is replaced by `<NoAccess action="runner:run" />`;
  - the jobs list stays, with Logs, but without Cancel or Retry.
- **Packages.** In `ProjectPackages`:
  - `New package`, `Upload` and `Rename` need `packages:manage`;
  - `Delete` needs `packages:delete`;
  - `New run from this package` needs `runner:run`;
  - a row menu with no item left is not drawn.
- **Notes.**
  - `RunShell` passes `canEdit={access.can('run:note')}` to `RunNote`, with access from `useProjectAccess(identity.project?.slug)`;
  - with `canEdit` false, `RunNote` shows an existing note read-only and no Add a note, Edit note or Remove note.
- **Links.** Every link to `projectSetupPath` or `projectNewRunnerRunPath` follows Gate by destination.

- [ ] **Step 1: Write the failing tests.**
  - for each control above, a viewer sees it absent, and a member (or the action's lowest role) sees it present;
  - NewRunnerRun for a viewer shows the NoAccess sentence and still lists jobs with Logs;
  - a run whose identity has no `project` shows a note read-only;
  - pending access hides every one of them.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 10: The no-projects state, and New project for admins only

**Files:**
- Modify:
  - `apps/web/src/ProjectRail.tsx`
  - `apps/web/src/routes/Home.tsx`, `apps/web/src/home/AttentionCard.tsx`
  - `apps/web/src/routes/RunList.tsx`
  - `apps/web/src/palette/destinations.ts`
  - `apps/web/src/routes/NewProject.tsx`
- Test: `ProjectRail.test.tsx`, `Home.test.tsx`, `AttentionCard.test.tsx`, `RunList.test.tsx`, `paletteDestinations.test.ts`, `NewProject.test.tsx`

- **Rail.** When projects loaded empty:
  - a non-admin reads `You're not on any project yet. Ask an admin to add you.`;
  - an admin keeps `No projects yet.`
- **Home.** A non-admin whose `GET /v1/projects` is empty sees the greeting and one `EmptyState`: title `You're not on any project yet`, body `Ask an admin to add you.` There is no glance, attention, running, runs-by-project or tests card. An admin's empty org is unchanged.
- **New project, admin only.**
  - `RunList`'s heading link, `AttentionCard`'s Empty link and the palette's `go:new-project` are drawn only for an admin.
  - `NewProject` for a known non-admin renders `<NoAccess action="projects:create" />` in place of the form.

- [ ] **Step 1: Write the failing tests.**
  - the rail's two empty sentences by admin flag;
  - Home's no-projects page for a member with zero projects, and the admin's unchanged Empty with New project;
  - no New project link for a non-admin in RunList, AttentionCard and the palette;
  - NewProject's NoAccess for a member, and the form for an admin;
  - pending admin flag shows neither.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 11: The browser journeys, the docs, and the record

**Files:**
- Create: `apps/web/e2e/project-roles.spec.ts`
- Modify:
  - `apps/web/e2e/fixtures.ts` (`seedProjectMember(orgId, projectId, role): Promise<{ email, password }>`, a non-admin account in the org with that role)
  - `apps/web/e2e/administration.spec.ts` (its last step now expects `/login`, Task 4)
  - `apps/web/e2e/project-shell.spec.ts` (seven sections for an admin)
  - `DEPLOYMENT.md` and `docs/api.md` (roles in the UI; the 401 redirect)
  - `CLAUDE.md` (the entry and the floors)

- [ ] **Step 1: The e2e journeys** (each role a fresh account; `exact: true` on overlapping names):
  1. **Viewer** of `checkout`:
     - Tests, Runs, Packages, SLA rules and Members only;
     - no Add rule, no New on-prem run, no package actions;
     - on a run, no Add a note;
     - `/projects/checkout/access` shows the NoAccess sentence.
  2. **Member:** Add results and New on-prem run are present; no API tokens tab; no Rename or Delete test on a test's page.
  3. **Manager:** API tokens present.
  4. **A person in no project:** the rail and Home read the no-projects sentence; no New project link.
  5. **Admin on Members:** adds the Viewer as Member through Save; the Viewer's next page load shows Add results.
- [ ] **Step 2: Predict the floors** from the source (unit from 231 / 3601, integration from 215 / 3261, e2e from 198). Then run the gates in order, each exit code read from its own file:

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && PERFPORTAL_E2E_PORT=3700 pnpm test:e2e --workers=2
```

  Expected: every total equals the prediction. Then dispatch `gh workflow run ci.yml --ref <branch>` for the three-engine run before the PR.
- [ ] **Step 3: The real-run check.**
  - Setup:
    - a `pg_dump` copy of the developer database, migrated;
    - the API and worker from this checkout on a free port, with Redis db 2 and a scratch bucket;
    - an admin made reachable by a script-set password on the COPY only.
  - Through the admin routes, create a Viewer, a Member and a Manager of one project.
  - A throwaway Playwright script (not committed) signs in as each and records which controls each project page draws; compare with the table in Tasks 5, 8 and 9.
  - Cleanup: drop the copy, the bucket and the Redis index; stop the processes by PID.
- [ ] **Step 4: Write the docs and the CLAUDE.md entry:**
  - what the branch added, and the measured floors;
  - the red-verifies;
  - the rulings;
  - KNOWN AND LEFT: anything deferred, including the XHR uploads outside the 401 handler, and any control found without a gate.
- [ ] **Step 5: Commit.**
