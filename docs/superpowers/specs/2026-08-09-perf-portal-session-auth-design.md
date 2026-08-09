# PerfPortal Session Authentication — Service Design

**Date:** 2026-08-09
**Status:** Approved for planning
**Milestone:** PRD §26 M3 (*Parity UI*) — prerequisite; identity work otherwise scheduled at M6
**Predecessors:** [Ingest spine](2026-08-07-perf-portal-ingest-spine-service-design.md) · [Parity backend](2026-08-08-perf-portal-parity-backend-design.md), both shipped

---

## 1. Why this exists before the UI

The platform has no human authentication. `/v1` accepts exactly one credential: a
project-scoped bearer token minted by `pnpm bootstrap` and carried by CI. OIDC
SSO is **M6**, three milestones after the Parity UI. So the UI planned for M3 has
nothing a person can log in with.

Two options were rejected. Pasting an API token into the browser and holding it in
`sessionStorage` needs no backend work, but puts a long-lived project credential
in XSS reach and would be replaced wholesale at M6. Building the UI first against
bearer tokens and retrofitting sessions later means every request path, error
state and route guard is written against one auth model and reworked under
another.

**Scope.** Local accounts with session cookies, on Better Auth. Nothing else. RBAC,
OIDC, SAML, invitations, password reset and rate limiting are explicitly out —
see §8.

## 2. Library choice

**Better Auth**, over a hand-rolled implementation, Passport, and a self-hosted
identity provider.

The competing argument for hand-rolling was real and is recorded here because it
shapes §3: this codebase already contains the hard parts. `@perfportal/core`
carries argon2id hashing and a `prefix.secret` credential scheme in which a
database read never yields a usable credential, and `org` → `project` tenancy is
enforced on every query path. Better Auth's two largest value-adds — credential
storage and an organization model — are precisely those.

Better Auth was chosen anyway for what it makes cheap later: OIDC and social
providers, 2FA, and passkeys arrive as configuration rather than as build work,
which matters because M6 requires SSO and V1.1 requires SAML.

**Known costs, accepted:**

- Its NestJS binding is **community-maintained**, not first-party. The glue
  between the library and our middleware is therefore not covered by the
  library's own guarantees, which is why §7 tests that boundary directly rather
  than trusting it.
- Its schema sits alongside ours rather than replacing it.
- Its error shapes are not this API's RFC 9457 (§5).

Hosted services (Clerk, Auth0, WorkOS) were excluded by a PRD constraint, not on
merit: M0's exit criterion is *"a stranger deploys a running instance and
authenticates."* A mandatory external dependency breaks that.

## 3. Better Auth owns identity; we keep tenancy

The load-bearing decision.

Better Auth generates `user`, `session`, `account` and `verification`, and ships an
`organization` plugin. **The organization plugin is not used.** `org` and `project`
already exist, every metric and run query already filters on them, and `api_token`
is already project-scoped. Adopting a second organization model would create two
answers to "what may this caller see?", and the failure mode of that disagreement
is a tenancy leak.

One new table instead:

```
org_member
  user_id     text     -- Better Auth's user id
  org_id      uuid     -- references org(id)
  role        text     -- 'admin' | 'member'; written, unused until M6's RBAC
  created_at  timestamptz
  PRIMARY KEY (user_id, org_id)
```

`role` is deliberately stored though nothing reads it. That is normally a defect
in this project — the ingest spine shipped a `run_indicator.failed` column written
by every ingest and read by nothing, and the parity backend deleted a
`MetricReader.sketch()` with no caller. It is admitted here because the column is
part of the tenancy key's shape and adding it later means migrating live
membership rows. **It must be listed in the plan as a known write-only column so a
reviewer flags its absence of readers as expected rather than as a finding.**

Division of responsibility: Better Auth answers *who is this?*; `org_member` and
the existing tables answer *what may they see?*

## 4. The perimeter keeps one door

`AuthMiddleware` is mounted on the whole `/v1` prefix and today resolves exactly
one credential. It gains a second branch:

```
Authorization: Bearer <prefix.secret>   → existing token path, UNCHANGED
Cookie: <better-auth session>           → auth.api.getSession({ headers })
                                          → user → org_member → req.tenant
neither                                 → 401
```

Both branches produce the same `req.tenant`, so **no controller changes and no
change to any existing test of the bearer path.** CI ingest continues to work
untouched — that is the property this design most needs to preserve, because the
ingest contract is what two prior sub-projects were built to guarantee.

A session grants every scope within its org. RBAC is M6; inventing a finer model
now would be a guess to unpick later.

