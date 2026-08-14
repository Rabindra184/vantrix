# PerfPortal Parity UI — Application Shell Design

**Date:** 2026-08-10
**Status:** Approved for planning
**Milestone:** PRD §26 M3 (*Parity UI*) — first of two sub-projects; charts follow
**Predecessors:** [Ingest spine](2026-08-07-perf-portal-ingest-spine-service-design.md) · [Parity backend](2026-08-08-perf-portal-parity-backend-design.md) · [Session auth](2026-08-09-perf-portal-session-auth-design.md), all shipped

---

## 1. Why the shell is its own sub-project

There is no frontend at all: no `apps/web`, no React, no Vite. M3's rendering half is the whole Gatling report — a global page carrying eight chart types plus three detail-page families. Building that in one pass means the chart work depends on plumbing that has never run once.

The riskiest unknown is not a chart. It is whether a session cookie minted by Better Auth survives a round trip through a real browser into `/v1`, because that path has only ever been exercised by supertest, which keeps no cookie jar and enforces no `Secure` or `SameSite` semantics. **This sub-project exists to answer that with a browser, before eight charts are written on top of the assumption.**

**Scope.** An app shell, session login, the run list, and one run's header and assertions. No charts.

## 2. Stack, already decided

PRD §16.4 and §22 fix the stack, so it is recorded rather than re-litigated: **React 18 + TypeScript**, **Vite**, **Tailwind consuming CSS custom properties**, **Apache ECharts** on the canvas renderer when charts arrive. Added here: **TanStack Query**.

TanStack Query is adopted now rather than after the pain. Three routes do not need it. The chart page does — eight endpoints on one screen, plus background refetch — and a run is `pending` until the worker finishes, so polling is required by this sub-project regardless. Retrofitting a query layer under written components is a rewrite; adopting it first is not.

**Types are imported, never redeclared.** `@perfportal/contracts` already exports a Zod schema and inferred type for every response. The UI validates against those schemas at the boundary. A hand-written interface mirroring `StatsResponse` would be a second source of truth for the API's shape, and the failure mode is a silent drift that typechecks.

## 3. Same origin, and the mount ordering that makes it work

**The API serves the built SPA.** One origin for browser and API.

The alternative topologies were rejected on evidence, not taste. The session cookie is `sameSite: 'strict'` and the API has **no CORS configuration at all** — a SPA on a different site would send no cookie, and the symptom is a login that appears to succeed followed by a 401 on every subsequent call. PRD §16's diagram shows the SPA on a CDN, which is exactly that case; adopting it would require relaxing the cookie to `sameSite: 'none'`, and that property is currently the platform's entire CSRF defence, since neither rate limiting nor a CSRF token exists (session-auth spec §8).

Same-origin keeps all of that untouched and forecloses nothing: a reverse proxy can front both later with no application change.

**Ordering is load-bearing**, and inherits the reasoning Task 4 established for `/auth/*`:

```
1. /auth/*splat   → Better Auth handler (raw Express, before Nest's body parser)
2. /v1/*          → AuthMiddleware perimeter, then routes
3. everything else → static build, SPA fallback to index.html
```

The static handler mounts **last**, and its fallback must not swallow unknown `/v1` paths. `GET /v1/nonsense` must keep returning RFC 9457 `problem+json`, not `index.html` with a 200 — an API client receiving HTML where it expects a problem document is a worse failure than a 404, because it typechecks as a string and fails somewhere else entirely. **A test asserts this directly.**

In development, Vite proxies `/v1` and `/auth` to the API, which is same-origin from the browser's view. The cookie therefore behaves identically in dev and production, rather than working in one and failing in the other.

## 4. The data layer

```ts
apiFetch<T>(schema: ZodSchema<T>, path: string, init?: RequestInit): Promise<T>
```

Validates the response against the contract schema, and on failure throws a typed `ProblemError` carrying `code`, `detail` and `remediation`. `remediation` is compile-time-required across this API; surfacing it is what makes an error actionable rather than decorative.

TanStack Query wraps `apiFetch`. Run detail refetches while `status === 'pending'` and stops when it settles.

**Session bootstrap** asks `/auth/get-session` once on load, and that answer decides `/login` versus the shell. Letting each route discover its own 401 would produce a redirect race on first paint.

## 5. Two error languages, deliberately not unified

Deviation D-1 of the session-auth spec means `/auth/*` returns Better Auth's native error shapes while `/v1` returns RFC 9457. That lands on the UI as **two narrow adapters, not one normaliser**. The login form is the only place the Better Auth shape is understood; everything else consumes `ProblemError`.

Collapsing them would mean synthesising a `remediation` Better Auth never sent — inventing guidance and attributing it to the server.

### 5.1 Three rejections, three outcomes

