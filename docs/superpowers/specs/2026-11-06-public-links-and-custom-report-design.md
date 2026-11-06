# Public links and custom report — design

Gaps #6 (public links) and #3 (custom report and PDF export) of
`docs/superpowers/research/2026-11-03-ge-page-parity/README.md`, whose
"Suggested order" calls them the sharing story: a link for someone without an
account, and a PDF for a review. This is one design for both. **Public links are
built first and are specified in full (sections 2–8). The custom report is
specified to the level that fixes its shape and what it reuses (section 9), and
gets its own plan later.**

Agreed with the user on 2026-11-06:

- The org-level switch starts **off** on new and upgraded installs, as the AI
  switch does. An admin turns it on in Administration › Settings.
- Turning the switch off **suspends** every link. Turning it back on restores
  the links that have not expired or been revoked. Revoking one link is how a
  leak is stopped.
- A project **Member creates** links, and **any Member revokes** any link on the
  project. Admins can do both.
- A link's URL is **shown once**, at creation. The database keeps only a SHA-256
  hash of its secret.
- Approach: **a link is a credential over the existing read API**, pinned to its
  run, with an allowlist marker on the routes it may read. The public page mounts
  the existing run shell and tabs.

## 1. What Gatling Enterprise does, and what this adds

From `page-notes.md`, "Public link":

- A run's ⋮ menu offers *Share public link*. The dialog offers an expiry of 1
  week, 2 weeks, 1 month, 6 months, 1 year, 2 years or Custom, says "Public link
  will expire on …", and generates
  `/o/<org>/public/<token>/simulations/<test>/runs/<run>`.
- The public page shows the logo and a Help center link, with no navigation.
  It has Summary, Report and Logs, the run facts, the lifecycle strip, the tiles,
  the assertions bar and the charts. It has no AI analysis card, no Compare, no
  ⋮ menu and no edit controls.
- An org setting, *Features management › Public links*, turns the feature on or
  off.
- **No revoke control exists.** A link lives until it expires. This design adds
  one.

## 2. One design for sharing

Three ideas carry both features:

1. **A public link grants reading of a fixed set of runs.** For a run link the
   set is that one run. For a shared custom report (section 9.5) it is the runs
   the report's blocks name. The access model is written against the set from the
   start (`runIds`), so the second target is a new row shape and not a new guard.
2. **One presentation context decides how a run renders.** `app` is the signed-in
   page as it is today. `public` is the read-only page behind a link. `print` is
   the custom report's printable view (section 9). The context decides where links
   go (or that they are plain text), which panels render, and what the permissions
   are. Components ask it rather than calling the global path helpers.
3. **PDF is the browser's own print.** The custom report renders a print-styled,
   read-only view and the reader saves it as PDF from the print dialog, as
   Gatling Enterprise's *Preview & Print to PDF* does. Nothing renders a PDF on
   the server, so the image gains no headless browser.

## 3. Data

### 3.1 `run_public_link`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | `gen_random_uuid()` |
| `org_id` | `uuid` | FK `org(id) ON DELETE CASCADE` |
| `project_id` | `uuid` | FK `project(id) ON DELETE CASCADE` |
| `run_id` | `uuid` | FK `run(id) ON DELETE CASCADE` |
| `token_hash` | `text` UNIQUE | lowercase hex SHA-256 of the secret |
| `created_by` | `text` NULL | FK `"user"(id) ON DELETE SET NULL` |
| `created_at` | `timestamptz(3)` | `now()` |
| `expires_at` | `timestamptz(3)` NOT NULL | every link expires |
| `revoked_at` | `timestamptz(3)` NULL | set by revoke and never cleared |
| `revoked_by` | `text` NULL | FK `"user"(id) ON DELETE SET NULL` |
| `last_used_at` | `timestamptz(3)` NULL | touched at most once a minute |

- An index on `(run_id, created_at DESC)` serves the run's list.
- `org_id` and `project_id` are denormalised from the run, as `api_token` and the
  metrics tables do, so the credential lookup answers the tenant in one row.