Better Auth's own handler mounts at `/auth/*`, **outside** `/v1`, so the perimeter
never guards its own login route. NestJS guards run only for already-matched
routes, which is why the perimeter is middleware and not a guard — a guard cannot
401 an unmatched path. That reasoning is inherited from the ingest spine and must
not be undone here.

## 5. Two deliberate deviations

| # | Deviation | Rationale |
|---|---|---|
| D-1 | `/auth/*` returns Better Auth's native error shapes, not RFC 9457 `application/problem+json` with a compile-time-required `remediation` | Wrapping a library's auth errors risks flattening distinctions it draws deliberately, and `/auth/*` is a separate, separately-documented surface. `/v1` stays RFC 9457 throughout, including the 401 for a missing or invalid session |
| D-2 | Session lifetime, sliding expiry and "log out everywhere" follow Better Auth's semantics, not ours | Reimplementing them against its `session` table would fork behaviour from the library that owns it |

## 6. Schema and migrations

Better Auth's models are declared in `packages/persistence/prisma/schema.prisma`
via its Prisma adapter and land as an ordinary generated migration — unlike
`run_series_bucket` and `run_user_bucket`, which are hand-written because Prisma
cannot express range partitioning.

Standing hazards that have each cost real debugging time in this repo:

- `prisma migrate deploy` does **not** regenerate the client. Apply with
  `pnpm --filter @perfportal/persistence run migrate:deploy`, which chains
  `prisma generate`.
- Never edit a migration after applying it: `_prisma_migrations.checksum` will
  disagree with the file while `prisma migrate status` still reports "up to date".
- `SCHEMA_TABLES` in `packages/persistence/src/client.ts` and the per-app
  truncation lists in `apps/api/test/support/app.ts` and
  `apps/worker/test/pipeline.integration.test.ts` must gain the new tables.
  A stale list there broke every persistence integration test during the parity
  backend and was found only by an implementer working on an unrelated task.

## 7. Testing

Integration tests, against live Postgres:

- login sets a session cookie, and `/v1` accepts that cookie;
- **a bearer token still authenticates unchanged** — the regression that would
  break CI ingest;
- logout invalidates the session; a request with the stale cookie 401s;
- **a session in org A cannot read org B's runs** — the tenancy assertion, and the
  one whose failure is a security bug rather than a bug;
- a user with no `org_member` row receives 403, not 500;
- `/auth/*` is reachable without a session, and `/v1` is not.

Because Better Auth's NestJS binding is community-maintained (§2), the boundary
between library and middleware is tested directly rather than assumed: the
org-isolation test in particular must exercise a real logged-in session, not a
fabricated `req.tenant`.

## 8. Out of scope

Rate limiting on login belongs here on the merits and is deliberately excluded:
the platform has no rate-limiting primitive at all, and building one inside an
auth spec would make it a hidden dependency for every future endpoint. Recorded
as a gap rather than smuggled in.

Also out: RBAC enforcement (M6), OIDC and SAML (M6/V1.1), invitations, password
reset, email verification, 2FA and passkeys — Better Auth supports the last several
as configuration, which is the reason it was chosen, but enabling them is not this
sub-project.

## 9. Pre-flight spike, before planning

Both previous sub-projects were saved by one. The parity backend's spike found
that esbuild silently drops the `design:paramtypes` metadata NestJS DI depends on,
which would have broken every task from Task 10 onward.

Three unknowns here, each of which invalidates the plan if it resolves badly:

1. Does Better Auth's handler mount cleanly in this **ESM + NestJS-on-Express**
   setup, given the repo's `.js`-extension imports and its SWC-for-apps /
   esbuild-for-packages Vitest split?
2. Does `auth.api.getSession({ headers })` work server-side from inside
   `AuthMiddleware`, with Express's `req.headers`?
3. Does its Prisma adapter coexist with the hand-written partitioned-table
   migrations, and does `prisma migrate status` stay clean afterwards?

The spike answers all three against the real repo and records the versions it
proved. If any answer is no, the design returns to hand-rolled on the existing
argon2id primitives (§2), which remains the fallback.

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | The community-maintained NestJS binding breaks on a Better Auth minor release | Pin exact versions; the spike records what was proven; §7's tests exercise the binding rather than mocking it |
| R-2 | Two credential systems drift — a session grants what a token does not, or vice versa | Both branches produce the same `req.tenant` and nothing below the middleware can tell them apart; a test asserts a bearer token and a session reach identical results on the same endpoint |
| R-3 | `org_member.role` stays unread and is deleted by a later reviewer applying this project's own standing rule | Recorded in §3 and required to be flagged in the plan as a known write-only column |
| R-4 | Better Auth's session table is truncated between tests but its in-memory state is not, producing order-dependent failures | Truncation lists updated per §6; the login test creates its own user rather than relying on bootstrap state |