| Response | Meaning | UI |
|---|---|---|
| **401** | no/invalid/expired session | redirect to `/login`, preserving the intended path |
| **403** | valid session, no `org_member` row | a real page: an administrator must add this account to an organisation |
| **400 `PROJECT_REQUIRED`** | session hit a project-scoped route | surface the `remediation` |

**The 403 is the one a naive implementation gets wrong.** Treating every rejection as "go to `/login`" produces an infinite loop for that user: they sign in successfully, get 403, and are thrown back to a login page that will keep working. The session-auth spec introduced this status precisely so authentication and authorisation are distinguishable; the UI has to honour the distinction.

**Logout** posts to `/auth/sign-out`, **clears the query cache**, then redirects. Leaving a previous user's run list in memory after logout on a shared machine is a data leak with no server-side component.

### 5.2 One environmental trap

The session cookie is `secure: true`. Browsers permit `Secure` cookies over `http://localhost`, so local development works — but a plain-HTTP deployment on any real hostname holds no cookie at all, and the symptom is a login that appears to succeed and then 401s forever. The README documents the TLS requirement; this design's contribution is to keep the failure legible rather than silent.

## 6. Rendering decisions with consequences

**Sort and display must agree.** `RunRepository.list` orders by `COALESCE(tool_started_at, started_at)` — the tool's own run start, falling back to ingest time. A table displaying `startedAt` while the server sorts on the coalesced value looks mis-sorted whenever CI uploads out of order, and reads as a backend fault. The column shows the value the sort uses, and distinguishes the two when they differ.

**Three things render honestly rather than conveniently:**

- **`not_applicable`** gets its own treatment, never a green tick. The ingest spine introduced this outcome specifically so a rule that could not be evaluated is not reported as a pass.
- **`pending`** is a real state, not an empty one. A run still processing says so, rather than rendering zeros that look like a completed run with no traffic.
- **Duration renders to whole seconds**, matching Gatling's own header, so parity comparison is not defeated by formatting.

**Pagination is cursor-based**, following `nextCursor`. The API offers no offset paging, and the cursor encodes the same coalesced sort key.

## 7. Accessibility, asserted rather than aspired to

§22 requires WCAG 2.2 AA. For a form and a table that is concrete: real `<table>` semantics with headers, labelled inputs, focus moved deliberately on redirect, and verdict conveyed by text and shape — **never colour alone**. Playwright's role-based selectors assert these directly, so a regression in semantics fails a test rather than surviving to an audit.

The design-token layer lands now, both light and dark, so the chart sub-project inherits it instead of retrofitting a theme under existing components.

## 8. Testing

**Playwright against the real API, Postgres and worker** — the posture the integration suites already take. Fixtures come from the established path: bootstrap an admin, mint a project token, ingest the real Gatling reference bundle.

Component tests in jsdom with a mocked API were rejected for this sub-project. They cannot exercise the cookie, the proxy, or the real problem shapes — and the cookie round trip is the entire reason this sub-project exists. A mocked 401 proves only that the mock returned 401.

**Every test must be shown capable of failing.** The plan names the mutation for each: break the auth redirect, delete the SPA-fallback exclusion, revert the sort column, render `not_applicable` as a pass. The previous sub-project shipped four assertions that could not fail — one asserted a `where` clause that a truncated table made irrelevant, one accepted the 404 it was meant to reject, one compared two empty objects. **"It renders" is not an assertion.**

## 9. Out of scope

All charts and detail pages (the next sub-project). i18n mechanics, personalization, saved views, custom dashboards (post-V1, §26). Live monitoring (fast-follow). Self-registration, invitations and password reset — the first admin comes from `pnpm bootstrap`, so a registration link would be a dead end.

**Any RBAC affordance.** `org_member.role` is written and read by nothing until M6. A UI reading it would invent an authorization model the backend does not enforce, and the failure mode of that invention is a control that appears to restrict and does not.

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | The SPA fallback swallows unknown `/v1` paths, returning HTML where clients expect `problem+json` | Mount order fixed in §3; a test asserts `GET /v1/nonsense` still returns a problem document |
| R-2 | The `Secure` cookie fails on a non-TLS deployment, presenting as a login that works then 401s | §5.2; documented in the README, and the 401 remediation names both credentials |
| R-3 | Playwright's real-stack fixtures make the suite slow enough to be skipped | Reuse the existing ingest fixture rather than a per-test ingest. The ~51s per ingest this row originally assumed was never measured: on 2026-08-12 a full `seedRunWithData` (POST + parse + statistics + SLA evaluation) MEASURED at ~0.34s cold, ~0.13s warm, so the risk is far smaller than stated — the reuse is still worth keeping, but no test should be shaped around the price of an ingest |
| R-4 | Two error adapters drift, and the login form starts inventing `remediation` | §5 makes the boundary explicit: only the login form parses Better Auth's shape |