- Rows are never deleted by the product. Expired and revoked links stay listed,
  so a reader can see what was shared and when it stopped.
- Every instant is `timestamptz` (CLAUDE.md, "An instant column must be
  `timestamptz`").

### 3.2 `org.public_links_enabled`

`boolean NOT NULL DEFAULT false`, beside `ai_enabled`. `OrgSettingsRepository`
gains `publicLinksEnabled` and `setPublicLinksEnabled`.

### 3.3 The secret

- `ppl_` followed by 43 base64url characters: 32 random bytes from
  `crypto.randomBytes`.
- Stored as SHA-256, **not Argon2** as API tokens are. The secret carries 256 bits
  of entropy, so a slow hash adds nothing against guessing. And a link is checked
  on every request the page makes, about twenty when a Report opens, so Argon2
  would cost real time per page.
- It is looked up by its hash through the unique index, so there is no prefix
  split and no comparison loop.
- It is returned once, in the create response, and is never readable again.
- The web builds the URL as `${location.origin}/share/<secret>`.

## 4. API

### 4.1 Managing links (signed-in)

A new access action: `'run:share': { role: 'member', scope: null, label: 'Sharing
runs by public link' }`. `scope: null` makes it session-only, so every route below
carries `SessionOnlyGuard`.

| Route | Answer |
| --- | --- |
| `POST /v1/runs/:id/public-links` `{ expiresAt }` | 201 `{ link, secret }` |
| `GET /v1/runs/:id/public-links` | 200 `{ enabled, items }`, newest first |
| `DELETE /v1/runs/:id/public-links/:linkId` | 204 |

`PublicLink` in `@perfportal/contracts`:

```ts
{
  id: string;                 // uuid
  state: 'active' | 'expired' | 'revoked';
  createdAt: string;
  createdBy: { name: string } | null;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: { name: string } | null;
  lastUsedAt: string | null;
}
```

- `state` is derived when the link is read: revoked beats expired, because the
  two have different causes (the token-status rule in `tokenStatus`).
- `enabled` on the list is the org switch, so a Member's dialog can say an admin
  has turned public links off without the Member being able to read
  `/v1/admin/settings`.

**Create refuses:**

| Condition | Status | Code |
| --- | --- | --- |
| switch off | 403 | `PUBLIC_LINKS_DISABLED`, remediation: ask an admin to turn on public links in Administration › Settings |
| run not `complete` or `incomplete` | 409 | `RUN_NOT_SHAREABLE`, detail: only a finished run can be shared |
| `expiresAt` not after now plus one minute | 400 | `INVALID_PUBLIC_LINK` |
| `expiresAt` more than 732 days ahead | 400 | `INVALID_PUBLIC_LINK` |

- **Run status.** A `failed` run is refused because `GET /v1/runs/:id` answers it
  with its ingest problem: it has no Summary to share. A run still pending,
  parsing or running is refused because its page is live, and the live socket is
  session-only (section 5.5).
- **Expiry window.** 732 days is two years, plus a leap day, plus a day of clock
  slack between the browser that computed the preset and the server. Every link
  expires; there is no "never".

**Revoke:**

- Revoking a link that is already revoked answers 204 and changes nothing.
- A `linkId` that is not one of that run's links answers 404.
- Any Member may revoke any link on the project, with no creator check.

### 4.2 The org switch

- `OrgSettingsSchema` gains `publicLinksEnabled: boolean`.
- `UpdateOrgSettingsRequestSchema` stays `.strict()`. Both fields become optional,
  and a refinement requires at least one. A browser built before this change keeps
  sending `{ aiEnabled }` alone through a rolling deploy, and it still works.
- The switch takes effect on the next request, because the credential check reads
  it every time (section 5.1).

### 4.3 Reading through a link

The public page sends **`Authorization: PublicLink <secret>`** on every request,
with `credentials: 'omit'`. It never sends a cookie. A signed-in sharer who opens
their own link therefore sees exactly what a stranger sees.

`GET /v1/public-link` answers 200 `{ runId, expiresAt }`. It is the page's first
call, because the URL carries only the secret.

## 5. Access model

### 5.1 The middleware

`AuthMiddleware` gains a third branch, ahead of the bearer and session branches:
a `PublicLink` authorization scheme. It runs one query that joins the link, its
org's switch, and its run's existence.

The credential is refused with 401, with one code per cause:

| Case | Code |
| --- | --- |
| malformed secret, or no matching hash | `LINK_NOT_FOUND` |
| `revoked_at` set | `LINK_REVOKED` |
| org switch off | `PUBLIC_LINKS_DISABLED` |
| `expires_at` passed | `LINK_EXPIRED` |

- **The order is revoked, then disabled, then expired.** A revoked link never
  comes back, so that is the truest statement about it. A disabled link may come
  back, which matters more to its reader than the date it expires.
- **Each detail says what happened** ("This link expired on …"). A link's secret
  is unguessable, so whoever holds one was given it, and distinguishing the four
  cases leaks nothing a stranger could use.

On success the tenant is:

```ts
{
  orgId, projectId,
  tokenId: `link:${linkId}`,
  scopes: [],
  publicLink: { linkId, runIds: [runId] },
}
```

- Its `tokenId` has no `session:` prefix, so `SessionOnlyGuard` refuses it on
  every route that guard carries, which is every write.
- `last_used_at` is touched with the same once-a-minute throttle as API tokens
  (`TOKEN_TOUCH_INTERVAL_MS`). A failure to touch is swallowed.
- Nothing is cached between requests, so a revoke, an expiry and the switch all
  take effect on the next request.

### 5.2 Guards

- **`AuthGuard`:** a link tenant skips the `@Scopes` check. Scopes describe what a
  token minted for a project may do; they are not this credential's model.
- **`AccessGuard`:** a link tenant is decided first, and the decision is
  default-deny. The request is allowed only when the handler carries
  `@LinkReadable` **and** the route's `:id` is in `publicLink.runIds`. Every other
  case answers the same 404 `runNotFound` that an invisible run gets.
  - That includes a non-UUID id, an unlisted route, and another run in the same
    project.
  - No route is "not found" for one reason and "forbidden" for another, so a link
    cannot be used to map the API.
- **`PasswordChangeGuard`:** unchanged. A link tenant has no `mustChangePassword`.

### 5.3 The allowlist

`@LinkReadable()` is a new decorator. It is additive: it sits beside
`@Requires('project:read')` and does not replace it. It goes on exactly these 15
GET routes:

| Route | Read by |
| --- | --- |
| `/v1/runs/:id` | the shell |
| `/v1/runs/:id/verification` | the shell's verification mark |
| `/v1/runs/:id/users` | the time brush, Summary, Report |
| `/v1/runs/:id/stats` | Summary, Report |
| `/v1/runs/:id/series` | Summary, Report |
| `/v1/runs/:id/errors` | Summary |
| `/v1/runs/:id/errors/series` | Report |
| `/v1/runs/:id/distribution` | Report |
| `/v1/runs/:id/telemetry` | Report (Connections, Load generators) |
| `/v1/runs/:id/agent` | Report (agent sections) |
| `/v1/runs/:id/agent/connections` | Report |
| `/v1/runs/:id/agent/dns` | Report |
| `/v1/runs/:id/agent/injectors` | Report |
| `/v1/runs/:id/agent/status` | Report |
| `/v1/runs/:id/events` | Logs |

Deliberately **not** readable:

- `/trends` returns the run's whole cohort, other runs' ids and figures included.
  It is what the baseline deltas and the Trends tab read.
- `/ai-analysis` is excluded because the public page has no AI card.
- `/scatter` is read only by the request drill-down, which the public page does
  not offer.

`GET /v1/public-link` carries **`@PublicLinkOnly()`**, a sixth exclusive access
marker beside `@Requires`, `@BearerOnly`, `@NotProjectScoped`, `@Public` and
`@OwnAccount`. `AccessGuard` answers any other tenant 404 there.

### 5.4 Redaction

For a link tenant, `GET /v1/runs/:id` returns `note.updatedBy: null`. The note's
text stays, because it is part of the run the sharer chose to share. A person's
name does not leave the install. `updatedBy` is already nullable: it is null once
an author's account is deleted, so the page renders this case today.

Every response to a link tenant carries `Cache-Control: private, no-store`, so an
intermediary never keeps a copy.

### 5.5 What stays as it is

- The live WebSocket (`/v1/runs/:id/live`) authenticates a session itself and is
  not touched. A link reaches only a finished run (section 4.1), so the public
  page never opens it.
- Better Auth's `/auth/*` routes never see the `PublicLink` scheme.
- The bearer and session paths are byte-for-byte unchanged.

### 5.6 Guards derived from the routes

These go in `apps/api/test/access-routes.integration.test.ts`, which already walks
every route:

- The walked set of `@LinkReadable` routes equals a literal `LINK_READABLE_ROUTES`
  list, both ways. A route added to the allowlist is a decision someone wrote
  down.
- Every `@LinkReadable` route is a GET under `/v1/runs/:id` and carries
  `@Requires('project:read')`.
- `@PublicLinkOnly` is exclusive with the other five markers, and the walked set
  of `@PublicLinkOnly` routes is exactly `GET /v1/public-link`.
- **The link matrix.** A real link tenant is sent against **every walked route**,
  with an id from the walk's own probe shapes. It must answer 2xx on the
  allowlist for its own run, 404 on the allowlist for another run in the same
  project, and 404 on every other route. The vacuity floor counts the routes
  probed, never the verdicts.

## 6. Web

### 6.1 Routes

`/share/:token` sits outside `AuthGate` and `AppShell`, beside `/login`:

```
/share/:token          Summary (index)
/share/:token/report   Report
/share/:token/logs     Logs
```

It carries its own `QueryClient`. The app's `endSessionOn401` handler would send a
401 to `/login`; here a `LINK_*` or `PUBLIC_LINKS_DISABLED` 401 replaces the page
with the matching link-state page instead:

| Code | Page says |
| --- | --- |
| `LINK_EXPIRED` | This link expired on 13 Nov 2026. |
| `LINK_REVOKED` | This link has been revoked. |
| `PUBLIC_LINKS_DISABLED` | Public links are turned off for this organisation. |
| `LINK_NOT_FOUND` | This link does not exist. |

Each of these pages also asks the reader to request a new link from whoever sent
this one.

### 6.2 The credential

- `apiFetch` and `apiFetchNoContent` take the link secret from
  `window.location.pathname` when it matches `^/share/(ppl_[A-Za-z0-9_-]{43})(/|$)`.
  They then send `Authorization: PublicLink <secret>` with `credentials: 'omit'`.
- The current URL is the only reliable answer to "which credential". A module-level
  setter would be stale after a history navigation back into the app in the same
  tab, and a setter in a parent effect runs after its children's queries have
  already fired. A unit case covers both halves.
- The SPA serves `/share/*` with `X-Robots-Tag: noindex`, so a link pasted
  somewhere public is not indexed.

### 6.3 The public page reuses the run shell

`PublicRunPage` resolves the link (`GET /v1/public-link`) and reads the run
through the existing `useRunTerminal(runId)`. It then mounts the existing
`RunShell` inside `RunPresentationProvider value={{ kind: 'public', token,
expiresAt }}`. The tabs are the existing `RunSummary`, `RunReport` and `RunLogs`,
pickers from #300 included.

The presentation context makes these changes, and nothing else on the page differs:

| Piece | `public` |
| --- | --- |
| permissions | `{ known: true, can: () => false }`, with no request to `/auth/*` or `/v1/projects`. The note is read-only, and every rule link and access link hides itself, as they already do for a Viewer. |
| `RunTabs` | Summary, Report and Logs, at `/share/:token/…`. Logs still appears only when the run has a runner job. |
| `RunHeader` | The breadcrumb's project and test are text, not links. |
| AI card | not rendered |
| baseline deltas | not computed, and `/trends` is never requested; tiles show values only |
| decision band | no Compare action; its fragment link targets `/share/:token` |
| statistics table, groups list, assertion targets | names are text, not drill-down links. The #300 pickers narrow the Report instead. |
| chart menus, SLA summary export | unchanged: they are reads |

The mechanism is a hook, `useRunPaths(runId)`. It returns each destination's path,
or `null` where the presentation has none: `section(name)`, `request(name)`,
`group(name)`, `compare()`, `trends()`, `project()`, `test()`. Every link inside
the shell and the three tabs is built through it. The global path helpers stay for
everything outside the run page.

The header has no rail, no palette and no account menu. It shows the product name,
then "Read-only link · expires 13 Nov 2026".

### 6.4 Creating and revoking, on the run page

- **The Share button.** `RunHeader` gains it, beside the run's other actions. It
  renders when `can('run:share')` and the run is `complete` or `incomplete`.
- **The dialog.** It reads `GET /v1/runs/:id/public-links`.
  - **Switch off:** when `enabled` is false, the dialog says an admin has turned
    public links off, names Administration › Settings, and draws no form.
  - **Expiry:** a select offering 1 week, 2 weeks, 1 month, 6 months, 1 year,
    2 years and Custom. Custom shows a date input, bounded to two years from
    today, and resolves to the end of the chosen day in the reader's zone. Under
    the select: "This link will expire on …".
  - **Consent:** "Anyone with this link can read this run's Summary, Report and
    Logs — its project and test names included — without signing in, until it
    expires or is revoked."
  - **Create:** shows the URL once, with Copy. A read-only field shows the value
    when the clipboard is absent, as the API-token page already does. Then:
    "This is the only time the full link is shown."
  - **The list:** each of the run's links shows its state badge, creator, created
    and expires times, last opened, and Revoke. Revoke asks for an inline
    confirmation; it is a destructive action and is not `primary`.

### 6.5 Administration › Settings

A second switch, *Public links*. Its sentence is always visible, because turning
it on is a decision about publishing (the AI consent rule):

> Anyone with a public link can read that run's Summary, Report and Logs without
> signing in, until the link expires or is revoked. Turning this off stops every
> link at once; turning it back on restores the links that have not expired or
> been revoked.

### 6.6 Guards derived from the page

- **Links never leave the share tree.** An e2e case opens each public tab in a
  cookie-less browser context. Every `<a href>` on the page must stay under
  `/share/<secret>`, or be a fragment. The vacuity floor counts the anchors found.
- **The page reads only the allowlist.** The same case records every request the
  page makes. Each one must be `GET /v1/public-link` or an allowlisted path for
  the link's own run. Calling `/trends`, `/ai-analysis`, `/auth/*` or
  `/v1/projects` fails the case and names the URL.

## 7. Testing

**Unit:**
- the secret's format and hash
- the expiry bounds
- `state` derivation
- `useRunPaths` for both presentations
- the credential choice in `apiFetch`, including the stale-history case
- the link-state page per code
- the share dialog: switch off, preset to instant, Custom, shown-once, revoke
  confirmation
- `RunShell` in public mode: no AI card, no Compare action, text breadcrumb, three
  tabs

**Integration:**
- each of the four refusal codes from the middleware
- the matrix in section 5.6
- revoke taking effect on the next request
- the switch suspending links and then restoring them
- an expired link refused while an unexpired one beside it reads
- redaction of `note.updatedBy`
- `Cache-Control: no-store`
- the cascade from run and project deletion
- the create refusals
- the rolling-deploy settings body
- the OpenAPI document covering the four new operations and the `publicLink`
  security scheme on the 16 operations a link can reach

**e2e** (`public-links.spec.ts`):
- turn the switch on, create a link from the run page, and open it in a fresh
  context with no cookies
- read all three tabs, and narrow the Report with a picker
- assert no AI card and the two derived guards above
- revoke the link, then reload: the revoked page shows

**Real check:**
- a real `ParitySimulation` run through the Gradle plugin, on scratch stores
- share it, open it signed out, and compare the shared Summary's figures with the
  signed-in page's
- revoke it, and see the revoked page

## 8. Known and left

- **No org-wide list of live links.** The switch is the stop-everything control,
  and the per-run list is where a link is found. A list belongs to the day an
  audit log exists; AC-SEC-4 is unbuilt.
- **No per-open audit**, only `last_used_at`.
- **The URL path carries the secret**, as Gatling Enterprise's does.
  - It does not leak through Referer: the app already sends `no-referrer`, and the
    public page has no links out.
  - A reverse proxy's access log does see it. On an on-prem install the operator
    owns that log.
  - A fragment would have kept it out of the log, but the run page already uses
    fragments to open Report sections and reveal the errors table.
- **A run recomputed after it was shared reads its new figures**, as it does
  signed in.
- **Logs show the runner's host name** ("Claimed by the runner on '<host>'"), and
  Connections shows remote addresses. Gatling Enterprise's public page shows both,
  and the consent sentence says the Logs are included.
- **No theme control on the public page.** It follows the stored or system
  preference that the pre-paint script already applies.

## 9. Custom report and PDF export (designed now, built later)

### 9.1 What it is

A per-project document of ordered blocks, each naming its own run, saved either
with data (a **report**) or as a reusable shape (a **template**). Its print view
is saved as PDF from the browser. This is Gatling Enterprise's `/runs/<run>/export`
(`page-notes.md`, "Custom report").

### 9.2 Data

`report`:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `org_id`, `project_id` | `uuid` | FKs, cascade |
| `kind` | `text` | `'report' \| 'template'`, with a CHECK |
| `title` | `text` | |
| `blocks` | `jsonb` | validated by a zod discriminated union, versioned |
| `created_by`, `updated_by` | `text` NULL | FK `"user"`, set null |
| `created_at`, `updated_at` | `timestamptz(3)` | |

- A template is a report with every `runId` and every text emptied, which is
  Gatling Enterprise's own definition ("the basic definition of all graphs,
  without custom texts or data").
- A block references its run by id and reads the run's figures when it renders;
  it is not a snapshot. Runs are immutable once finished, except for a recompute,
  which the report then shows. That is recorded rather than prevented.

### 9.3 Blocks

Gatling Enterprise's catalogue, mapped to what PerfPortal already draws:

| Group | Blocks |
| --- | --- |
| General | Title, Text, Page break |
| Run | Status (the decision band's sentence), Note, Assertions (both bars), Summary (the four tiles) |
| Charts | any Report chart, carrying its section pick (#300's group, request or scenario) and its time window |
| Counts | Requests and responses counts, Status counts, Errors counts |

Each block names its own `runId`, so one report can show several runs. A new
report opened from a run is seeded with that run and the same default blocks
Gatling Enterprise seeds.

### 9.4 Pages and reuse

- The builder lives at `/projects/:slug/reports/:reportId`. Each block offers a
  type, a run, move up, move down and delete, with Add block between blocks. The
  page has Load (a template or a saved report) and Save (as a report or as a
  template).
- The print view lives at `/projects/:slug/reports/:reportId/print`, rendered
  under presentation `print`:
  - every `useRunPaths` destination is `null`
  - ECharts animation is off
  - a Page break block is `break-before: page`
  - the reader's browser saves the PDF
- **The one refactor it needs.** Every Report section already takes its `runId` as
  a prop. They read the window, the time domain and the permissions from
  `RunShell`'s outlet context (`useRunWindow`). A block is not a route child, so
  that read moves to a `RunViewProvider`. `RunShell` supplies it today, and a
  report block will supply its own. The public-links build does not need this,
  because its tabs are route children.

### 9.5 Sharing a report

A shared report is a `run_public_link` row with `report_id` in place of
`run_id`; the table gains the column and a CHECK that exactly one is set. Its
tenant's `runIds` is the set of runs the report's blocks name, read when the
request arrives. The guard in section 5.2 does not change. Whether this ships with
the report builder or after it is that plan's decision.
